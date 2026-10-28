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
    const queue = busy.slice(0, busy.indexOf(') : ('));
    expect(queue).toMatch(/className="chat-send is-queue"/);
    expect(queue).toMatch(
      /disabled=\{uploadsInFlight \|\| \(!input\.trim\(\) && chips\.length === 0\)\}/,
    );
    // …and exactly one <button> in that branch.
    expect(queue.match(/<button/g) ?? []).toHaveLength(1);
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
    const closeTernary = turn.indexOf('\n                )}');
    expect(stopAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(closeTernary);
  });

  it('is quiet until hovered — the turn block is saying "still going", not "stop me"', () => {
    const rest = CSS.slice(CSS.indexOf('.chat-turn-stop {'));
    const rule = rest.slice(0, rest.indexOf('}'));
    expect(rule).toMatch(/background:\s*transparent/);
    expect(rule).toMatch(/color:\s*var\(--chat-faint\)/);
    expect(CSS).toMatch(/\.chat-turn-stop:hover[\s\S]{0,160}--chat-danger/);
  });
});
