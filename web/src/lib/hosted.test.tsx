import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostedState } from './hosted';

/**
 * Returning to the hosted page starts a fresh poll, but a request that was
 * already in flight when we hid can land afterwards and overwrite that
 * catch-up. `alive.current` only checks hook lifetime, not request order.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const appsQ: Deferred<{ apps: { state: string }[] }>[] = [];
const pubQ: Deferred<{ publishes: never[]; base: null }>[] = [];

vi.mock('../api', () => ({
  req: (path: string) => {
    if (path === '/api/apps') {
      const d = deferred<{ apps: { state: string }[] }>();
      appsQ.push(d);
      return d.promise;
    }
    if (path === '/api/publish') {
      const d = deferred<{ publishes: never[]; base: null }>();
      pubQ.push(d);
      return d.promise;
    }
    return Promise.reject(new Error(path));
  },
}));

let vis: 'visible' | 'hidden' = 'visible';
let host: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HostedState | null = null;

async function mount() {
  const { useHosted } = await import('./hosted');
  function Inner() {
    latest = useHosted();
    return null;
  }
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(<Inner />);
  });
}

function setVisibility(next: 'visible' | 'hidden') {
  vis = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  appsQ.length = 0;
  pubQ.length = 0;
  latest = null;
  vis = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => vis,
  });
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
});

describe('useHosted in-flight overwrite', () => {
  it('does not let a pre-hide poll clobber the fresh foreground result', async () => {
    await mount();
    expect(appsQ).toHaveLength(1);
    expect(pubQ).toHaveLength(1);

    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
    });
    expect(appsQ).toHaveLength(2);

    await act(async () => {
      appsQ[1]?.resolve({ apps: [{ state: 'running' }] });
      pubQ[1]?.resolve({ publishes: [], base: null });
    });
    expect(latest?.apps).toEqual([{ state: 'running' }]);
    expect(latest?.error).toBeNull();

    await act(async () => {
      appsQ[0]?.resolve({ apps: [{ state: 'unreachable' }] });
      pubQ[0]?.resolve({ publishes: [], base: null });
    });
    expect(latest?.apps).toEqual([{ state: 'running' }]);
  });
});
