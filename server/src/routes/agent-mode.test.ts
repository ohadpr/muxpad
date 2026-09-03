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

  it('an agent tab defaults to deep, with the historical bare startup command', async () => {
    const { pane } = await agentTab();
    expect(pane.mode).toBe('deep');
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent');
  });

  it('bootstrap with mode:do stamps the row AND bakes --mode do into the command', async () => {
    const { pane } = await agentTab({ mode: 'do' });
    expect(pane.mode).toBe('do');
    // The flag is what makes a respawn boot with the real system-prompt
    // overlay rather than just an in-band note.
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode do');
  });

  it('mode + backend + model compose in the canonical flag order', async () => {
    const { pane } = await agentTab({ mode: 'do', backend: 'codex', model: 'gpt-5.5' });
    expect(paneRow(pane.id).startup_cmd).toBe(
      "muxpad agent --backend codex --mode do --model 'gpt-5.5'",
    );
  });

  it('a pending harness-pick pane keeps the exact `muxpad agent --pick` literal', async () => {
    // Several call sites compare against that string verbatim; the mode lives
    // on the row until a harness is chosen.
    const { pane } = await agentTab({ mode: 'do', backend: 'pick' });
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --pick');
    expect(pane.mode).toBe('do');
  });

  it('a mode PATCH on a PENDING pane does not wedge the harness picker', async () => {
    // Regression: applyModeToStartupCmd used to rewrite `muxpad agent --pick`
    // to `muxpad agent --mode do --pick`, after which /agent-backend,
    // /as-terminal and /as-web all 409'd (they compare that literal verbatim)
    // and the dead-runner sweep stopped skipping the pane. Not reachable from
    // the UI — the picker replaces the mode toggle — but trivially reachable
    // over HTTP, which is exactly how an agent would drive it.
    const { pane } = await agentTab({ backend: 'pick' });
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'do' }),
    });
    expect(res.status).toBe(200);
    // Mode lands on the ROW; the command keeps its exact literal.
    expect(paneRow(pane.id)).toMatchObject({ mode: 'do', startup_cmd: 'muxpad agent --pick' });
    // …and the picker still works, carrying the mode into the real command.
    const pick = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'claude' }),
    });
    expect(pick.status).toBe(200);
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode do');
  });

  it('the other pending-pane conversions also survive a mode PATCH', async () => {
    for (const route of ['as-terminal', 'as-web'] as const) {
      const { pane } = await agentTab({ backend: 'pick' });
      await test.app.request(`/api/panes/${pane.id}`, { method: 'PATCH', ...json({ mode: 'do' }) });
      const res = await test.app.request(`/api/panes/${pane.id}/${route}`, { method: 'POST' });
      expect(res.status).toBe(204);
    }
  });

  it('choosing a harness re-applies the pane’s mode to the new command', async () => {
    const { pane } = await agentTab({ mode: 'do', backend: 'pick' });
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'cursor' }),
    });
    expect(res.status).toBe(200);
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --backend cursor --mode do');
  });

  it('a non-agent (shell) tab’s pane still reads deep and ignores the flag', async () => {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, bootstrap: 'shell', mode: 'do' }),
      })
    ).json()) as { id: string };
    const detail = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as {
      panes: PaneSpec[];
    };
    expect(detail.panes[0]?.mode).toBe('deep');
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
    expect(paneRow(pane.id).mode).toBe('deep'); // unchanged
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
      ...json({ mode: 'do' }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'bad_request' } });
  });

  it('404s for an unknown pane', async () => {
    const res = await test.app.request('/api/panes/nope', {
      method: 'PATCH',
      ...json({ mode: 'do' }),
    });
    expect(res.status).toBe(404);
  });

  // ── mid-session semantics ───────────────────────────────────────────────

  it('a switch persists the row, rewrites startup_cmd, and NOTIFIES the runner', async () => {
    const { pane } = await agentTab();
    // Simulate the self-heal rewrite an attached runner performs.
    db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?').run(
      'muxpad agent --resume sid-1',
      pane.id,
    );

    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'do' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as PaneSpec).toMatchObject({ mode: 'do' });

    const row = paneRow(pane.id);
    expect(row.mode).toBe('do');
    // The NEXT respawn gets the real system-prompt overlay…
    expect(row.startup_cmd).toBe('muxpad agent --mode do --resume sid-1');
    // …while the LIVE session only gets a notification frame.
    expect(relayed).toEqual([{ paneId: pane.id, mode: 'do' }]);
  });

  it('does NOT respawn the pane — the conversation survives a mode switch', async () => {
    // A respawn would kill the session, its background subagents and any
    // scheduled wakeups. The proof is that --resume is preserved rather than
    // dropped (the /cwd route, which DOES restart, strips it).
    const { pane } = await agentTab();
    db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?').run(
      'muxpad agent --resume sid-keep',
      pane.id,
    );
    await test.app.request(`/api/panes/${pane.id}`, { method: 'PATCH', ...json({ mode: 'do' }) });
    expect(paneRow(pane.id).startup_cmd).toContain('--resume sid-keep');
  });

  it('switching back to deep strips the flag and notifies again', async () => {
    const { pane } = await agentTab({ mode: 'do' });
    await test.app.request(`/api/panes/${pane.id}`, { method: 'PATCH', ...json({ mode: 'deep' }) });
    expect(paneRow(pane.id)).toMatchObject({ mode: 'deep', startup_cmd: 'muxpad agent' });
    expect(relayed).toEqual([{ paneId: pane.id, mode: 'deep' }]);
  });

  it('re-PATCHing the SAME mode is a no-op — no relay, no command churn', async () => {
    const { pane } = await agentTab({ mode: 'do' });
    const before = paneRow(pane.id).startup_cmd;
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'do' }),
    });
    expect(res.status).toBe(200);
    expect(relayed).toEqual([]);
    expect(paneRow(pane.id).startup_cmd).toBe(before);
  });

  it('repeated switches never accrete flags', async () => {
    const { pane } = await agentTab();
    for (const m of ['do', 'deep', 'do', 'deep', 'do'] as const) {
      await test.app.request(`/api/panes/${pane.id}`, { method: 'PATCH', ...json({ mode: m }) });
    }
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode do');
  });

  it('succeeds with no runner connected — the row is authoritative regardless', async () => {
    const { pane } = await agentTab();
    runnerConnected = false;
    const res = await test.app.request(`/api/panes/${pane.id}`, {
      method: 'PATCH',
      ...json({ mode: 'do' }),
    });
    expect(res.status).toBe(200);
    expect(paneRow(pane.id).mode).toBe('do');
    // Nothing was relayed, but the respawn path is armed.
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode do');
  });

  it('a folder switch keeps the mode (a new project, not a new personality)', async () => {
    const { pane } = await agentTab({ mode: 'do' });
    const res = await test.app.request(`/api/panes/${pane.id}/cwd`, {
      method: 'POST',
      ...json({ cwd: tmp }),
    });
    expect([204, 503]).toContain(res.status); // 503 only if ptyd went away
    expect(paneRow(pane.id).startup_cmd).toBe('muxpad agent --mode do');
  });

  // ── surfacing ───────────────────────────────────────────────────────────

  it('GET /api/panes/:id and the flat list both carry the mode', async () => {
    const { pane } = await agentTab({ mode: 'do' });
    const one = (await (await test.app.request(`/api/panes/${pane.id}`)).json()) as PaneSpec;
    expect(one.mode).toBe('do');
    const all = (await (await test.app.request('/api/panes')).json()) as PaneSpec[];
    expect(all.find((p) => p.id === pane.id)?.mode).toBe('do');
  });
});
