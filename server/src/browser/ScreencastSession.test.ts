import { describe, expect, it, vi } from 'vitest';
import { type CdpTransport, ScreencastSession } from './ScreencastSession.js';

/**
 * The screencast state machine, and the two ways it dies quietly.
 *
 * Both failure modes below were found by building the thing and watching it
 * break, not by reading the protocol docs — and both present as A STILL
 * PICTURE WITH NO ERROR ANYWHERE. That is the worst possible failure for a
 * handoff: the human is looking at a page that no longer exists, typing into
 * nothing, and everything claims to be fine. Hence the tests.
 */

class FakeCdp implements CdpTransport {
  calls: Array<{ method: string; params: unknown }> = [];
  handlers = new Map<string, (p: never) => void>();
  /** Methods that should reject, e.g. a frame ack against a dead widget. */
  failing = new Set<string>();
  /** Canned results per method. */
  results = new Map<string, unknown>();

  async send(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (this.failing.has(method)) throw new Error(`${method} failed`);
    return (this.results.get(method) as Record<string, unknown>) ?? {};
  }

  on(event: string, handler: (p: never) => void) {
    this.handlers.set(event, handler);
  }

  emit(event: string, params: unknown) {
    const h = this.handlers.get(event);
    if (!h) throw new Error(`nothing listening for ${event}`);
    (h as (p: unknown) => void)(params);
  }

  methods() {
    return this.calls.map((c) => c.method);
  }

  /** Index of the Nth call to `method`, or -1. */
  nth(method: string, n = 0) {
    let seen = 0;
    for (let i = 0; i < this.calls.length; i++) {
      if (this.calls[i]?.method === method && seen++ === n) return i;
    }
    return -1;
  }
}

const metrics = { cssLayoutViewport: { clientWidth: 1280, clientHeight: 700 } };

function session(overrides: Partial<{ onFrame: (f: unknown) => void }> = {}) {
  const cdp = new FakeCdp();
  cdp.results.set('Page.getLayoutMetrics', metrics);
  const onFrame = overrides.onFrame ?? vi.fn();
  const s = new ScreencastSession(cdp, { onFrame });
  return { cdp, s, onFrame };
}

const FRAME = (sessionId = 1) => ({
  data: Buffer.from('jpeg-bytes').toString('base64'),
  sessionId,
  metadata: { deviceWidth: 1280, deviceHeight: 700, pageScaleFactor: 1, offsetTop: 0 },
});

describe('starting', () => {
  it('enables the domains it needs before streaming', async () => {
    const { cdp, s } = session();
    await s.start();
    expect(cdp.methods()).toContain('Page.enable');
    expect(cdp.methods()).toContain('DOM.enable');
    expect(cdp.nth('Page.enable')).toBeLessThan(cdp.nth('Page.startScreencast'));
  });

  it('forces a repaint, because a static page emits no frames at all', async () => {
    // The first version of this looked completely broken — frames: 0 — and was
    // working perfectly. The compositor only commits when something CHANGES, so
    // a viewer attaching to an already-painted page waits forever for a picture
    // the browser has no reason to send.
    const { cdp, s } = session();
    await s.start();
    expect(cdp.methods()).toContain('Emulation.setDeviceMetricsOverride');
    expect(cdp.methods()).toContain('Emulation.clearDeviceMetricsOverride');
    expect(cdp.nth('Page.startScreencast')).toBeLessThan(
      cdp.nth('Emulation.setDeviceMetricsOverride'),
    );
  });

  it('repaints on demand, for a viewer that arrives AFTER the page settled', async () => {
    // Found by the end-to-end run, not by these tests. start() kicks a repaint,
    // but a person opening the viewer ten minutes later attaches to a page that
    // has not changed since — and the compositor has nothing to send. They see
    // black until something moves. The host calls this on every viewer connect.
    const { cdp, s } = session();
    await s.start();
    const before = cdp.calls.filter(
      (c) => c.method === 'Emulation.setDeviceMetricsOverride',
    ).length;
    await s.repaint();
    expect(
      cdp.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride').length,
    ).toBeGreaterThan(before);
  });

  it('does not repaint once stopped', async () => {
    const { cdp, s } = session();
    await s.start();
    await s.stop();
    const before = cdp.calls.length;
    await s.repaint();
    expect(cdp.calls.length).toBe(before);
  });

  it('survives a browser that will not report layout metrics', async () => {
    const { cdp, s } = session();
    cdp.failing.add('Page.getLayoutMetrics');
    await expect(s.start()).resolves.not.toThrow();
    expect(cdp.methods()).toContain('Page.startScreencast');
  });
});

