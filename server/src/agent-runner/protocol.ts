// Wire protocol between an agent runner (the `muxpad agent` process living
// inside a pane's pty) and the main server's /ws/agent-runner/:paneId
// endpoint. JSON frames both ways. The runner owns the Claude session; the
// server relays chat clients' sends/stops to it and fans its turn lifecycle
// back out to every open chat view of the pane.

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
      /** The session died and the runner is exiting (claude crash, fatal error). */
      t: 'fatal';
      error: string;
    };

/** server → runner */
export type ServerFrame = { t: 'send'; text: string } | { t: 'stop' };

export function parseFrame<T>(data: unknown): T | null {
  try {
    return JSON.parse(String(data)) as T;
  } catch {
    return null;
  }
}
