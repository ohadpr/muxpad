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
  resumeSid: string;
  text: string;
  cb?: HeadlessRunnerCallbacks;
  /** Override the claude binary (tests). */
  bin?: string;
  /** Extra args before the prompt (tests / future). */
  extraArgs?: string[];
}

/**
 * Drives ONE turn of a Claude session headlessly: `claude -p <text> --resume
 * <sid> --output-format stream-json --permission-mode bypassPermissions`. The
 * turn is appended to the same transcript file, so the existing TranscriptTail
 * on /ws/chat renders it — this runner does NOT re-emit chat events. Its only
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

  constructor(private readonly opts: HeadlessRunnerOpts) {}

  start(): void {
    const bin = this.opts.bin ?? 'claude';
    const args = [
      ...(this.opts.extraArgs ?? []),
      '-p',
      this.opts.text,
      '--resume',
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
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (e) {
      this.finish(false, e instanceof Error ? e.message : String(e));
      return;
    }
    this.proc = proc;
    proc.stdout?.on('data', (d: Buffer) => this.onStdout(d.toString('utf8')));
    proc.stderr?.on('data', (d: Buffer) => {
      this.errText += d.toString('utf8');
    });
    proc.on('error', (e) => this.finish(false, e.message));
    proc.on('exit', (code) =>
      this.finish(code === 0, code === 0 ? undefined : this.errText.trim() || `exit ${code}`),
    );
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
      // The init event carries the (possibly new) session-id.
      if (obj.type === 'system' && obj.subtype === 'init' && typeof obj.session_id === 'string') {
        this.opts.cb?.onSessionId?.(obj.session_id);
      }
      // Also present on the final `result` event; harmless to re-capture.
      if (obj.type === 'result' && typeof obj.session_id === 'string') {
        this.opts.cb?.onSessionId?.(obj.session_id);
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
    this.opts.cb?.onDone?.(ok, error);
  }

  /** Graceful interrupt of the in-flight turn (the chat Stop button). */
  interrupt(): void {
    this.proc?.kill('SIGTERM');
  }

  get running(): boolean {
    return this.proc !== null && !this.done;
  }
}
