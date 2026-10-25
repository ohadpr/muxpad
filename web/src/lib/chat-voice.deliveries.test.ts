import type { ChatEvent } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { dropCardedDeliveries, isDeliveryText } from './chat-voice';

/**
 * ONE FINISHED WORKER, ONE ROW TOO MANY.
 *
 * A sub-chat that ran and reported drew three: a launch card, a completion
 * card carrying its report, and a "⇤ 1 sub-agent reported" chip for the
 * delivery that brought the same words in. Reported as "one sub chat yielded
 * three messages".
 */
const chip = (from?: string[]): ChatEvent => ({
  kind: 'notice',
  id: 'n1',
  ts: 1,
  variant: 'report',
  text: '1 sub-agent reported',
  ...(from ? { from } : {}),
});
const body = (): ChatEvent => ({ kind: 'user', id: 'u1', ts: 1, text: '## x', folded: true });
const said = (): ChatEvent => ({ kind: 'assistant', id: 'a1', ts: 1, text: 'ok' });

describe('a delivery chip the cards already cover', () => {
  it('drops the chip when every child it names has a card', () => {
    const out = dropCardedDeliveries([chip(['t1']), body(), said()], new Set(['t1']));
    expect(out.map((e) => e.id)).toEqual(['u1', 'a1']);
  });

  it('keeps the BODY — the text is one disclosure away either way', () => {
    // Only the chip is redundant. The folded run is where the full reports
    // live, including for a child whose card was capped out.
    const out = dropCardedDeliveries([chip(['t1']), body()], new Set(['t1']));
    expect(out.some((e) => e.kind === 'user' && e.folded)).toBe(true);
  });

  it('keeps the chip when ANY child has no card', () => {
    // Spawn cards are capped, so a big fan-out has children with no card at
    // all — and for those this chip is the only thing in the log saying their
    // result arrived.
    const out = dropCardedDeliveries([chip(['t1', 't2'])], new Set(['t1']));
    expect(out).toHaveLength(1);
  });

  it('keeps a chip that names nobody — an older transcript', () => {
    // Deliveries only started carrying their child ids with this change. With
    // no ids we cannot prove the cards cover it, and a silent drop on a guess
    // is how a result goes missing from a log.
    expect(dropCardedDeliveries([chip()], new Set(['t1']))).toHaveLength(1);
  });

  it('leaves every other notice alone', () => {
    const cron: ChatEvent = { kind: 'notice', id: 'c1', ts: 1, variant: 'cron', text: 'nw-open' };
    expect(dropCardedDeliveries([cron], new Set(['t1']))).toHaveLength(1);
  });

  it('returns the SAME array when nothing matched — no needless rerender', () => {
    const input = [chip(['t9'])];
    expect(dropCardedDeliveries(input, new Set(['t1']))).toBe(input);
    expect(dropCardedDeliveries(input, new Set())).toBe(input);
  });
});

describe('the echo and the queue render nothing for a delivery', () => {
  // The chip appeared for a few seconds and then vanished: it was the
  // OPTIMISTIC ECHO, and whether it drew depended on whether the child's card
  // had landed yet — two different signals racing, with the answer changing
  // under the reader.
  //
  // So the preview is unconditional, and the question "is this worth a row?"
  // belongs to the row that persists (`dropCardedDeliveries`), where a capped
  // fan-out still keeps its chip.
  const delivery = [
    '<muxpad-delivery count="1" from="t1">',
    'Delivered by muxpad: 1 sub-chat you spawned has finished.',
    '</muxpad-delivery>',
    '',
    '## hn-top',
    '',
    'HN #1: something',
  ].join('\n');

  it('recognises a delivery, whatever the cards know', () => {
    expect(isDeliveryText(delivery)).toBe(true);
  });

  it('leaves a message a PERSON sent alone', () => {
    expect(isDeliveryText('get me the top HN headline')).toBe(false);
    // …including one that merely mentions the tag mid-sentence, which is the
    // same rule `parseSpawnDelivery` has always had.
    expect(isDeliveryText('why does <muxpad-delivery> leak?')).toBe(false);
  });
});
