// Cursor backend — drives `cursor-agent -p --output-format stream-json`
// spawn-per-turn, resumed by session_id. Same shape as the Codex backend; the
// stream schema differs (Claude-Code-ish: system/init → assistant → tool_call →
// result). We DON'T pass --stream-partial-output, so each assistant message
// arrives whole (one stream chunk) — no cumulative-delta reconstruction.
//
// IMPORTANT caveat: Cursor sessions are CLOUD-backed. Resume is a network call
// into Cursor's backend, not a local-file replay — an offline/aged-out session
// can't rehydrate. We still persist a muxpad-owned transcript log so the pane
// keeps its RENDERED history even when the cloud session is gone; resume itself
// is best-effort (falls back to a fresh session on failure).
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ChatEvent } from '@muxpad/shared';
import { appendTranscriptEvent, migrateTranscript } from '../../chat/TranscriptReader.js';
import { bold, dim } from '../ansi.js';
import type { RunnerFrame } from '../protocol.js';
import type { BackendDeps, ModelFetch } from './codex.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

const CURSOR_BIN = process.env.MUXPAD_CURSOR_BIN || 'cursor-agent';
// Adopted session ids must satisfy the server's sid charset gate or the pane
// goes dark on hello — reject a non-conforming id instead.
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Parse `cursor-agent --list-models` — lines are `slug - Display Name`, with
 *  the active one marked `(current, default)`. Best-effort. */
