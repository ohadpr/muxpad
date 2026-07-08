// Wire protocol between an agent runner (the `muxpad agent` process living
// inside a pane's pty) and the main server's /ws/agent-runner/:paneId
// endpoint. JSON frames both ways. The runner owns the Claude session; the
// server relays chat clients' sends/stops to it and fans its turn lifecycle
// back out to every open chat view of the pane.

import type { AgentQuestion, SubagentProgress } from '@muxpad/shared';

export type { AgentQuestion, SubagentProgress };

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
      /** The session died and the runner is exiting (claude crash, fatal error). */
      t: 'fatal';
      error: string;
    };

/** server → runner */
export type ServerFrame =
  | { t: 'send'; text: string }
  | { t: 'stop' }
  | {
      /** The user's answer to a `question` frame. One entry per question, in order. */
      t: 'answer';
      qid: string;
      answers: Array<{ question: string; answers: string[] }>;
    };

export function parseFrame<T>(data: unknown): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}
