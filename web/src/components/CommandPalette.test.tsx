import type { MuxpadEvent, Tab } from '@muxpad/shared';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveSearchHit } from '../api';
import type { WorkspaceTabs } from '../lib/nav-search';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const tab = (id: string, layout: string, over: Partial<Tab> = {}): Tab =>
  ({ id, slug: id, name: id, layout, created_at: 1, updated_at: 1, ...over }) as Tab;

let SERVER: WorkspaceTabs[] = [];
const listAllTabs = vi.fn(async () => ({ workspaces: SERVER }));
vi.mock('../api', () => ({
  api: {
    listAllTabs: () => listAllTabs(),
    searchMessages: () => new Promise<{ hits: ArchiveSearchHit[] }>(() => {}),
  },
}));
vi.mock('../events', () => ({
  subscribe: (_h: (e: MuxpadEvent) => void) => () => {},
  subscribeResync: () => () => {},
}));
const navigate = vi.fn(() => Promise.resolve());
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => navigate }));
vi.mock('../workspaces', () => ({
  useWorkspaces: () => ({ workspaces: [] }),
  visibleWorkspaces: () => [],
}));
vi.mock('../tabs', () => ({ cachedTabsFor: () => [] }));
vi.mock('../lib/search-jump', () => ({ requestSearchJump: () => {} }));

const { CommandPalette } = await import('./CommandPalette');
const { resetAllTabsCache } = await import('../lib/all-tabs');

let host: HTMLDivElement;
let root: Root;

/** The real platform test the component uses, driven per test. */
function setPlatform(value: string) {
  Object.defineProperty(window.navigator, 'platform', { value, configurable: true });
}

beforeEach(() => {
  resetAllTabsCache();
  navigate.mockClear();
  SERVER = [{ id: 'w1', slug: 'personal', name: 'Personal', tabs: [tab('investing', 'p')] }];
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = () => act(() => root.render(<CommandPalette />));
const chord = (init: KeyboardEventInit, target: EventTarget = window) =>
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, ...init }));
  });
const dialog = () => host.querySelector('.cmdk-dialog');

describe('CommandPalette — the shortcut', () => {
  it('⌘K opens it on macOS, and a second ⌘K closes it', () => {
    setPlatform('MacIntel');
    mount();
    expect(dialog()).toBeNull();
    chord({ metaKey: true });
    expect(dialog()).not.toBeNull();
    chord({ metaKey: true });
    expect(dialog()).toBeNull();
  });

  it('does NOT open on Ctrl+K on macOS — that chord is the terminal’s', () => {
    setPlatform('MacIntel');
    mount();
    chord({ ctrlKey: true });
    expect(dialog()).toBeNull();
  });

  it('opens on Ctrl+K off macOS', () => {
    setPlatform('Win32');
    mount();
    chord({ ctrlKey: true });
    expect(dialog()).not.toBeNull();
  });

  it('LEAVES Ctrl+K ALONE inside a terminal off macOS', () => {
    // Ctrl+K is readline's kill-to-end-of-line. Stealing it in the capture
    // phase — which is what the macOS path deliberately does, because xterm
    // swallows ⌘K otherwise — would quietly break line editing in every shell
    // in the app. A shortcut that needs the rail is the cheaper trade.
    setPlatform('Win32');
    mount();
    const term = document.createElement('div');
    term.className = 'xterm';
    const helper = document.createElement('textarea');
    term.appendChild(helper);
    document.body.appendChild(term);
    try {
      chord({ ctrlKey: true }, helper);
      expect(dialog()).toBeNull();
    } finally {
      term.remove();
    }
  });

  it('opens from a pane that stops propagation, because the handler captures', () => {
    setPlatform('MacIntel');
    mount();
    const greedy = document.createElement('div');
    greedy.addEventListener('keydown', (e) => e.stopPropagation());
    document.body.appendChild(greedy);
    try {
      chord({ metaKey: true }, greedy);
      expect(dialog()).not.toBeNull();
    } finally {
      greedy.remove();
    }
  });
});

describe('CommandPalette — the list', () => {
  const input = () => host.querySelector('.cmdk-input') as HTMLInputElement;
  const type = (value: string) => {
    const el = input();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    act(() => {
      setter?.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const press = (key: string, init: KeyboardEventInit = {}) =>
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
    });

  beforeEach(async () => {
    setPlatform('MacIntel');
    mount();
    chord({ metaKey: true });
    await act(async () => {});
  });

  it('finds a chat by name and Enter navigates to it, closing the palette', () => {
    type('invest');
    expect(host.querySelectorAll('[role="option"]').length).toBe(1);
    press('Enter');
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ params: { wsSlug: 'personal', tabSlug: 'investing' } }),
    );
    expect(dialog()).toBeNull();
  });

  it('ignores Enter and the arrows mid-IME-composition', () => {
    // Enter commits a candidate; navigating on it makes the field unusable in
    // Japanese/Chinese input.
    type('invest');
    act(() => {
      const e = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      Object.defineProperty(e, 'isComposing', { value: true });
      input().dispatchEvent(e);
    });
    expect(navigate).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
  });

  it('forgets the previous query when reopened', () => {
    type('invest');
    expect(input().value).toBe('invest');
    chord({ metaKey: true });
    chord({ metaKey: true });
    expect(input().value).toBe('');
  });
});
