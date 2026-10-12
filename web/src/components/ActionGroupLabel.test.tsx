import type { ChatEvent } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ActionGroup } from './ChatTranscript';

/**
 * WHAT THE FOLD CALLS ITSELF.
 *
 * The header is the only thing standing between a fold and a disappearance, so
 * it has to name what is actually inside. Two rules collide here and both
 * matter:
 *
 *   · a run that DID nothing is not "N actions" — counting demoted prose as an
 *     action made Chat mode read backwards, with the fold looking like where
 *     the work went and the visible reply looking like deliberation;
 *   · …but the noun still has to be true. Once every cron's injected prompt
 *     became folded, a fire whose turn ran nothing — one that died at the
 *     weekly limit — was a run of one PROMPT being announced as a "note".
 */
let n = 0;
const id = () => `e${++n}`;
const prose = (text = 'closed'): ChatEvent => ({
  kind: 'assistant',
  id: id(),
  ts: 0,
  text,
  voice: 'private',
});
const prompt = (text = 'Run: python3 …'): ChatEvent => ({
  kind: 'user',
  id: id(),
  ts: 0,
  text,
  folded: true,
});
const tool = (): ChatEvent => ({
  kind: 'tool_use',
  id: id(),
  ts: 0,
  toolUseId: id(),
  name: 'Bash',
  input: {},
});

function label(events: ChatEvent[]): string {
  const host = document.createElement('div');
  document.body.append(host);
  act(() => {
    createRoot(host).render(
      <ActionGroup events={events} expanded={false} onToggle={() => {}} renderEvent={() => null} />,
    );
  });
  return host.querySelector('.chat-action-group-count')?.textContent ?? '';
}
afterEach(() => {
  document.body.innerHTML = '';
});

describe('the fold header', () => {
  it('calls a lone injected prompt a prompt, not a note', () => {
    expect(label([prompt()])).toBe('prompt');
  });

  it('pluralises prompts', () => {
    expect(label([prompt(), prompt()])).toBe('2 prompts');
  });

  it('still calls demoted prose a note', () => {
    expect(label([prose()])).toBe('note');
  });

  it('falls back to notes when a run mixes prose with a prompt', () => {
    // The summary line names both; the count just needs a true noun, and prose
    // is the thing a reader would be surprised to find hidden.
    expect(label([prompt(), prose()])).toBe('2 notes');
  });

  it('counts ACTIONS the moment real work joins the run', () => {
    // The "nothing was done" rule is narrow on purpose — one tool call and the
    // header goes back to announcing work.
    expect(label([prompt(), tool()])).toBe('2 actions');
  });
});
