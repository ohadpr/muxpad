import {
  type BrowserAppState,
  type EnsureBrowserAppDeps,
  ensureBrowserApp,
} from './BrowserApps.js';

/**
 * Starts a browser because somebody asked to use it, and waits for it to answer.
 *
 * TWO DOORS, ONE ROOM. An agent's first tool call arrives at the CDP endpoint;
 * a person tapping a card arrives at the viewer. Both are somebody reaching for
 * a browser that, since browsers became lazy, is usually not running — and only
 * the first door knew how to open it. The second returned a bare
 * "the browser is not running" 502, which is a dead end at the exact moment
 * somebody asked to look.
 *
 * Waiting is the point. Chrome takes a couple of seconds from cold, and the
 * alternative to waiting is an error for something that was about to work.
 */
export interface WakeResult {
  state: BrowserAppState;
  /** Whether it answered before the deadline. */
  awake: boolean;
}

export async function wakeBrowser(opts: {
  profile: string;
  deps: EnsureBrowserAppDeps;
  /** Asked repeatedly until it answers. */
  probe: (state: BrowserAppState) => Promise<boolean>;
  timeoutMs?: number;
  /** Injected so a test does not wait in real seconds. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<WakeResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const state = await ensureBrowserApp(opts.profile, opts.deps);
  const deadline = now() + (opts.timeoutMs ?? 30_000);
  for (;;) {
    if (await opts.probe(state)) return { state, awake: true };
    if (now() > deadline) return { state, awake: false };
    await sleep(200);
  }
}
