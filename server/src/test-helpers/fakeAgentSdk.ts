// A stand-in for `@anthropic-ai/claude-agent-sdk` that lets a test DRIVE the
// Claude backend's real message loop.
//
// Why this exists: `createClaudeBackend` calls `query()` at construction, so
// every unit test to date has had to stop at the seams either side of the loop
// — `applyTaskLifecycle` and `SubagentRoster` below it, `claudeSystemPromptOption`
// above it. The DISPATCH itself (which SDK message shape reaches which roster
// method) has never been executed by a test, and that is the layer where the
// subagent count is actually computed. Mocking the module puts the real loop,
// the real roster and the real wire frames under test with scripted input.
//
// Message shapes fed through here are TRANSCRIBED from a live SDK probe
// (scripts/sdk-task-probe.mjs, SDK 0.3.220) rather than invented — see
// sdkScript.ts, which builds them.

/** Everything a test needs to steer one fake `query()` session. */
export interface FakeSession {
  /** Deliver one SDK message to the backend's `for await` loop. */
  push(msg: unknown): void;
  /** Close the stream (the loop returns and `start()` resolves). */
  end(): void;
  /** Resolve once the loop has consumed every message pushed so far. */
  settle(): Promise<void>;
  /** Options the backend passed to `query()`. */
  readonly options: Record<string, unknown>;
  /** How many times the backend called `interrupt()`. */
  readonly interrupts: number;
  /** Set by a test to make `interrupt()` reject (the stop-failed path). */
  interruptRejects: boolean;
  /** True once the backend called `close()`. */
  readonly closed: boolean;
}

let current: FakeSessionImpl | null = null;

/** The session created by the backend's `query()` call. Throws if none yet. */
export function fakeSession(): FakeSession {
  if (!current) throw new Error('fakeAgentSdk: no session — construct the backend first');
  return current;
}

/** Drop the session between tests. */
export function resetFakeAgentSdk(): void {
  current = null;
}

/** A settle marker: a `system` message with a subtype the loop ignores. */
const SETTLE_SUBTYPE = '__fake_settle__';

class FakeSessionImpl implements FakeSession {
  private readonly buf: unknown[] = [];
  private wake: (() => void) | null = null;
  private finished = false;
  private readonly settlers = new Map<number, () => void>();
  private settleSeq = 0;
  interrupts = 0;
  interruptRejects = false;
  closed = false;

  constructor(readonly options: Record<string, unknown>) {}

  push(msg: unknown): void {
    this.buf.push(msg);
    this.wake?.();
    this.wake = null;
  }

  end(): void {
    this.finished = true;
    this.wake?.();
    this.wake = null;
  }

  settle(): Promise<void> {
    const id = ++this.settleSeq;
    return new Promise<void>((resolve) => {
      this.settlers.set(id, resolve);
      this.push({ type: 'system', subtype: SETTLE_SUBTYPE, settleId: id });
    });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
    while (true) {
      while (this.buf.length > 0) {
        const msg = this.buf.shift();
        const marker = msg as { subtype?: string; settleId?: number };
        if (marker?.subtype === SETTLE_SUBTYPE) {
          // Resolve on a macrotask so any promise chain the loop kicked off
          // for the PRECEDING message (emit → ws.send) has flushed first.
          const done = this.settlers.get(marker.settleId as number);
          this.settlers.delete(marker.settleId as number);
          if (done) setTimeout(done, 0);
          continue;
        }
        yield msg;
      }
      if (this.finished) return;
      await new Promise<void>((r) => {
        this.wake = r;
      });
    }
  }

  supportedModels(): Promise<Array<{ value: string; displayName: string }>> {
    return Promise.resolve([{ value: 'opus', displayName: 'Opus' }]);
  }

  getContextUsage(): Promise<Record<string, unknown>> {
    return Promise.resolve({ model: 'opus', usedTokens: 1, maxTokens: 100 });
  }

  setModel(_model: string): Promise<void> {
    return Promise.resolve();
  }

  interrupt(): Promise<void> {
    this.interrupts++;
    return this.interruptRejects
      ? Promise.reject(new Error('interrupt failed'))
      : Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.end();
  }
}

/** The mocked `query()`. The backend calls it twice: once for the session
 *  (streaming `prompt`), and once per self-title (a plain string prompt). */
export function query(args: { prompt: unknown; options?: Record<string, unknown> }): unknown {
  if (typeof args.prompt === 'string') {
    // The one-shot title query. Answer immediately so the fire-and-forget
    // title path completes instead of dangling past the test.
    return (async function* titleStream() {
      yield { type: 'result', subtype: 'success', result: 'Fake Title' };
    })();
  }
  // Drain the backend's user-message generator in the background so `send()`
  // resolves its queue exactly as the real SDK's consumption would.
  const prompts = args.prompt as AsyncIterable<unknown>;
  void (async () => {
    try {
      for await (const _ of prompts) {
        // The scripted stream, not this generator, drives the loop.
      }
    } catch {
      // The generator is torn down with the session.
    }
  })();
  current = new FakeSessionImpl(args.options ?? {});
  return current;
}

/** The in-process MCP server factory — the backend only stores the result. */
export function createSdkMcpServer(config: unknown): unknown {
  return { type: 'sdk', name: (config as { name?: string })?.name ?? 'fake', instance: {} };
}

/** The MCP tool factory — the backend only stores the result. */
export function tool(
  name: string,
  description: string,
  schema: unknown,
  handler: unknown,
): unknown {
  return { name, description, inputSchema: schema, handler };
}
