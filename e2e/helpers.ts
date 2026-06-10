import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const webPort = Number(process.env.MUXPAD_E2E_WEB_PORT ?? 5188);

export type E2eRuntime = { port: number; paneId: string };

export type MuxpadE2e = {
  linesAboveBottom: () => number;
  scrollRatio: () => number;
  wheelUp: (ticks?: number) => void;
  wheelDown: (ticks?: number) => void;
  lifecycleStorm: (rounds?: number) => void;
  flushScrollSave: () => void;
};

export function loadRuntime(): E2eRuntime {
  return JSON.parse(readFileSync(join(here, '.runtime.json'), 'utf8')) as E2eRuntime;
}

export function paneUrl(paneId: string, extra = ''): string {
  const q = extra ? `&${extra}` : '';
  return `http://127.0.0.1:${webPort}/p/${paneId}?cursor=1&e2e=1${q}`;
}

export async function waitForE2e(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    return Boolean((window as unknown as { __muxpad_e2e?: MuxpadE2e }).__muxpad_e2e);
  }, { timeout: 30_000 });
}

export async function readLinesAbove(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as unknown as { __muxpad_e2e: MuxpadE2e }).__muxpad_e2e;
    return api.linesAboveBottom();
  });
}

export async function scrollUp(page: Page, ticks = 14): Promise<void> {
  const term = page.locator('.xterm-screen');
  await term.hover();
  for (let i = 0; i < ticks; i++) {
    await page.mouse.wheel(0, -400);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(300);
}

/** Finger-up swipe via pointer events (XtermPane touch handler). */
export async function scrollUpTouch(page: Page, steps = 8): Promise<void> {
  await page.evaluate((n) => {
    const el = document.querySelector('.xterm-pane');
    if (!el) throw new Error('xterm pane missing');
    const rect = el.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y0 = rect.top + rect.height * 0.75;
    const y1 = rect.top + rect.height * 0.2;
    for (let i = 0; i < n; i++) {
      el.dispatchEvent(
        new PointerEvent('pointerdown', {
          pointerId: 10 + i,
          pointerType: 'touch',
          clientX: x,
          clientY: y0,
          bubbles: true,
        }),
      );
      el.dispatchEvent(
        new PointerEvent('pointermove', {
          pointerId: 10 + i,
          pointerType: 'touch',
          clientX: x,
          clientY: y1,
          bubbles: true,
        }),
      );
      el.dispatchEvent(
        new PointerEvent('pointerup', {
          pointerId: 10 + i,
          pointerType: 'touch',
          clientX: x,
          clientY: y1,
          bubbles: true,
        }),
      );
    }
  }, steps);
  await page.waitForTimeout(300);
}

export async function assertPinnedAbove(
  page: Page,
  minLines: number,
  label: string,
): Promise<number> {
  const n = await readLinesAbove(page);
  expect(n, label).toBeGreaterThan(minLines);
  return n;
}
