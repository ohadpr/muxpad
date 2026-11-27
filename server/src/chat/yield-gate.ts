/**
 * THE ANTI-YIELD GATE — what happens when a chat tries to hand the controls
 * back to the owner.
 *
 * ── THE PROBLEM, MEASURED ────────────────────────────────────────────────
 *
 * "The main chat is too fragile in the sense that all it takes is the harness
 * deciding it's done and calling the tool that tells me, and bam, work is
 * halted until I approve or answer a stupid question."
 *
 * muxpad already had an answer to this: `task-continue.ts`, a continuation
 * budget of six, an anti-loop that stops a circling task at two, wired at
 * turn end. It opens with `if (!task) return { continue: false }` — autonomy
 * had to be ASKED for by writing a task down. Measured on this install: six
 * tasks ever declared, across 2,434 chats, by four of them; eighteen
 * continuations spent across some 27,500 turns. The mechanism was sound and
 * effectively dead, because declaring a task is exactly the bookkeeping a
 * model skips when it believes it is nearly finished.
 *
 * So the gate replaces the opt-in with a judgement, and writes the task the
 * agent should have written — which makes every guard downstream (the budget,
 * the progress rule, the UI) work unchanged.
 *
 * ── IT IS AUTOPILOT, NOT A PILOT ─────────────────────────────────────────
 *
 * One way, and only at a YIELD. It never interrupts a working agent, never
 * escalates, never rings anybody: "this is an anti yield mechanism". The only
 * moment it has an opinion is the moment work would otherwise stop.
 *
 * And the standard does not move with where the owner is. Bolder at 3am was
 * offered and declined — "doesn't matter, this is like autopilot" — so the
 * same question gets the same answer whether he is at the keyboard or asleep.
 *
 * ── WHAT IT ASKS ITSELF ──────────────────────────────────────────────────
 *
 * Not "is this report any good". The question is his: "what is Ohad's goal
 * here, and would he consider this done — or what would he answer this with,
 * or what follow-up clarification, proof, scale or capability would he ask
 * for?" That framing is the product, so it lives in `yieldPrompt` where a
 * test can hold it, not in a string somewhere.
 *
 * ── THE ONE RULE THAT IS NOT NEGOTIABLE ──────────────────────────────────
 *
 * Every unknown resolves to DELIVER. A model that errors, times out, returns
 * something unparseable, or simply has no view hands the turn to the owner,
 * because that is the behaviour muxpad had before this existed. The gate may
 * only ever make the cockpit *less* likely to stop; it must never be able to
 * trap work inside a chat.
 */
import type { ChatEvent } from '@muxpad/shared';
import type { Task } from './TaskStore.js';
import { CONTINUATION_LIMIT, type ContinueContext } from './task-continue.js';

/**
 * What the gate decided. `prod` is the message injected back into the chat —
 * the answer, the clarification, or the next instruction — in the gate's own
 * voice (see `YIELD_SPEAKER`), never in the owner's.
 */
export type YieldVerdict =
  | { kind: 'deliver'; why: string }
  | { kind: 'prod'; message: string; why: string };

/**
 * The gate speaks as ITSELF, never as the owner, and this is not only about
 * the chat's label.
 *
 * Every word the owner has ever typed is archived, and that archive is the
 * only record of what he actually wants — it is what a future version of this
 * gate learns "what would Ohad answer" FROM. A machine that writes in his
 * voice poisons its own training data, quietly and irreversibly, and nothing
 * downstream could ever tell the two apart again.
 */
export const YIELD_SPEAKER = 'muxpad';

/** Everything the gate needs that is not the conversation itself. */
export interface YieldContext extends ContinueContext {
  /** The open task, if the chat (or a previous prod) declared one. */
  task: Task | null;
  /** Is this a sub-chat? Its parent is its reader; the gate leaves it alone. */
  spawned: boolean;
}

/**
 * The reasons to hand over that no judgement may overrule, in the order they
 * are checked. Returns the reason, or null when the gate is allowed an
 * opinion.
 *
 * These are deliberately the same conditions `shouldContinue` already stops
 * on, plus the two that are about the gate itself. They are hard because each
 * one means the chat is waiting for something only a person can supply, and
 * prodding there is muxpad talking over the answer it asked for.
 */
export function hardStop(ctx: YieldContext): string | null {
  if (ctx.spawned) return 'a sub-chat reports to its parent, not to the owner';
  if (ctx.stopped) return 'the turn was stopped';
  if (ctx.blocked) return 'the chat is waiting on a question it asked';
  if (ctx.turnFailed) return 'the turn ended in failure';
  if (ctx.queued > 0) return 'work is already queued';
  const task = ctx.task;
  if (task && task.state === 'open') {
    if (task.continuations >= CONTINUATION_LIMIT) return 'the continuation budget is spent';
    // A prod is EARNED by progress. `continued_from` holds the `updated_at`
    // the last one was spent against: unchanged means the chat went round the
    // same loop, and the second lap is where that stops.
    if (task.continued_from !== null && task.updated_at <= task.continued_from) {
      return 'nothing moved since the last prod';
    }
  }
  return null;
}

/**
 * The gate's own question, as sent to the model.
 *
 * `ask` is the last thing the OWNER said and it is the single most important
 * input: when his message was itself a question, the answer IS the
 * deliverable and the turn is correctly over. Most of the gate's value is in
 * not getting that one wrong.
 */
