import { EventEmitter } from 'node:events';
import type { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { muxpadTranscriptPath } from '../../chat/TranscriptReader.js';
import type { RunnerFrame } from '../protocol.js';
import type { RunnerHost } from './types.js';
import { createCursorBackend } from './cursor.js';

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
const line = (c: FakeChild, obj: unknown) => c.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
const closeChild = (c: FakeChild, code = 0) => c.emit('close', code);
const tick = () => new Promise((r) => setTimeout(r, 0));
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
    const b = createCursorBackend(host, { requestedSid, requestedModel: null }, { spawn });
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
    line(turn, { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'ping' }] } });
    line(turn, { type: 'assistant', message: { content: [{ type: 'text', text: 'pong' }] } });
    line(turn, { type: 'result', subtype: 'success', is_error: false, result: 'pong' });
    closeChild(turn, 0);
    await tick();
    expect(types(frames)).toEqual(expect.arrayContaining(['turn-start', 'stream', 'turn-done', 'status']));
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
      tool_call: { shellToolCall: { args: { command: 'ls' }, result: { success: { stdout: 'x\n' } } } },
    });
    line(turn, { type: 'result', subtype: 'success' });
    closeChild(turn, 0);
    await tick();
    const log = readLog('cur-t');
    expect(log.map((e) => e.kind)).toEqual(['user', 'tool_use', 'tool_result']);
    expect((log[1] as { name: string }).name).toBe('shell');
    expect((log[2] as { ok: boolean }).ok).toBe(true);
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
    const b = createCursorBackend(host, { requestedSid: null, requestedModel: null }, { spawn });
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

  it('stop kills the child and closes the turn as not-ok', async () => {
    const { b, frames, calls } = await boot();
    b.send('long');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'system', subtype: 'init', session_id: 'cur-s' });
    b.stop();
    expect(turn.killed).toBe(true);
    closeChild(turn, 143);
    await tick();
    const done = frames.filter((f) => f.t === 'turn-done').at(-1) as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(done.error).toBe('stopped');
  });
});
