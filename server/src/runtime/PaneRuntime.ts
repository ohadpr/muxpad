import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { RingBuffer } from './RingBuffer.js';
import { type AppUrlMarker, PtyScanner } from './pty-scanner.js';

// Debounce window between a URL/marker sighting and the (async) confirm pass.
// Coalesces the burst a server emits as it boots; the confirm itself is also
// re-run on the manager's 10s poll, so this only governs first-surface latency.
const execFileAsync = promisify(execFile);

const RING_CAPACITY = 2 * 1024 * 1024; // 2MB

/**
 * How long a pane must go without emitting any output before we consider it
 * idle ("done / waiting"). Output activity is the only transparent signal that
 * distinguishes an interactive app *working* from one *waiting for input* —
 * the foreground process is the same in both cases (e.g. `claude` is always
 * the foreground process whether it's thinking or sitting at its prompt), so
 * tcgetpgrp/`ps` can't tell them apart. A working app streams bytes (Claude's
 * spinner redraws ~10×/s and its elapsed-time counter ticks every second); a
 * waiting one falls silent (the blinking cursor is drawn client-side and emits
 * nothing). The window must exceed the slowest steady heartbeat — Claude's 1s
 * timer tick — so we don't flicker to idle between ticks. 1.5s clears that with
 * margin; the cost is only a ~1.5s lag before "done" shows after real work ends.
 */
const BUSY_QUIET_MS = 1500;

/**
 * Absolute path to the repo's `scripts/` directory. Resolved relative to
 * this file rather than `process.cwd()` because in `pnpm dev` the daemon's
 * cwd is `server/`, not the repo root. The directory layout (file at
 * `server/src/runtime/PaneRuntime.ts` for source, `server/dist/runtime/…`
 * after build) is `../../../scripts` either way — three levels up to the
 * repo root, then `scripts/`.
 */
const SCRIPTS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'scripts',
);
const MUXPAD_BIN_PATH = path.join(SCRIPTS_DIR, 'muxpad');

/**
 * Make a `ps args=` line readable as a pane label. Strips the leading
 * absolute path from argv[0] (so /usr/local/bin/pnpm dev:tui → pnpm
 * dev:tui) and collapses runs of whitespace. Deliberately does NOT
 * try to unwrap `node script.js …` style invocations — predictability
 * beats prettiness.
 */
export function prettifyCommand(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const tokens = trimmed.split(/\s+/);
  if (tokens.length === 0) return trimmed;
  tokens[0] = basename(tokens[0]!);
  return tokens.join(' ');
}

function basename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash >= 0 ? p.slice(slash + 1) : p;
}

/**
 * Strip env vars that signal "we're running inside an npm/pnpm script". If the
 * daemon was launched via `pnpm dev`, pnpm sets these on its child (this
 * process) and they would otherwise leak into every spawned shell, causing
 * subsequent npm/pnpm invocations inside the shell to behave as nested-script
 * runs (capturing stdio, breaking TUIs that need a real TTY, etc.).
 *
 * We keep PNPM_HOME and similar user-level config vars since those are
 * permanent settings, not script-run indicators.
 */
function sanitizeEnv(parent: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (typeof v !== 'string') continue;
    if (k.startsWith('npm_')) continue;
    if (k === 'INIT_CWD') continue;
    if (k === 'PNPM_SCRIPT_SRC_DIR') continue;
    if (k === 'NODE_OPTIONS') continue;
    // The terminal that launched the daemon may have exported COLUMNS/LINES.
    // If we forwarded them, child processes that prefer the env var over
    // TIOCGWINSZ (some TUI frameworks do) would render at the launching
    // terminal's old size instead of the actual pane size.
    if (k === 'COLUMNS' || k === 'LINES') continue;
    out[k] = v;
  }
  return out;
}

