import { type ChatEvent, expandCronFire, renderCronMarker } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { coalesceCronFires, dropSilentCardFires, foldCronTurns } from './chat-voice';

/**
 * A CRON WHOSE OUTPUT IS A CARD SHOULD NOT POLLUTE THE CONVERSATION.
 *
 * "Isn't the idea that the cron, so long as its sole goal is to update a
 * persistent card, doesn't pollute the chat with the agent's responses? Did we
 * define the primitive properly?"
 *
 * No — it was being expressed with a rendering flag, when the fact the author
 * knows is where the OUTPUT goes. With `--card` declared, a fire that updated
 * it and said nothing renders nothing at all.
 */
let n = 0;
const id = () => `e${++n}`;
const fire = (opts: { card?: string; speak?: boolean; prompt?: string; missed?: number } = {}) => {
  const out = expandCronFire(
    renderCronMarker(
      {
        id: `c${++n}`,
        name: 'nw-hourly',
        at: null,
        missed: opts.missed ?? 0,
        ...(opts.speak ? { speak: true } : {}),
        ...(opts.card ? { card: opts.card } : {}),
      },
      opts.prompt ?? 'refresh the card',
    ),
    id(),
    0,
  );
  if (!out) throw new Error('fixture is not a cron fire');
  return out;
};
const prose = (text = 'closed'): ChatEvent => ({ kind: 'assistant', id: id(), ts: 0, text });
const reply = (text: string): ChatEvent => ({
  kind: 'assistant',
  id: id(),
  ts: 0,
  text,
  voice: 'reply',
});
const user = (text: string): ChatEvent => ({ kind: 'user', id: id(), ts: 0, text });
const tool = (): ChatEvent => ({
  kind: 'tool_use',
  id: id(),
  ts: 0,
  toolUseId: id(),
  name: 'Bash',
  input: {},
});

/** The pipeline in the order ChatPane runs it. */
const run = (e: ChatEvent[]) => coalesceCronFires(dropSilentCardFires(foldCronTurns(e)));

describe('a card-writing cron', () => {
  it('leaves NOTHING in the chat when it updated the card and said nothing', () => {
    const out = run([...fire({ card: 'market' }), tool(), prose('closed')]);
    expect(out).toEqual([]);
  });

  it('a whole quiet morning of them is still nothing', () => {
    const events: ChatEvent[] = [];
    for (let i = 0; i < 9; i++) events.push(...fire({ card: 'market' }), tool(), prose());
    expect(run(events)).toEqual([]);
  });

  it('…and the conversation either side of them is untouched', () => {
    // Note the ORDER. A reply sitting directly after a fire with no user
    // message between them belongs to that FIRE'S turn, not to the question
    // above it — so the conversation has to be a complete exchange before the
    // fire, or the fire has spoken and rightly keeps its row. Getting this
    // wrong in the fixture is how you talk yourself into "the code is broken".
    const q = user('how are the markets?');
    const a = reply('down 0.4%');
    const out = run([q, a, ...fire({ card: 'market' }), tool(), prose()]);
    expect(out).toEqual([q, a]);
  });

  it('…and a person typing after a silent fire still gets their turn', () => {
    const q = user('wait, and SPY?');
    const a = reply('up 0.2%');
    const out = run([...fire({ card: 'market' }), tool(), prose(), q, a]);
    expect(out).toEqual([q, a]);
  });

  it('SPEAKS UP when the fire actually says something', () => {
    // The case the audit trail exists for: the fire that breaks is the one that
    // speaks, and a visible message brings its chip back with it.
    const out = run([
      ...fire({ card: 'market' }),
      tool(),
      reply('credentials expired — card not written'),
    ]);
    expect(out.some((e) => e.kind === 'notice' && e.variant === 'cron')).toBe(true);
    expect(out.some((e) => e.kind === 'assistant' && e.voice === 'reply')).toBe(true);
  });

  it('keeps a fire that collapsed MISSED fires, card or no card', () => {
    // That detail is the unusual thing, and it is the thing worth a row.
    const out = run([...fire({ card: 'market', missed: 3 }), tool(), prose()]);
    expect(out.some((e) => e.kind === 'notice')).toBe(true);
  });

  it('leaves a cron with NO declared card exactly as it was', () => {
    // The chat is still the default destination; this changes nothing for a job
    // that never said otherwise.
    const out = run([...fire(), tool(), prose('closed')]);
    expect(out.some((e) => e.kind === 'notice' && e.variant === 'cron')).toBe(true);
  });

  it('does not swallow a person who typed into the middle of it', () => {
    const mine = user('wait, what about SPY?');
    const out = run([...fire({ card: 'market' }), tool(), mine, reply('up 0.2%')]);
    expect(out).toContainEqual(mine);
  });
});

/**
 * A FAILED FIRE IS NEVER SILENT.
 *
 * This held for free while a cron's prose was visible: a job that errored
 * explained itself, and the explanation broke the span. When every cron turn's
 * prose became machinery it stopped holding, and the comment promising it
 * stayed — measured, a card fire whose script was missing rendered ZERO rows
 * after saying "the card script is missing". The job failed, said so, and the
 * chat showed nothing.
 */
describe('a card fire that failed', () => {
  const failed = () => ({
    kind: 'tool_result' as const,
    id: id(),
    ts: 0,
    toolUseId: 'x',
    ok: false,
    text: 'scripts/market_card.sh: not found',
  });

  it('keeps its row even when the agent said nothing about it', () => {
    // The machine's own account, not the model's — and the case a
    // disappearing row is actually a bug rather than a tidy-up.
    const out = run([...fire({ card: 'market' }), tool(), failed()]);
    expect(out.length).toBeGreaterThan(0);
  });

  it('keeps it when the agent DID explain, now that prose is folded', () => {
    const out = run([...fire({ card: 'market' }), tool(), failed(), prose('could not update it')]);
    expect(out.length).toBeGreaterThan(0);
  });

  it('still drops the ordinary quiet success beside it', () => {
    const out = run([
      ...fire({ card: 'market' }),
      tool(),
      failed(),
      ...fire({ card: 'market' }),
      tool(),
      prose(),
    ]);
    // The failed one survives; the clean one does not.
    const chips = out.filter((e) => e.kind === 'notice');
    expect(chips).toHaveLength(1);
  });
});
