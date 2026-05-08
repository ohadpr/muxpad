import { EventEmitter } from 'node:events';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import * as pty from 'node-pty';
import { RingBuffer } from './RingBuffer.js';
import { PtyScanner } from './pty-scanner.js';

const execFileAsync = promisify(execFile);

const RING_CAPACITY = 2 * 1024 * 1024; // 2MB

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
  // The PTY only has one size, but the pane can be mirrored across multiple
  // clients of different sizes. We track each client's reported size and
  // resize the PTY to the MIN across them so the smaller view never has to
  // wrap output meant for a wider terminal (which is what causes garbling).
  private clientSizes = new Map<string, { cols: number; rows: number }>();
  cols = 80;
  rows = 24;
  // True iff this pane has emitted a "real" BEL (\x07) since the user
  // last interacted with it. Set by the scanner in the output callback;
  // cleared by write() (user typed) or markSeen() (user opened the
  // workspace tab). The workspace list endpoint folds these into a
  // per-workspace attention flag so the tab bar can render a dot.
  private needsAttention = false;
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
    const env: Record<string, string> = {
      ...sanitizeEnv(process.env),
      ...(this.spec.env ?? {}),
      TERM: 'xterm-256color',
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
      if (ev.bel && !this.needsAttention) this.needsAttention = true;
      if (ev.title !== undefined) this.currentTitle = ev.title;
      this.buffer.push(data);
      this.emit('output', data);
    });
    this.process.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
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
    if (this.needsAttention) this.needsAttention = false;
    this.process?.write(data);
  }

  /** True iff this pane has rung BEL since the user last interacted with it. */
  getNeedsAttention(): boolean {
    return this.needsAttention;
  }

  /** Clear the attention flag without writing input (e.g. user opened the tab). */
  markSeen(): void {
    this.needsAttention = false;
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
      const argsResult = await execFileAsync(
        'ps',
        ['-p', String(tpgid), '-o', 'args='],
        { timeout: 1500, encoding: 'utf-8' },
      );
      const args = argsResult.stdout.trim();
      if (!args) return null;
      return prettifyCommand(args);
    } catch {
      return null;
    }
  }


  /** Report a client's terminal size; PTY uses the min across all clients. */
  setClientSize(clientId: string, cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    this.clientSizes.set(clientId, { cols, rows });
    this.recomputeSize();
  }

  /** Drop a client's size contribution (call on disconnect). */
  removeClient(clientId: string): void {
    if (!this.clientSizes.delete(clientId)) return;
    this.recomputeSize();
  }

  private recomputeSize(): void {
    if (this.clientSizes.size === 0) return; // keep last known size
    let cols = Number.POSITIVE_INFINITY;
    let rows = Number.POSITIVE_INFINITY;
    for (const s of this.clientSizes.values()) {
      if (s.cols < cols) cols = s.cols;
      if (s.rows < rows) rows = s.rows;
    }
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    if (this.process) {
      try {
        this.process.resize(cols, rows);
      } catch {
        // PTY may have exited mid-resize; ignore.
      }
    }
  }

  kill(signal: NodeJS.Signals = 'SIGHUP'): void {
    this.exitCause = 'killed';
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
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
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }

  override off(event: 'output', listener: Listener<[string]>): this;
  override off(event: 'exit', listener: Listener<[number]>): this;
  override off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}
