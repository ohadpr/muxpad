import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The face-switch trigger for a `muxpad claude` / just-attached agent pane
 * is `hasSession`, fetched once on mount and then only on
 * `agent_session.updated`. A session created while /ws/events was down
 * (phone background, failed first connect) never flipped the flag, so the
 * user stayed stuck on the terminal with no chat toggle until remount.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const resyncHandlers = new Set<() => void>();
const eventHandlers = new Set<(e: { type: string; pane_id?: string }) => void>();

vi.mock('../events', () => ({
  subscribe: (h: (e: { type: string; pane_id?: string }) => void) => {
    eventHandlers.add(h);
    return () => {
      eventHandlers.delete(h);
    };
  },
  subscribeReconnect: (h: () => void) => {
    resyncHandlers.add(h);
    return () => {
      resyncHandlers.delete(h);
    };
  },
  subscribeResync: (h: () => void) => {
    resyncHandlers.add(h);
    return () => {
      resyncHandlers.delete(h);
    };
  },
}));

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let fetchImpl: (url: string) => Promise<{ ok: boolean }> = async () => ({ ok: false });

const settle = () => act(async () => { await Promise.resolve(); });

async function mount() {
  const { PaneWebSwitch } = await import('./PaneWebSwitch');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<PaneWebSwitch paneId="pane_1" appUrls={[]} />);
  });
  await settle();
}

beforeEach(() => {
  resyncHandlers.clear();
  eventHandlers.clear();
  fetchImpl = async () => ({ ok: false });
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => fetchImpl(url)),
  );
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
  vi.unstubAllGlobals();
});

describe('PaneWebSwitch hasSession reconnect', () => {
  it('shows the face trigger after a reconnect check finds a session', async () => {
    await mount();
    expect(host?.querySelector('button')).toBeNull();
    expect(resyncHandlers.size).toBe(1);

    fetchImpl = async () => ({ ok: true });
    await act(async () => {
      for (const h of resyncHandlers) h();
    });
    await settle();
    expect(host?.querySelector('button')).not.toBeNull();
  });

  it('hides the trigger again when the session is gone', async () => {
    fetchImpl = async () => ({ ok: true });
    await mount();
    expect(host?.querySelector('button')).not.toBeNull();

    fetchImpl = async () => ({ ok: false });
    await act(async () => {
      for (const h of resyncHandlers) h();
    });
    await settle();
    expect(host?.querySelector('button')).toBeNull();
  });
});