function cursorModelFetch(spawnFn: typeof spawn): ReturnType<ModelFetch> {
  return new Promise((resolve) => {
    const p = spawnFn(CURSOR_BIN, ['--list-models'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    p.on('error', () => resolve({ models: [], defaultModel: null }));
    p.on('close', () => {
      const models: Array<{ value: string; displayName: string }> = [];
      let defaultModel: string | null = null;
      for (const raw of out.split('\n')) {
        const m = raw.match(/^(\S+)\s+-\s+(.+)$/);
        if (!m) continue;
        const value = m[1] as string;
        if (/\(current, default\)/.test(m[2] as string)) defaultModel = value;
        const displayName = (m[2] as string).replace(/\s*\(current, default\)\s*/, '').trim();
        models.push({ value, displayName });
      }
      resolve({ models, defaultModel });
    });
  });
}

export function createCursorBackend(
  host: RunnerHost,
  opts: BackendOptions,
  deps: BackendDeps = {},
): AgentBackend {
  const { emit, log } = host;
  const spawnFn = deps.spawn ?? spawn;
  const listModels: ModelFetch = deps.listModels ?? (() => cursorModelFetch(spawnFn));
  let sessionRef: string | null = opts.requestedSid;
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
  let modelList: Array<{ value: string; displayName: string }> | null = null;

  // Per-turn transcript buffer — flushed to the final <sessionId>.jsonl once
  // system/init settles the id (see the Codex backend for the rationale).
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
    const frame: RunnerFrame & { t: 'status' } = {
      t: 'status',
      model: model ?? 'cursor',
      ...(modelList && modelList.length > 0 ? { models: modelList } : {}),
    };
    lastStatus = frame;
    emit(frame);
  }

  function checkAuth(): Promise<boolean> {
    return new Promise((resolve) => {
      const p = spawnFn(CURSOR_BIN, ['status'], { stdio: 'ignore' });
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
  }

  function buildArgs(prompt: string, useResume: boolean): string[] {
    const args = ['-p', '--output-format', 'stream-json', '--trust', '--force'];
    if (useResume && sessionRef) args.push('--resume', sessionRef);
    if (model) args.push('--model', model);
    args.push(prompt);
    return args;
  }

  function finishTurn(ok: boolean, error?: string): void {
    if (!turnActive) return;
    turnActive = false;
    child = null;
    if (!turnCommitted) commitTurnLog();
    emit({ t: 'turn-done', ok, ...(error ? { error } : {}) });
    emitStatus();
    if (!closed && queue.length > 0) void runTurn();
  }

  function extractResultText(result: Record<string, unknown> | undefined): string {
    if (!result) return '';
    const success = result.success as Record<string, unknown> | undefined;
    if (success) {
      if (typeof success.stdout === 'string') return success.stdout;
      if (typeof success.content === 'string') return success.content;
    }
    const denied = result.permissionDenied as Record<string, unknown> | undefined;
    if (denied && typeof denied.error === 'string') return denied.error;
    return '';
  }

  function handleEvent(ev: Record<string, unknown>): void {
    const type = ev.type as string | undefined;
    if (type === 'system' && ev.subtype === 'init') {
      const sid = ev.session_id;
      if (typeof sid === 'string' && SID_RE.test(sid)) {
        sessionRef = sid;
        if (liveSid !== sid) {
          migrateTranscript(liveSid, sid); // carry history across a re-mint/fallback
          liveSid = sid;
          emit(hello());
        }
      } else if (typeof sid === 'string') {
        log(dim(`ignoring cursor session id with unexpected charset: ${sid.slice(0, 40)}`));
      }
      if (typeof ev.model === 'string' && !model) model = ev.model;
      commitTurnLog();
    } else if (type === 'assistant') {
      // No --stream-partial-output → each assistant message arrives whole.
      const message = ev.message as { content?: Array<Record<string, unknown>> } | undefined;
      let text = '';
      for (const block of message?.content ?? []) {
        if (block.type === 'text' && typeof block.text === 'string') text += block.text;
      }
      if (text) {
        emit({ t: 'stream', delta: text });
        log(`${bold('cursor')} ${text}`);
        logEvent({ kind: 'assistant', id: randomUUID(), ts: Date.now(), text, ...(model ? { model } : {}) });
      }
    } else if (type === 'tool_call' && ev.subtype === 'completed') {
      const tc = ev.tool_call as Record<string, unknown> | undefined;
      const key = tc ? Object.keys(tc)[0] : undefined;
      const wrap = key ? (tc?.[key] as Record<string, unknown> | undefined) : undefined;
      if (key && wrap) {
        const name = key.replace(/ToolCall$/, '');
        const result = wrap.result as Record<string, unknown> | undefined;
        const ok = !!result?.success;
        const text = extractResultText(result);
        const toolUseId = randomUUID();
        log(`${dim('⚙')} ${dim(name)}`);
        logEvent({ kind: 'tool_use', id: randomUUID(), ts: Date.now(), toolUseId, name, input: wrap.args ?? {} });
        logEvent({ kind: 'tool_result', id: randomUUID(), ts: Date.now(), toolUseId, ok, ...(text ? { text } : {}) });
      }
    } else if (type === 'result') {
      const ok = ev.subtype === 'success' && ev.is_error !== true;
      finishTurn(ok, ok ? undefined : (typeof ev.result === 'string' ? ev.result : 'cursor turn failed'));
    }
  }

  async function runTurn(): Promise<void> {
    if (turnActive || queue.length === 0 || closed) return;
    // Claim the slot before the checkAuth() await so a second send in that
    // window can't spawn a second child for the same session (see codex).
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
          error: 'cursor-agent is not logged in — run `cursor-agent login` in this pane’s terminal face',
        });
        if (!closed && queue.length > 0) void runTurn();
        return;
      }
    }
    const prompt = queue.shift() as string;
    interrupted = false;
    turnLog = [];
    turnCommitted = false;
    emit({ t: 'turn-start' });
    log(`${bold('▸ user')} ${prompt.length > 200 ? `${prompt.slice(0, 200)}…` : prompt}`);
    logEvent({ kind: 'user', id: randomUUID(), ts: Date.now(), text: prompt });

    let triedFresh = !sessionRef;
    let gotInit = false;
    let finished = false;

    const spawnCursor = (useResume: boolean) => {
      const args = buildArgs(prompt, useResume);
      const proc = spawnFn(CURSOR_BIN, args, {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child = proc;
      let buf = '';
      const decoder = new StringDecoder('utf8'); // avoid multibyte corruption across chunks
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
          if (obj.type === 'system' && obj.subtype === 'init') gotInit = true;
          if (finished) continue;
          handleEvent(obj);
          if (obj.type === 'result') finished = true;
        }
      });
      proc.stderr?.on('data', (d: Buffer) => {
        const s = d.toString().trim();
        if (s) log(dim(s.length > 300 ? `${s.slice(0, 300)}…` : s));
      });
      proc.on('error', (e) => {
        log(dim(`cursor spawn error: ${e.message}`));
        if (!finished) {
          finished = true;
          finishTurn(false, `cursor-agent failed to start: ${e.message}`);
        }
      });
      proc.on('close', (code) => {
        if (interrupted || closed) {
          // Deliberate Stop/shutdown → clean finish (ok:true), mirror Claude;
          // `closed` also blocks a post-shutdown fresh-fallback respawn.
          if (turnActive) finishTurn(true);
          return;
        }
        if (!finished && !gotInit && useResume && !triedFresh) {
          triedFresh = true;
          sessionRef = null;
          log(dim('resume failed (cloud session may be gone) — starting fresh'));
          spawnCursor(false);
          return;
        }
        if (!finished) {
          finished = true;
          finishTurn(code === 0, code === 0 ? undefined : `cursor-agent exited (${code})`);
        }
      });
    };
    spawnCursor(!!sessionRef);
  }

  function hello(): RunnerFrame {
    return { t: 'hello', sid: liveSid, cwd: process.cwd(), pid: process.pid, turnActive, backend: 'cursor' };
  }

  async function start(): Promise<void> {
    process.stdout.write('\x1b]0;✳ cursor\x07');
    log(`${bold('muxpad agent')} — cursor backend · session ${liveSid}`);
    log(dim(`pane ${host.paneId} · ${process.cwd()}`));
    authOk = await checkAuth();
    if (!authOk) log(dim('cursor-agent not logged in — run `cursor-agent login` in the terminal face'));
    try {
      const { models, defaultModel } = await listModels();
      modelList = models;
      if (!model && defaultModel) model = defaultModel;
    } catch {
      // best-effort
    }
    emitStatus();
    await new Promise<void>((r) => {
      resolveDone = r;
    });
  }

  return {
    id: 'cursor',
    start,
    send: (text: string) => {
      queue.push(text);
      if (!turnActive) void runTurn();
    },
    slash: () => log(dim('cursor: /compact and /clear are not supported')),
    stop: () => {
      queue.length = 0;
      if (turnActive && child) {
        interrupted = true;
        log(dim('⏹ interrupt — killing cursor-agent'));
        child.kill('SIGTERM');
      }
    },
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
      interrupted = true; // block the child close handler's fresh-fallback respawn
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
