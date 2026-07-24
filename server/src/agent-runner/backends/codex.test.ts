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
import { createCodexBackend } from './codex.js';

// ── fake spawn ──────────────────────────────────────────────────────────────
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

describe('codex backend', () => {
  let dataDir: string;
  let prev: string | undefined;
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'codex-'));
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
    const b = createCodexBackend(host, { requestedSid, requestedModel: null }, { spawn, listModels: noModels });
    b.start();
    await tick();
    closeChild(calls[0]!.child, 0); // auth: `codex login status` exits 0
    await tick();
    return { b, host, frames, calls };
  }

  it('runs a turn: turn-start → stream(whole message) → turn-done + status(no context)', async () => {
    const { b, frames, calls } = await boot();
    b.send('hi');
    await tick();
    const turn = calls[1]!.child;
    expect(calls[1]!.args.slice(0, 2)).toEqual(['exec', '--json']); // fresh, no resume
    line(turn, { type: 'thread.started', thread_id: 'thr-1' });
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'hello world' } });
    line(turn, { type: 'turn.completed', usage: { output_tokens: 2 } });
    closeChild(turn, 0);
    await tick();
    expect(types(frames)).toEqual(
      expect.arrayContaining(['turn-start', 'hello', 'stream', 'turn-done', 'status']),
    );
    const stream = frames.find((f) => f.t === 'stream') as { delta: string };
    expect(stream.delta).toBe('hello world');
    const done = frames.find((f) => f.t === 'turn-done') as { ok: boolean };
    expect(done.ok).toBe(true);
    const status = frames.find((f) => f.t === 'status') as { context?: unknown };
    expect(status.context).toBeUndefined();
  });

  it('adopts the real thread id (re-hello) and lands [user, assistant] under it', async () => {
    const { b, frames, calls } = await boot();
    b.send('the prompt');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'thread.started', thread_id: 'thr-XYZ' });
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'answer' } });
    line(turn, { type: 'turn.completed' });
    closeChild(turn, 0);
    await tick();
    const hello = frames.find((f) => f.t === 'hello') as { sid: string; backend: string };
    expect(hello.sid).toBe('thr-XYZ');
    expect(hello.backend).toBe('codex');
    const log = readLog('thr-XYZ');
    expect(log.map((e) => e.kind)).toEqual(['user', 'assistant']);
    expect((log[0] as { text: string }).text).toBe('the prompt');
    expect((log[1] as { text: string }).text).toBe('answer');
  });

  it('logs command_execution as tool_use + tool_result', async () => {
    const { b, calls } = await boot();
    b.send('run it');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'thread.started', thread_id: 'thr-c' });
    line(turn, {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls', aggregated_output: 'a\nb\n', exit_code: 0 },
    });
    line(turn, { type: 'turn.completed' });
    closeChild(turn, 0);
    await tick();
    const log = readLog('thr-c');
    expect(log.map((e) => e.kind)).toEqual(['user', 'tool_use', 'tool_result']);
    expect((log[1] as { name: string }).name).toBe('shell');
    expect((log[2] as { ok: boolean; text?: string }).ok).toBe(true);
  });

  it('surfaces a logged-out backend as a clear turn-done, not a crash-loop', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(host, { requestedSid: null, requestedModel: null }, { spawn, listModels: noModels });
    b.start();
    await tick();
    closeChild(calls[0]!.child, 1); // auth FAILS at boot
    await tick();
    b.send('hi');
    await tick();
    closeChild(calls[1]!.child, 1); // the lazy re-check on send also fails
    await tick();
    const done = frames.find((f) => f.t === 'turn-done') as { ok: boolean; error?: string };
    expect(done.ok).toBe(false);
    expect(done.error).toMatch(/not logged in/i);
    // No turn child was ever spawned (only the two auth checks).
    expect(calls.every((c) => c.args.includes('login'))).toBe(true);
  });

  it('falls back to a fresh thread when resume exits before any event', async () => {
    const { b, calls } = await boot('stale-ref');
    b.send('hi');
    await tick();
    // First spawn attempts resume of the stale ref.
    expect(calls[1]!.args.slice(0, 3)).toEqual(['exec', 'resume', 'stale-ref']);
    closeChild(calls[1]!.child, 1); // fails with no thread.started
    await tick();
    // Second spawn is a FRESH exec (no resume).
    expect(calls[2]!.args.slice(0, 2)).toEqual(['exec', '--json']);
    const fresh = calls[2]!.child;
    line(fresh, { type: 'thread.started', thread_id: 'thr-new' });
    line(fresh, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
    line(fresh, { type: 'turn.completed' });
    closeChild(fresh, 0);
    await tick();
    expect(readLog('thr-new').map((e) => e.kind)).toEqual(['user', 'assistant']);
  });

  it('stop kills the child and closes the turn CLEANLY (ok:true, mirrors Claude)', async () => {
    const { b, frames, calls } = await boot();
    b.send('long task');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'thread.started', thread_id: 'thr-s' });
    b.stop();
    expect(turn.killed).toBe(true);
    closeChild(turn, 143); // killed
    await tick();
    const done = frames.filter((f) => f.t === 'turn-done').at(-1) as { ok: boolean; error?: string };
    expect(done.ok).toBe(true); // a deliberate Stop is not a red error
    expect(done.error).toBeUndefined();
  });

  it('two sends racing the auth check spawn exactly ONE turn child', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(host, { requestedSid: null, requestedModel: null }, {
      spawn,
      listModels: noModels,
    });
    b.start();
    // Two sends arrive BEFORE the boot auth-check resolves.
    b.send('a');
    b.send('b');
    await tick();
    // Resolve every pending `codex login status` (boot's + the turn's).
    for (const c of calls) if (c.args.includes('login')) closeChild(c.child, 0);
    await tick();
    const turnSpawns = calls.filter((c) => c.args[0] === 'exec');
    expect(turnSpawns.length).toBe(1); // NOT two children for one session
  });

  it('migrates prior history to a fresh thread id on resume-fallback (no orphan)', async () => {
    const { b, calls } = await boot('old-thread');
    // Seed a prior conversation under the stale resume id.
    const { appendTranscriptEvent } = await import('../../chat/TranscriptReader.js');
    appendTranscriptEvent('old-thread', { kind: 'user', id: 'p1', ts: 1, text: 'earlier question' });
    appendTranscriptEvent('old-thread', { kind: 'assistant', id: 'p2', ts: 2, text: 'earlier answer' });
    b.send('next');
    await tick();
    closeChild(calls[1]!.child, 1); // resume fails → fresh fallback
    await tick();
    const fresh = calls[2]!.child;
    line(fresh, { type: 'thread.started', thread_id: 'thr-fresh' });
    line(fresh, { type: 'item.completed', item: { type: 'agent_message', text: 'new answer' } });
    line(fresh, { type: 'turn.completed' });
    closeChild(fresh, 0);
    await tick();
    // The new id's log carries the OLD conversation + the new turn.
    expect(readLog('thr-fresh').map((e) => (e as { text?: string }).text)).toEqual([
      'earlier question',
      'earlier answer',
      'next',
      'new answer',
    ]);
    expect(readLog('old-thread')).toEqual([]); // old file migrated away
  });

  it('advertises its model list + default in the status frame (the picker)', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(host, { requestedSid: null, requestedModel: null }, {
      spawn,
      listModels: async () => ({
        models: [
          { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
          { value: 'gpt-5.5', displayName: 'GPT-5.5' },
        ],
        defaultModel: 'gpt-5.6-sol',
      }),
    });
    b.start();
    await tick();
    closeChild(calls[0]!.child, 0);
    await tick();
    const status = frames.find((f) => f.t === 'status') as {
      model: string;
      models?: Array<{ value: string }>;
    };
    expect(status.model).toBe('gpt-5.6-sol'); // highlights the current row
    expect(status.models?.map((m) => m.value)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
  });
});
