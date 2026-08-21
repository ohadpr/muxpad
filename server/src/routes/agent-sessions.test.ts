import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../store/db.js';
import { type TestApp, createTestApp } from '../test-helpers/createTestApp.js';

describe('agent-sessions transcript route', () => {
  let test: TestApp;
  let tmp: string;
  let tabId: string;
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-transcript-'));
    // muxpadTranscriptDir() resolves through MUXPAD_DATA_DIR at call time, so
    // pointing it at the test tmp dir scopes the normalized logs here.
    prevDataDir = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = tmp;
    test = await createTestApp({ db: openDb(':memory:'), dataDir: tmp });
    const ws = (await (
      await test.app.request('/api/workspaces', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'W' }),
      })
    ).json()) as { id: string };
    const t = (await (
      await test.app.request('/api/tabs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'T', workspace_id: ws.id }),
      })
    ).json()) as { id: string };
    tabId = t.id;
  });

  afterEach(async () => {
    // biome-ignore lint/performance/noDelete: restoring an env var that wasn't set
    if (prevDataDir === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prevDataDir;
    await test.cleanup();
    rmSync(tmp, { recursive: true, force: true });
  });

  // agent_sessions rows FK onto panes, so mint a real pane per session.
  const createPane = async () =>
    (
      (await (
        await test.app.request(`/api/tabs/${tabId}/panes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ shell: '/bin/sh' }),
        })
      ).json()) as { id: string }
    ).id;

  const register = async (sid?: string): Promise<string> => {
    const paneId = await createPane();
    const res = await test.app.request('/api/agent-sessions/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pane_id: paneId,
        assistant: 'codex',
        ...(sid ? { session_id: sid } : {}),
      }),
    });
    expect(res.status).toBe(201);
    return paneId;
  };

  const writeLog = (sid: string, events: unknown[]) => {
    const dir = join(tmp, 'agent-transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
    );
  };

  it('returns the last N normalized events as JSONL', async () => {
    const sid = 'sid-transcript-a';
    const paneId = await register(sid);
    writeLog(sid, [
      { kind: 'user', id: 'e1', text: 'first' },
      { kind: 'assistant', id: 'e2', text: 'second' },
      { kind: 'user', id: 'e3', text: 'third' },
    ]);
    const res = await test.app.request(`/api/agent-sessions/${paneId}/transcript?tail=2`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n');
    expect(lines).toHaveLength(2);
    const events = lines.map((l) => JSON.parse(l) as { id: string; text: string });
    expect(events.map((e) => e.id)).toEqual(['e2', 'e3']);
  });

  it('defaults tail and skips garbage lines', async () => {
    const sid = 'sid-transcript-b';
    const paneId = await register(sid);
    const dir = join(tmp, 'agent-transcripts');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, `${sid}.jsonl`),
      `${JSON.stringify({ kind: 'user', id: 'ok', text: 'hi' })}\nnot json at all\n`,
    );
    const res = await test.app.request(`/api/agent-sessions/${paneId}/transcript`);
    expect(res.status).toBe(200);
    const lines = (await res.text()).trim().split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] as string) as { id: string }).id).toBe('ok');
  });

  it('404s for an unknown pane, a sid-less session, and a missing file', async () => {
    expect((await test.app.request('/api/agent-sessions/nope/transcript')).status).toBe(404);
    const noSid = await register(); // no session_id → no sid
    expect((await test.app.request(`/api/agent-sessions/${noSid}/transcript`)).status).toBe(404);
    const noFile = await register('sid-without-file');
    expect((await test.app.request(`/api/agent-sessions/${noFile}/transcript`)).status).toBe(404);
  });
});