export function yieldPrompt(input: { ask: string; closing: string }): string {
  return [
    'You are the autopilot of a developer cockpit. A chat is about to hand control',
    'back to its owner, Ohad. Decide whether it should.',
    '',
    'Ask yourself, in this order:',
    "  1. What is Ohad's GOAL here — not the literal words, the outcome he wants?",
    '  2. Would he consider that goal DONE?',
    '  3. If the chat is asking him something, what would HE answer? Answer it',
    '     yourself when the answer is knowable — from the repo, from what he has',
    '     already said, or from any choice that is reversible. He would rather you',
    '     decided and told him than stopped and asked.',
    '  4. What follow-up would he ask for — clarification, proof it works, scale,',
    '     or a capability he obviously wants next? If there is an obvious one,',
    '     that is the next instruction, not a question for him.',
    '',
    'Hand over (DELIVER) when: his message was a question and it has been answered;',
    'the goal is genuinely met; the decision left is irreversible, costs real money,',
    'reaches another person, or is a matter of his taste with no precedent.',
    '',
    'Otherwise PROD: write the next instruction, in the imperative, to the agent.',
    'Say what to do and why he would want it. One or two sentences. Never speak as',
    'Ohad and never invent an opinion of his you cannot point at.',
    '',
    'Reply with one line of JSON and nothing else:',
    '  {"verdict":"deliver","why":"..."}',
    '  {"verdict":"prod","message":"...","why":"..."}',
    '"why" is one short clause, for a human reading the log.',
    '',
    '--- What Ohad last said ---',
    input.ask.slice(0, 4000) || '(nothing — the chat began on its own)',
    '',
    '--- How the chat is ending ---',
    input.closing.slice(0, 4000) || '(it said nothing)',
  ].join('\n');
}

/**
 * Read the model's line. EVERY failure answers `deliver`, including a prod
 * with no message in it — see the module note: the gate may make the cockpit
 * less likely to stop, never more likely to trap.
 */
export function parseVerdict(raw: string): YieldVerdict {
  const line = raw.trim();
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return { kind: 'deliver', why: 'no verdict in the reply' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(start, end + 1));
  } catch {
    return { kind: 'deliver', why: 'the verdict was not JSON' };
  }
  const o = parsed as { verdict?: unknown; message?: unknown; why?: unknown };
  const why = typeof o.why === 'string' && o.why.trim() ? o.why.trim() : 'no reason given';
  if (o.verdict !== 'prod') return { kind: 'deliver', why };
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  if (!message) return { kind: 'deliver', why: 'a prod with nothing to say' };
  return { kind: 'prod', message, why };
}

/**
 * THE PROD, AS THE AGENT RECEIVES IT — and it is told who is speaking.
 *
 * The alternative was a prod that reads like an ordinary instruction, which
 * buys ordinary compliance. It was rejected for the failure it creates: an
 * agent that believes the owner asked for something, does a day of work on
 * it, and tells him so later. Naming the autopilot costs a little compliance
 * and buys the safety valve — an agent that can answer "this one really does
 * need him", which a silent gate has no way to hear.
 *
 * So the message says three things: who is speaking, what to do and why he
 * would want it, and how to refuse. The refusal is deliberately cheap: one
 * line and stop. Anything that makes pushing back expensive turns the valve
 * into decoration.
 */
export function renderYieldProd(
  verdict: Extract<YieldVerdict, { kind: 'prod' }>,
  budget: { attempt: number; limit: number },
): string {
  return [
    `[${YIELD_SPEAKER} autopilot — not Ohad, and he has not seen this turn]`,
    '',
    verdict.message,
    '',
    `Why you are getting this instead of handing back: ${verdict.why}.`,
    `Continuation ${budget.attempt} of ${budget.limit}; they are spent by finishing,`,
    'not by trying, so record what moved.',
    '',
    'If this genuinely needs Ohad — it is irreversible, it costs money, it reaches',
    'another person, or it is his taste with no precedent — say so in one line and',
    'stop. That reaches him. Do not argue with this message; either carry on or',
    'name the thing only he can settle.',
  ].join('\n');
}

/**
 * THE TWO SIDES OF THE YIELD, out of a transcript tail.
 *
 * `ask` is the last thing the OWNER said and `closing` is everything the
 * chat has said since — not just its final paragraph, because a turn that
 * ends "…and that's the last of it" means nothing without the three findings
 * above it.
 *
 * A machine message is not an ask. Continuations, cron fires and sub-chat
 * reports all arrive as user-role events, and treating one as a fresh
 * instruction is how the gate would measure a turn against its own previous
 * prod. `isOwner` decides that — the caller passes the same predicate the
 * send road uses, so there is one definition of "a person said this".
 */
export function yieldPair(
  events: readonly ChatEvent[],
  isOwner: (text: string) => boolean,
): { ask: string; closing: string } {
  let askAt = -1;
  let ask = '';
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (!e || e.kind !== 'user' || e.folded) continue;
    const text = (e.text ?? '').trim();
    if (!text || !isOwner(text)) continue;
    ask = text;
    askAt = i;
    break;
  }
  const said: string[] = [];
  for (let i = askAt + 1; i < events.length; i++) {
    const e = events[i];
    if (!e || e.kind !== 'assistant') continue;
    const text = (e.text ?? '').trim();
    if (text) said.push(text);
  }
  return { ask, closing: said.join('\n\n') };
}
