/**
 * A live JPEG stream of one page, over CDP, for a human to watch and drive.
 *
 * WHY THIS IS A CLASS AND NOT TWELVE LINES INLINE
 * ----------------------------------------------
 * `Page.startScreencast` looks trivial and has two failure modes that both
 * present identically: A STILL PICTURE, NO ERROR ANYWHERE. For a handoff — the
 * whole reason this exists — that is the worst thing that can happen. The
 * person is looking at a page that no longer exists, typing a card number into
 * a screenshot, and every layer claims to be healthy.
 *
 * Both were found by building it and watching it break:
 *
 * 1. THE COMPOSITOR ONLY COMMITS WHEN SOMETHING CHANGES. Attach to a page that
 *    is already painted and idle and you receive nothing, forever. The first
 *    run of this reported `frames: 0` and looked completely broken while
 *    working exactly as designed. So {@link kickRepaint} forces one commit
 *    whenever we begin — on start, and again after every re-arm.
 *
 * 2. AN UNACKED FRAME HALTS THE STREAM PERMANENTLY. Chrome will not send frame
 *    N+1 until frame N is acked. After a cross-process navigation the last
 *    frame of the OLD RenderWidgetHost can never be acked, so the obvious
 *    `catch {}` around the ack is precisely the bug. We re-arm instead.
 *
 *    And the obvious repair does not work either: re-issuing `startScreencast`
 *    rejects with "Screencast is already active" and changes nothing, because
 *    the screencast is still nominally attached — to a widget that is gone.
 *    You have to STOP and then START. That asymmetry is the reason
 *    {@link rearm} exists as a named thing instead of a second `start()` call.
 *
 * Neither of these shows up in a demo. Both show up the first time a handoff
 * follows a link.
 */

/** The slice of a CDP connection this needs. Injected, so it is testable without a browser. */
export interface CdpTransport {
  send(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
  on(event: string, handler: (params: never) => void): void;
}

export interface ScreencastFrame {
  /** Decoded JPEG bytes. */
  bytes: Buffer;
  /** CDP's frame metadata — viewport size and scroll, needed to map clicks back. */
  metadata: Record<string, unknown>;
}

export interface ScreencastOptions {
  onFrame: (frame: ScreencastFrame) => void;
  /** JPEG quality, 0-100. */
  quality?: number;
  /** Send every Nth frame; 1 is every frame. */
  everyNthFrame?: number;
  /** Where to report errors that are handled rather than thrown. */
  onError?: (where: string, err: Error) => void;
}

export class ScreencastSession {
  private running = false;

  constructor(
    private readonly cdp: CdpTransport,
    private readonly opts: ScreencastOptions,
  ) {
    this.cdp.on('Page.screencastFrame', (p: never) => {
      void this.onScreencastFrame(
        p as unknown as { data: string; sessionId: number; metadata: Record<string, unknown> },
      );
    });
    this.cdp.on('Page.frameNavigated', (p: never) => {
      void this.onFrameNavigated(p as unknown as { frame: { parentId?: string; url: string } });
    });
  }

  async start(): Promise<void> {
    await this.cdp.send('Page.enable');
    await this.cdp.send('DOM.enable');
    this.running = true;
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: this.opts.quality ?? 60,
      everyNthFrame: this.opts.everyNthFrame ?? 1,
    });
    await this.kickRepaint();
  }

  async stop(): Promise<void> {
    this.running = false;
    try {
      await this.cdp.send('Page.stopScreencast');
    } catch (err) {
      // The browser going away first is the ordinary case, not an error.
      this.report('stop', err);
    }
  }

  /**
   * Force a repaint for a viewer that arrived after the page settled.
   *
   * {@link start} already kicks one, but a person opening the viewer ten minutes
   * later attaches to a page that has not changed since — and the compositor has
   * nothing to send them. They get a black rectangle until something moves on
   * its own, which on a finished page is never. Found by the end-to-end run;
   * the unit tests could not see it because they only ever connect at start.
   */
  async repaint(): Promise<void> {
    if (!this.running) return;
    await this.kickRepaint();
  }

  /**
   * Force one compositor commit.
   *
   * Resizing the viewport by a single pixel and immediately clearing the
   * override is the cheapest reliable way to make the page repaint without
   * touching its content or scroll position. Best-effort: a browser that will
   * not report layout metrics still gets a working stream, it just stays blank
   * until the page next changes by itself.
   */
  private async kickRepaint(): Promise<void> {
    try {
      const m = (await this.cdp.send('Page.getLayoutMetrics')) as {
        cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      };
      const vp = m.cssLayoutViewport;
      if (!vp) return;
      await this.cdp.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(vp.clientWidth),
        height: Math.round(vp.clientHeight) + 1,
        deviceScaleFactor: 0,
        mobile: false,
      });
      await this.cdp.send('Emulation.clearDeviceMetricsOverride');
    } catch (err) {
      this.report('kickRepaint', err);
    }
  }

  /**
   * Rebind the stream to the current render widget.
   *
   * STOP FIRST. `startScreencast` on a nominally-active screencast rejects and
   * does nothing, which leaves the picture frozen on the previous page — see
   * the module comment.
   */
  private async rearm(): Promise<void> {
    if (!this.running) return;
    try {
      await this.cdp.send('Page.stopScreencast');
    } catch (err) {
      this.report('rearm/stop', err);
    }
    try {
      await this.cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: this.opts.quality ?? 60,
        everyNthFrame: this.opts.everyNthFrame ?? 1,
      });
      await this.kickRepaint();
    } catch (err) {
      this.report('rearm/start', err);
    }
  }

  private async onScreencastFrame(p: {
    data: string;
    sessionId: number;
    metadata: Record<string, unknown>;
  }) {
    if (!this.running) return;
    this.opts.onFrame({ bytes: Buffer.from(p.data, 'base64'), metadata: p.metadata });
    try {
      await this.cdp.send('Page.screencastFrameAck', { sessionId: p.sessionId });
    } catch (err) {
      // NOT swallowed. An unacked frame is a permanently dead stream.
      this.report('ack', err);
      await this.rearm();
    }
  }

  private async onFrameNavigated(p: { frame: { parentId?: string; url: string } }) {
    // Subframes only. A page with three ad iframes would otherwise re-arm three
    // times on load, and each re-arm costs a stop, a start and a forced repaint.
    if (p.frame.parentId) return;
    await this.rearm();
  }

  private report(where: string, err: unknown) {
    this.opts.onError?.(where, err instanceof Error ? err : new Error(String(err)));
  }
}
