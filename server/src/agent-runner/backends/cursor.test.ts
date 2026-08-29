import type { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { muxpadTranscriptPath } from '../../chat/TranscriptReader.js';
import type { RunnerFrame } from '../protocol.js';
import { createCursorBackend } from './cursor.js';
import type { RunnerHost } from './types.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: () => void;
  killed: boolean;
}
function fakeSpawner() {
  const calls: { args: string[]; child: FakeChild }[] = [];
  const spawn = ((_bin: string, args: string[]) => {
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.killed = false;
    child.kill = () => {
      child.killed = true;
    };
    calls.push({ args: args ?? [], child });
    return child;
  }) as unknown as typeof nodeSpawn;
  return { spawn, calls };
}
const line = (c: FakeChild, obj: unknown) =>
  c.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
const closeChild = (c: FakeChild, code = 0) => c.emit('close', code);
const tick = () => new Promise((r) => setTimeout(r, 0));
const noModels = async () => ({ models: [], defaultModel: null });
function makeHost() {
  const frames: RunnerFrame[] = [];
  const host: RunnerHost = {
    emit: (f) => frames.push(f),
    log: () => {},
    connected: () => true,
    paneId: 'pane-1',
    apiUrl: 'http://localhost',
  };
  return { host, frames };
}
const types = (frames: RunnerFrame[]) => frames.map((f) => f.t);
function readLog(sid: string): ChatEvent[] {
  const p = muxpadTranscriptPath(sid);
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ChatEvent);
}

