import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderCronMarker } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { QueuedText } from './ChatTranscript';

/**
 * THE RAW MARKER MUST NEVER REACH A BUBBLE.
 *
 * A cron fire's outgoing text begins with its `<muxpad-cron …>` block. The
 * transcript splits that off on the way in, and the queue preview does too —
 * but the OPTIMISTIC ECHO did not, so a fire drained from the queue showed
 * its whole marker, attributes and all, for the length of its turn:
 *
 *   <muxpad-cron id="01M4…" name="nw-hourly" at="1791482627209" fold="1">
 *   Delivered by the muxpad cron "nw-hourly" — a scheduled job, not a human.
 *   </muxpad-cron>
 *
 * The handler that set it reasoned "a turn nobody started carries no text and
 * sets nothing" — true when it was written, false once the queue drain began
 * stamping the text it relayed.
 */
function render(node: React.ReactNode): HTMLElement {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    createRoot(host).render(node);
  });
  return host;
}
afterEach(() => {
  document.body.innerHTML = '';
});

const fire = (speak: boolean) =>
  renderCronMarker(
    { id: '01M4CECK8AMG2SBKSJEFF0MVYK', name: 'nw-hourly', at: 1791482627209, missed: 0, speak },
    'Are the US markets open right now?',
  );

describe('a cron fire previewed before its transcript line lands', () => {
  it('shows a chip, never the marker', () => {
    const host = render(<QueuedText text={fire(true)} />);
    expect(host.textContent).not.toContain('muxpad-cron');
    expect(host.textContent).not.toContain('01M4CECK8AMG2SBKSJEFF0MVYK');
    expect(host.querySelector('.chat-queued-cron')?.textContent).toContain('nw-hourly');
  });

  it('shows no prompt, for either kind, because that is what will render', () => {
    // It would be odd for a message to be noisy in the preview and silent a
    // second later. EVERY fire's prompt folds now — it is an instruction a
    // schedule injected, never something a person said — so the echo is the
    // chip alone whatever the schedule declared. This used to branch on the
    // flag, back when one flag answered both "hide the prompt" and "hide the
    // reply"; `--speak` answers only the second.
    for (const speaks of [true, false]) {
      const host = render(<QueuedText text={fire(speaks)} />);
      expect(host.textContent).not.toContain('markets open');
      expect(host.textContent).not.toContain('muxpad-cron');
      expect(host.querySelector('.chat-queued-cron')?.textContent).toContain('nw-hourly');
    }
  });

  it('leaves an ordinary message completely alone', () => {
    const host = render(<QueuedText text="just a message" />);
    expect(host.textContent).toBe('just a message');
    expect(host.querySelector('.chat-queued-cron')).toBeNull();
  });

  it('is the component the ECHO uses, not just the queue', () => {
    // The two are the same thing a second apart, and the bug was that only one
    // of them went through the split. Asserted against the source because the
    // echo lives behind a live socket and a turn-start frame.
    const src = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
    const i = src.indexOf('{optimisticUser ? (');
    expect(i).toBeGreaterThan(-1);
    // Slice to the block's own end, not a byte count — a fixed window silently
    // stops covering the thing it is checking the moment a comment is added,
    // which is how a source assertion becomes vacuous.
    const end = src.indexOf(') : null}', i);
    expect(end).toBeGreaterThan(i);
    const block = src.slice(i, end);
    expect(block).toContain('<QueuedText');
    expect(block).not.toMatch(/<UserText text=\{optimisticUser\}/);
  });
});
