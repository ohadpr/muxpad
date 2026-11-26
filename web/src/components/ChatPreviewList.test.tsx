import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { type Root, createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchableTab } from '../lib/nav-search';

/**
 * THE SECOND LINE, AND WHAT IT COSTS TO KEEP IT TRUE.
 *
 * Every row shows its chat's last message, fetched for the rows on screen. The
 * list this feeds hardest is Activity — the whole corpus, by recency — and the
 * effect was keyed on every row's `lastActivityAt`, so ONE chat saying
 * anything re-fetched the previews of ALL of them. On a phone watching a
 * working agent that is a request for ~18 chats every few seconds, for rows
 * already on screen of which one has new words. Reported as "clicking activity
 * in unread can take multiple seconds until it responds, at least on mobile".
 *
 * This had no tests at all, which is why the policy could be that wrong
 * quietly.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const asked: string[][] = [];
vi.mock('../api', () => ({
  api: {
    tabPreviews: (ids: readonly string[]) => {
      asked.push([...ids]);
      return Promise.resolve({
        previews: Object.fromEntries(ids.map((id) => [id, { text: `last in ${id}`, by: 'user' }])),
      });
    },
  },
}));
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, className }: { children?: unknown; className?: string }) => (
    <span className={className}>{children as never}</span>
  ),
}));

const { PreviewList, resetPreviewCache } = await import('./ChatPreviewList');

const row = (id: string, at: number): SearchableTab =>
  ({
    tabId: id,
    tabSlug: id,
    tabName: id,
    workspaceId: 'w1',
    workspaceSlug: 'w1',
    workspaceName: 'W',
    paneIds: [],
    headline: `about ${id}`,
    lastActivityAt: at,
  }) as SearchableTab;

describe('previews are asked for what moved', () => {
  let host: HTMLDivElement;
  let root: Root;

  const draw = (rows: SearchableTab[]) =>
    act(() => {
      root.render(<PreviewList rows={rows} active={true} empty={<p>none</p>} />);
    });
  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    // The cache is module-level on purpose — shared by the sibling lists that
    // unmount each other — so a test must start from nothing.
    resetPreviewCache();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('asks once for the rows it is given', async () => {
    draw([row('a', 1), row('b', 1)]);
    await settle();
    expect(asked).toEqual([['a', 'b']]);
  });

  it('asks for ONE row when one row moves, not for the whole list', async () => {
    draw([row('a', 1), row('b', 1), row('c', 1)]);
    await settle();
    asked.length = 0;
    draw([row('a', 2), row('b', 1), row('c', 1)]);
    await settle();
    expect(asked).toEqual([['a']]);
  });

  it('turns a burst of pushes into one request', async () => {
    draw([row('a', 1), row('b', 1)]);
    await settle();
    asked.length = 0;
    for (let i = 2; i < 8; i++) {
      draw([row('a', i), row('b', 1)]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(40);
      });
    }
    await settle();
    expect(asked).toEqual([['a']]);
  });

  it('asks for nothing when nothing has moved', async () => {
    const rows = [row('a', 1), row('b', 1)];
    draw(rows);
    await settle();
    asked.length = 0;
    draw([row('a', 1), row('b', 1)]); // same activity, new objects
    await settle();
    expect(asked).toEqual([]);
  });

  it('asks for a row that has just joined the list', async () => {
    draw([row('a', 1)]);
    await settle();
    asked.length = 0;
    draw([row('a', 1), row('new', 5)]);
    await settle();
    expect(asked).toEqual([['new']]);
  });

  it('draws the row before its preview lands — the headline holds the line', () => {
    draw([row('a', 1)]);
    // No timers advanced: nothing fetched yet, and the row is still readable.
    expect(asked).toEqual([]);
    expect(host.querySelectorAll('.mcl-row')).toHaveLength(1);
    expect(host.textContent).toContain('about a');
  });

  it('spends nothing while the list is not showing', async () => {
    act(() => {
      root.render(<PreviewList rows={[row('a', 1)]} active={false} empty={<p>none</p>} />);
    });
    await settle();
    expect(asked).toEqual([]);
  });
});

/**
 * A SCREENFUL FIRST. "It still takes between 500 and 900 ms."
 *
 * Measured at 10× CPU throttling: switching into the 17-row Activity list
 * cost 124–168 ms, and the reveal MECHANISM barely mattered (visibility
 * instead of display saved a quarter). What costs is laying out and painting
 * every row, and ten of them fit a 390×844 screen. With a screenful first the
 * same switch measures 21–26 ms, and the rest of the list arrives on the next
 * idle callback.
 */
