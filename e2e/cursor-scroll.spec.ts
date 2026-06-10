import { test, expect } from '@playwright/test';
import {
  assertPinnedAbove,
  loadRuntime,
  paneUrl,
  readLinesAbove,
  scrollUp,
  waitForE2e,
} from './helpers';

test.describe('Cursor TUI scroll in muxpad', () => {
  test('stays pinned during live cursor-sim output + lifecycle', async ({ page }) => {
    const { paneId } = loadRuntime();
    await page.goto(paneUrl(paneId));
    await waitForE2e(page);
    await page.waitForTimeout(2000);
    await scrollUp(page);
    const before = await assertPinnedAbove(page, 8, 'after scroll up');

    await page.evaluate(() => {
      (window as unknown as { __muxpad_e2e: { lifecycleStorm: (n?: number) => void } })
        .__muxpad_e2e.lifecycleStorm(5);
    });
    await page.waitForTimeout(4000);

    const after = await readLinesAbove(page);
    expect(after).toBeGreaterThan(8);
    expect(after).toBeGreaterThanOrEqual(before * 0.85);
  });

  test('15s soak: agent output does not reset scroll to bottom', async ({ page }) => {
    const { paneId } = loadRuntime();
    await page.goto(paneUrl(paneId));
    await waitForE2e(page);
    await page.waitForTimeout(1500);
    await scrollUp(page, 16);
    await assertPinnedAbove(page, 10, 'initial pin');

    for (let t = 0; t < 15; t += 3) {
      await page.evaluate(() => {
        (window as unknown as { __muxpad_e2e: { lifecycleStorm: () => void } }).__muxpad_e2e
          .lifecycleStorm(2);
      });
      await page.waitForTimeout(3000);
      await assertPinnedAbove(page, 8, `still pinned at t+${t + 3}s`);
    }
  });

  test('partial wheel-down does not snap to live prompt', async ({ page }) => {
    const { paneId } = loadRuntime();
    await page.goto(paneUrl(paneId));
    await waitForE2e(page);
    await page.waitForTimeout(1500);
    await scrollUp(page, 20);
    const high = await assertPinnedAbove(page, 15, 'scrolled far up');

    const term = page.locator('.xterm-screen');
    await term.hover();
    for (let i = 0; i < 3; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(500);

    const mid = await readLinesAbove(page);
    // Live output grows baseY while scrolling — allow drift. Must not snap to bottom.
    expect(mid).toBeGreaterThan(8);
    expect(mid).toBeLessThanOrEqual(high + 20);
  });

  test('reload restores proportional scroll position', async ({ page }) => {
    const { paneId } = loadRuntime();
    await page.goto(paneUrl(paneId));
    await waitForE2e(page);
    await page.waitForTimeout(2000);
    await scrollUp(page, 18);
    const before = await assertPinnedAbove(page, 12, 'before reload');
    await page.evaluate(() => {
      (window as unknown as { __muxpad_e2e: { flushScrollSave: () => void } }).__muxpad_e2e
        .flushScrollSave();
    });

    await page.reload();
    await waitForE2e(page);
    // Replay + continuous cursor-sim output: restore runs on 3s fallback at latest.
    await page.waitForFunction(
      () => !document.querySelector('.xterm-pane-wrapper.replay-restoring'),
      { timeout: 12_000 },
    );
    await page.waitForTimeout(500);

    const after = await readLinesAbove(page);
    expect(after).toBeGreaterThan(8);
    expect(after).toBeGreaterThanOrEqual(before * 0.4);
  });
});

test.describe('Cursor TUI scroll — mobile viewport', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });

  test('mobile layout scroll stays pinned during live output', async ({ page }) => {
    const { paneId } = loadRuntime();
    await page.goto(paneUrl(paneId));
    await waitForE2e(page);
    await page.waitForTimeout(2000);
    await page.evaluate(() => {
      (window as unknown as { __muxpad_e2e: { wheelUp: (n?: number) => void } }).__muxpad_e2e
        .wheelUp(12);
    });
    const before = await assertPinnedAbove(page, 6, 'after scroll up');
    await page.waitForTimeout(4000);
    const after = await readLinesAbove(page);
    expect(after).toBeGreaterThan(4);
    expect(after).toBeGreaterThanOrEqual(before * 0.75);
  });

  test('mobile refit keeps terminal rows in sane range', async ({ page }) => {
    const { paneId } = loadRuntime();
    await page.goto(paneUrl(paneId));
    await waitForE2e(page);
    await page.waitForTimeout(1500);
    const metrics = await page.evaluate(() => {
      const pane = document.querySelector('.xterm-pane') as HTMLElement | null;
      const api = (window as unknown as { __muxpad_e2e?: { linesAboveBottom: () => number } })
        .__muxpad_e2e;
      return {
        paneH: pane?.clientHeight ?? 0,
        vvH: window.visualViewport?.height ?? window.innerHeight,
        linesAbove: api?.linesAboveBottom() ?? -1,
      };
    });
    expect(metrics.paneH).toBeGreaterThan(120);
    expect(metrics.paneH).toBeLessThan(metrics.vvH);
  });
});
