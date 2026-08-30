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
import { execFileSync, type spawn as nodeSpawn, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ChatEvent } from '@muxpad/shared';
import { readAgentInstructions, wrapAgentInstructions } from '../../agent-instructions.js';
import { readDoModeOverlay, wrapModeNote } from '../../agent-modes.js';
import { appendTranscriptEvent, migrateTranscript } from '../../chat/TranscriptReader.js';

// Provider ids we adopt as the transcript-log filename + hello sid must satisfy
// the server's charset gate, or the hello is rejected and the pane goes dark.
// Reject a non-conforming id rather than silently breaking the pane.
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;
import { bold, dim } from '../ansi.js';
import type { AgentMode, RunnerFrame } from '../protocol.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

const CODEX_BIN = process.env.MUXPAD_CODEX_BIN || 'codex';

/**
 * Build the delimited preamble prepended to a NEW session's first user
 * message — the injection mechanism for the spawn-per-turn backends
 * (codex + cursor), neither of which has an append-instructions surface.
 * Shared by both so they can't drift.
 *
 * `instructions` is the universal <dataDir>/agent-instructions.md;
 * `modeOverlay` is <dataDir>/do-mode.md, present only in ⚡ Do mode. Both
 * optional — with neither, the prompt is returned untouched.
 */
export function withSessionPreamble(
  prompt: string,
  instructions: string | null,
  modeOverlay: string | null,
): string {
  const blocks: string[] = [];
  if (instructions?.trim()) blocks.push(wrapAgentInstructions(instructions));
  // Behavior after capabilities, matching the Claude backend's append order.
  if (modeOverlay?.trim()) blocks.push(`<muxpad-mode>\n${modeOverlay.trim()}\n</muxpad-mode>`);
  return blocks.length ? `${blocks.join('\n\n')}\n\n${prompt}` : prompt;
}

// When the pane's cwd is a git WORKTREE, the real git metadata lives in the main
// repo's `.git` (outside the worktree). Codex's `workspace-write` sandbox makes
// only the cwd writable, so that external `.git` is read-only and `git add` /
// `git commit` fail from the worktree. Grant write access to the git common dir
// via `--add-dir`. A normal checkout keeps `.git` inside the cwd (already
// writable), so nothing is added. Best-effort — any git failure yields nothing.
function gitWorktreeExtraDirs(cwd: string): string[] {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000, // never let a wedged git shim block backend startup
    }).trim();
    if (!out) return [];
    const abs = isAbsolute(out) ? out : resolve(cwd, out);
    // Inside the cwd → already covered by workspace-write; only add when external.
    if (abs === cwd || abs.startsWith(cwd + sep)) return [];
    return [abs];
  } catch {
    return []; // not a git repo, git missing, etc.
  }
}

// Kill a spawned agent child's DESCENDANTS — the shell commands it ran and, the
// reason this exists, the long-lived dev servers (`vite`, `pnpm dev`) they start.
// Those block the turn, then survive it: when the child exits they reparent to
// launchd and pile up as leaked servers holding ports. The blocking case always
// reaches a kill point (Stop / stall watchdog / pane close) while the child is
// still alive, so its ppid tree is intact — we walk it with `pgrep -P` (macOS +
// Linux) BEFORE signalling the child, and SIGKILL leaves-first. Best-effort; the
// caller signals the child (codex/cursor) itself so it can still exit cleanly.
export function killDescendants(pid: number): void {
  const descendants: number[] = [];
  const walk = (p: number) => {
    let kids: number[];
    try {
      kids = execFileSync('pgrep', ['-P', String(p)], { encoding: 'utf8', timeout: 2000 })
        .split('\n')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return; // no children, or pgrep unavailable
    }
    for (const k of kids) {
      descendants.push(k);
      walk(k);
    }
  };
  walk(pid);
  for (const p of descendants.reverse()) {
    try {
      process.kill(p, 'SIGKILL'); // leaves before their parents
    } catch {
      // already gone
    }
  }
}

/** Model list + the backend's current default, for the chat model picker. */
export type ModelFetch = () => Promise<{
  models: Array<{ value: string; displayName: string }>;
  defaultModel: string | null;
}>;

/** Injectable deps — production uses the real spawner / model fetch; tests
 *  inject fakes so no real CLI, filesystem, or subprocess is touched. */
export interface BackendDeps {
  spawn?: typeof nodeSpawn;
  listModels?: ModelFetch;
}