describe('the first paint carries a screenful', () => {
  let host: HTMLDivElement;
  let root: Root;
  const many = (n: number) => Array.from({ length: n }, (_, i) => row(`t${i}`, 1));
  const draw = (rows: SearchableTab[], active = true) =>
    act(() => {
      root.render(<PreviewList rows={rows} active={active} empty={<p>none</p>} />);
    });
  const idle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
  };
  const painted = () => host.querySelectorAll('.mcl-row').length;

  beforeEach(() => {
    vi.useFakeTimers();
    asked.length = 0;
    // The cache is module-level on purpose — shared by the sibling lists that
    // unmount each other — so a test must start from nothing.
    resetPreviewCache();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
    vi.useRealTimers();
  });

  it('paints ten rows, then the whole list', async () => {
    draw(many(17));
    expect(painted()).toBe(10);
    await idle();
    expect(painted()).toBe(17);
  });

  it('is NOT windowing — every row is in the DOM a moment later', async () => {
    draw(many(40));
    await idle();
    expect(painted()).toBe(40);
    // So find-in-page, the scroll height and a screen reader see all of it.
    expect([...host.querySelectorAll('.mcl-row-name')].at(-1)?.textContent).toBe('t39');
  });

  it('pays a screenful again on the next switch in, not the whole list', async () => {
    draw(many(17));
    await idle();
    expect(painted()).toBe(17);
    draw(many(17), false); // switched away
    await idle();
    draw(many(17), true); // and back
    expect(painted()).toBe(10);
  });

  it('does not cap a list that already fits', async () => {
    draw(many(4));
    expect(painted()).toBe(4);
  });
});

/**
 * THE ROW IS ITS FINAL HEIGHT FROM ITS FIRST PAINT.
 *
 * The second line arrives after the row does — the list paints with each
 * chat's headline and the real last message replaces it when the previews
 * request lands, 200–500 ms later. Sized by its content, every row grew when
 * that happened: measured on the desktop Activity page with the response
 * delayed, rows went 64px → 83px and cumulative layout shift was 0.094.
 * With the clamp's height reserved, the rows do not move and CLS is 0.004.
 */
describe('the second line has its room before it arrives', () => {
  const css = readFileSync(join(__dirname, 'MobileNav.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const rule = /\.mcl-row-preview\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';

  it('reserves exactly what the clamp can use', () => {
    const clamp = Number(/-webkit-line-clamp:\s*(\d+)/.exec(rule)?.[1]);
    const line = Number(/line-height:\s*([\d.]+)/.exec(rule)?.[1]);
    expect(clamp).toBe(2);
    // The reservation has to be the clamp's own height, or the row either
    // still grows (too little) or carries dead space (too much).
    const reserved = /min-height:\s*calc\((\d+)\s*\*\s*([\d.]+)em\)/.exec(rule);
    expect(reserved, `min-height in: ${rule.trim()}`).toBeTruthy();
    expect(Number(reserved?.[1])).toBe(clamp);
    expect(Number(reserved?.[2])).toBe(line);
  });

  it('is the same rule the desktop re-scales, not a second copy', () => {
    // ActivityView.css re-sizes these rows for a pointer; if it set its own
    // line-height without the matching reservation the desktop would jump
    // while the phone did not.
    const desktop = readFileSync(join(__dirname, '..', 'pages', 'ActivityView.css'), 'utf8');
    expect(desktop).not.toMatch(/\.mcl-row-preview[^}]*line-height/);
  });
});