describe('frames', () => {
  it('hands the decoded frame and its metadata to the consumer', async () => {
    const onFrame = vi.fn();
    const { cdp, s } = session({ onFrame });
    await s.start();
    cdp.emit('Page.screencastFrame', FRAME());
    await vi.waitFor(() => expect(onFrame).toHaveBeenCalled());
    const frame = onFrame.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(frame.bytes)).toBe(true);
    expect(frame.bytes.toString()).toBe('jpeg-bytes');
    expect(frame.metadata.deviceWidth).toBe(1280);
  });

  it('acks every frame — an unacked frame stops the stream forever', async () => {
    // Chrome will not send frame N+1 until frame N is acked. Drop one ack and
    // the picture freezes permanently, with no error on either side.
    const { cdp, s } = session();
    await s.start();
    cdp.emit('Page.screencastFrame', FRAME(7));
    await vi.waitFor(() => expect(cdp.methods()).toContain('Page.screencastFrameAck'));
    const ack = cdp.calls.find((c) => c.method === 'Page.screencastFrameAck');
    expect(ack?.params).toMatchObject({ sessionId: 7 });
  });

  it('re-arms when an ack is REJECTED rather than swallowing it', async () => {
    // This is how the stream dies in practice: after a cross-process
    // navigation the last frame of the OLD render widget can never be acked.
    // Catching that error and moving on is the bug.
    const { cdp, s } = session();
    await s.start();
    cdp.failing.add('Page.screencastFrameAck');
    cdp.emit('Page.screencastFrame', FRAME());
    await vi.waitFor(() => expect(cdp.nth('Page.stopScreencast')).toBeGreaterThan(-1));
    expect(cdp.nth('Page.startScreencast', 1)).toBeGreaterThan(cdp.nth('Page.stopScreencast'));
  });
});

describe('navigation', () => {
  const mainFrame = { frame: { id: 'f1', url: 'https://example.com/' } };
  const subFrame = { frame: { id: 'f2', parentId: 'f1', url: 'https://ads.example/' } };

  it('re-arms by STOPPING first — startScreencast alone is a silent no-op', async () => {
    // A cross-process navigation swaps the RenderWidgetHost. The screencast is
    // still nominally "active", so re-issuing start errors with
    // "Screencast is already active" and changes nothing, and the picture stays
    // frozen on the previous page. Stop, then start.
    const { cdp, s } = session();
    await s.start();
    cdp.emit('Page.frameNavigated', mainFrame);
    await vi.waitFor(() => expect(cdp.nth('Page.stopScreencast')).toBeGreaterThan(-1));
    expect(cdp.nth('Page.startScreencast', 1)).toBeGreaterThan(cdp.nth('Page.stopScreencast'));
  });

  it('forces a repaint after re-arming, or the new page is blank until it moves', async () => {
    const { cdp, s } = session();
    await s.start();
    const before = cdp.calls.filter(
      (c) => c.method === 'Emulation.setDeviceMetricsOverride',
    ).length;
    cdp.emit('Page.frameNavigated', mainFrame);
    await vi.waitFor(() =>
      expect(
        cdp.calls.filter((c) => c.method === 'Emulation.setDeviceMetricsOverride').length,
      ).toBeGreaterThan(before),
    );
  });

  it('ignores SUBFRAME navigations — every ad iframe would otherwise re-arm', async () => {
    const { cdp, s } = session();
    await s.start();
    cdp.emit('Page.frameNavigated', subFrame);
    await new Promise((r) => setTimeout(r, 10));
    expect(cdp.nth('Page.stopScreencast')).toBe(-1);
  });
});