describe('cursor backend', () => {
  let dataDir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'cursor-'));
    prev = process.env.MUXPAD_DATA_DIR;
    process.env.MUXPAD_DATA_DIR = dataDir;
  });
  afterEach(() => {
    // biome-ignore lint/performance/noDelete: restoring an env var
    if (prev === undefined) delete process.env.MUXPAD_DATA_DIR;
    else process.env.MUXPAD_DATA_DIR = prev;
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function boot(requestedSid: string | null = null) {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCursorBackend(
      host,
      { requestedSid, requestedModel: null },
      { spawn, listModels: noModels },
    );
    b.start();
    await tick();
    closeChild(calls[0]!.child, 0); // auth: `cursor-agent status` exits 0
    await tick();
    return { b, host, frames, calls };
  }

  it('runs a turn: init → assistant(whole) → result(success), adopts session id via re-hello', async () => {
    const { b, frames, calls } = await boot();
    b.send('ping');
    await tick();
    const turn = calls[1]!.child;
    expect(calls[1]!.args.slice(0, 3)).toEqual(['-p', '--output-format', 'stream-json']);
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-1', model: 'Auto' });
    line(turn, {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'ping' }] },
    });
    line(turn, { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } });
    line(turn, { type: 'result', subtype: 'success', is_error: false, result: 'pong' });
    closeChild(turn, 0);
    await tick();
    expect(types(frames)).toEqual(
      expect.arrayContaining(['turn-start', 'stream', 'turn-done', 'status']),
    );
    expect((frames.find((f) => f.t === 'stream') as { delta: string }).delta).toBe('pong');
    expect((frames.find((f) => f.t === 'turn-done') as { ok: boolean }).ok).toBe(true);
    const hello = frames.find((f) => f.t === 'hello') as { sid: string; backend: string };
    expect(hello.sid).toBe('cur-1');
    expect(hello.backend).toBe('cursor');
    // The `user` echo from cursor is ignored (we log our own user event once).
    expect(readLog('cur-1').map((e) => e.kind)).toEqual(['user', 'assistant']);
  });

  it('logs a completed tool_call as tool_use + tool_result', async () => {
    const { b, calls } = await boot();
    b.send('go');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-t' });
    line(turn, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call-1',
      tool_call: {
        shellToolCall: { args: { command: 'ls' }, result: { success: { stdout: 'x\n' } } },
        toolCallId: 'call-1',
        hookAdditionalContexts: [],
      },
    });
    line(turn, { type: 'result', subtype: 'success' });
    closeChild(turn, 0);
    await tick();
    const log = readLog('cur-t');
    expect(log.map((e) => e.kind)).toEqual(['user', 'tool_use', 'tool_result']);
    expect((log[1] as { name: string; toolUseId: string }).name).toBe('shell');
    expect((log[1] as { toolUseId: string }).toolUseId).toBe('call-1');
    expect((log[2] as { ok: boolean; toolUseId: string }).ok).toBe(true);
    expect((log[2] as { toolUseId: string }).toolUseId).toBe('call-1');
  });

  it('emits tool_use on started and pairs the result on completed (stable call_id)', async () => {
    const { b, calls } = await boot();
    b.send('go');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-st' });
    line(turn, {
      type: 'tool_call',
      subtype: 'started',
      call_id: 'call-await-1',
      tool_call: {
        awaitToolCall: { args: { taskId: '9', blockUntilMs: 15000 } },
        toolCallId: 'call-await-1',
      },
    });
    await tick();
    let log = readLog('cur-st');
    expect(log.map((e) => e.kind)).toEqual(['user', 'tool_use']);
    expect((log[1] as { name: string; toolUseId: string }).name).toBe('await');
    expect((log[1] as { toolUseId: string }).toolUseId).toBe('call-await-1');

    line(turn, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'call-await-1',
      tool_call: {
        awaitToolCall: {
          args: { taskId: '9', blockUntilMs: 15000 },
          result: { success: { content: 'matched' } },
        },
        toolCallId: 'call-await-1',
      },
    });
    line(turn, { type: 'result', subtype: 'success' });
    closeChild(turn, 0);
    await tick();
    log = readLog('cur-st');
    expect(log.map((e) => e.kind)).toEqual(['user', 'tool_use', 'tool_result']);
    expect((log[2] as { toolUseId: string; ok: boolean }).toolUseId).toBe('call-await-1');
    expect((log[2] as { ok: boolean }).ok).toBe(true);
  });

  it('ends the turn when cursor-agent goes quiet mid-turn (stall watchdog)', async () => {
    const { b, frames, calls } = await boot();
    b.send('hang');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-hang' });
    line(turn, {
      type: 'tool_call',
      subtype: 'completed',
      call_id: 'c1',
      tool_call: {
        shellToolCall: { args: { command: 'echo' }, result: { success: { stdout: 'ok' } } },
      },
    });
    await tick();
    expect(frames.some((f) => f.t === 'turn-done')).toBe(false);
    // Stall timer was armed under real timers; switch to fake and re-arm via
    // a quiet NDJSON heartbeat so advanceTimers drives the watchdog.
    vi.useFakeTimers();
    try {
      turn.stdout.emit('data', Buffer.from('\n'));
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      const done = frames.find((f) => f.t === 'turn-done') as { ok: boolean; error?: string };
      expect(done).toBeTruthy();
      expect(done.ok).toBe(false);
      expect(done.error).toMatch(/stopped responding/i);
      expect(turn.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a failed result closes the turn as not-ok', async () => {
    const { b, frames, calls } = await boot();
    b.send('go');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-f' });
    line(turn, { type: 'result', subtype: 'error', is_error: true, result: 'boom' });
    closeChild(turn, 0);
    await tick();
    const done = frames.find((f) => f.t === 'turn-done') as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(done.error).toBe('boom');
  });

  it('surfaces a logged-out backend as a clear turn-done', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCursorBackend(
      host,
      { requestedSid: null, requestedModel: null },
      { spawn, listModels: noModels },
    );
    b.start();
    await tick();
    closeChild(calls[0]!.child, 1);
    await tick();
    b.send('hi');
    await tick();
    closeChild(calls[1]!.child, 1);
    await tick();
    const done = frames.find((f) => f.t === 'turn-done') as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/not logged in/i);
  });

  it('falls back to a fresh session when resume exits before init (cloud session gone)', async () => {
    const { b, calls } = await boot('stale-cloud-id');
    b.send('hi');
    await tick();
    expect(calls[1]!.args).toContain('--resume');
    expect(calls[1]!.args).toContain('stale-cloud-id');
    // Sandbox off, or network commands (curl/git/gh) block and the turn hangs.
    expect(calls[1]!.args.join(' ')).toContain('--sandbox disabled');
    closeChild(calls[1]!.child, 1);
    await tick();
    expect(calls[2]!.args).not.toContain('--resume');
    const fresh = calls[2]!.child;
    line(fresh, { type: 'system', subtype: 'init', session_id: 'cur-new' });
    line(fresh, { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    line(fresh, { type: 'result', subtype: 'success' });
    closeChild(fresh, 0);
    await tick();
    expect(readLog('cur-new').map((e) => e.kind)).toEqual(['user', 'assistant']);
  });

  it('stop kills the child and closes the turn CLEANLY (ok:true, mirrors Claude)', async () => {
    const { b, frames, calls } = await boot();
    b.send('long');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-s' });
    b.stop();
    expect(turn.killed).toBe(true);
    closeChild(turn, 143);
    await tick();
    const done = frames.filter((f) => f.t === 'turn-done').at(-1) as {
      ok: boolean;
      error?: string;
    };
    expect(done.ok).toBe(true);
    expect(done.error).toBeUndefined();
  });

  it('two sends racing the auth check spawn exactly ONE turn child', async () => {
    const { host } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCursorBackend(
      host,
      { requestedSid: null, requestedModel: null },
      {
        spawn,
        listModels: noModels,
      },
    );
    b.start();
    b.send('a');
    b.send('b');
    await tick();
    // Resolve every pending `cursor-agent status` (boot's + the turn's).
    for (const c of calls) if (c.args[0] === 'status') closeChild(c.child, 0);
    await tick();
    const turnSpawns = calls.filter((c) => c.args[0] === '-p');
    expect(turnSpawns.length).toBe(1);
  });

  it('migrates prior history to a fresh session id on resume-fallback', async () => {
    const { b, calls } = await boot('old-cloud');
    const { appendTranscriptEvent } = await import('../../chat/TranscriptReader.js');
    appendTranscriptEvent('old-cloud', { kind: 'user', id: 'p1', ts: 1, text: 'earlier q' });
    appendTranscriptEvent('old-cloud', { kind: 'assistant', id: 'p2', ts: 2, text: 'earlier a' });
    b.send('next');
    await tick();
    closeChild(calls[1]!.child, 1); // resume fails → fresh
    await tick();
    const fresh = calls[2]!.child;
    line(fresh, { type: 'system', subtype: 'init', session_id: 'cur-fresh' });
    line(fresh, { type: 'assistant', message: { content: [{ type: 'text', text: 'new a' }] } });
    line(fresh, { type: 'result', subtype: 'success' });
    closeChild(fresh, 0);
    await tick();
    expect(readLog('cur-fresh').map((e) => (e as { text?: string }).text)).toEqual([
      'earlier q',
      'earlier a',
      'next',
      'new a',
    ]);
    expect(readLog('old-cloud')).toEqual([]);
  });

  it('prepends muxpad instructions to the FIRST message of a NEW session only', async () => {
    writeFileSync(join(dataDir, 'agent-instructions.md'), 'use muxpad publish\n');
    const { b, calls } = await boot();
    b.send('hi');
    await tick();
    // Fresh session → delimited instructions ride the prompt arg…
    expect(calls[1]!.args.at(-1)).toBe(
      '<muxpad-instructions>\nuse muxpad publish\n</muxpad-instructions>\n\nhi',
    );
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-instr' });
    line(turn, { type: 'result', subtype: 'success' });
    closeChild(turn, 0);
    await tick();
    // …but the muxpad transcript records the RAW prompt (chat stays clean).
    expect((readLog('cur-instr')[0] as { text: string }).text).toBe('hi');
    // The next turn RESUMES the session → no re-injection.
    b.send('again');
    await tick();
    expect(calls[2]!.args).toContain('--resume');
    expect(calls[2]!.args.at(-1)).toBe('again');
  });

  it('missing instructions file → raw prompt, no error', async () => {
    const { b, calls } = await boot();
    b.send('plain');
    await tick();
    expect(calls[1]!.args.at(-1)).toBe('plain');
  });

  it('advertises its model list + default in the status frame (the picker)', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCursorBackend(
      host,
      { requestedSid: null, requestedModel: null },
      {
        spawn,
        listModels: async () => ({
          models: [
            { value: 'auto', displayName: 'Auto' },
            { value: 'composer-2.5', displayName: 'Composer 2.5' },
          ],
          defaultModel: 'auto',
        }),
      },
    );
    b.start();
    await tick();
    closeChild(calls[0]!.child, 0);
    await tick();
    const status = frames.find((f) => f.t === 'status') as {
      model: string;
      models?: Array<{ value: string }>;
    };
    expect(status.model).toBe('auto');
    expect(status.models?.map((m) => m.value)).toEqual(['auto', 'composer-2.5']);
  });
});
