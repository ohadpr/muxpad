import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionBar } from './ChatStart';

/**
 * "THIS CHAT IS ON ANOTHER MACHINE" — the one thing a remote chat must say.
 *
 * Everything else about it is deliberately identical to a local chat; that is
 * the whole point of the design, and exactly why this has to be visible.
 * `~/work` is a different directory, `git log` a different repository, and a
 * file the agent writes is on a computer you are not sitting at.
 *
 * Two properties are pinned here, and they are the two that would actually
 * hurt:
 *   · a LOCAL chat grows nothing. Every chat on a single-machine install is
 *     local, so a cell that renders "this machine" is a permanent tax paid by
 *     everyone for a fact nobody needs.
 *   · the cell is NOT the warning colour. A remote chat is working as
 *     intended, and the amber would be saying "something is wrong" for the
 *     entire life of a chat that is fine — the same mistake as the old folder
 *     cell's red `!`.
 */

const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');
const CSS = readFileSync(join(__dirname, 'ChatPane.css'), 'utf8');

describe('the host cell', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let host: HTMLDivElement | null = null;
  let root: ReturnType<typeof createRoot> | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    host?.remove();
    host = null;
    root = null;
  });

  const mount = (props: Partial<Parameters<typeof SessionBar>[0]>) => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <SessionBar
          paneId="p1"
          folder={null}
          status={null}
          send={() => {}}
          liveLabel={null}
          agents={[]}
          mode="chat"
          {...props}
        />,
      );
    });
    return host as HTMLDivElement;
  };

  it('names the machine, so "which elsewhere" is answerable', () => {
    const box = mount({ host: 'Trayo dev VM' });
    const cell = box.querySelector('[data-testid="chat-status-host"]');
    expect(cell).not.toBeNull();
    expect(cell?.textContent).toContain('Trayo dev VM');
  });

  it('is ABSENT for a local chat — no cell, not an empty one', () => {
    expect(mount({}).querySelector('[data-testid="chat-status-host"]')).toBeNull();
    expect(mount({ host: null }).querySelector('[data-testid="chat-status-host"]')).toBeNull();
  });

  it('opens a panel that says what is different about it', () => {
    const box = mount({ host: 'Trayo dev VM' });
    const cell = box.querySelector('[data-testid="chat-status-host"]') as HTMLButtonElement;
    act(() => cell.click());
    const panel = box.querySelector('.chat-session-menu');
    expect(panel?.textContent).toContain('Trayo dev VM');
    // The two facts that actually bite: whose files these are, and what
    // happens when that machine is away.
    expect(panel?.textContent).toMatch(/not here/i);
    expect(panel?.textContent).toMatch(/goes away/i);
  });
});

describe('what the cell is told, and by whom', () => {
  it('comes down the SESSION FRAME, not from the pane row', () => {
    // The pane row reaches the chat through a different path on a different
    // poll. An indicator about where the words you are typing are going must
    // not lag the socket carrying them.
    expect(SRC).toMatch(/host\?: string;/);
    expect(SRC).toMatch(/setRemoteHost\(/);
    expect(SRC).toMatch(/host=\{remoteHost\}/);
  });

  it('treats an absent field as local, by the same omission rule as staleRunner', () => {
    expect(SRC).toMatch(/typeof msg\.host === 'string' && msg\.host \? msg\.host : null/);
  });
});

describe('the colour', () => {
  it('is the accent, never the warning token', () => {
    const rule = /\.chat-status-seg\.-host\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rule).toContain('var(--accent)');
    expect(rule).not.toContain('--chat-warn');
  });

  it('may shrink, because a clipped machine NAME is still the right machine', () => {
    // The opposite call from `-stale`, which is two fixed words that mean
    // nothing clipped and so refuses to shrink at all.
    const rule = /\.chat-status-seg\.-host\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(rule).not.toMatch(/flex-shrink:\s*0/);
  });
});