describe('stopping', () => {
  it('stops the screencast and ignores a browser that has already gone', async () => {
    const { cdp, s } = session();
    await s.start();
    cdp.failing.add('Page.stopScreencast');
    await expect(s.stop()).resolves.not.toThrow();
  });

  it('delivers no further frames once stopped', async () => {
    const onFrame = vi.fn();
    const { cdp, s } = session({ onFrame });
    await s.start();
    await s.stop();
    onFrame.mockClear();
    cdp.emit('Page.screencastFrame', FRAME());
    await new Promise((r) => setTimeout(r, 10));
    expect(onFrame).not.toHaveBeenCalled();
  });
});

describe('a caller that owns emulation', () => {
  it('uses the injected kick instead of clearing device metrics', async () => {
    // The default kick toggles a metrics override and CLEARS it, which wipes a
    // deliberate mobile emulation. Observed: enabling the mobile layout, then a
    // reload re-armed the screencast, whose kick cleared the metrics — leaving a
    // 1280px page still claiming to be a phone.
    const cdp = new FakeCdp();
    cdp.results.set('Page.getLayoutMetrics', metrics);
    const kick = vi.fn(async () => {});
    const s = new ScreencastSession(cdp, { onFrame: vi.fn(), kick });
    await s.start();
    expect(kick).toHaveBeenCalled();
    expect(cdp.methods()).not.toContain('Emulation.clearDeviceMetricsOverride');
  });
});

describe('a start that was refused, and never tried again', () => {
  /**
   * The third silent death, found in a live host. Chrome refuses
   * `startScreencast` on a WebUI page — `chrome://newtab` among them, which is
   * where every browser begins. The error was reported and dropped, `running`
   * stayed true, the page later navigated somewhere real, and nothing ever
   * tried again: a viewer black since boot, with every layer reporting health.
   */
  function refusingOnce() {
    const calls: string[] = [];
    let refuse = true;
    const cdp: CdpTransport = {
      async send(method) {
        calls.push(method);
        if (method === 'Page.startScreencast' && refuse) {
          throw new Error('Not attached to an active page');
        }
        return {};
      },
      on() {},
    };
    return {
      cdp,
      calls,
      allow: () => {
        refuse = false;
      },
    };
  }

  it('tries again when no frame has ever arrived', async () => {
    const { cdp, calls, allow } = refusingOnce();
    const session = new ScreencastSession(cdp, { onFrame: () => {}, kick: async () => {} });
    await session.start().catch(() => {});
    allow();
    expect(await session.ensureStreaming(10_000)).toBe(true);
    expect(calls.filter((c) => c === 'Page.startScreencast').length).toBeGreaterThan(1);
  });

  it('leaves a stream that is delivering frames alone', async () => {
    // Re-arming a working stream costs a stop, a start and a forced repaint —
    // a visible stutter for somebody mid-sentence in a form.
    let clock = 1000;
    const cdp: CdpTransport = {
      async send() {
        return {};
      },
      on() {},
    };
    const session = new ScreencastSession(cdp, {
      onFrame: () => {},
      kick: async () => {},
      now: () => clock,
    });
    await session.start();
    await session.frameForTest({ data: '', sessionId: 1, metadata: {} });
    clock = 2000;
    expect(await session.ensureStreaming(clock)).toBe(false);
  });

  it('but re-arms one that has gone quiet', async () => {
    let clock = 1000;
    const cdp: CdpTransport = {
      async send() {
        return {};
      },
      on() {},
    };
    const session = new ScreencastSession(cdp, {
      onFrame: () => {},
      kick: async () => {},
      now: () => clock,
    });
    await session.start();
    await session.frameForTest({ data: '', sessionId: 1, metadata: {} });
    clock = 1000 + 60_000;
    expect(await session.ensureStreaming(clock)).toBe(true);
  });

  it('does nothing at all when it was never started', async () => {
    const cdp: CdpTransport = {
      async send() {
        return {};
      },
      on() {},
    };
    const session = new ScreencastSession(cdp, { onFrame: () => {} });
    expect(await session.ensureStreaming(10_000)).toBe(false);
  });
});
