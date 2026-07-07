import { type ChildProcess, spawn } from 'node:child_process';

export interface HeadlessRunnerCallbacks {
  /** The provider session-id from the stream's init event (may differ from the resumed id). */
  onSessionId?: (sid: string) => void;
  /** Streaming assistant text deltas (for a live "typing" preview in chat). */
  onText?: (delta: string) => void;
  /** Turn finished. ok=false with an optional message on error/nonzero exit. */
  onDone?: (ok: boolean, error?: string) => void;
}

export interface HeadlessRunnerOpts {
  cwd: string;
  /** The session-id to resume — or to CREATE when `fresh` is set. */
  resumeSid: string;
  /**
   * First turn of a session whose transcript doesn't exist yet (launched via
   * `muxpad claude` but never prompted): `--resume` would fail with "no
   * conversation found", so start the session fresh under the same id
   * (`--session-id`) instead. The transcript lands under that id, so the tail
   * and later resumes line up.
   */
  fresh?: boolean;
  text: string;
  cb?: HeadlessRunnerCallbacks;
  /** Override the claude binary (tests). */
  bin?: string;
  /** Extra args before the prompt (tests / future). */
  extraArgs?: string[];
  /** Startup watchdog in ms (tests shrink it). Kills a claude that never emits an event. */
  startTimeoutMs?: number;
}

/**
 * Drives ONE turn of a Claude session headlessly: `claude -p --resume <sid>
 * --output-format stream-json --permission-mode bypassPermissions`, with the
 * prompt written to stdin (argv would misparse a message starting with `-`,
 * and argv has size limits a long pasted message can hit). The turn is
 * appended to the same transcript file, so the existing TranscriptTail on
 * /ws/chat renders it — this runner does NOT re-emit chat events. Its only
 * jobs are (a) capture the session-id from the init event (lineage), and (b)
 * signal turn completion so the caller can release the single-writer lock.
 *
 * Per-turn + resume is the restart-safe shape every real tool uses (Sculptor/
 * CloudCLI/opcode). `bypassPermissions` (NOT the `--dangerously-skip-permissions`
 * flag, which blocks on a TTY confirm) runs non-interactively.
 */
export class HeadlessRunner {
  private proc: ChildProcess | null = null;
  private outBuf = '';
  private errText = '';
  private done = false;
  private interrupted = false;
  private sawEvent = false;
  private reapTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private startTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly opts: HeadlessRunnerOpts) {}

  start(): void {
    const bin = this.opts.bin ?? 'claude';
    const args = [
      ...(this.opts.extraArgs ?? []),
      '-p',
      ...(this.opts.fresh ? ['--session-id'] : ['--resume']),
      this.opts.resumeSid,
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'bypassPermissions',
    ];
    let proc: ChildProcess;
    try {
      proc = spawn(bin, args, {
        cwd: this.opts.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (e) {
      this.finish(false, e instanceof Error ? e.message : String(e));
      return;
    }
    this.proc = proc;
    // Prompt over stdin (`claude -p` reads it when no positional prompt is
    // given), then EOF so the turn starts.
    proc.stdin?.on('error', () => {
      // EPIPE if claude died before reading — the exit handler reports it.
    });
    proc.stdin?.end(this.opts.text);
    proc.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => {
      this.errText += d.toString('utf8');
    });
    proc.on('error', (e) => this.finish(false, e.message));
    proc.on('exit', (code) => {
      if (this.interrupted) {
        // A user Stop is a clean end of the turn, not a failure — the partial
        // work is already on disk and the composer should return to idle
        // without an error banner.
        this.finish(true);
        return;
      }
      this.finish(code === 0, code === 0 ? undefined : this.errText.trim() || `exit ${code}`);
    });
    // Startup watchdog: a healthy `claude -p` emits its init event within a
    // couple of seconds. If NOTHING parseable arrives, the child is wedged
    // (bad PATH shim, waiting on something it can't get) — kill it so the
    // single-writer lock releases instead of the pane hanging forever.
    this.startTimer = setTimeout(() => {
      if (!this.sawEvent && !this.done) {
        try {
          this.proc?.kill('SIGKILL');
        } catch {
          // already gone
        }
        this.finish(false, this.errText.trim() || 'claude produced no output (startup timeout)');
      }
    }, this.opts.startTimeoutMs ?? 30_000);
  }

  private onStdout(chunk: string): void {
    this.outBuf += chunk;
    const lines = this.outBuf.split('\n');
    this.outBuf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.sawEvent = true;
      // The init event carries the (possibly new) session-id.
      if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
        this.opts.cb?.onSessionId?.(obj.session_id);
      }
      // The final `result` event also carries the session-id (harmless to
      // re-capture) and marks the turn logically complete. If the child then
      // hangs on teardown (stuck stdout, leaked MCP child), reap it so onDone
      // still fires and the single-writer lock releases — otherwise the pane
      // wedges forever with "a turn is already running".
      if (obj.type === 'result') {
        if (typeof obj.session_id === 'string') this.opts.cb?.onSessionId?.(obj.session_id);
        if (!this.reapTimer && !this.done) {
          this.reapTimer = setTimeout(() => {
            try {
              this.proc?.kill('SIGKILL');
            } catch {
              // already gone
            }
            this.finish(true);
          }, 5000);
        }
      }
      // Streaming text deltas (--include-partial-messages) for a live preview.
      if (obj.type === 'stream_event') {
        const evt = obj.event as
          | { type?: string; delta?: { type?: string; text?: string } }
          | undefined;
        if (
          evt?.type === 'content_block_delta' &&
          evt.delta?.type === 'text_delta' &&
          typeof evt.delta.text === 'string'
        ) {
          this.opts.cb?.onText?.(evt.delta.text);
        }
      }
    }
  }

  private finish(ok: boolean, error?: string): void {
    if (this.done) return;
    this.done = true;
    if (this.reapTimer) clearTimeout(this.reapTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    if (this.startTimer) clearTimeout(this.startTimer);
    this.opts.cb?.onDone?.(ok, error);
  }

  /** Interrupt the in-flight turn (the chat Stop button). SIGTERM, then SIGKILL
   * if it doesn't die — otherwise a stubborn child holds the single-writer lock. */
  interrupt(): void {
    this.interrupted = true;
    this.proc?.kill('SIGTERM');
    if (!this.killTimer && !this.done) {
      this.killTimer = setTimeout(() => {
        if (!this.done) {
          try {
            this.proc?.kill('SIGKILL');
          } catch {
            // already gone
          }
        }
      }, 2000);
    }
  }

  get running(): boolean {
    return this.proc !== null && !this.done;
  }
}