export interface PaneRuntimeSpec {
  id: string;
  shell: string;
  startup_cmd?: string | null | undefined;
  cwd: string;
  env?: Record<string, string> | null | undefined;
  /**
   * Parent tab id. Optional because some unit tests construct runtimes
   * without a real DB. When present, exposed to the spawned shell as
   * `MUXPAD_TAB_ID` so the in-pane CLI wrapper can default `--tab` to it.
   */
  tab_id?: string | undefined;
  /**
   * Parent workspace id (the tab's workspace_id). Optional for the same
   * reason as `tab_id`. Exposed as `MUXPAD_WORKSPACE_ID`.
   */
  workspace_id?: string | undefined;
}

type Listener<T extends unknown[]> = (...args: T) => void;

export class PaneRuntime extends EventEmitter {
  private process: pty.IPty | null = null;
  private buffer = new RingBuffer(RING_CAPACITY);
  private exited = false;
  private exitCode = 0;
  private startupTimer: NodeJS.Timeout | null = null;
  /**
   * Why this runtime stopped (or will stop). Set to 'killed' just before any
   * server-initiated kill (manager.kill, manager.killAll); otherwise stays
   * 'natural' so the WS bridge knows to tell clients "the shell exited on
   * its own" → clients clean up the layout. This is the protocol-level
   * disambiguation between user-typed-exit and daemon-shutdown.
   */
  private exitCause: 'natural' | 'killed' = 'natural';
  // PTY size is last-writer-wins: any client's resize is applied
  // immediately. The correctness guarantee lives on the CLIENT: only a
  // visible browser tab sends resize frames (see `mayDriveResize` in
  // web/src/components/XtermPane.tsx). A hidden/backgrounded/bfcache'd tab
  // — the phantom that previously shrank the PTY out from under the active
  // viewer — stays silent, so last-writer-wins only ever arbitrates among
  // tabs the user is actually looking at. We keep just the set of connected
  // client ids for clientCount() / liveness.
  private connectedClients = new Set<string>();
  cols = 80;
  rows = 24;
  // True iff this pane has emitted a "real" BEL (\x07) since the user
  // last interacted with it. Set by the scanner in the output callback;
  // cleared by write() (user typed) or markSeen() (user opened the
  // workspace tab). The workspace list endpoint folds these into a
  // per-workspace attention flag so the tab bar can render a dot.
  private needsAttention = false;
  // True iff this pane has emitted output within the last BUSY_QUIET_MS —
  // i.e. the foreground app is actively doing work, not idling at a prompt.
  // Flipped true on the first output byte after a quiet spell and back to
  // false by busyTimer when the stream goes quiet. See markBusy() and the
  // BUSY_QUIET_MS comment for why output-activity (not the foreground pgid)
  // is the signal here.
  private busy = false;
  // Decay timer that flips `busy` back to false after a quiet window. Reset
  // (debounced) on every output chunk; unref'd so it never holds the daemon
  // alive on its own.
  private busyTimer: NodeJS.Timeout | null = null;
  // Latest terminal title set by an OSC 0/1/2 sequence in PTY output.
  // Updated in real-time by the scanner; exposed via getCurrentTitle().
  private currentTitle: string | null = null;
  // Streaming state-machine scanner for the byte stream — extracts BEL
  // and OSC title events without building intermediate strings beyond
  // the OSC payload. See pty-scanner.ts.
  private scanner = new PtyScanner();

  constructor(public readonly spec: PaneRuntimeSpec) {
    super();
    this.setMaxListeners(100);
  }

