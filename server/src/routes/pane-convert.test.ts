// Converting a chat pane into something else (a raw harness, a terminal, a
// web view). The precondition is ZERO MESSAGES and it is enforced here, on
// the server — the "open instead" strip only decides what to OFFER.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaneSpec, Tab } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentQueueStore } from '../store/AgentQueueStore.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('pane conversion — the zero-message gate', () => {
  let test: TestApp;
  let db: Database.Database;
  let wsId: string;
  let tmp: string;

  let prevDataDir: string | undefined;
  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-convert-'));
    // muxpadLocate resolves <MUXPAD_DATA_DIR>/agent-transcripts — point it at
    // the test dir so a written transcript is actually findable.
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = tmp;
    db = openDb(':memory:');
    test = await createTestApp({ db, dataDir: tmp });
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
    // biome-ignore lint/performance/noDelete: restoring an env var
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  const json = (body: unknown) => ({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  /** A house chat, exactly as the `+` button creates one. */
  async function houseChat() {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, bootstrap: 'agent', backend: 'claude', mode: 'do' }),
      })
    ).json()) as Tab;
    const detail = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as {
      panes: PaneSpec[];
    };
    return { tabId: t.id, pane: detail.panes[0] as PaneSpec };
  }

  const row = (id: string) =>
    db.prepare('SELECT mode, startup_cmd, kind, face FROM panes WHERE id = ?').get(id) as {
      mode: string;
      startup_cmd: string | null;
      kind: string;
      face: string;
    };

  it('the house chat is claude, house overlay, and NO pinned model', async () => {
    const { pane } = await houseChat();
    // A pinned --model would silently override the account default and go
    // stale as models ship; the house chat runs Claude's own default.
    expect(row(pane.id).startup_cmd).toBe('muxpad agent --mode do');
    expect(row(pane.id).startup_cmd).not.toContain('--model');
    expect(pane.mode).toBe('do');
  });

  it('converts an EMPTY house chat to a raw harness with NO overlay', async () => {
    const { pane } = await houseChat();
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'codex', mode: 'deep' }),
    });
    expect(res.status).toBe(204);
    // Raw = the harness as it ships: no --mode flag, and the row says deep.
    expect(row(pane.id)).toMatchObject({
      mode: 'deep',
      startup_cmd: 'muxpad agent --backend codex',
    });
  });

  it('carries the launch card’s FOLDER and MODEL into the spawned session', async () => {
    // The two things the user decides at the moment of picking. Both have to
    // reach the process, not just the UI: the model rides the startup command
    // (which is what a respawn re-runs) and the folder is persisted on the row
    // (which is what a respawn spawns in).
    const { pane } = await houseChat();
    const dir = join(tmp, 'work');
    mkdirSync(dir, { recursive: true });
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'codex', mode: 'deep', cwd: dir, model: 'gpt-5-codex' }),
    });
    expect(res.status).toBe(204);
    expect(row(pane.id).startup_cmd).toBe("muxpad agent --backend codex --model 'gpt-5-codex'");
    expect(
      (db.prepare('SELECT cwd FROM panes WHERE id = ?').get(pane.id) as { cwd: string }).cwd,
    ).toBe(dir);
  });

  it('omitting the model leaves NO --model pin — the harness keeps its own default', async () => {
    const { pane } = await houseChat();
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'claude', mode: 'deep' }),
    });
    expect(res.status).toBe(204);
    expect(row(pane.id).startup_cmd).toBe('muxpad agent');
  });

  it('snaps the chosen folder up to its project root, like every other agent spawn', async () => {
    const { pane } = await houseChat();
    const root = join(tmp, 'repo');
    mkdirSync(join(root, '.git'), { recursive: true });
    const sub = join(root, 'src');
    mkdirSync(sub, { recursive: true });
    await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'claude', mode: 'deep', cwd: sub }),
    });
    expect(
      (db.prepare('SELECT cwd FROM panes WHERE id = ?').get(pane.id) as { cwd: string }).cwd,
    ).toBe(root);
  });

  it('rejects a bad folder or a shell-metacharacter model — with the pane untouched', async () => {
    const { pane } = await houseChat();
    const before = row(pane.id);
    for (const body of [
      { backend: 'claude', cwd: 'relative/path' },
      { backend: 'claude', cwd: join(tmp, 'does-not-exist') },
      // The model is baked into a command that runs through a shell.
      { backend: 'claude', model: 'opus; rm -rf /' },
      { backend: 'claude', model: '$(whoami)' },
    ]) {
      const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
        method: 'POST',
        ...json(body),
      });
      expect(res.status).toBe(400);
    }
    // A refused request must never leave the pane converted, or dead between a
    // kill and a respawn that never happened.
    expect(row(pane.id)).toEqual(before);
  });

  it('accepts a model id with brackets — real ids have them', async () => {
    const { pane } = await houseChat();
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'claude', mode: 'deep', model: 'claude-opus-4-8[1m]' }),
    });
    expect(res.status).toBe(204);
    // Single-quoted so zsh's nomatch cannot glob-error on the brackets.
    expect(row(pane.id).startup_cmd).toBe("muxpad agent --model 'claude-opus-4-8[1m]'");
  });

  it('converts an empty chat to a terminal and to a web view', async () => {
    const a = await houseChat();
    expect(
      (await test.app.request(`/api/panes/${a.pane.id}/as-terminal`, { method: 'POST' })).status,
    ).toBe(204);
    expect(row(a.pane.id)).toMatchObject({ startup_cmd: null, face: 'terminal' });

    const b = await houseChat();
    expect(
      (await test.app.request(`/api/panes/${b.pane.id}/as-web`, { method: 'POST' })).status,
    ).toBe(204);
    expect(row(b.pane.id).kind).toBe('url');
  });

  it('REFUSES once the chat has a queued message, with a human reason', async () => {
    const { pane } = await houseChat();
    new AgentQueueStore(db).enqueue(pane.id, 'do the thing');
    for (const route of ['agent-backend', 'as-terminal', 'as-web']) {
      const res = await test.app.request(`/api/panes/${pane.id}/${route}`, {
        method: 'POST',
        ...json({ backend: 'codex' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; code: string } };
      // Human sentence, not jargon — it renders straight into the UI.
      expect(body.error.message).toBe('this chat already has messages — open a new tab instead');
      // …and a machine code, because the client must tell this 409 apart from
      // the mid-turn one: only THIS one means "your empty view is wrong".
      expect(body.error.code).toBe('has_messages');
    }
    // …and nothing was mutated.
    expect(row(pane.id)).toMatchObject({ startup_cmd: 'muxpad agent --mode do', kind: 'shell' });
  });

  it('a session that merely STARTED is still convertible — starting isn’t speaking', async () => {
    const { pane } = await houseChat();
    // The runner registered and minted a sid, but no message was ever sent
    // (no transcript file). That is the exact state a new tab sits in.
    new AgentSessionStore(db).attachRunner({
      pane_id: pane.id,
      cwd: tmp,
      session_id: '11111111-2222-3333-4444-555555555555',
      assistant: 'claude',
    });
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'cursor', mode: 'deep' }),
    });
    expect(res.status).toBe(204);
  });

  it('REFUSES while a turn is in flight, even with nothing on disk yet', async () => {
    // The transcript-based gate has a hole: the harness only writes records as
    // the turn produces them, so between "user hits send on their phone" and
    // "the first user record lands" the chat is message-free on paper while a
    // real turn runs. The same chat open on a laptop still shows its empty
    // state and its "open instead:" strip — a click there used to kill the
    // runner mid-turn. `agent_sessions.status` is the persisted mirror of the
    // live registry's turnActive; either saying 'running' refuses.
    const { pane } = await houseChat();
    const sessions = new AgentSessionStore(db);
    sessions.attachRunner({
      pane_id: pane.id,
      cwd: tmp,
      session_id: '99999999-2222-3333-4444-555555555555',
      assistant: 'claude',
    });
    sessions.setStatus(pane.id, 'running');
    for (const route of ['agent-backend', 'as-terminal', 'as-web']) {
      const res = await test.app.request(`/api/panes/${pane.id}/${route}`, {
        method: 'POST',
        ...json({ backend: 'codex' }),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { message: string; code: string } };
      expect(body.error.message).toMatch(/mid-turn/);
      // A DIFFERENT code: this chat really is empty, so the client must not
      // conclude it has history and retire the offer for good.
      expect(body.error.code).toBe('mid_turn');
    }
    expect(row(pane.id)).toMatchObject({ startup_cmd: 'muxpad agent --mode do', kind: 'shell' });
    // Once the turn ends, the same conversion is allowed again.
    sessions.setStatus(pane.id, 'idle');
    const ok = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'cursor', mode: 'deep' }),
    });
    expect(ok.status).toBe(204);
  });

  it('REFUSES a chat with a real transcript — a live conversation is never nuked', async () => {
    const { pane } = await houseChat();
    const sid = 'thr-live-1';
    // A codex/cursor session writes the muxpad-normalized log, which
    // muxpadLocate finds under <dataDir>/agent-transcripts.
    const { appendTranscriptEvent } = await import('../chat/TranscriptReader.js');
    appendTranscriptEvent(sid, { kind: 'user', id: 'u1', ts: 1, text: 'hello there' });
    appendTranscriptEvent(sid, { kind: 'assistant', id: 'a1', ts: 2, text: 'hi' });
    new AgentSessionStore(db).attachRunner({
      pane_id: pane.id,
      cwd: tmp,
      session_id: sid,
      assistant: 'codex',
    });
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'cursor', mode: 'deep' }),
    });
    expect(res.status).toBe(409);
    // The pane is untouched — same harness, same overlay.
    expect(row(pane.id).startup_cmd).toBe('muxpad agent --mode do');
  });

  it('refuses a non-agent pane — a terminal you are working in is never converted', async () => {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, name: 'T' }),
      })
    ).json()) as Tab;
    const p = (await (
      await test.app.request(`/api/tabs/${t.id}/panes`, { method: 'POST', ...json({}) })
    ).json()) as PaneSpec;
    const res = await test.app.request(`/api/panes/${p.id}/as-terminal`, { method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: { message: string } }).toMatchObject({
      error: { code: 'not_an_agent', message: 'only an agent chat can be converted' },
    });
  });

  it('a LEGACY --pick pane still converts (the old chooser keeps working)', async () => {
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        ...json({ workspace_id: wsId, bootstrap: 'agent', backend: 'pick' }),
      })
    ).json()) as Tab;
    const detail = (await (await test.app.request(`/api/tabs/${t.id}`)).json()) as {
      panes: PaneSpec[];
    };
    const pane = detail.panes[0] as PaneSpec;
    expect(row(pane.id).startup_cmd).toBe('muxpad agent --pick');
    const res = await test.app.request(`/api/panes/${pane.id}/agent-backend`, {
      method: 'POST',
      ...json({ backend: 'claude' }),
    });
    expect(res.status).toBe(204);
  });
});
