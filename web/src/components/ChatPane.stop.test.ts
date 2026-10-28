import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ONE BUTTON ON THE COMPOSER'S RIGHT EDGE, IN EVERY STATE.
 *
 * While a turn was running and something was typed, the composer rendered TWO
 * circles side by side — Queue and Stop. Reported as "you have both a send and
 * a stop button and they're both horizontally presented".
 *
 * The split is by SUBJECT, not by layout: the composer's button acts on your
 * draft (send it, queue it); Stop acts on the agent's turn, which has its own
 * block in the log. So Stop lives at the foot of the running turn and the
 * composer never holds two.
 */
const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

describe('the composer holds one button', () => {
  it('has no stop button of its own', () => {
    expect(SRC).not.toMatch(/chat-send is-stop/);
    expect(CSS).not.toMatch(/\.chat-send\.is-stop\s*\{/);
  });

  it('queues while busy, and is disabled when there is nothing to queue', () => {
    // Same disabled rule as Send: the slot must not change shape under the
    // thumb depending on whether you have started typing.
    const busy = SRC.slice(SRC.indexOf('{sending && !question ? ('));
    // …to the NEXT branch, which is the mic that stands in for Send while the
    // composer is empty — not to the final `) : (`, which is three branches
    // down now.
    const queue = busy.slice(0, busy.indexOf(') : micInsteadOfSend ? ('));
    expect(queue).toMatch(/className="chat-send is-queue"/);
    expect(queue).toMatch(
      /disabled=\{uploadsInFlight \|\| \(!input\.trim\(\) && chips\.length === 0\)\}/,
    );
    // …and exactly one <button> in that branch. The whole point: the right
    // edge of the composer holds ONE target in every state — queue while a
    // turn runs, send when there is something to send, the mic when there is
    // not. Never two side by side.
    expect(queue.match(/<button/g) ?? []).toHaveLength(1);
    for (const branch of ['micInsteadOfSend ? (', '} else nothing'])
      if (SRC.includes(branch)) {
        const slice = SRC.slice(SRC.indexOf(branch));
        expect(slice.slice(0, slice.indexOf(') : (')).match(/<button/g) ?? []).toHaveLength(1);
      }
  });
});

describe('stop is attached to the turn it stops', () => {
  it('is rendered at the foot of the running assistant turn', () => {
    expect(SRC).toMatch(/className="chat-turn-stop"[\s\S]{0,200}onClick=\{stop\}/);
  });

  it('is OUTSIDE the streaming/indicator branch, so a streaming turn can be stopped', () => {
    // The indicator block only renders while there is nothing to stream. A
    // Stop hung off it would leave the longest turns — the ones you actually
    // want to stop — with no stop at all.
    const turn = SRC.slice(SRC.indexOf('{agentWorking && !question ? ('));
    const stopAt = turn.indexOf('className="chat-turn-stop"');
    const closeTernary = turn.indexOf('\n                  )}');
    expect(stopAt).toBeGreaterThan(-1);
    expect(closeTernary).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(closeTernary);
  });

  it('is quiet until hovered — the turn block is saying "still going", not "stop me"', () => {
    // COMMENTS STRIPPED FIRST: the rule's own note NAMES --chat-faint, to say
    // why it is not the token being used. A test reading the raw file would
    // fail on the sentence explaining the correct choice.
    // The rule ITSELF, anchored at a line start — `.chat-turn-stop {` also
    // appears as the tail of the `:has()` rule above it.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rest = flat.slice(flat.indexOf('\n.chat-turn-stop {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/color:\s*var\(--chat-dim\)/);
    // NOT --chat-faint: measured 2.1–3.3:1 across the ten themes that ship,
    // on the only control that stops a running turn.
    expect(rule).not.toMatch(/--chat-faint/);
    expect(CSS).toMatch(/\.chat-turn-stop:hover[\s\S]{0,160}--chat-danger/);
  });
});

/**
 * AND IT MUST NOT BECOME A FULL-HEIGHT PILL DOWN THE SIDE OF THE ANSWER.
 *
 * `.chat-turn` is `display: flex`, so Stop — added as a sibling of the
 * message — became a flex ITEM beside it and stretched to the turn's height:
 * a 350px rounded pill floating to the right of a streaming table. Reported
 * as "stop button goes crazy when agent streams response".
 */
describe('stop sits under the answer, not beside it', () => {
  it('shares a COLUMN with the message rather than a row', () => {
    const turn = SRC.slice(SRC.indexOf('{agentWorking && !question ? ('));
    const body = turn.slice(0, turn.indexOf('\n            ) : null}'));
    expect(body).toMatch(/<div className="chat-turn-body">/);
    // The message comes first, Stop after it: the order on screen is the
    // order in the markup, which is what "at the foot of the turn" means.
    expect(body.indexOf('chat-turn-body')).toBeLessThan(body.indexOf('chat-msg'));
    expect(body.indexOf('chat-msg')).toBeLessThan(body.indexOf('chat-turn-stop'));
  });

  it("gives that column the row's width, so the answer is not button-wide", () => {
    const rest = CSS.slice(CSS.indexOf('.chat-turn-body {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/flex-direction:\s*column/);
    expect(rule).toMatch(/align-items:\s*flex-start/);
    expect(rule).toMatch(/flex:\s*1 1 auto/);
  });

  it('never stretches, wherever it is dropped', () => {
    // The rule ITSELF, anchored at a line start — `.chat-turn-stop {` also
    // appears as the tail of the `:has()` rule above it.
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const rest = flat.slice(flat.indexOf('\n.chat-turn-stop {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/flex:\s*0 0 auto/);
    expect(rule).toMatch(/align-self:\s*flex-start/);
  });
});

/**
 * …AND BESIDE IT WHEN THE TURN IS ONE LINE TALL.
 *
 * The column is right for a streaming answer — paragraphs, tables, code — and
 * wrong for the working indicator, which is a single line: a button stacked
 * under it spends a whole row on a control that fits beside the thing it acts
 * on. Reported as "stop is now on its own line to the right below the
 * progress indicator".
 */
describe('stop follows the shape of the turn', () => {
  it('is a row while the indicator is what the turn holds', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = flat.indexOf('.chat-turn-body:has(> .chat-working) {');
    expect(i).toBeGreaterThan(-1);
    const rule = flat.slice(i, flat.indexOf('}', i));
    expect(rule).toMatch(/flex-direction:\s*row/);
    expect(rule).toMatch(/align-items:\s*center/);
  });

  it('stays a column for prose, which is what the wrapper was added for', () => {
    const flat = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    const i = flat.indexOf('.chat-turn-body {');
    expect(flat.slice(i, flat.indexOf('}', i))).toMatch(/flex-direction:\s*column/);
  });

  it('decides it from the content, not from a second branch in the JSX', () => {
    // One render site: the shape follows what the turn is holding.
    expect((SRC.match(/className="chat-turn-stop"/g) ?? []).length).toBe(1);
  });
});
