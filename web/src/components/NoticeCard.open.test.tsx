import { type ChatEvent, expandCronFire, renderCronMarker } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { coalesceCronFires, foldCronTurns } from '../lib/chat-voice';
import { NoticeCard } from './ChatTranscript';

/**
 * A CHIP THAT REPLACED SOMETHING CAN BE OPENED.
 *
 * A notice is a mark, not a control — it carried a caret once, revealing a
 * folded cron's prompt, and that gave one fire two separate folds. The caret
 * is not coming back for that.
 *
 * The exception is the chip that COLLAPSED a run: the fires it absorbed are
 * removed from the log, so the summary is the only trace of them. "I see it
 * but I can't dig to understand what these are."
 */
let n = 0;
const fire = (name: string): ChatEvent[] => {
  const out = expandCronFire(
    renderCronMarker({ id: `c${++n}`, name, at: null, missed: 0 }, 'go'),
    `e${++n}`,
    Date.UTC(2026, 9, 7, 17, 25),
  );
  if (!out) throw new Error('fixture is not a cron fire');
  return out;
};
const collapsed = (...names: string[]) => {
  const events = coalesceCronFires(foldCronTurns(names.flatMap(fire)));
  const chip = events.find((e) => e.kind === 'notice');
  if (!chip || chip.kind !== 'notice') throw new Error('no chip');
  return chip;
};

let host: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
const mount = (event: ReturnType<typeof collapsed>) => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<NoticeCard event={event} />);
  });
  return host;
};
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('a collapsed cron chip', () => {
  it('is a button, and says it is closed', () => {
    const box = mount(collapsed('nw-hourly', 'pr-sweep', 'nw-close'));
    const btn = box.querySelector('button.chat-sysnote');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-expanded')).toBe('false');
    expect(box.querySelector('.chat-sysnote-fired')).toBeNull();
  });

  it('opens to one row per schedule', () => {
    const box = mount(collapsed('nw-hourly', 'pr-sweep', 'nw-hourly'));
    act(() => {
      box.querySelector<HTMLButtonElement>('button.chat-sysnote')?.click();
    });
    const rows = [...box.querySelectorAll('.chat-sysnote-fired li')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('nw-hourly');
    // Two fires of the same schedule read as a count, one reads as "once".
    expect(rows[0]?.textContent).toContain('2×');
    expect(rows[1]?.textContent).toContain('once');
    expect(box.querySelector('button.chat-sysnote')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('closes again', () => {
    const box = mount(collapsed('a', 'b', 'c'));
    const btn = box.querySelector<HTMLButtonElement>('button.chat-sysnote');
    act(() => btn?.click());
    act(() => btn?.click());
    expect(box.querySelector('.chat-sysnote-fired')).toBeNull();
  });
});

describe('an ordinary notice stays a mark', () => {
  it('is not a button and has nothing to open', () => {
    // The scar this protects: a caret on a chip that LABELS the run sitting
    // right below it makes a label look pressable for a reason no reader
    // would guess.
    const box = mount({
      kind: 'notice',
      id: 'x',
      ts: Date.UTC(2026, 9, 7, 17, 25),
      variant: 'cron',
      text: 'nw-hourly',
    } as ReturnType<typeof collapsed>);
    expect(box.querySelector('button.chat-sysnote')).toBeNull();
    expect(box.querySelector('.chat-sysnote-caret')).toBeNull();
  });
});
