import type { spawn as nodeSpawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatEvent } from '@muxpad/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { muxpadTranscriptPath } from '../../chat/TranscriptReader.js';
import type { RunnerFrame } from '../protocol.js';
import { codexErrorText, createCodexBackend } from './codex.js';
import type { RunnerHost } from './types.js';

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
const line = (c: FakeChild, obj: unknown) =>
  c.stdout.emit('data', Buffer.from(`${JSON.stringify(obj)}\n`));
const closeChild = (c: FakeChild, code = 0) => c.emit('close', code);
const tick = () => new Promise((r) => setTimeout(r, 0));
const noModels = async () => ({ models: [], defaultModel: null });

function makeHost() {
  const frames: RunnerFrame[] = [];
  // The pane's terminal face. Kept, not discarded: a backend that DECLINES to
  // do something (chat mode, which is Claude-only) has the log as its only way
  // to say so, and "it announced the collapse" is the assertion.
  const logs: string[] = [];
  const host: RunnerHost = {
    emit: (f) => frames.push(f),
    log: (l) => void logs.push(l),
    connected: () => true,
    paneId: 'pane-1',
    apiUrl: 'http://localhost',
  };
  return { host, frames, logs };
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
    const { host, frames, logs } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(
      host,
      { requestedSid, requestedModel: null, mode: 'agent' },
      { spawn, listModels: noModels },
    );
    b.start();
    await tick();
    closeChild(calls[0]!.child, 0); // auth: `codex login status` exits 0
    await tick();
    return { b, host, frames, logs, calls };
  }

  it('runs a turn: turn-start → stream(whole message) → turn-done + status(no context)', async () => {
    const { b, frames, calls } = await boot();
    b.send('hi');
    await tick();
    const turn = calls[1]!.child;
    expect(calls[1]!.args.slice(0, 2)).toEqual(['exec', '--json']); // fresh, no resume
    // Network must be enabled or git/gh/fetch hang under workspace-write.
    expect(calls[1]!.args).toContain('sandbox_workspace_write.network_access=true');
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

  it('reports the last answer before completion and never repeats it on a silent turn', async () => {
    const { b, frames, calls } = await boot();
    b.send('review');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'Checking now' } });
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'ACCEPT' } });
    line(turn, { type: 'turn.completed' });
    closeChild(turn);
    await tick();
    expect(frames.filter((frame) => frame.t === 'report')).toEqual([
      { t: 'report', text: 'ACCEPT' },
    ]);
    expect(types(frames).indexOf('report')).toBeLessThan(types(frames).indexOf('turn-done'));
    b.send('second job');
    await tick();
    line(calls[2]!.child, { type: 'turn.completed' });
    closeChild(calls[2]!.child);
    await tick();
    expect(frames.filter((frame) => frame.t === 'report')).toHaveLength(1);
  });

  it('does not report unfinished commentary when the turn fails', async () => {
    const { b, frames, calls } = await boot();
    b.send('review');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'Checking now' } });
    line(turn, { type: 'turn.failed', error: 'interrupted' });
    closeChild(turn, 1);
    await tick();
    expect(frames.filter((frame) => frame.t === 'report')).toEqual([]);
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
    const b = createCodexBackend(
      host,
      { requestedSid: null, requestedModel: null, mode: 'agent' },
      { spawn, listModels: noModels },
    );
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
    const done = frames.filter((f) => f.t === 'turn-done').at(-1) as {
      ok: boolean;
      error?: string;
    };
    expect(done.ok).toBe(true); // a deliberate Stop is not a red error
    expect(done.error).toBeUndefined();
  });

  it('two sends racing the auth check spawn exactly ONE turn child', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(
      host,
      { requestedSid: null, requestedModel: null, mode: 'agent' },
      {
        spawn,
        listModels: noModels,
      },
    );
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
    appendTranscriptEvent('old-thread', {
      kind: 'user',
      id: 'p1',
      ts: 1,
      text: 'earlier question',
    });
    appendTranscriptEvent('old-thread', {
      kind: 'assistant',
      id: 'p2',
      ts: 2,
      text: 'earlier answer',
    });
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

  it('prepends the full instructions to a NEW session, and the standing rules to every turn after', async () => {
    writeFileSync(join(dataDir, 'agent-instructions.md'), 'use muxpad publish\n');
    const { b, calls } = await boot();
    b.send('hi');
    await tick();
    // Fresh session → delimited instructions ride the prompt arg…
    expect(calls[1]!.args.at(-1)).toBe(
      '<muxpad-instructions>\nuse muxpad publish\n</muxpad-instructions>\n\nhi',
    );
    const turn = calls[1]!.child;
    line(turn, { type: 'thread.started', thread_id: 'thr-instr' });
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'ok' } });
    line(turn, { type: 'turn.completed' });
    closeChild(turn, 0);
    await tick();
    // …but the muxpad transcript records the RAW prompt (chat stays clean).
    expect((readLog('thr-instr')[0] as { text: string }).text).toBe('hi');
    // ── A RESUME RE-ASSERTS THE NON-NEGOTIABLES ──────────────────────────
    // It used to send the bare prompt, on the reasoning that "a resume
    // already carries it in-thread". That is true on day one and false ever
    // after: the block is a MESSAGE, and a message is summarised and
    // compacted away. Measured on a four-day-old pane — 2,392 turns, zero
    // occurrences of any muxpad rule — which then DM'd a colleague on Slack
    // as a bot, unapproved, from a token on disk.
    b.send('again');
    await tick();
    expect(calls[2]!.args.slice(0, 3)).toEqual(['exec', 'resume', 'thr-instr']);
    const resumed = calls[2]!.args.at(-1) as string;
    expect(resumed.endsWith('again')).toBe(true);
    expect(resumed).toContain('muxpad slack post');
    // …and NOT the whole 33 KB document, which would pay for the rules in the
    // context pressure that lost them.
    expect(resumed).not.toContain('use muxpad publish');
  });

  it('missing instructions file → the standing rules alone, no error', async () => {
    // No document to read is not a reason to send NOTHING: the file is
    // generated at boot and can be absent, empty or unreadable, and the card
    // is compiled in. A rule-less fresh session is the exact state the Slack
    // DM was sent from.
    const { b, calls } = await boot();
    b.send('plain');
    await tick();
    const sent = calls[1]!.args.at(-1) as string;
    expect(sent).toContain('muxpad slack post');
    expect(sent.endsWith('plain')).toBe(true);
  });

  it('gives the full document to the FIRST turn after a pane start, resume or not', async () => {
    // The test the original bug would have failed. A runner that boots with a
    // session id has no idea whether that session still carries the document
    // — a server restart, a respawn, or codex's own compaction all look the
    // same from here, and `cursor-agent --resume <unknown>` silently opens a
    // new session rather than failing. So the document rides the first turn
    // of the PROCESS, and the card every turn after.
    writeFileSync(join(dataDir, 'agent-instructions.md'), 'use muxpad publish\n');
    const { b, calls } = await boot('thr-old');
    b.send('after a restart');
    await tick();
    expect(calls[1]!.args.slice(0, 3)).toEqual(['exec', 'resume', 'thr-old']);
    const first = calls[1]!.args.at(-1) as string;
    expect(first).toContain('use muxpad publish');
    expect(first.endsWith('after a restart')).toBe(true);
    const turn = calls[1]!.child;
    line(turn, { type: 'thread.started', thread_id: 'thr-old' });
    line(turn, { type: 'turn.completed' });
    closeChild(turn, 0);
    await tick();
    b.send('and again');
    await tick();
    const second = calls[2]!.args.at(-1) as string;
    expect(second).not.toContain('use muxpad publish');
    expect(second).toContain('muxpad slack post');
  });

  // ── Chat mode ───────────────────────────────────────────────────────────
  // There isn't one here. Chat IS Claude (modeForBackend): the mode is built
  // on the in-process `reply` tool and codex has no in-process tool surface.
  // What these pin is the COLLAPSE — a chat-mode request produces an ordinary
  // Agent-mode session and says so in the pane log, rather than a half-mode
  // wearing a "Chat" chip.

  async function bootMode(mode: 'chat' | 'agent', requestedSid: string | null = null) {
    const { host, frames, logs } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(
      host,
      { requestedSid, requestedModel: null, mode },
      { spawn, listModels: noModels },
    );
    b.start();
    await tick();
    closeChild(calls[0]!.child, 0);
    await tick();
    return { b, host, frames, logs, calls };
  }

  it('a chat-mode request is collapsed to Agent mode — no overlay, and it says so', async () => {
    // Chat IS Claude (modeForBackend): Chat mode is built on the in-process
    // `reply` tool and `codex exec` has no in-process tool surface at all. A
    // row or a hand-typed startup command can still ask for it; the runner
    // announces the collapse in the pane's own log instead of injecting a
    // contract the harness cannot honour.
    writeFileSync(join(dataDir, 'agent-instructions.md'), 'use muxpad publish\n');
    writeFileSync(join(dataDir, 'chat-mode.md'), 'be terse\n');
    const { b, calls, logs } = await bootMode('chat');
    b.send('hi');
    await tick();
    expect(calls[1]!.args.at(-1)).toBe(
      '<muxpad-instructions>\nuse muxpad publish\n</muxpad-instructions>\n\nhi',
    );
    expect(logs.some((l) => /Claude-only/i.test(l))).toBe(true);
  });

  it('deep mode injects NOTHING extra — byte-identical to the pre-mode prompt', async () => {
    writeFileSync(join(dataDir, 'agent-instructions.md'), 'use muxpad publish\n');
    writeFileSync(join(dataDir, 'chat-mode.md'), 'be terse\n');
    const { b, calls } = await bootMode('agent');
    b.send('hi');
    await tick();
    expect(calls[1]!.args.at(-1)).toBe(
      '<muxpad-instructions>\nuse muxpad publish\n</muxpad-instructions>\n\nhi',
    );
  });

  it('chat mode with no chat-mode.md → nothing injected, no error', async () => {
    const { b, calls } = await bootMode('chat');
    b.send('hi');
    await tick();
    // The standing rules still ride along (preamble.ts) — what must be absent
    // is a <muxpad-mode> block, because there is no overlay to deliver.
    const sent = calls[1]!.args.at(-1) as string;
    expect(sent).not.toContain('<muxpad-mode>');
    expect(sent.endsWith('hi')).toBe(true);
  });

  it('a mid-session switch to Chat changes NOTHING about the prompt', async () => {
    // There is no contract to announce: this session is Agent mode and stays
    // Agent mode. The old in-band <muxpad-mode> note is retired with the
    // overlay it used to carry.
    writeFileSync(join(dataDir, 'chat-mode.md'), 'be terse\n');
    const { b, calls, logs } = await bootMode('agent');
    b.send('first');
    await tick();
    const t1 = calls[1]!.child;
    line(t1, { type: 'thread.started', thread_id: 'thr-mode' });
    line(t1, { type: 'turn.completed' });
    closeChild(t1, 0);
    await tick();

    b.setMode('chat');
    b.send('second');
    await tick();
    expect(calls[2]!.args.slice(0, 3)).toEqual(['exec', 'resume', 'thr-mode']);
    // The PROMPT is the message plus muxpad's standing rules (preamble.ts)
    // and nothing else: no <muxpad-mode> note, which is what this test is
    // about. Asserting an exact string here made it a test of two things,
    // and the second one changed.
    const sent = calls[2]!.args.at(-1) as string;
    expect(sent.endsWith('second')).toBe(true);
    expect(sent).not.toContain('<muxpad-mode>');
    expect(sent).not.toContain('be terse');
    expect(logs.some((l) => /Claude-only/i.test(l))).toBe(true);
  });

  it('re-setting the SAME mode is a no-op (no spurious note)', async () => {
    writeFileSync(join(dataDir, 'chat-mode.md'), 'be terse\n');
    const { b, calls } = await bootMode('agent');
    b.send('first');
    await tick();
    const t1 = calls[1]!.child;
    line(t1, { type: 'thread.started', thread_id: 'thr-same' });
    line(t1, { type: 'turn.completed' });
    closeChild(t1, 0);
    await tick();
    b.setMode('agent'); // already agent — the server sends this on every hello
    b.send('second');
    await tick();
    // The PROMPT is the message plus muxpad's standing rules (preamble.ts)
    // and nothing else: no <muxpad-mode> note, which is what this test is
    // about. Asserting an exact string here made it a test of two things,
    // and the second one changed.
    const sent = calls[2]!.args.at(-1) as string;
    expect(sent.endsWith('second')).toBe(true);
    expect(sent).not.toContain('<muxpad-mode>');
    expect(sent).not.toContain('be terse');
  });

  it('switching to Agent mode is a no-op — there was never anything to revoke', async () => {
    const { b, calls } = await bootMode('chat');
    b.send('first');
    await tick();
    const t1 = calls[1]!.child;
    line(t1, { type: 'thread.started', thread_id: 'thr-rev' });
    line(t1, { type: 'turn.completed' });
    closeChild(t1, 0);
    await tick();
    b.setMode('agent');
    b.send('second');
    await tick();
    // The PROMPT is the message plus muxpad's standing rules (preamble.ts)
    // and nothing else: no <muxpad-mode> note, which is what this test is
    // about. Asserting an exact string here made it a test of two things,
    // and the second one changed.
    const sent = calls[2]!.args.at(-1) as string;
    expect(sent.endsWith('second')).toBe(true);
    expect(sent).not.toContain('<muxpad-mode>');
    expect(sent).not.toContain('be terse');
  });

  it('advertises its model list + default in the status frame (the picker)', async () => {
    const { host, frames } = makeHost();
    const { spawn, calls } = fakeSpawner();
    const b = createCodexBackend(
      host,
      { requestedSid: null, requestedModel: null, mode: 'agent' },
      {
        spawn,
        listModels: async () => ({
          models: [
            { value: 'gpt-5.6-sol', displayName: 'GPT-5.6-Sol' },
            { value: 'gpt-5.5', displayName: 'GPT-5.5' },
          ],
          defaultModel: 'gpt-5.6-sol',
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
    expect(status.model).toBe('gpt-5.6-sol'); // highlights the current row
    expect(status.models?.map((m) => m.value)).toEqual(['gpt-5.6-sol', 'gpt-5.5']);
  });

  /**
   * TWO MESSAGES IN ONE TURN, AND THE BLANK LINE BETWEEN THEM.
   *
   * Codex has no token deltas, so each whole `agent_message` goes out twice: a
   * `stream` delta for the live view and a transcript event for history. The
   * client removes the landed copy from the preview by joining the landed
   * blocks and subtracting them (ChatPane's `consumeStreamedText`), and that
   * join is tried with the '\n\n' separator claude.ts emits between blocks.
   *
   * Codex emitted none, so a turn that spoke, ran a tool and spoke again left
   * a preview the subtraction could not line up, and the turn's prose drew a
   * SECOND time under the committed messages. Reported from a real codex chat
   * as "duplication of messages", with the stored transcript provably single —
   * one id per sentence, nothing repeated on disk.
   */
  it('separates two agent messages with a blank line, none before the first', async () => {
    const { b, calls, frames } = await boot();
    b.send('go');
    await tick();
    const turn = calls[1]!.child;
    line(turn, { type: 'thread.started', thread_id: 'thr-2' });
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'first' } });
    line(turn, {
      type: 'item.completed',
      item: { type: 'command_execution', command: 'ls', exit_code: 0, aggregated_output: '' },
    });
    line(turn, { type: 'item.completed', item: { type: 'agent_message', text: 'second' } });
    line(turn, { type: 'turn.completed' });
    closeChild(turn, 0);
    await tick();
    const deltas = frames
      .filter((f) => f.t === 'stream')
      .map((f) => (f as { t: 'stream'; delta: string }).delta);
    // The buffer the client accumulates is these concatenated…
    expect(deltas.join('')).toBe('first\n\nsecond');
    // …which is exactly `landed.join('\n\n')` for the two transcript events,
    // so the subtraction lines up and nothing draws twice.
    expect(['first', 'second'].join('\n\n')).toBe(deltas.join(''));
  });

  it('starts a NEW turn with no leading blank line', async () => {
    // The flag is per TURN, not per process: a later turn's first message must
    // not open with a paragraph break around nothing.
    const { b, calls, frames } = await boot();
    b.send('one');
    await tick();
    const t1 = calls[1]!.child;
    line(t1, { type: 'thread.started', thread_id: 'thr-3' });
    line(t1, { type: 'item.completed', item: { type: 'agent_message', text: 'a' } });
    line(t1, { type: 'turn.completed' });
    closeChild(t1, 0);
    await tick();
    frames.length = 0;
    b.send('two');
    await tick();
    const t2 = calls[calls.length - 1]!.child;
    line(t2, { type: 'item.completed', item: { type: 'agent_message', text: 'b' } });
    line(t2, { type: 'turn.completed' });
    closeChild(t2, 0);
    await tick();
    const deltas = frames
      .filter((f) => f.t === 'stream')
      .map((f) => (f as { t: 'stream'; delta: string }).delta);
    expect(deltas.join('')).toBe('b');
  });
  /**
   * THE FAILURE THAT LOOKED LIKE A HANG.
   *
   * Reported as "codex + model astra HANGS and never runs — no tokens, no tool
   * calls, indefinitely", three times. It never hung. Run by hand, the same
   * command fails in under a second:
   *
   *   {"type":"item.completed","item":{"type":"error","message":"Model metadata
   *     for `astra` not found…"}}
   *   {"type":"error","message":"{\"status\":400,\"error\":{\"message\":\"The
   *     'astra' model is not supported when using Codex with a ChatGPT
   *     account.\"}}"}
   *   {"type":"turn.failed","error":{"message":"…same…"}}
   *
   * muxpad showed none of it. `turn.failed` carries an OBJECT and the handler
   * tested `typeof err === 'string'`, so the message was replaced with the
   * generic "codex turn failed"; and the standalone `error` event — where the
   * sentence actually lives — had no branch at all. The pane went idle in
   * silence, which reads exactly like a hang.
   */
  describe('codex surfaces the provider error instead of going quiet', () => {
    const PROVIDER = JSON.stringify({
      type: 'error',
      status: 400,
      error: {
        message: "The 'astra' model is not supported when using Codex with a ChatGPT account.",
      },
    });

    it('unwraps the provider JSON buried in a message field', () => {
      expect(codexErrorText({ message: PROVIDER })).toBe(
        "The 'astra' model is not supported when using Codex with a ChatGPT account.",
      );
    });

    it('takes a plain string, and an ordinary {message} object', () => {
      expect(codexErrorText('rate limited')).toBe('rate limited');
      expect(codexErrorText({ message: 'rate limited' })).toBe('rate limited');
    });

    it('returns null when there is nothing quotable, so callers keep their fallback', () => {
      expect(codexErrorText(undefined)).toBeNull();
      expect(codexErrorText({})).toBeNull();
      expect(codexErrorText({ message: '   ' })).toBeNull();
    });

    it('reports the real sentence on turn-done, not "codex turn failed"', async () => {
      const { b, calls, frames } = await boot();
      b.send('critique the plan');
      await tick();
      const turn = calls[1]!.child;
      line(turn, { type: 'thread.started', thread_id: 'thr-astra' });
      // The order codex actually emits: the standalone error, THEN turn.failed.
      line(turn, { type: 'error', message: PROVIDER });
      line(turn, { type: 'turn.failed', error: { message: PROVIDER } });
      closeChild(turn, 1);
      await tick();
      const done = frames.filter((f) => f.t === 'turn-done').at(-1) as
        | { ok?: boolean; error?: string }
        | undefined;
      expect(done?.ok).toBe(false);
      expect(done?.error).toContain('not supported when using Codex');
    });

    it('still falls back when turn.failed arrives with nothing usable', async () => {
      const { b, calls, frames } = await boot();
      b.send('go');
      await tick();
      const turn = calls[1]!.child;
      line(turn, { type: 'thread.started', thread_id: 'thr-bare' });
      line(turn, { type: 'turn.failed', error: {} });
      closeChild(turn, 1);
      await tick();
      const done = frames.filter((f) => f.t === 'turn-done').at(-1) as
        | { ok?: boolean; error?: string }
        | undefined;
      expect(done?.ok).toBe(false);
      expect(done?.error).toBe('codex turn failed');
    });
  });
});