  start(): void {
    if (this.process) return;
    // The daemon may bind a non-localhost interface (Tailscale IP,
    // 0.0.0.0) via MUXPAD_HOST, but the spawned shell is always on the
    // same machine — hit localhost regardless of bind host. Port comes
    // from MUXPAD_PORT (same env var the daemon reads at startup).
    const apiPort = process.env.MUXPAD_PORT ?? '7777';
    const env: Record<string, string> = {
      ...sanitizeEnv(process.env),
      ...(this.spec.env ?? {}),
      TERM: 'xterm-256color',
      // Expose the muxpad wrapper script so spawned shells can find it
      // on PATH and reference the absolute path via $MUXPAD_BIN. The
      // wrapper script also uses MUXPAD_BIN being set to detect "we're
      // inside a muxpad pane" and refuse otherwise.
      MUXPAD_BIN: MUXPAD_BIN_PATH,
      PATH: `${SCRIPTS_DIR}:${process.env.PATH ?? ''}`,
      // Identity + endpoint for the in-pane CLI wrapper. The wrapper
      // reads these so `muxpad pane new` (no flags) creates a sibling
      // in the current tab; `muxpad tab new` (no flags) creates a tab
      // in the current workspace; etc.
      MUXPAD_API_URL: `http://localhost:${apiPort}`,
      MUXPAD_PANE_ID: this.spec.id,
      MUXPAD_TAB_ID: this.spec.tab_id ?? '',
      MUXPAD_WORKSPACE_ID: this.spec.workspace_id ?? '',
      // Suppress oh-my-zsh's "Would you like to check for updates? [Y/n]"
      // prompt. Without this it fires on the first pane of the day and
      // eats the first character of any startup_cmd as its answer.
      DISABLE_AUTO_UPDATE: 'true',
      DISABLE_UPDATE_PROMPT: 'true',
    };
    // Always spawn the shell interactively (no `-c`). When startup_cmd is set,
    // it's auto-typed into the shell so that when it exits the user is left
    // at a prompt — same scrollback, same cwd, same pane.
    this.process = pty.spawn(this.spec.shell, [], {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.spec.cwd,
      env,
    });
    this.process.onData((data) => {
      const ev = this.scanner.feed(data);
      if (ev.bel && !this.needsAttention) {
        this.needsAttention = true;
        // Emit only on the false→true transition so the manager can
        // eagerly broadcast a pane.updated without waiting for the next
        // cmd-poll tick. Each subsequent BEL within the same "unseen"
        // window is intentionally suppressed.
        this.emit('attention-changed', true);
      }
      if (ev.title !== undefined) this.currentTitle = ev.title;
      // App-url detection: ptyd only *extracts* raw sightings here (cheap,
      // sync). Host classification + the listening probe + tracking live on
      // the main server (see ptyd-cache / app-url-detector), so that logic
      // can change with a server-only restart instead of a ptyd bounce that
      // kills every terminal. Forward the raw lists for the server to judge.
      if (ev.urls !== undefined || ev.markers !== undefined) {
        this.emit('urls-seen', ev.urls ?? [], ev.markers ?? []);
      }
      // Any output chunk is activity → the pane is busy. markBusy() handles
      // the false→true transition (eager emit) and (re)arms the decay timer.
      // Done AFTER the scanner/BEL/title work so, on the very first output
      // chunk, attention/title/fg surface with their real first-sample values
      // rather than the all-null/false snapshot a busy-triggered emit would
      // otherwise capture first.
      this.markBusy();
      this.buffer.push(data);
      this.emit('output', data);
    });
    this.process.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      // A dead pane isn't busy. Cancel the decay timer and clear the flag
      // (emitting the transition) so a tab whose pane just exited mid-run
      // doesn't keep a stale spinner until the timer would have fired.
      this.clearBusy();
      this.emit('exit', exitCode);
    });
    if (this.spec.startup_cmd) {
      // Small delay so the shell has time to print its prompt first; harmless
      // for headless shells, makes the UX nicer for interactive ones. Tracked
      // so kill() can cancel before we try to write to a dead PTY.
      const cmd = this.spec.startup_cmd;
      this.startupTimer = setTimeout(() => {
        this.startupTimer = null;
        if (this.exited) return;
        try {
          this.process?.write(`${cmd}\n`);
        } catch {
          // PTY closed in the gap; ignore.
        }
      }, 50);
    }
  }

  write(data: string): void {
    this.process?.write(data);
    if (this.needsAttention) {
      this.needsAttention = false;
      // Emit on the true→false transition so the manager broadcasts the
      // clear immediately. Symmetric with the false→true emit in onData;
      // without this the cleared state would wait for the next cmd-poll
      // tick (~10s) to reach the cache and the UI dot would linger.
      // Emitted AFTER the PTY write so "attention cleared" implies the
      // user input actually reached the shell.
      this.emit('attention-changed', false);
    }
  }

  /** True iff this pane has rung BEL since the user last interacted with it. */
  getNeedsAttention(): boolean {
    return this.needsAttention;
  }

  /**
   * True iff the pane has produced output within the last BUSY_QUIET_MS —
   * the foreground app is actively working rather than idling at a prompt.
   */
  getBusy(): boolean {
    return this.busy;
  }

  /**
   * Note output activity: flip to busy (emitting the false→true transition
   * so the manager can fan it out eagerly, without waiting for the next poll
   * tick) and (re)arm the decay timer that returns the pane to idle after a
   * quiet window. Called once per output chunk.
   */
  private markBusy(): void {
    if (!this.busy) {
      this.busy = true;
      this.emit('busy-changed', true);
    }
    if (this.busyTimer) clearTimeout(this.busyTimer);
    this.busyTimer = setTimeout(() => {
      this.busyTimer = null;
      if (this.busy) {
        this.busy = false;
        this.emit('busy-changed', false);
      }
    }, BUSY_QUIET_MS);
    // Don't let the decay timer keep the daemon's event loop alive.
    this.busyTimer.unref?.();
  }

  /** Cancel the decay timer and clear busy (emitting the transition if set). */
  private clearBusy(): void {
    if (this.busyTimer) {
      clearTimeout(this.busyTimer);
      this.busyTimer = null;
    }
    if (this.busy) {
      this.busy = false;
      this.emit('busy-changed', false);
    }
  }

  /** Clear the attention flag without writing input (e.g. user opened the tab). */
  markSeen(): void {
    if (this.needsAttention) {
      this.needsAttention = false;
      // See write() — emit so the clear broadcasts eagerly, not on the
      // next 10s cmd-poll tick.
      this.emit('attention-changed', false);
    }
  }

  /** Latest terminal title emitted via OSC 0/1/2, or null if no title set yet. */
  getCurrentTitle(): string | null {
    return this.currentTitle;
  }

  /**
   * Best-effort async lookup of the foreground process command in this
   * pane's controlling tty. Used as a fallback display name when the
   * running program doesn't set a terminal title. Returns null if the
   * process is gone, ps doesn't behave as expected, or the foreground
   * pgid couldn't be resolved.
   *
   * Async (vs the older execFileSync version) so polling many panes in
   * parallel doesn't block the event loop while ps runs. The two ps
   * calls per pane each cost a few ms; in aggregate that adds up.
   */
  async getForegroundCommand(): Promise<string | null> {
    if (!this.process || this.exited) return null;
    try {
      // tpgid = the process group ID currently in the foreground of the
      // pty's controlling terminal. For a shell sitting at a prompt this
      // equals the shell's own pid. While running e.g. `vim` it's vim.
      const tpgidResult = await execFileAsync(
        'ps',
        ['-p', String(this.process.pid), '-o', 'tpgid='],
        { timeout: 1500, encoding: 'utf-8' },
      );
      const tpgid = Number(tpgidResult.stdout.trim());
      if (!Number.isFinite(tpgid) || tpgid <= 0) return null;
      // Prefer `args=` (full command line) over `comm=` (basename only)
      // so we can show "pnpm dev:tui" instead of just "pnpm" or "node".
      const argsResult = await execFileAsync('ps', ['-p', String(tpgid), '-o', 'args='], {
        timeout: 1500,
        encoding: 'utf-8',
      });
      const args = argsResult.stdout.trim();
      if (!args) return null;
      return prettifyCommand(args);
    } catch {
      return null;
    }
  }

  /**
   * Report a client's terminal size. Last-writer-wins: the PTY adopts this
   * size immediately. Correctness against phantom/stale viewers is enforced
   * client-side — only a visible tab sends resizes (see the connectedClients
   * comment near the field declaration). Also registers the client id so
   * clientCount() reflects it even if this is its first message.
   */
  setClientSize(clientId: string, cols: number, rows: number): void {
    this.connectedClients.add(clientId);
    if (cols < 1 || rows < 1) return;
    // Sanity floor, mirroring the web client's MIN_COLS/MIN_ROWS: a
    // well-behaved client never sends below 20x5 (its fit paths refuse
    // to), so anything smaller is a buggy/stale client measuring a
    // degenerate viewport. Observed in the wild as an 8x4 SIGWINCH storm
    // from a backgrounded mobile browser that blanked every other view of
    // the pane. proxyAttach drops these before they reach a running ptyd;
    // this guard makes ptyd itself safe once it's eventually restarted.
    // Kept below real device minimums — a large-font phone is ~36 cols.
    if (cols < 20 || rows < 5) {
      console.warn(
        `[size] pane=${this.spec.id} client=${clientId.slice(-6)} REJECTED sub-floor ${cols}x${rows}`,
      );
      return;
    }
    if (cols === this.cols && rows === this.rows) return;
    const prevCols = this.cols;
    const prevRows = this.rows;
    this.cols = cols;
    this.rows = rows;
    if (!this.process) return;
    try {
      this.process.resize(cols, rows);
    } catch (err) {
      // PTY may have exited mid-resize. Roll back our local tracker so the
      // next resize call won't dedup against state we never applied.
      this.cols = prevCols;
      this.rows = prevRows;
      const stack = err instanceof Error && err.stack ? err.stack : undefined;
      console.error(
        `[size] pane=${this.spec.id} client=${clientId.slice(-6)} FAILED ${prevCols}x${prevRows} → ${cols}x${rows} err=${String(err)}${stack ? `\n${stack}` : ''}`,
      );
    }
  }

  /**
   * Drop a client from the connected set (call on disconnect). The PTY keeps
   * its last size — there is no recompute. The next resize from any remaining
   * (visible) client updates it.
   */
  removeClient(clientId: string): void {
    this.connectedClients.delete(clientId);
  }

  /** Number of clients currently connected to this pane. */
  clientCount(): number {
    return this.connectedClients.size;
  }

  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    this.exitCause = 'killed';
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
    // Stop the busy decay timer up front; onExit also calls clearBusy(), but
    // a SIGKILL fallback path may not deliver onExit promptly.
    this.clearBusy();
    if (!this.process || this.exited) return;
    try {
      this.process.kill(signal);
    } catch {
      // Already dead.
    }
  }

  getExitCause(): 'natural' | 'killed' {
    return this.exitCause;
  }

  isExited(): boolean {
    return this.exited;
  }

  getExitCode(): number {
    return this.exitCode;
  }

  snapshot(): string {
    return this.buffer.snapshot();
  }

  /**
   * Best-effort lookup of the shell's current working directory via lsof on
   * the PTY process pid. Reflects wherever the user cd'd to inside the shell,
   * which is what we want when spawning a sibling pane that should "inherit"
   * the cwd. Returns null if the process is gone or lsof isn't available.
   */
  getCurrentCwd(): string | null {
    if (!this.process || this.exited) return null;
    try {
      const output = execFileSync(
        'lsof',
        ['-p', String(this.process.pid), '-F', 'n', '-a', '-d', 'cwd'],
        { timeout: 1500, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      for (const line of output.split('\n')) {
        // lsof -F n prefixes name fields with 'n'
        if (line.startsWith('n/')) return line.slice(1);
      }
    } catch {
      // lsof missing, process gone, or timed out
    }
    return null;
  }

  override on(event: 'output', listener: Listener<[string]>): this;
  override on(event: 'exit', listener: Listener<[number]>): this;
  override on(event: 'attention-changed', listener: Listener<[boolean]>): this;
  override on(event: 'busy-changed', listener: Listener<[boolean]>): this;
  override on(event: 'urls-seen', listener: Listener<[string[], AppUrlMarker[]]>): this;
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override off(event: 'output', listener: Listener<[string]>): this;
  override off(event: 'exit', listener: Listener<[number]>): this;
  override off(event: 'attention-changed', listener: Listener<[boolean]>): this;
  override off(event: 'busy-changed', listener: Listener<[boolean]>): this;
  override off(event: 'urls-seen', listener: Listener<[string[], AppUrlMarker[]]>): this;
  override off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}
