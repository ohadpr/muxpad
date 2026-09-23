import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Document chat used a one-shot socket: onclose flipped `connected` to false
 * and the 20s ping interval only spoke to that same object if it was still
 * OPEN. Returning to the tab, waiting out backoff, even remounting the same
 * paneId-stable effect — none of those opened a replacement. The composer
 * sat on "connecting…" over a frozen transcript until a full reload.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class FakeWS {
  static instances: FakeWS[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  CONNECTING = 0;
  OPEN = 1;
  CLOSING = 2;
  CLOSED = 3;
  readyState = FakeWS.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  constructor(public url: string) {
    FakeWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    if (this.readyState === FakeWS.CLOSED) return;
    this.readyState = FakeWS.CLOSED;
    this.onclose?.();
  }
  open() {
    this.readyState = FakeWS.OPEN;
    this.onopen?.();
  }
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;
let vis: 'visible' | 'hidden' = 'visible';

function setVisibility(next: 'visible' | 'hidden') {
  vis = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

async function mount() {
  const { DocChat } = await import('./DocChat');
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(
      <DocChat paneId="pane_doc" active onExit={() => {}} />,
    );
  });
}

function placeholder(): string {
  return host?.querySelector('textarea')?.getAttribute('placeholder') ?? '';
}

beforeEach(() => {
  FakeWS.instances = [];
  vis = 'visible';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => vis,
  });
  vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
  vi.useFakeTimers();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  host?.remove();
  host = null;
  root = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('DocChat reconnects after its socket closes', () => {
  it('opens a replacement socket after close, instead of sitting disconnected', async () => {
    await mount();
    expect(FakeWS.instances).toHaveLength(1);
    await act(async () => {
      FakeWS.instances[0]?.open();
    });
    expect(placeholder()).toBe('Message…');

    await act(async () => {
      FakeWS.instances[0]?.close();
    });
    expect(placeholder()).toBe('connecting…');
    expect(FakeWS.instances).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(FakeWS.instances).toHaveLength(2);
    expect(FakeWS.instances[1]?.url).toContain('/ws/chat/pane_doc');
    await act(async () => {
      FakeWS.instances[1]?.open();
    });
    expect(placeholder()).toBe('Message…');
  });

  it('skips pending backoff and reconnects as soon as the document is visible', async () => {
    await mount();
    await act(async () => {
      FakeWS.instances[0]?.open();
    });
    await act(async () => {
      FakeWS.instances[0]?.close();
    });
    // Backoff is 1s. Returning now must not wait it out.
    await act(async () => {
      setVisibility('hidden');
      setVisibility('visible');
    });
    expect(FakeWS.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    // Visibility already opened the replacement; the skipped timer must not
    // spawn a third socket.
    expect(FakeWS.instances).toHaveLength(2);
  });

  it('does not reconnect after unmount', async () => {
    await mount();
    await act(async () => {
      FakeWS.instances[0]?.open();
    });
    await act(async () => {
      root?.unmount();
    });
    root = null;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(FakeWS.instances).toHaveLength(1);
  });
});
