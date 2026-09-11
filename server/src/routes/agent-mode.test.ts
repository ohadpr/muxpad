// Agent modes at the HTTP seam: PATCH /api/panes/:id {mode} validation, what
// it persists, and the honest MID-SESSION semantics — the pane row and its
// startup_cmd change immediately, the live runner is merely NOTIFIED (no
// harness can rewrite a running session's system prompt; see agent-modes.ts).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentMode, PaneSpec } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAgentBridge } from '../agent-bridge.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('agent modes over HTTP', () => {
  let test: TestApp;
  let db: Database.Database;
  let wsId: string;
  let tmp: string;
  /** Every mode frame the route relayed to the (fake) live runner. */
  let relayed: Array<{ paneId: string; mode: AgentMode }>;
  /** When false the bridge reports "no runner connected". */
  let runnerConnected: boolean;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-mode-'));
    db = openDb(':memory:');
    relayed = [];
    runnerConnected = true;
    test = await createTestApp({
      db,
      dataDir: tmp,
      agentBridge: {
        ...createAgentBridge(),
        send: () => ({ ok: false, reason: 'test bridge' }),
        setMode: (paneId, mode) => {
          if (!runnerConnected) return false;
          relayed.push({ paneId, mode });
          return true;
        },
      },
    });
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    wsId = ws.id;
  });

  afterEach(async () => {
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  async function agentTab(body: Record<string, unknown> = {}) {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, bootstrap: 'agent', ...body }),
      })
    ).json()) as { id: string };
    const detail = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as {
      panes: PaneSpec[];
    };
    return { tabId: t.id, pane: detail.panes[0] as PaneSpec };
  }

  const paneRow = (id: string) =>
    db.prepare('SELECT mode, startup_cmd FROM panes WHERE id = ?').get(id) as {
      mode: string;
      startup_cmd: string | null;
    };

  // ── creation ────────────────────────────────────────────────────────────

  it('an agent tab DEFAULTS TO CHAT — the flip — and bakes the flag in', async () => {
    // The default used to be 'deep' (inject nothing) and a bare `muxpad
    // agent`. Both moved together: a row that says Chat with a command that
    // boots Agent is the one state this feature must never produce.
    const { pane } = await agentTab();
    expect(pane.mode).toBe('chat');
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode chat');
  });

  it('an agent tab asked for Agent mode gets the historical bare command', async () => {
    // Agent mode is the ABSENCE of the flag, so this is byte-for-byte the
    // command every pane carried before modes existed.
    const { pane } = await agentTab({ mode: 'agent' });
    expect(pane.mode).toBe('agent');
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent');
  });

  it('accepts the PRE-RENAME spellings on the wire, normalized', async () => {
    // A version-skewed `muxpad agent new --mode=do` must not 400 and leave
    // the caller with no way to say what it meant.
    const legacyDo = await agentTab({ mode: 'do' });
    expect(legacyDo.pane.mode).toBe('chat');
    expect(paneRow(legacyDo.pane.id).startup_cmd).toBe('muxpad agent --mode chat');
    const legacyDeep = await agentTab({ mode: 'deep' });
    expect(legacyDeep.pane.mode).toBe('agent');
    expect(paneRow(legacyDeep.pane.id).startup_cmd).toBe('muxpad agent');
  });

  it('bootstrap with mode:chat stamps the row AND bakes --mode chat into the command', async () => {
    const { pane } = await agentTab({ mode: 'chat' });
    expect(pane.mode).toBe('chat');
    // The flag is what makes a respawn boot with the real system-prompt
    // overlay rather than just an in-band note.
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode chat');
  });

  it('mode + backend + model compose in the canonical flag order', async () => {
    const { pane } = await agentTab({ mode: 'chat', backend: 'codex', model: 'gpt-5.5' });
    expect(paneRow(pane.id).startup_cmd).toBe(
      "muxpad agent --backend codex --mode chat --model 'gpt-5.5'",
    );
  });

  it('a pending harness-pick pane keeps the exact `muxpad agent --pick` literal', async () => {
    // Several call sites compare against that string verbatim; the mode lives
    // on the row until a harness is chosen.
    const { pane } = await agentTab({ mode: 'chat', backend: 'pick' });
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --pick');
    expect(pane.mode).toBe('chat');
  });

  it('a mode PATCH on a PENDING pane does not wedge the harness picker', async () => {
    // Regression: applyModeToStartupCmd used to rewrite `muxpad agent --pick`
    // to `muxpad agent --mode chat --pick`, after which /agent-backend,
    // /as-terminal and /as-web all 409'd (they compare that literal verbatim)
    // and the dead-runner sweep stopped skipping the pane. Not reachable from
    // the UI — the picker replaces the mode toggle — but trivially reachable
    // over HTTP, which is exactly how an agent would drive it.
    const { pane } = await agentTab({ backend: 'pick' });
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'chat' }),
    });
    expect(res.status).toBe(200);
    // Mode lands on the ROW; the command keeps its exact literal.
    expect(paneRow(pane.id)).toMatchObject({ mode: 'chat', startup_cmd: 'muxpad agent --pick' });
    // …and the picker still works, carrying the mode into the real command.
    const pick = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'claude' }),
    });
    expect(pick.status).toBe(200);
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode chat');
  });

  it('the other pending-pane conversions also survive a mode PATCH', async () => {
    for (const route of ['as-terminal', 'as-web'] as const) {
      const { pane } = await agentTab({ backend: 'pick' });
      await test.app.request(`/api/panes/${pane.id}`, {
        method: 'PATCH',
        ...json({ mode: 'chat' }),
      });
      const res = await test.app.request(`/api/panes/${pane.id}/${route}`, { method: 'POST' });
      expect(res.status).toBe(204);
    }
  });

  it('choosing a harness re-applies the pane’s mode to the new command', async () => {
    const { pane } = await agentTab({ mode: 'chat', backend: 'pick' });
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'cursor' }),
    });
    expect(res.status).toBe(200);
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --backend cursor --mode chat');
  });

  it('a non-agent (shell) tab’s pane still reads Agent and ignores the flag', async () => {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, bootstrap: 'shell', mode: 'chat' }),
      })
    ).json()) as { id: string };
    const detail = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as {
      panes: PaneSpec[];
    };
    // The BASELINE, not the new default: there is no agent in a plain shell
    // to carry a contract, and `muxpad claude` reads this row.
    expect(detail.panes[0]?.mode).toBe('agent');
    expect(paneRow(detail.panes[0]!.id).startup_cmd).toBeNull();
  });

  // ── PATCH validation ────────────────────────────────────────────────────

  it('rejects an unknown mode with 400', async () => {
    const { pane } = await agentTab();
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'turbo' }),
    });
    expect(res.status).toBe(400);
    expect(paneRow(pane.id).mode).toBe('chat'); // unchanged
  });

  it('rejects mode on a non-agent pane with 400 (the column would be dead data)', async () => {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, name: 'T' }),
      })
    ).json()) as { id: string };
    const p = (await (
      await test.app.request(`/api/tabs/${t.id}/panes`, { method: 'POST', ...json({}) })
    ).json()) as PaneSpec;
    const res = await test.app.request(`/api/panes/${p.id}`, {
      method: 'PATCH',
      ...json({ mode: 'chat' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('404s for an unknown pane', async () => {
    const res = await test.app.request('/api/panes/nope', {
      method: 'PATCH',
      ...json({ mode: 'chat' }),
    });
    expect(res.status).toBe(404);
  });

  // ── mid-session semantics ───────────────────────────────────────────────

  it('a switch persists the row, rewrites startup_cmd, and NOTIFIES the runner', async () => {
    const { pane } = await agentTab({ mode: 'agent' });
    // Simulate the self-heal rewrite an attached runner performs.
    db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?').run(
      'muxpad agent --resume sid-1',
      pane.id,
    );

    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'chat' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as PaneSpec).toMatchObject({ mode: 'chat' });

    const row = paneRow(pane.id);
    expect(row.mode).toBe('chat');
    // The NEXT respawn gets the real system-prompt overlay…
    expect(row.startup_cmd).toBe('muxpad agent --mode chat --resume sid-1');
    // …while the LIVE session only gets a notification frame.
    expect(relayed).toEqual([{ paneId: pane.id, mode: 'chat' }]);
  });

  it('does NOT respawn the pane — the conversation survives a mode switch', async () => {
    // A respawn would kill the session, its background subagents and any
    // scheduled wakeups. The proof is that --resume is preserved rather than
    // dropped (the /cwd route, which DOES restart, strips it).
    const { pane } = await agentTab({ mode: 'agent' });
    db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?').run(
      'muxpad agent --resume sid-keep',
      pane.id,
    );
    await test.app.request(`/api/panes/${pane.id}`, { method: 'PATCH', ...json({ mode: 'chat' }) });
    expect(paneRow(pane.id).startup_cmd).toContain('--resume sid-keep');
  });

  it('switching to Agent mode strips the flag and notifies again', async () => {
    const { pane } = await agentTab({ mode: 'chat' });
    await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'agent' }),
    });
    expect(paneRow(pane.id)).toMatchObject({ mode: 'agent', startup_cmd: 'muxpad agent' });
    expect(relayed).toEqual([{ paneId: pane.id, mode: 'agent' }]);
  });

  it('re-PATCHing the SAME mode is a no-op — no relay, no command churn', async () => {
    const { pane } = await agentTab({ mode: 'chat' });
    const before = paneRow(pane.id).startup_cmd;
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'chat' }),
    });
    expect(res.status).toBe(200);
    expect(relayed).toEqual([]);
    expect(paneRow(pane.id).startup_cmd).toBe(before);
  });

  it('repeated switches never accrete flags', async () => {
    const { pane } = await agentTab({ mode: 'agent' });
    for (const m of ['chat', 'agent', 'chat', 'agent', 'chat'] as const) {
      await test.app.request(`/api/panes/${pane.id}`, { method: 'PATCH', ...json({ mode: m }) });
    }
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode chat');
  });

  it('succeeds with no runner connected — the row is authoritative regardless', async () => {
    const { pane } = await agentTab({ mode: 'agent' });
    runnerConnected = false;
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'chat' }),
    });
    expect(res.status).toBe(200);
    expect(paneRow(pane.id).mode).toBe('chat');
    // Nothing was relayed, but the respawn path is armed.
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode chat');
  });

  it('a folder switch keeps the mode (a new project, not a new personality)', async () => {
    const { pane } = await agentTab({ mode: 'chat' });
    const res = await test.app.request(`/api/panes/${pane.id}/cwd`, {
      method: 'POST',
      ...json({ cwd: tmp }),
    });
    expect([204, 503]).toContain(res.status); // 503 only if ptyd went away
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode chat');
  });

  // ── surfacing ───────────────────────────────────────────────────────────

  it('GET /api/panes/:id and the flat list both carry the mode', async () => {
    const { pane } = await agentTab({ mode: 'chat' });
    const one = (await (await test.app.request(`/api/panes/${pane.id}`)).json()) as PaneSpec;
    expect(one.mode).toBe('chat');
    const all = (await (await test.app.request('/api/panes')).json()) as PaneSpec[];
    expect(all.find((p) => p.id === pane.id)?.mode).toBe('chat');
  });
});
