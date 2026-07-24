// Codex backend — drives OpenAI's `codex` CLI in headless JSON mode
// (`codex exec --json`, resumed by thread_id). Unlike Claude's persistent SDK
// session, this is SPAWN-PER-TURN: each user message runs one `codex exec`
// child whose NDJSON stdout we translate into runner frames, and it writes a
// muxpad-owned normalized transcript log (the server tails that, since Codex
// writes no ~/.claude file).
//
// Known Phase-1 limitations (advertised via caps): no token-level deltas (an
// agent_message arrives whole), no interactive tool approvals (runs under a
// fixed sandbox policy), no subagents, no autonomous turns, and no context
// meter (Codex's exec stream carries usage but not the window size).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { ChatEvent } from '@muxpad/shared';
import { appendTranscriptEvent } from '../../chat/TranscriptReader.js';
import { bold, dim } from '../ansi.js';
import type { RunnerFrame } from '../protocol.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

const CODEX_BIN = process.env.MUXPAD_CODEX_BIN || 'codex';

export function createCodexBackend(host: RunnerHost, opts: BackendOptions): AgentBackend {
  const { emit, log } = host;
  // The codex thread id we resume. Starts from --resume (may be a placeholder
  // minted before the first turn ever ran — see the resume-with-fallback in
  // runTurn) and becomes the real thread_id after `thread.started`.
  let sessionRef: string | null = opts.requestedSid;
  // The id used for the hello frame + the muxpad transcript log filename. Kept
  // stable so history survives even before codex mints its own thread id.
  let liveSid = opts.requestedSid ?? randomUUID();
  let model = opts.requestedModel;

  const queue: string[] = [];
  let turnActive = false;
  let child: ReturnType<typeof spawn> | null = null;
  let interrupted = false;
  let closed = false;
  let authOk = false;
  let resolveDone: (() => void) | null = null;

  let lastStatus: (RunnerFrame & { t: 'status' }) | null = null;

  // Per-turn transcript buffer. A fresh turn's real thread id isn't known until
  // `thread.started` arrives (and a failed resume changes it again mid-turn), so
  // buffer events until the id is settled, then flush them ALL to the final
  // `<threadId>.jsonl` — otherwise the user message would orphan under the
  // placeholder id the server never tails.
  let turnLog: ChatEvent[] = [];
  let turnCommitted = false;
  function writeEvent(event: ChatEvent): void {
    try {
      appendTranscriptEvent(liveSid, event);
    } catch (e) {
      log(dim(`transcript log write failed: ${e instanceof Error ? e.message : String(e)}`));
    }
  }
  function logEvent(event: ChatEvent): void {
    if (turnCommitted) writeEvent(event);
    else turnLog.push(event);
  }
  function commitTurnLog(): void {
    turnCommitted = true;
    for (const ev of turnLog) writeEvent(ev);
    turnLog = [];
  }

  function emitStatus(): void {
    // Codex exposes per-turn token usage but not the model's context window, so
    // we advertise the model only — the chat header hides the meter chip.
    const frame: RunnerFrame & { t: 'status' } = { t: 'status', model: model ?? 'codex' };
    lastStatus = frame;
    emit(frame);
  }

  function checkAuth(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawn(CODEX_BIN, ['login', 'status'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  function buildArgs(prompt: string, useResume: boolean): string[] {
    const head = useResume && sessionRef ? ['exec', 'resume', sessionRef] : ['exec'];
    const common = [
      '--json',
      '--skip-git-repo-check',
      // No interactive approval channel in exec — pick a policy up front. The
      // pane's cwd is a dev workspace, so allow writes there but nothing wider.
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'approval_policy="never"',
    ];
    if (model) common.push('-m', model);
    return [...head, ...common, prompt];
  }

  function finishTurn(ok: boolean, error?: string): void {
    if (!turnActive) return;
    turnActive = false;
    child = null;
    // Defensive: a turn that produced no thread.started (spawn error) still
    // flushes its buffered user event so it isn't lost.
    if (!turnCommitted) commitTurnLog();
    emit({ t: 'turn-done', ok, ...(error ? { error } : {}) });
    emitStatus();
    // Release the next queued send.
    if (!closed && queue.length > 0) void runTurn();
  }

  function handleEvent(ev: Record<string, unknown>): void {
    const type = ev.type as string | undefined;
    if (type === 'thread.started') {
      const tid = ev.thread_id;
      if (typeof tid === 'string' && tid) {
        // Adopt codex's authoritative thread id: future turns resume it, and
        // the self-heal startup_cmd + transcript log re-point to it via
        // re-hello. This is where the turn's buffered events settle onto the
        // final <threadId>.jsonl.
        sessionRef = tid;
        if (liveSid !== tid) {
          liveSid = tid;
          emit(hello());
        }
      }
      commitTurnLog();
    } else if (type === 'item.completed') {
      const item = ev.item as Record<string, unknown> | undefined;
      if (!item) return;
      const itype = item.type as string | undefined;
      if (itype === 'agent_message') {
        const text = typeof item.text === 'string' ? item.text : '';
        if (text) {
          // No token deltas from exec — stream the whole message as one chunk
          // for the live view, and land it in the transcript log for history.
          emit({ t: 'stream', delta: text });
          log(`${bold('codex')} ${text}`);
          logEvent({ kind: 'assistant', id: randomUUID(), ts: Date.now(), text, ...(model ? { model } : {}) });
        }
      } else if (itype === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : '';
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
        const toolUseId = randomUUID();
        log(`${dim('⚙')} ${dim(command)}`);
        logEvent({ kind: 'tool_use', id: randomUUID(), ts: Date.now(), toolUseId, name: 'shell', input: { command } });
        logEvent({
          kind: 'tool_result',
          id: randomUUID(),
          ts: Date.now(),
          toolUseId,
          ok: exit === 0,
          ...(output ? { text: output } : {}),
        });
      }
    } else if (type === 'turn.completed') {
      finishTurn(true);
    } else if (type === 'turn.failed') {
      const err = ev.error;
      finishTurn(false, typeof err === 'string' ? err : 'codex turn failed');
    }
  }

  async function runTurn(): Promise<void> {
    if (turnActive || queue.length === 0 || closed) return;
    if (!authOk) {
      authOk = await checkAuth();
      if (!authOk) {
        queue.shift();
        emit({ t: 'turn-start' });
        emit({
          t: 'turn-done',
          ok: false,
          error: 'codex is not logged in — run `codex login` in this pane’s terminal face',
        });
        return;
      }
    }
    const prompt = queue.shift() as string;
    turnActive = true;
    interrupted = false;
    // Reset the per-turn transcript buffer; it flushes to the final thread id
    // once `thread.started` lands (or at turn end if it never does).
    turnLog = [];
    turnCommitted = false;
    emit({ t: 'turn-start' });
    log(`${bold('▸ user')} ${prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt}`);
    logEvent({ kind: 'user', id: randomUUID(), ts: Date.now(), text: prompt });

    // Attempt resume when we have a ref; fall back to a FRESH turn if the child
    // exits nonzero before emitting any thread event (a stale/placeholder ref
    // that codex can't resume). Only one fallback per turn.
    let triedFresh = !sessionRef;
    let gotThread = false;
    let finished = false;

    const spawnCodex = (useResume: boolean) => {
      const args = buildArgs(prompt, useResume);
      // stdin IGNORED (not inherited/piped): `codex exec` reads the prompt from
      // its positional arg, but if stdin is an open pipe it ALSO waits on it
      // ("Reading additional input from stdin…") and hangs forever. /dev/null
      // gives it an immediate EOF so it runs the positional prompt.
      const proc = spawn(CODEX_BIN, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc;
      let buf = '';
      proc.stdout?.on('data', (d: Buffer) => {
        buf += d.toString();
        let nl: number;
        // biome-ignore lint/suspicious/noAssignInExpressions: line-split loop
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let obj: Record<string, unknown>;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          if (obj.type === 'thread.started') gotThread = true;
          if (finished) continue;
          handleEvent(obj);
          if (obj.type === 'turn.completed' || obj.type === 'turn.failed') finished = true;
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s) log(dim(s.length > 300 ? `${s.slice(0, 300)}…` : s));
      });
      proc.on('error', (e) => {
        log(dim(`codex spawn error: ${e.message}`));
        if (!finished) {
          finished = true;
          finishTurn(false, `codex failed to start: ${e.message}`);
        }
      });
      proc.on('close', (code) => {
        if (interrupted) {
          if (turnActive) finishTurn(false, 'stopped');
          return;
        }
        if (!finished && !gotThread && useResume && !triedFresh) {
          // Resume failed before producing anything — retry as a fresh thread.
          triedFresh = true;
          sessionRef = null;
          log(dim('resume failed — starting a fresh codex thread'));
          spawnCodex(false);
          return;
        }
        if (!finished) {
          finished = true;
          finishTurn(code === 0, code === 0 ? undefined : `codex exited (${code})`);
        }
      });
    };
    spawnCodex(!!sessionRef);
  }

  function hello(): RunnerFrame {
    return { t: 'hello', sid: liveSid, cwd: process.cwd(), pid: process.pid, turnActive, backend: 'codex' };
  }

  async function start(): Promise<void> {
    process.stdout.write('\x1b]0;✳ codex\x07');
    log(`${bold('muxpad agent')} — codex backend · session ${liveSid}`);
    log(dim(`pane ${host.paneId} · ${process.cwd()}`));
    authOk = await checkAuth();
    if (!authOk) {
      log(dim('codex not logged in — run `codex login` in this pane’s terminal face'));
    }
    emitStatus();
    // Spawn-per-turn: nothing to loop. Stay alive until shutdown.
    await new Promise<void>((r) => {
      resolveDone = r;
    });
  }

  function send(text: string): void {
    queue.push(text);
    if (!turnActive) void runTurn();
  }

  function stop(): void {
    queue.length = 0;
    if (turnActive && child) {
      interrupted = true;
      log(dim('⏹ interrupt — killing codex'));
      child.kill('SIGTERM');
    }
  }

  return {
    id: 'codex',
    start,
    send,
    slash: () => log(dim('codex: /compact and /clear are not supported')),
    stop,
    setModel: (m: string) => {
      model = m;
      log(`${bold('model')} → ${m}`);
      emitStatus();
    },
    answer: () => {},
    onConnected: () => {
      if (lastStatus) emit(lastStatus);
    },
    hello,
    shutdown: () => {
      closed = true;
      if (child) {
        try {
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
      resolveDone?.();
    },
  };
}
