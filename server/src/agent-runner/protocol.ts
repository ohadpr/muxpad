// Wire protocol between an agent runner (the `muxpad agent` process living
// inside a pane's pty) and the main server's /ws/agent-runner/:paneId
// endpoint. JSON frames both ways. The runner owns the Claude session; the
// server relays chat clients' sends/stops to it and fans its turn lifecycle
// back out to every open chat view of the pane.

import type { AgentQuestion, AgentSessionStatus, SubagentProgress } from '@muxpad/shared';

export type { AgentQuestion, AgentSessionStatus, SubagentProgress };

/** runner → server */
export type RunnerFrame =
  | {
      t: 'hello';
      /** The provider session id — known up front (minted or resumed). */
      sid: string;
      cwd: string;
      pid: number;
      /** True when a turn is mid-flight (a reconnect during a turn). */
      turnActive: boolean;
    }
  | { t: 'turn-start' }
  | { t: 'stream'; delta: string }
  | { t: 'turn-done'; ok: boolean; error?: string }
  | {
      /** The session is blocked on the user: render these as tappable chips. */
      t: 'question';
      qid: string;
      questions: AgentQuestion[];
    }
  | {
      /** The question was resolved (answered, or the turn ended) — dismiss it. */
      t: 'question-done';
      qid: string;
    }
  | { t: 'subagent'; progress: SubagentProgress }
  | {
      /**
       * A short conversation title the runner generated after the first turn
       * (SDK sessions never get the CLI's ai-title transcript records, so the
       * runner titles itself). The server applies it to the pane/tab name —
       * user renames always win over it.
       */
      t: 'title';
      title: string;
    }
  | ({
      /**
       * Session status for the chat header (shape shared with the web client
       * via @muxpad/shared — see AgentSessionStatus). `models` rides only the
       * frames where the list was (re)fetched; the server merges frames so a
       * reconnect hello still carries the last known list.
       */
      t: 'status';
    } & AgentSessionStatus)
  | {
      /** The session died and the runner is exiting (claude crash, fatal error). */
      t: 'fatal';
      error: string;
    };

/** server → runner */
export type ServerFrame =
  | { t: 'send'; text: string }
  | { t: 'stop' }
  | { t: 'set-model'; model: string }
  | {
      /** Run a session-management slash command (queued like a user turn). */
      t: 'slash';
      cmd: 'compact' | 'clear';
    }
  | {
      /** The user's answer to a `question` frame. One entry per question, in order. */
      t: 'answer';
      qid: string;
      answers: Array<{ question: string; answers: string[] }>;
    };

/**
 * WS close code sent to a runner socket displaced by a NEWER runner for the
 * same pane — the displaced process must EXIT, not reconnect (two live
 * processes would trade the registration forever). 4001 is also used
 * elsewhere in the project for unrelated closes (pane kind flips to browser
 * attach sockets); this named constant exists so the runner's exit-on-close
 * coupling is to the displacement CONTRACT, not to a bare number a future
 * path might reuse by accident.
 */
export const CLOSE_RUNNER_DISPLACED = 4001;

export function parseFrame<T>(data: unknown): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}
