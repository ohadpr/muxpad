import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { TaskStore } from './TaskStore.js';
import { recentChatEvents } from './last-message.js';
import { CONTINUATION_LIMIT } from './task-continue.js';
import {
  type YieldVerdict,
  asksTheOwner,
  hardStop,
  parseVerdict,
  renderYieldProd,
  yieldPair,
  yieldPrompt,
} from './yield-gate.js';

/**
 * THE ANTI-YIELD GATE, WIRED — a subscriber on the turn bus.
 *
 * This is HeadlineWriter's shape on purpose: watch `agent_turn`/`done`, read
 * the finished turn, ask a small model one question, write the answer back.
 * The first attempt hooked the socket handler instead and was backed out —
 * the frame handler is the most delicate code in the server and this needs
 * none of it.
 *
 * WHAT IT DOES, ONCE: a chat tries to hand the controls back with no task
 * recorded. The gate decides whether the owner would call that done. If not,
 * it writes the task the agent should have written and sends one prod — after
 * which every guard in task-continue.ts governs the NEXT yield, because by
 * then there is a task for them to govern. That is the point of synthesising
 * it: six chats out of 2,434 ever declared one, so the budget and the
 * anti-loop have never had anything to count.
 *
 * ── EVERYTHING HERE FAILS TOWARD HANDING OVER ───────────────────────────
 *
 * No pane, no tab, no transcript, no model, a model that errors or times out,
 * a reply that will not parse: all of them leave the yield exactly as it was
 * found. The gate may only ever make the cockpit LESS likely to stop.
 */
export class YieldGate {
  private readonly db: Database.Database;
  private readonly events: EventBus;
  private readonly send: (paneId: string, text: string) => { status: string; reason?: string };
  private readonly decide: (prompt: string) => Promise<string>;
  private readonly isOwner: (text: string) => boolean;
  private readonly log: (line: string) => void;
  private unsubscribe: (() => void) | null = null;
  private pending: Promise<unknown> = Promise.resolve();
  private readonly inFlight = new Set<string>();

  constructor(opts: {
    db: Database.Database;
    events: EventBus;
    /** The ordinary send road, so a prod is indistinguishable from any other
     *  message: same durable queue, same drain, same Stop button. */
    send: (paneId: string, text: string) => { status: string; reason?: string };
    /** One tool-free completion. Injected so the decision is testable without
     *  a model and so the account pool stays the caller's concern. */
    decide: (prompt: string) => Promise<string>;
    /** "A person said this" — the send road's own predicate. */
    isOwner: (text: string) => boolean;
    log?: (line: string) => void;
  }) {
    this.db = opts.db;
    this.events = opts.events;
    this.send = opts.send;
    this.decide = opts.decide;
    this.isOwner = opts.isOwner;
    this.log = opts.log ?? ((l) => console.log(l));
  }

  start(): void {
    this.unsubscribe = this.events.subscribe((e) => {
      if (e.type !== 'agent_turn' || e.phase !== 'done') return;
      // Stop means stop. It is not advice.
      if (e.stopped) return;
      // A turn that backgrounded work has not yielded: that work will start
      // another turn on its own, and prodding now races it.
      if (typeof e.background === 'number' && e.background > 0) return;
      this.pending = this.pending.then(() => this.consider(e.pane_id)).catch(() => {});
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** In-flight work settles (tests await this between assertions). */
  async idle(): Promise<void> {
    await this.pending;
  }

  private async consider(paneId: string): Promise<void> {
    if (this.inFlight.has(paneId)) return;
    const pane = new PaneStore(this.db).getById(paneId);
    if (!pane) return;
    const tabId = pane.tab_id;
    const tabs = new TabStore(this.db);
    const tab = tabs.getById(tabId);
    if (!tab) return;
    const tasks = new TaskStore(this.db);
    const open = tasks.openFor(tabId);

    const stop = hardStop({
      // A declared task is task-continue.ts's business, not this gate's: it
      // has already run by the time this event lands.
      task: open,
      spawned: !!tab.spawned_by,
      queued: 0,
      blocked: false,
      stopped: false,
      turnFailed: false,
    });
    if (stop || open) return;

    const events = recentChatEvents(this.db, paneId);
    if (!events || events.length === 0) return;
    const pair = yieldPair(events, this.isOwner);
    // Nothing the owner said, nothing the chat said: there is no yield here
    // to have an opinion about.
    if (!pair.ask && !pair.closing) return;
    // A CHAT THAT IS ASKING HIM SOMETHING IS ALREADY YIELDING TO HIM, and
    // deliberately. Checked here rather than left to the model, because the
    // model got it wrong on exactly this case and the cost was a chat driven
    // further into work he did not want. See asksTheOwner.
    if (asksTheOwner(pair.closing)) {
      this.log(`[yield] ${tabId}: handed over — the chat is asking him something`);
      return;
    }

    this.inFlight.add(paneId);
    try {
      const raw = await this.decide(yieldPrompt(pair));
      const verdict: YieldVerdict = parseVerdict(raw);
      if (verdict.kind !== 'prod') {
        this.log(`[yield] ${tabId}: handed over — ${verdict.why}`);
        return;
      }
      // The task the agent should have written. Everything downstream — the
      // budget, the progress rule, the chat's own task UI — works from here.
      const task = tasks.create(tabId, {
        request: pair.ask || verdict.message,
        next_step: verdict.message,
      });
      // Stamp BEFORE the send, as the continuation path does: a send that is
      // relayed and then fails to record its attempt is an unbounded loop.
      tasks.noteContinuation(task.id);
      const out = this.send(
        paneId,
        renderYieldProd(verdict, { attempt: 1, limit: CONTINUATION_LIMIT }),
      );
      this.log(
        out.status === 'rejected'
          ? `[yield] ${tabId}: prod refused — ${out.reason ?? 'no reason'}`
          : `[yield] ${tabId}: prodded — ${verdict.why}`,
      );
    } catch (err) {
      // Including the model being unavailable. The yield stands.
      this.log(`[yield] ${tabId}: handed over — the gate failed (${String(err)})`);
    } finally {
      this.inFlight.delete(paneId);
    }
  }
}