/** Read Codex's cached model catalog (+ config default) — best-effort. */
function codexModelFetch(): {
  models: Array<{ value: string; displayName: string }>;
  defaultModel: string | null;
} {
  const home = process.env.CODEX_HOME || join(homedir(), '.codex');
  let models: Array<{ value: string; displayName: string }> = [];
  let defaultModel: string | null = null;
  try {
    const cache = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8')) as {
      models?: Array<{
        slug?: string;
        display_name?: string;
        visibility?: string;
        supported_in_api?: boolean;
      }>;
    };
    models = (cache.models ?? [])
      .filter(
        (m) =>
          m.visibility === 'list' && m.supported_in_api !== false && typeof m.slug === 'string',
      )
      .map((m) => ({ value: m.slug as string, displayName: m.display_name || (m.slug as string) }));
  } catch {
    // no cache / unreadable — picker just won't show
  }
  try {
    const match = readFileSync(join(home, 'config.toml'), 'utf8').match(
      /^\s*model\s*=\s*"([^"]+)"/m,
    );
    defaultModel = match?.[1] ?? null;
  } catch {
    // no config — leave default null
  }
  return { models, defaultModel };
}

export function createCodexBackend(
  host: RunnerHost,
  opts: BackendOptions,
  deps: BackendDeps = {},
): AgentBackend {
  const { emit, log } = host;
  const spawnFn = deps.spawn ?? spawn;
  const listModels: ModelFetch = deps.listModels ?? (async () => codexModelFetch());
  // The codex thread id we resume. Starts from --resume (may be a placeholder
  // minted before the first turn ever ran — see the resume-with-fallback in
  // runTurn) and becomes the real thread_id after `thread.started`.
  let sessionRef: string | null = opts.requestedSid;
  // The id used for the hello frame + the muxpad transcript log filename. Kept
  // stable so history survives even before codex mints its own thread id.
  let liveSid = opts.requestedSid ?? randomUUID();
  let model = opts.requestedModel;

  // Agent mode. Codex spawns a fresh `codex exec` per turn but RESUMES the
  // same thread, so — exactly like Claude — the mode overlay only reaches the
  // model as prompt material on a NEW session's first message. A mid-session
  // switch can only be announced in-conversation: see agent-modes.ts.
  let currentMode: AgentMode = opts.mode;
  let pendingModeNote: string | null = null;
  function setMode(next: AgentMode): void {
    if (next === currentMode) return;
    currentMode = next;
    pendingModeNote = wrapModeNote(next, readDoModeOverlay(next));
    log(dim(`mode → ${next} (announced to the thread on the next message)`));
  }

  // Extra writable roots for the sandbox (the worktree's external git dir, if
  // any) — computed once; the cwd is fixed for a runner's lifetime.
  const extraWritableDirs = gitWorktreeExtraDirs(process.cwd());
  if (extraWritableDirs.length) {
    log(dim(`codex: granting git write access → ${extraWritableDirs.join(', ')}`));
  }

  const queue: string[] = [];
  let turnActive = false;
  let child: ReturnType<typeof spawn> | null = null;
  let interrupted = false;
  let closed = false;
  let authOk = false;
  let resolveDone: (() => void) | null = null;

  let lastStatus: (RunnerFrame & { t: 'status' }) | null = null;
  let modelList: Array<{ value: string; displayName: string }> | null = null;

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
    // we advertise the model (+ the switchable list) but no context meter.
    const frame: RunnerFrame & { t: 'status' } = {
      t: 'status',
      model: model ?? 'codex',
      ...(modelList && modelList.length > 0 ? { models: modelList } : {}),
    };
    lastStatus = frame;
    emit(frame);
  }

  function checkAuth(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawnFn(CODEX_BIN, ['login', 'status'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  function buildArgs(prompt: string, useResume: boolean): string[] {
    const resuming = useResume && !!sessionRef;
    // Universal muxpad instructions + the ⚡ Do-mode overlay — CODEX injection
    // mechanism: `codex exec` has NO append-instructions surface (its only
    // hook, `-c experimental_instructions_file`, REPLACES the base prompt, and
    // AGENTS.md lives in user-owned dirs muxpad must not write), so fall back
    // to prepending the delimited file content to the FIRST user message of
    // each NEW session — fresh spawns only; a resume already carries it
    // in-thread. Read at spawn time; missing file → nothing injected, no
    // error. The muxpad transcript records the RAW prompt (logEvent runs
    // before this), so rendered chat history stays clean.
    let finalPrompt = prompt;
    if (resuming) {
      // A mid-session mode switch: the thread already ran with the old
      // contract, so declare the new one once, in-band.
      if (pendingModeNote) {
        finalPrompt = `${pendingModeNote}\n\n${prompt}`;
        pendingModeNote = null;
      }
    } else {
      // Fresh thread → the overlay lands as real preamble; any pending
      // switch note is redundant (the preamble already states the contract).
      pendingModeNote = null;
      finalPrompt = withSessionPreamble(
        prompt,
        readAgentInstructions(),
        readDoModeOverlay(currentMode),
      );
    }
    const head = resuming ? ['exec', 'resume', sessionRef as string] : ['exec'];
    const common = [
      '--json',
      '--skip-git-repo-check',
      // No interactive approval channel in exec — pick a policy up front. The
      // pane's cwd is a trusted dev workspace: allow writes there, plus network
      // (so git/gh/fetch work — off by default under workspace-write, which
      // otherwise leaves the agent unable to reach github and hanging on curl).
      '-c',
      'sandbox_mode="workspace-write"',
      '-c',
      'sandbox_workspace_write.network_access=true',
      '-c',
      'approval_policy="never"',
    ];
    // Make the worktree's external git dir writable so commits work in-place.
    for (const dir of extraWritableDirs) common.push('--add-dir', dir);
    if (model) common.push('-m', model);
    return [...head, ...common, finalPrompt];
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
      if (typeof tid === 'string' && SID_RE.test(tid)) {
        // Adopt codex's authoritative thread id: future turns resume it, and
        // the self-heal startup_cmd + transcript log re-point to it via
        // re-hello. This is where the turn's buffered events settle onto the
        // final <threadId>.jsonl.
        sessionRef = tid;
        if (liveSid !== tid) {
          // Carry any prior conversation to the new id's log so a resume that
          // re-mints (or a fresh fallback) doesn't orphan history.
          migrateTranscript(liveSid, tid);
          liveSid = tid;
          emit(hello());
        }
      } else if (typeof tid === 'string') {
        log(dim(`ignoring codex thread id with unexpected charset: ${tid.slice(0, 40)}`));
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
          logEvent({
            kind: 'assistant',
            id: randomUUID(),
            ts: Date.now(),
            text,
            ...(model ? { model } : {}),
          });
        }
      } else if (itype === 'command_execution') {
        const command = typeof item.command === 'string' ? item.command : '';
        const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
        const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
        const toolUseId = randomUUID();
        log(`${dim('⚙')} ${dim(command)}`);
        logEvent({
          kind: 'tool_use',
          id: randomUUID(),
          ts: Date.now(),
          toolUseId,
          name: 'shell',
          input: { command },
        });
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
    // Claim the turn slot BEFORE any await — checkAuth() suspends, and without
    // this a second send arriving in that window passes the guard again and
    // spawns a second child for the same session (leaking the first, wiping its
    // transcript buffer).
    turnActive = true;
    if (!authOk) {
      authOk = await checkAuth();
      if (!authOk) {
        turnActive = false;
        queue.shift();
        emit({ t: 'turn-start' });
        emit({
          t: 'turn-done',
          ok: false,
          error: 'codex is not logged in — run `codex login` in this pane’s terminal face',
        });
        if (!closed && queue.length > 0) void runTurn(); // drain the rest
        return;
      }
    }
    const prompt = queue.shift() as string;
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
      const proc = spawnFn(CODEX_BIN, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc;
      let buf = '';
      // StringDecoder so a multibyte UTF-8 codepoint split across two chunks
      // isn't corrupted (a plain d.toString() per chunk mangles it).
      const decoder = new StringDecoder('utf8');
      proc.stdout?.on('data', (d: Buffer) => {
        buf += decoder.write(d);
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
        if (interrupted || closed) {
          // User Stop (or shutdown): mirror Claude — a deliberate interrupt is a
          // CLEAN finish (ok:true), not a red error. `closed` also blocks the
          // fresh-fallback respawn below from resurrecting a child post-shutdown.
          if (turnActive) finishTurn(true);
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
    return {
      t: 'hello',
      sid: liveSid,
      cwd: process.cwd(),
      pid: process.pid,
      turnActive,
      backend: 'codex',
    };
  }

  async function start(): Promise<void> {
    process.stdout.write('\x1b]0;✳ codex\x07');
    log(`${bold('muxpad agent')} — codex backend · session ${liveSid}`);
    log(dim(`pane ${host.paneId} · ${process.cwd()}`));
    if (currentMode === 'do') log(dim('⚡ do mode — decisive, terse, result-first'));
    authOk = await checkAuth();
    if (!authOk) {
      log(dim('codex not logged in — run `codex login` in this pane’s terminal face'));
    }
    try {
      const { models, defaultModel } = await listModels();
      modelList = models;
      if (!model && defaultModel) model = defaultModel; // highlight the picker's current row
    } catch {
      // best-effort — no picker if the catalog can't be read
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
      if (child.pid) killDescendants(child.pid); // take down any dev server it started
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
    setMode,
    answer: () => {},
    onConnected: () => {
      if (lastStatus) emit(lastStatus);
    },
    hello,
    shutdown: () => {
      closed = true;
      interrupted = true; // the child's close handler must not fresh-fallback-respawn
      if (child) {
        try {
          if (child.pid) killDescendants(child.pid); // don't leak its dev servers
          child.kill('SIGTERM');
        } catch {
          // already gone
        }
      }
      resolveDone?.();
    },
  };
}
