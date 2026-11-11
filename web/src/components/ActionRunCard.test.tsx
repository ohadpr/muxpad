import type { ChatAction } from '@muxpad/shared';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { actionRuns } from '../lib/action-runs';
import { ActionRunCard } from './ActionRunCard';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot> | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

const act_ = (kind: string, title: string, over: Partial<ChatAction> = {}): ChatAction =>
  ({ id: `${kind}:${title}`, kind, title, state: 'sent', at: 1, ...over }) as ChatAction;

function mount(actions: ChatAction[]) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const run = actionRuns(actions)[0]!;
  act(() => root?.render(<ActionRunCard run={run} />));
  return host;
}

describe('a run of reads is one row until you open it', () => {
  const reads = [
    act_('msgvault.search', 'Searched your mail for "Ada Lovelace"'),
    act_('msgvault.search', 'Searched your mail for "dinner plans"'),
    act_('msgvault.show-message', 'Read one email (150889)'),
  ];

  it('says how many and where, and shows no card until opened', () => {
    const h = mount(reads);
    expect(h.textContent).toContain('3 reads · your mail');
    // The wall this removes: the individual lines are not on screen.
    expect(h.textContent).not.toContain('Ada Lovelace');
    expect(h.querySelector('[aria-expanded="false"]')).toBeTruthy();
  });

  it('opens in place to the ordinary cards', () => {
    const h = mount(reads);
    act(() => (h.querySelector('button') as HTMLButtonElement).click());
    expect(h.textContent).toContain('Ada Lovelace');
    expect(h.textContent).toContain('Read one email (150889)');
  });

  it('carries a mark, because these left the machine and a Bash call did not', () => {
    const h = mount(reads);
    const mark = h.querySelector('.action-run__mark svg');
    expect(mark).toBeTruthy();
    expect(mark?.getAttribute('aria-label')).toBe('connector');
  });

  it('never calls it an archive', () => {
    expect(mount(reads).textContent).not.toMatch(/archive/i);
  });

  it('counts failures on the closed row, so a fold cannot hide one', () => {
    const h = mount([
      act_('msgvault.search', 'a'),
      act_('msgvault.search', 'b', { state: 'failed' }),
    ]);
    expect(h.textContent).toContain('1 failed');
  });
});
