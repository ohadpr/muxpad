# Xterm Hardening Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three concrete symptoms in muxpad's terminal layer — (1) stuck glyphs when scrolling Claude Code mid-paint, (2) custom overlay scrollbar that freezes during Claude's in-place repaints, (3) intermittent paste weirdness with current Claude Code — and adopt a small set of validated techniques from peer projects (Codeman, 247-claude-code-remote, agent-of-empires) to prevent future regressions.

**Architecture:** Each fix lands as one commit, with the risky output-pipeline changes guarded by an `experimental.*` settings flag so they can be toggled off without a revert. We replace ad-hoc retry bursts with deterministic state-machine code, dedup SIGWINCH on the wire, and add a thin client-side write coalescer that honours DEC mode 2026 sync-block markers (server is optional; client extracts markers if present, otherwise passes through). A new `docs/xterm-smoke.md` checklist captures the manual repro for each symptom so every commit can be verified before and after.

**Tech Stack:** TypeScript, React 18, Vite 5, Vitest 2, `@xterm/xterm` 5.5, `@xterm/addon-fit` 0.10, `node-pty` (server), custom binary WS protocol in `@muxpad/shared`.

---

## Pre-flight

Work happens on the `xterm-hardening` branch in the worktree at `/Users/you/Dropbox/Computer/MyDev/2025/webagents-xterm-hardening`. The default working directory for every command below is that path.

Per-task discipline:
1. Read the symptom and repro in `docs/xterm-smoke.md` for the section this task affects.
2. Make the change.
3. Run the test command listed in the task. It must pass.
4. Run `pnpm --filter @muxpad/web lint` and `pnpm --filter @muxpad/web build` — both must succeed.
5. For tasks that say so: start the dev server, manually repro the relevant smoke-test section, confirm fixed (or improved).
6. Commit with the exact message in the task.

If a task introduces a settings flag, the flag defaults to **off**. Default-on flip happens in a separate, named commit *after* the implementing commit, so reverting the flip is one revert.

---

## Task 1: Smoke-test doc + debug flag scaffolding

**Why first:** Every later task references this. We need a written, reproducible baseline before changing any code.

**Files:**
- Create: `docs/xterm-smoke.md`
- Modify: `web/src/settings.ts` (add `experimental` block, type-only — no behaviour yet)
- Test: `web/src/settings.test.ts` (new)

**Step 1: Write the failing test**

Create `web/src/settings.test.ts`:

```ts
import { describe, expect, it, beforeEach } from 'vitest';
import { getSettings, updateSettings } from './settings';

describe('settings.experimental', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults all experimental flags to false', () => {
    const s = getSettings();
    expect(s.experimental.syncBlocks).toBe(false);
    expect(s.experimental.writeChunkCap).toBe(false);
    expect(s.experimental.heartbeat).toBe(false);
    expect(s.experimental.liveFontUpdate).toBe(false);
  });

  it('persists experimental toggles to localStorage', () => {
    updateSettings({ experimental: { syncBlocks: true, writeChunkCap: false, heartbeat: false, liveFontUpdate: false } });
    const raw = localStorage.getItem('muxpad.settings.v1');
    expect(raw).toContain('"syncBlocks":true');
  });

  it('ignores unknown experimental keys from older versions', () => {
    localStorage.setItem('muxpad.settings.v1', JSON.stringify({ experimental: { unknownKey: true } }));
    const s = getSettings();
    expect(s.experimental.syncBlocks).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

```bash
pnpm --filter @muxpad/web test web/src/settings.test.ts
```

Expected: FAIL — `experimental` is not a property of `Settings`.

**Step 3: Implement minimal change in `web/src/settings.ts`**

Add to the file:

```ts
export interface ExperimentalFlags {
  syncBlocks: boolean;
  writeChunkCap: boolean;
  heartbeat: boolean;
  liveFontUpdate: boolean;
}

const EXPERIMENTAL_DEFAULTS: ExperimentalFlags = {
  syncBlocks: false,
  writeChunkCap: false,
  heartbeat: false,
  liveFontUpdate: false,
};
```

Extend `Settings`:

```ts
export interface Settings {
  fontSize: number;
  fontFamily: string;
  theme: Theme;
  experimental: ExperimentalFlags;
}
```

Extend `DEFAULTS`:

```ts
const DEFAULTS: Settings = {
  fontSize: 14,
  fontFamily: 'Menlo, Monaco, monospace',
  theme: 'acme',
  experimental: { ...EXPERIMENTAL_DEFAULTS },
};
```

Extend the parser in `read()`:

```ts
experimental: ((): ExperimentalFlags => {
  const raw = (parsed as { experimental?: Record<string, unknown> }).experimental;
  if (!raw || typeof raw !== 'object') return { ...EXPERIMENTAL_DEFAULTS };
  return {
    syncBlocks: raw.syncBlocks === true,
    writeChunkCap: raw.writeChunkCap === true,
    heartbeat: raw.heartbeat === true,
    liveFontUpdate: raw.liveFontUpdate === true,
  };
})(),
```

**Step 4: Write `docs/xterm-smoke.md`**

```markdown
# Xterm smoke checklist

Run after every commit on the `xterm-hardening` branch. Each section names the symptom it covers.

## A. Scroll-residue under Claude Code (symptom 1)
1. `pnpm --parallel dev` (web on :5173, server on :7777) and open <http://localhost:5173>.
2. Open a workspace, open a tab, start a pane. Run `claude` (or any Ink-based TUI that repaints heavily).
3. Ask Claude something that streams a long answer.
4. While text is streaming, mouse-wheel scroll up and down rapidly.
5. **Pass criteria:** no stuck/leftover glyphs remain visible after scrolling settles. The viewport is clean.

## B. Overlay scrollbar tracks Claude in-place repaints (symptom 2)
1. With Claude streaming (as above), watch the custom scrollbar thumb on the right.
2. **Pass criteria:** thumb visibly moves as scrollback grows during Claude output; does not freeze in one position while output streams.

## C. Resize stability under mosaic
1. In a tab, open two panes. Run `htop` or `claude` in each.
2. Drag the splitter slowly, then fast. Then rearrange tiles via drag.
3. Resize the browser window itself.
4. Switch to another tab/workspace and back (mosaic re-mounts).
5. **Pass criteria:** Claude input bar never visibly jumps to a tiny size and back; htop redraws cleanly; SIGWINCH count in devtools network (under WS messages) is <= 2 unique (cols,rows) pairs per drag-completion.

## D. Font live-update (post-task 10)
1. Settings → switch font family.
2. **Pass criteria (default):** terminal recreates, focus returns to it, scrollback is lost (current behavior).
3. **Pass criteria (experimental.liveFontUpdate on):** cell metrics update in place, scrollback preserved, no SIGWINCH storm.

## E. Reconnect replay
1. In dev: kill the server process (the one bound to :7777) for ~3s, then `pnpm --filter @muxpad/server dev` again. In a packaged install use `pnpm serve:stop` / `pnpm serve:restart`.
2. **Pass criteria:** terminal shows `[reconnected]`, replay arrives without GPU stall, no torn frames.

## F. Paste behaviour (symptom 3)
1. Plain text into Claude prompt: should appear as one line, not be auto-submitted.
2. Image-only clipboard into Claude prompt: should upload + insert path.
3. Image + text mixed clipboard (e.g. macOS Preview "Copy with caption"): should upload image AND paste the text, not silently drop one.
4. Large multiline paste (50+ lines): should arrive intact within bracketed-paste markers.

## G. SIGWINCH wire count
1. Open devtools → Network → WS → frames.
2. Drag splitter once (one gesture, settle).
3. **Pass criteria:** at most 2 distinct (cols,rows) opcodes 0x02 across the gesture.

## H. Debug logging
Open with `?debug=1` to enable verbose `console.debug` from XtermPane (WS open/close, resize sends, write chunk sizes, paste entry).
```

**Step 5: Run test to verify it passes**

```bash
pnpm --filter @muxpad/web test web/src/settings.test.ts
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

Expected: all green.

**Step 6: Commit**

```bash
git add web/src/settings.ts web/src/settings.test.ts docs/xterm-smoke.md
git commit -m "chore(web): smoke checklist + experimental flag scaffolding

Adds docs/xterm-smoke.md with reproducible checklists for the three
xterm symptoms (scroll residue, scrollbar freeze, paste weirdness).
Adds Settings.experimental { syncBlocks, writeChunkCap, heartbeat,
liveFontUpdate } with all flags defaulted off so subsequent commits
can guard risky changes.

Rollback: revert this commit."
```

---

## Task 2: `?debug=1` instrumentation in XtermPane

**Why:** when a user reports a regression in any later task, this lets them paste console output instead of bisecting.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

**Step 1: Add a module-level debug helper at the top of `XtermPane.tsx` (after imports, before `XTERM_THEMES`):**

```ts
const DEBUG = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('debug') === '1';
const dbg = (...args: unknown[]) => { if (DEBUG) console.debug('[XtermPane]', ...args); };
```

**Step 2: Sprinkle `dbg(...)` calls at the four interesting points:**

- Inside `connect()`'s `ws.addEventListener('open', ...)`: `dbg('ws open', { paneId, retries });`
- Inside `ws.addEventListener('close', ...)`: `dbg('ws close', { paneId, intentionallyClosed, paneExited, retries });`
- Inside `refit()`, immediately after `fit.fit()`: `dbg('refit', { cols: term.cols, rows: term.rows, w: container.clientWidth, h: container.clientHeight });`
- Inside `onPaste`, at the very top after the `if (!data) return;` guard: `dbg('paste', { types: Array.from(data.types), items: Array.from(data.items).map(i => i.type) });`

**Step 3: Build + lint**

```bash
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

Expected: green.

**Step 4: Manual verify**

`pnpm --filter @muxpad/web dev`, open `http://localhost:5173/?debug=1`, open devtools console. Type, resize, paste — confirm log lines appear. Reload without `?debug=1`, confirm silence.

**Step 5: Commit**

```bash
git add web/src/components/XtermPane.tsx
git commit -m "feat(web): ?debug=1 instrumentation in XtermPane

Logs WS open/close, refit dims, paste types when ?debug=1 is set.
Silent otherwise. Used to triage regressions in subsequent commits
without bisecting.

Rollback: revert this commit."
```

---

## Task 3: Scrollbar tracks `onWriteParsed` (symptom 2 fix)

**Why:** Claude Code repaints by rewriting lines in place — no line-feed, no viewport scroll, no resize. Current subscriptions in `XtermPane.tsx:265-267` never fire, so the overlay scrollbar in `XtermPane.tsx:62-63, 246-269` looks frozen during heavy Claude output.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

**Step 1: Add an rAF-coalesced scheduler immediately above the existing `scrollSub` line:**

Find:
```ts
    const scrollSub = term.onScroll(() => updateScrollbar());
    const lineFeedSub = term.onLineFeed(() => updateScrollbar());
    const termResizeSub = term.onResize(() => updateScrollbar());
```

Replace with:
```ts
    let scrollbarRaf: number | null = null;
    const scheduleScrollbarUpdate = () => {
      if (scrollbarRaf !== null) return;
      scrollbarRaf = requestAnimationFrame(() => {
        scrollbarRaf = null;
        updateScrollbar();
      });
    };
    const scrollSub = term.onScroll(scheduleScrollbarUpdate);
    const lineFeedSub = term.onLineFeed(scheduleScrollbarUpdate);
    const termResizeSub = term.onResize(scheduleScrollbarUpdate);
    const writeParsedSub = term.onWriteParsed(scheduleScrollbarUpdate);
```

**Step 2: Dispose the new subscription on unmount.** Find the cleanup block:
```ts
      scrollSub.dispose();
      lineFeedSub.dispose();
      termResizeSub.dispose();
```

Add after `termResizeSub.dispose();`:
```ts
      writeParsedSub.dispose();
      if (scrollbarRaf !== null) cancelAnimationFrame(scrollbarRaf);
```

**Step 3: Build + lint**

```bash
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

Expected: green.

**Step 4: Manual repro of smoke section B**

`pnpm --filter @muxpad/web dev`. Start Claude, watch a streaming response. Confirm scrollbar thumb moves smoothly throughout, not just when newlines occur.

**Step 5: Commit**

```bash
git add web/src/components/XtermPane.tsx
git commit -m "fix(web): overlay scrollbar tracks Claude in-place repaints

Symptom targeted: smoke section B.
Symptom before: scrollbar thumb froze while Claude Code repainted in
place, because the overlay was only updated on onScroll/onLineFeed/
onResize — none of which fire for Ink's cursor-positioned redraws.

Subscribes to term.onWriteParsed via an rAF-coalesced scheduler so
the scrollbar reflects buffer state on every visible change, without
N updates per write batch.

Rollback: revert this commit."
```

---

## Task 4: SIGWINCH dedup + explicit MIN_COLS/MIN_ROWS floor

**Why:** the existing 0/240/600ms refit burst (`XtermPane.tsx:315-323`) sends 3 SIGWINCHes for one settled size when cell metrics happen to be ready. And the 60×40 pixel gate (line 279) is an implicit dim gate — the real wire payload is `(cols, rows)`, so we should gate on that.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

**Step 1:** Inside the `useEffect` body, near the other refs/locals (just below `wsRef.current = ws;` location — actually just before the `refit` function definition around line 271), add:

```ts
    const MIN_COLS = 40;
    const MIN_ROWS = 10;
    let lastSentCols = 0;
    let lastSentRows = 0;
```

**Step 2:** Replace the body of `refit()`:

```ts
    const refit = () => {
      try {
        if (container.clientWidth < 60 || container.clientHeight < 40) return;
        fit.fit();
        const cols = term.cols;
        const rows = term.rows;
        if (cols < MIN_COLS || rows < MIN_ROWS) {
          dbg('refit skipped: below floor', { cols, rows });
          return;
        }
        if (cols === lastSentCols && rows === lastSentRows) {
          dbg('refit skipped: dedup', { cols, rows });
          return;
        }
        lastSentCols = cols;
        lastSentRows = rows;
        dbg('refit', { cols, rows, w: container.clientWidth, h: container.clientHeight });
        safeSend(encodeResize(cols, rows));
      } catch {
        // ignore; the next ResizeObserver / layout-changed tick will retry.
      }
    };
```

(Replaces the existing `refit` definition. Remove the old standalone `dbg('refit', ...)` added in Task 2, since this version subsumes it.)

**Step 3:** Inside `ws.addEventListener('open', ...)`, the post-fit resize send currently bypasses dedup. Change:

```ts
        safeSend(encodeResize(term.cols, term.rows));
```

to:

```ts
        lastSentCols = term.cols;
        lastSentRows = term.rows;
        safeSend(encodeResize(term.cols, term.rows));
```

(Reconnect always re-announces dims; the local cache must match what was just sent so the next `refit` correctly dedups.)

**Step 4:** Build + lint

```bash
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

Expected: green.

**Step 5: Manual repro of smoke section G**

Open devtools → Network → WS. Drag splitter once. Confirm ≤ 2 distinct `(cols,rows)` pairs on the wire (opcode 0x02 = decimal `02` first byte of binary frame).

**Step 6: Commit**

```bash
git add web/src/components/XtermPane.tsx
git commit -m "fix(web): dedup SIGWINCH on (cols,rows) + explicit dim floor

Symptom targeted: smoke section G.
Symptom before: the 0/240/600ms refit burst sent 3 identical
SIGWINCHes per settled resize, and the 60x40 pixel gate could pass
absurdly small (cols,rows) like 2x18 on transient mosaic states.

Caches last-sent dims and drops repeats. Adds MIN_COLS=40 /
MIN_ROWS=10 floor on the actual wire payload, in addition to the
existing pixel gate. Re-syncs the cache on every WS open so reconnect
doesn't desync.

Rollback: revert this commit."
```

---

## Task 5: Public `dimensions.css.cell` API with private fallback

**Why:** `XtermPane.tsx:148-155, 295-300` reaches into `_core._renderService.dimensions.css.cell`. xterm.js v5.5 exposes this publicly as `terminal._core` is still private but `terminal._core.coreService` etc. v7 fully exposes — but we're on v5. So the practical step is to centralize the cell-dims read into one helper with a try/catch fallback, so future xterm bumps don't scatter breakage across the file.

**Files:**
- Create: `web/src/lib/xterm-internals.ts`
- Modify: `web/src/components/XtermPane.tsx`
- Test: `web/src/lib/xterm-internals.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { getCellDimensions, setScrollBarWidthZero } from './xterm-internals';

describe('xterm-internals', () => {
  it('returns null when terminal has no usable dims', () => {
    expect(getCellDimensions({} as never)).toBeNull();
  });

  it('reads from _core path on xterm v5', () => {
    const fake = { _core: { _renderService: { dimensions: { css: { cell: { width: 8, height: 16 } } } } } } as never;
    expect(getCellDimensions(fake)).toEqual({ width: 8, height: 16 });
  });

  it('returns null when width is 0 (cell not yet measured)', () => {
    const fake = { _core: { _renderService: { dimensions: { css: { cell: { width: 0, height: 0 } } } } } } as never;
    expect(getCellDimensions(fake)).toBeNull();
  });

  it('setScrollBarWidthZero is a no-op when viewport is absent', () => {
    expect(() => setScrollBarWidthZero({} as never)).not.toThrow();
  });

  it('setScrollBarWidthZero zeros the viewport width when present', () => {
    const fake = { _core: { viewport: { scrollBarWidth: 14 } } } as never;
    setScrollBarWidthZero(fake);
    expect(fake._core.viewport.scrollBarWidth).toBe(0);
  });
});
```

**Step 2: Run test, watch it fail**

```bash
pnpm --filter @muxpad/web test web/src/lib/xterm-internals.test.ts
```

Expected: FAIL — module missing.

**Step 3: Implement `web/src/lib/xterm-internals.ts`**

```ts
import type { Terminal } from '@xterm/xterm';

/**
 * Why this file exists: xterm.js v5 exposes cell dimensions and the viewport
 * scrollbar width only through `_core` internals. Concentrating those reads
 * here means a future xterm bump only needs to update this one module.
 */

type V5Core = {
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
  viewport?: { scrollBarWidth?: number };
};

function getCore(term: Terminal): V5Core | undefined {
  return (term as unknown as { _core?: V5Core })._core;
}

export function getCellDimensions(term: Terminal): { width: number; height: number } | null {
  try {
    const cell = getCore(term)?._renderService?.dimensions?.css?.cell;
    if (!cell || cell.width <= 0 || cell.height <= 0) return null;
    return { width: cell.width, height: cell.height };
  } catch {
    return null;
  }
}

export function setScrollBarWidthZero(term: Terminal): void {
  try {
    const viewport = getCore(term)?.viewport;
    if (viewport && typeof viewport.scrollBarWidth === 'number') {
      viewport.scrollBarWidth = 0;
    }
  } catch {
    // ignore
  }
}
```

**Step 4: Run test, watch it pass**

```bash
pnpm --filter @muxpad/web test web/src/lib/xterm-internals.test.ts
```

Expected: PASS.

**Step 5: Refactor `XtermPane.tsx` to use the helpers**

Replace the existing `_core.viewport.scrollBarWidth = 0` block (around lines 148-155):

```ts
        setScrollBarWidthZero(term);
```

Replace the existing `fitWhenCellReady` private-API access (around lines 294-308):

```ts
    const fitWhenCellReady = (attemptsLeft = 30) => {
      if (getCellDimensions(term)) {
        refit();
        return;
      }
      if (attemptsLeft > 0) {
        window.setTimeout(() => fitWhenCellReady(attemptsLeft - 1), 50);
      }
    };
```

Add the import at the top:

```ts
import { getCellDimensions, setScrollBarWidthZero } from '../lib/xterm-internals';
```

**Step 6: Build + lint + test**

```bash
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

Expected: green.

**Step 7: Smoke check**

`pnpm --filter @muxpad/web dev` — open a pane, type, resize. No regression vs current behavior.

**Step 8: Commit**

```bash
git add web/src/lib/xterm-internals.ts web/src/lib/xterm-internals.test.ts web/src/components/XtermPane.tsx
git commit -m "refactor(web): centralize xterm v5 _core reads

Pulls the two _core internals reads (viewport.scrollBarWidth zeroing
and css.cell dimension polling) into web/src/lib/xterm-internals.ts
with unit tests. A future xterm major bump only needs to update this
one module instead of patching XtermPane in two places.

No behavior change. Rollback: revert this commit."
```

---

## Task 6: Paste handler — only intercept image-only clipboards (symptom 3 fix)

**Why:** `XtermPane.tsx:369-390` calls `e.preventDefault()` whenever the clipboard contains ANY `image/*` item. Mixed clipboards (e.g. screenshot + caption) lose the text. We should only swallow the event when the clipboard is image-only, otherwise let xterm's normal (bracketed-paste-aware) paste path handle it after we upload images.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`
- Test: `web/src/lib/clipboard-detect.test.ts`

**Step 1: Extract pure helper for testing**

Create `web/src/lib/clipboard-detect.ts`:

```ts
export interface ClipboardSplit {
  /** True if every item is image/*. Caller fully intercepts paste. */
  imageOnly: boolean;
  /** Image MIME items that should be uploaded. */
  imageItems: DataTransferItem[];
  /** True if any non-image item is present (text, files, html). */
  hasOther: boolean;
}

export function splitClipboard(data: DataTransfer): ClipboardSplit {
  const items = Array.from(data.items);
  const imageItems = items.filter((i) => i.type.startsWith('image/'));
  const hasOther = items.some((i) => !i.type.startsWith('image/') && i.kind !== 'string' ? true : i.kind === 'string' && !i.type.startsWith('image/'));
  return {
    imageOnly: imageItems.length > 0 && !hasOther,
    imageItems,
    hasOther,
  };
}
```

Wait — `DataTransferItem.kind` is either `"string"` or `"file"`, and `type` is the MIME. So a plain text paste arrives as one item with `kind="string"`, `type="text/plain"`. An image-only paste from a screenshot tool is `kind="file"`, `type="image/png"`. A "screenshot with caption" arrives as two items: a `file` (image/png) and a `string` (text/plain).

Simplify and clarify:

```ts
export interface ClipboardSplit {
  imageOnly: boolean;
  imageItems: DataTransferItem[];
}

export function splitClipboard(data: DataTransfer): ClipboardSplit {
  const items = Array.from(data.items);
  const imageItems = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
  const hasNonImage = items.some((i) => !(i.kind === 'file' && i.type.startsWith('image/')));
  return {
    imageOnly: imageItems.length > 0 && !hasNonImage,
    imageItems,
  };
}
```

**Step 2: Write tests**

Create `web/src/lib/clipboard-detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { splitClipboard } from './clipboard-detect';

function makeItem(kind: 'string' | 'file', type: string): DataTransferItem {
  return { kind, type } as unknown as DataTransferItem;
}
function makeData(items: DataTransferItem[]): DataTransfer {
  return { items: items as unknown as DataTransferItemList } as DataTransfer;
}

describe('splitClipboard', () => {
  it('detects image-only paste (single PNG file)', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png')]));
    expect(r.imageOnly).toBe(true);
    expect(r.imageItems).toHaveLength(1);
  });

  it('detects image-only paste with multiple images', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png'), makeItem('file', 'image/jpeg')]));
    expect(r.imageOnly).toBe(true);
    expect(r.imageItems).toHaveLength(2);
  });

  it('treats image + text as mixed (not image-only)', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png'), makeItem('string', 'text/plain')]));
    expect(r.imageOnly).toBe(false);
    expect(r.imageItems).toHaveLength(1);
  });

  it('treats text-only paste as not image-only', () => {
    const r = splitClipboard(makeData([makeItem('string', 'text/plain')]));
    expect(r.imageOnly).toBe(false);
    expect(r.imageItems).toHaveLength(0);
  });

  it('treats file (non-image) + image as mixed', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png'), makeItem('file', 'application/pdf')]));
    expect(r.imageOnly).toBe(false);
  });
});
```

**Step 3: Run tests, watch them fail**

```bash
pnpm --filter @muxpad/web test web/src/lib/clipboard-detect.test.ts
```

Expected: FAIL — module missing.

**Step 4: Implement (already drafted in Step 1). Save the file.**

**Step 5: Run tests, watch them pass**

```bash
pnpm --filter @muxpad/web test web/src/lib/clipboard-detect.test.ts
```

Expected: PASS.

**Step 6: Wire into `XtermPane.tsx`**

Replace the body of `onPaste` (currently lines 369-389):

```ts
    const onPaste = async (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      dbg('paste', { types: Array.from(data.types), items: Array.from(data.items).map(i => `${i.kind}:${i.type}`) });
      const { imageOnly, imageItems } = splitClipboard(data);
      if (imageItems.length === 0) return; // plain text — let xterm's bracketed paste handle it
      const paths: string[] = [];
      for (const item of imageItems) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = blob.type.split('/')[1] ?? 'png';
        try {
          const { path } = await api.uploadAttachment(paneId, blob, `pasted.${ext}`);
          paths.push(path);
        } catch (err) {
          term.writeln(`\r\n[upload failed: ${String(err)}]`);
        }
      }
      // Only swallow the paste event when there's no text portion to deliver.
      // For mixed clipboards we send paths immediately AND let xterm deliver
      // the text portion through its normal bracketed-paste path. The user's
      // input will be "<path> <typed text>", which Claude Code parses fine.
      if (paths.length) safeSend(encodeInput(`${paths.join(' ')} `));
      if (imageOnly) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
```

Add to the imports at the top:

```ts
import { splitClipboard } from '../lib/clipboard-detect';
```

**Step 7: Build + lint + test**

```bash
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

**Step 8: Manual repro of smoke section F**

Verify all four paste scenarios.

**Step 9: Commit**

```bash
git add web/src/lib/clipboard-detect.ts web/src/lib/clipboard-detect.test.ts web/src/components/XtermPane.tsx
git commit -m "fix(web): paste handler preserves text in mixed clipboards

Symptom targeted: smoke section F (case 3).
Symptom before: any clipboard containing an image/* item triggered a
full preventDefault, dropping any accompanying text. Most affected:
screenshot+caption pastes.

Now only swallows the event when the clipboard is image-only.
Mixed image+text clipboards upload the image, type the path, AND let
xterm deliver the text portion via its normal bracketed-paste path.

Extracts splitClipboard() helper for testability.

Rollback: revert this commit."
```

---

## Task 7: Two-tier resize debounce replaces refit burst

**Why:** `XtermPane.tsx:315-323` fires `fitWhenCellReady()` at 0/240/600ms after every `muxpad:layout-changed` and `window.resize`. With dedup now in place (Task 4), the only purpose of multiple retries is to wait for the *settled* size. A two-tier debounce (250ms initial, 50ms steady-state) achieves the same with one timer.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

**Step 1:** Find the `refitBurst` definition and the two event listeners that use it (around lines 315-329):

```ts
    const refitBurst = () => {
      fitWhenCellReady();
      window.setTimeout(() => fitWhenCellReady(), 240);
      window.setTimeout(() => fitWhenCellReady(), 600);
    };
    window.addEventListener('muxpad:layout-changed', refitBurst);
    const onWindowResize = () => refitBurst();
    window.addEventListener('resize', onWindowResize);
```

Replace with:

```ts
    let refitTimer: number | null = null;
    let hasSettledFirstResize = false;
    const scheduleRefit = () => {
      if (refitTimer !== null) window.clearTimeout(refitTimer);
      const delay = hasSettledFirstResize ? 50 : 250;
      refitTimer = window.setTimeout(() => {
        refitTimer = null;
        fitWhenCellReady();
        hasSettledFirstResize = true;
      }, delay);
    };
    window.addEventListener('muxpad:layout-changed', scheduleRefit);
    const onWindowResize = () => scheduleRefit();
    window.addEventListener('resize', onWindowResize);
```

**Step 2:** Update the existing `ResizeObserver` to use `scheduleRefit` instead of `refit` (line 309):

```ts
    const resizeObs = new ResizeObserver(scheduleRefit);
```

**Step 3:** Update cleanup. Find:

```ts
      window.removeEventListener('muxpad:layout-changed', refitBurst);
      window.removeEventListener('resize', onWindowResize);
```

Replace with:

```ts
      window.removeEventListener('muxpad:layout-changed', scheduleRefit);
      window.removeEventListener('resize', onWindowResize);
      if (refitTimer !== null) window.clearTimeout(refitTimer);
```

**Step 4: Build + lint**

```bash
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

**Step 5: Manual repro of smoke section C and G**

Drag splitter slowly, fast, rearrange tiles. Watch SIGWINCH count on the wire (should be ≤ 2 distinct dims per gesture, often 1 thanks to dedup). Watch Claude input bar — no visible jump.

**Step 6: Commit**

```bash
git add web/src/components/XtermPane.tsx
git commit -m "refactor(web): two-tier resize debounce replaces refit burst

Symptom targeted: smoke section C.
Replaces the 0/240/600ms fixed-schedule refitBurst with a single
trailing-edge timer: 250ms before the first send (covers mount +
font swap + mosaic settle), 50ms thereafter (steady-state drag).
Combined with SIGWINCH dedup from a previous commit, this drops the
typical drag from 3 wire messages to 1, and removes the racy
overlapping setTimeouts.

Rollback: revert this commit."
```

---

## Task 8: `term.write()` chunk cap (experimental.writeChunkCap)

**Why:** Large output bursts (reconnect ring-buffer replay, `cat` of a big file, Claude streaming long responses) can hand xterm.js multi-MB writes that stall the WebGL renderer and contribute to torn-frame artifacts. Codeman caps at 48 KB per `term.write()` call, scheduling the rest via `requestAnimationFrame`.

**Files:**
- Create: `web/src/lib/write-coalescer.ts`
- Modify: `web/src/components/XtermPane.tsx`
- Test: `web/src/lib/write-coalescer.test.ts`

**Step 1: Write the failing test**

```ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ChunkedWriter } from './write-coalescer';

describe('ChunkedWriter', () => {
  let raf: (cb: FrameRequestCallback) => number;
  let writes: string[];
  let writer: ChunkedWriter;

  beforeEach(() => {
    writes = [];
    // Synchronous RAF for deterministic tests.
    raf = (cb) => { cb(0); return 0; };
    writer = new ChunkedWriter((s) => writes.push(s), { chunkSize: 8, raf, enabled: true });
  });

  it('passes small writes through unchanged', () => {
    writer.push('abc');
    expect(writes).toEqual(['abc']);
  });

  it('splits large writes into chunks of chunkSize', () => {
    writer.push('1234567890ABCDEFGHIJ'); // 20 bytes, chunkSize 8 → 8/8/4
    expect(writes).toEqual(['12345678', '90ABCDEF', 'GHIJ']);
  });

  it('coalesces multiple pushes inside one chunk', () => {
    writer.push('abc');
    writer.push('def');
    // With chunkSize 8, both fit. RAF flush emits one combined chunk.
    expect(writes.join('')).toBe('abcdef');
  });

  it('passes through unchanged when disabled', () => {
    const passthrough = new ChunkedWriter((s) => writes.push(s), { chunkSize: 8, raf, enabled: false });
    passthrough.push('1234567890ABCDEFGHIJ');
    expect(writes).toEqual(['1234567890ABCDEFGHIJ']);
  });
});
```

**Step 2: Run test, watch fail**

```bash
pnpm --filter @muxpad/web test web/src/lib/write-coalescer.test.ts
```

**Step 3: Implement `web/src/lib/write-coalescer.ts`**

```ts
export interface ChunkedWriterOptions {
  chunkSize: number;
  raf: (cb: FrameRequestCallback) => number;
  enabled: boolean;
}

export class ChunkedWriter {
  private pending = '';
  private scheduled = false;
  constructor(
    private readonly write: (s: string) => void,
    private readonly opts: ChunkedWriterOptions,
  ) {}

  push(data: string): void {
    if (!this.opts.enabled) {
      this.write(data);
      return;
    }
    this.pending += data;
    if (!this.scheduled) {
      this.scheduled = true;
      this.opts.raf(() => this.flush());
    }
  }

  private flush(): void {
    this.scheduled = false;
    const { chunkSize } = this.opts;
    let buf = this.pending;
    this.pending = '';
    while (buf.length > 0) {
      const slice = buf.slice(0, chunkSize);
      buf = buf.slice(chunkSize);
      this.write(slice);
    }
  }

  dispose(): void {
    this.pending = '';
    this.scheduled = false;
  }
}
```

**Step 4: Run test, watch pass**

```bash
pnpm --filter @muxpad/web test web/src/lib/write-coalescer.test.ts
```

**Step 5: Wire into `XtermPane.tsx`**

Add import:
```ts
import { ChunkedWriter } from '../lib/write-coalescer';
```

After the `term.loadAddon(new WebLinksAddon());` line, instantiate the coalescer:

```ts
    const writer = new ChunkedWriter((s) => term.write(s), {
      chunkSize: 48 * 1024,
      raf: requestAnimationFrame.bind(window),
      enabled: settings.experimental.writeChunkCap,
    });
```

Find the WS message handler:

```ts
        if (msg.kind === 'output') {
          term.write(msg.data);
```

Change to:

```ts
        if (msg.kind === 'output') {
          writer.push(msg.data);
```

In cleanup (the `return () => {` block), add:

```ts
      writer.dispose();
```

**Step 6: Build + lint + test**

```bash
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

**Step 7: Manual repro of smoke section E + A**

Toggle `experimental.writeChunkCap` on (via devtools: `localStorage.setItem('muxpad.settings.v1', JSON.stringify({...JSON.parse(localStorage.getItem('muxpad.settings.v1')!), experimental: {syncBlocks: false, writeChunkCap: true, heartbeat: false, liveFontUpdate: false}}))` then reload). Trigger a reconnect with large ring-buffer replay (smoke E). Then mouse-wheel scroll during Claude streaming (smoke A). Compare with flag off.

**Step 8: Commit**

```bash
git add web/src/lib/write-coalescer.ts web/src/lib/write-coalescer.test.ts web/src/components/XtermPane.tsx
git commit -m "feat(web): chunked term.write() coalescer (experimental)

Symptom targeted: smoke section A (scroll-residue) and E (reconnect
replay GPU stalls).

Routes WS output through ChunkedWriter which caps each term.write()
call at 48 KiB, scheduled via requestAnimationFrame so the renderer
gets a frame to commit between chunks. Avoids the multi-MB write
that can stall WebGL during ring-buffer replay.

Gated by settings.experimental.writeChunkCap (default off). Toggle
on by editing localStorage or via a future settings UI.

Rollback: revert this commit, or toggle the flag off."
```

---

## Task 9: DEC 2026 sync-block extraction (experimental.syncBlocks)

**Why:** This is the largest perceived-quality win against symptom 1 (scroll residue). Claude Code (and other Ink apps) emit a redraw as one logical frame, but the network breaks it across packets. If we extract DEC mode 2026 sync-block markers (`ESC[?2026h … ESC[?2026l`) and only call `term.write()` on complete sync blocks, the renderer never paints a torn frame.

**Strategy:** client-side only for this task. We extract markers if Claude emits them (modern Ink does). If markers are absent, we pass-through unchanged. Server-side insertion of sync markers can be added later as a separate task if needed.

**Files:**
- Modify: `web/src/lib/write-coalescer.ts` (add a SyncBlockExtractor that wraps ChunkedWriter)
- Modify: `web/src/components/XtermPane.tsx`
- Add tests in `web/src/lib/write-coalescer.test.ts`

**Step 1: Add tests for the extractor**

Append to `web/src/lib/write-coalescer.test.ts`:

```ts
import { SyncBlockExtractor } from './write-coalescer';

describe('SyncBlockExtractor', () => {
  let writes: string[];
  let raf: (cb: FrameRequestCallback) => number;
  let extractor: SyncBlockExtractor;

  beforeEach(() => {
    writes = [];
    raf = (cb) => { cb(0); return 0; };
    extractor = new SyncBlockExtractor((s) => writes.push(s), { raf, enabled: true });
  });

  it('passes through data with no markers', () => {
    extractor.push('hello world');
    extractor.flush();
    expect(writes.join('')).toBe('hello world');
  });

  it('flushes a complete sync block as one write', () => {
    extractor.push('\x1b[?2026hframe\x1b[?2026l');
    extractor.flush();
    expect(writes).toContain('frame');
  });

  it('buffers a split sync block until end marker arrives', () => {
    extractor.push('before \x1b[?2026hfra');
    extractor.flush();
    // No closing marker → frame portion still pending; "before " has been emitted as pre-sync.
    expect(writes.join('')).toBe('before ');
    extractor.push('me\x1b[?2026l after');
    extractor.flush();
    expect(writes.join('')).toBe('before frame after');
  });

  it('passes through when disabled', () => {
    const passthrough = new SyncBlockExtractor((s) => writes.push(s), { raf, enabled: false });
    passthrough.push('\x1b[?2026hframe\x1b[?2026l');
    passthrough.flush();
    expect(writes).toEqual(['\x1b[?2026hframe\x1b[?2026l']);
  });

  it('times out a stuck sync block after the configured deadline', () => {
    const slow = new SyncBlockExtractor((s) => writes.push(s), { raf, enabled: true, maxHoldMs: 0 });
    slow.push('partial \x1b[?2026hframe-only-start');
    // Force timeout flush.
    slow.flushStale(Date.now() + 1);
    expect(writes.join('')).toContain('frame-only-start');
  });
});
```

**Step 2: Run test, watch fail**

```bash
pnpm --filter @muxpad/web test web/src/lib/write-coalescer.test.ts
```

**Step 3: Implement `SyncBlockExtractor` in `write-coalescer.ts`**

Append to the same file:

```ts
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export interface SyncBlockExtractorOptions {
  raf: (cb: FrameRequestCallback) => number;
  enabled: boolean;
  /** Force-flush a held sync block if it's been outstanding this long. */
  maxHoldMs?: number;
}

export class SyncBlockExtractor {
  private buf = '';
  private holding = false;
  private holdStartedAt = 0;
  private scheduled = false;
  constructor(
    private readonly emit: (s: string) => void,
    private readonly opts: SyncBlockExtractorOptions,
  ) {}

  push(data: string): void {
    if (!this.opts.enabled) {
      this.emit(data);
      return;
    }
    this.buf += data;
    this.drain();
    if (!this.scheduled) {
      this.scheduled = true;
      this.opts.raf(() => {
        this.scheduled = false;
        this.drain();
      });
    }
  }

  /** Emit anything we can, hold partial sync blocks. */
  private drain(): void {
    while (this.buf.length > 0) {
      if (!this.holding) {
        const begin = this.buf.indexOf(SYNC_BEGIN);
        if (begin < 0) {
          this.emit(this.buf);
          this.buf = '';
          return;
        }
        // Emit everything before the marker.
        if (begin > 0) this.emit(this.buf.slice(0, begin));
        this.buf = this.buf.slice(begin + SYNC_BEGIN.length);
        this.holding = true;
        this.holdStartedAt = Date.now();
      }
      // Currently holding: look for end marker.
      const end = this.buf.indexOf(SYNC_END);
      if (end < 0) return; // wait for more.
      this.emit(this.buf.slice(0, end));
      this.buf = this.buf.slice(end + SYNC_END.length);
      this.holding = false;
    }
  }

  /** External force-flush hook (called on a timer). */
  flushStale(nowMs: number): void {
    const hold = this.opts.maxHoldMs ?? 50;
    if (this.holding && nowMs - this.holdStartedAt >= hold) {
      this.emit(this.buf);
      this.buf = '';
      this.holding = false;
    }
  }

  flush(): void {
    // synchronous drain — used in tests.
    this.drain();
  }

  dispose(): void {
    this.buf = '';
    this.holding = false;
    this.scheduled = false;
  }
}
```

**Step 4: Run test, watch pass**

```bash
pnpm --filter @muxpad/web test web/src/lib/write-coalescer.test.ts
```

**Step 5: Wire into `XtermPane.tsx`**

Replace the writer construction added in Task 8 with a layered pipeline. Find:

```ts
    const writer = new ChunkedWriter((s) => term.write(s), {
      chunkSize: 48 * 1024,
      raf: requestAnimationFrame.bind(window),
      enabled: settings.experimental.writeChunkCap,
    });
```

Replace with:

```ts
    const chunker = new ChunkedWriter((s) => term.write(s), {
      chunkSize: 48 * 1024,
      raf: requestAnimationFrame.bind(window),
      enabled: settings.experimental.writeChunkCap,
    });
    const extractor = new SyncBlockExtractor((s) => chunker.push(s), {
      raf: requestAnimationFrame.bind(window),
      enabled: settings.experimental.syncBlocks,
      maxHoldMs: 50,
    });
    const staleTimer = window.setInterval(() => extractor.flushStale(Date.now()), 25);
```

Find the WS handler `writer.push(msg.data)` and rename to `extractor.push(msg.data)`.

In cleanup, replace `writer.dispose();` with:

```ts
      window.clearInterval(staleTimer);
      extractor.dispose();
      chunker.dispose();
```

Add to imports:

```ts
import { ChunkedWriter, SyncBlockExtractor } from '../lib/write-coalescer';
```

**Step 6: Build + lint + test**

```bash
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

**Step 7: Manual repro of smoke section A**

Toggle `experimental.syncBlocks` on (writeChunkCap should also be on as it composes). Stream a long Claude response, mouse-wheel scroll mid-stream. Confirm no stuck glyphs. Compare to flag off.

If Claude's current Ink version doesn't emit DEC 2026 markers (test by enabling debug and watching for `\x1b[?2026h` in the byte stream), there will be no visible difference — that means we need the server-side wrapping. Document in the commit body.

**Step 8: Commit**

```bash
git add web/src/lib/write-coalescer.ts web/src/lib/write-coalescer.test.ts web/src/components/XtermPane.tsx
git commit -m "feat(web): DEC 2026 sync-block extraction (experimental)

Symptom targeted: smoke section A.
Pipes WS output through SyncBlockExtractor → ChunkedWriter → term.
Holds any data between \\x1b[?2026h and \\x1b[?2026l, then writes the
whole frame in one term.write() call so the renderer cannot paint a
torn frame between marker pairs. 50ms safety flush prevents a stuck
half-frame from freezing output.

Gated by settings.experimental.syncBlocks (default off). When
combined with writeChunkCap it provides atomic frame writes that
still respect the per-call size budget.

Effective only when Claude / Ink emits DEC 2026 markers. If markers
are absent, behavior is identical to passthrough.

Rollback: revert this commit, or toggle the flag off."
```

---

## Task 10: WS heartbeat (experimental.heartbeat)

**Why:** the current reconnect path only fires on `ws.onclose`. Cloudflare tunnels, mobile background tabs, and NAT timeouts can leave a WS in a "open but silent" state where no data flows and onclose never fires. Adaptive heartbeat: after N seconds of silence, send a ping; if no pong arrives within M seconds, force-close to trigger reconnect.

**Files:**
- Modify: `shared/src/ws-protocol.ts` (add PING / PONG opcodes)
- Modify: `server/src/ws.ts` (handle PING → reply PONG)
- Modify: `web/src/components/XtermPane.tsx` (heartbeat state machine)
- Tests: `shared/src/ws-protocol.test.ts`, `server/src/ws.test.ts`

**Step 1: Inspect current opcodes**

```bash
grep -n "OP_" /Users/you/Dropbox/Computer/MyDev/2025/webagents-xterm-hardening/shared/src/ws-protocol.ts
```

Confirm `OP_INPUT=0x01, OP_RESIZE=0x02` (client→server), `OP_OUTPUT=0x01, OP_EXIT=0x03, OP_ERROR=0x04` (server→client). New opcodes:
- `OP_PING = 0x05` (client→server)
- `OP_PONG = 0x05` (server→client) — distinct namespace, reusable byte.

**Step 2: Extend `shared/src/ws-protocol.ts`**

Add to `ClientMessage`:

```ts
  | { kind: 'ping' };
```

Add to `ServerMessage`:

```ts
  | { kind: 'pong' };
```

Add constants and encoders:

```ts
export const OP_PING = 0x05;
export const OP_PONG = 0x05; // server-side; distinct from OP_OUTPUT=0x01

export function encodePing(): Uint8Array {
  return new Uint8Array([OP_PING]);
}

export function encodePong(): Uint8Array {
  return new Uint8Array([OP_PONG]);
}
```

Extend `decodeClientMessage` after the existing branches, before the throw:

```ts
  if (op === OP_PING) return { kind: 'ping' };
```

Extend `decodeServerMessage` similarly:

```ts
  if (op === OP_PONG) return { kind: 'pong' };
```

**Step 3: Add protocol tests**

Append to `shared/src/ws-protocol.test.ts`:

```ts
describe('ping/pong', () => {
  it('roundtrips a client ping', () => {
    const buf = encodePing();
    expect(decodeClientMessage(buf)).toEqual({ kind: 'ping' });
  });
  it('roundtrips a server pong', () => {
    const buf = encodePong();
    expect(decodeServerMessage(buf)).toEqual({ kind: 'pong' });
  });
});
```

Run:

```bash
pnpm --filter @muxpad/shared test
```

Expected: PASS after Step 2 is saved.

**Step 4: Server handler in `server/src/ws.ts`**

```bash
grep -n "decodeClientMessage" /Users/you/Dropbox/Computer/MyDev/2025/webagents-xterm-hardening/server/src/ws.ts
```

Find the message dispatch switch and add:

```ts
} else if (msg.kind === 'ping') {
  socket.send(encodePong());
}
```

(Add `encodePong` to the import list from `@muxpad/shared`.)

Add a server test in `server/src/ws.test.ts` confirming a `ping` frame elicits a `pong`. Pattern off the existing tests in that file (read first):

```bash
cat /Users/you/Dropbox/Computer/MyDev/2025/webagents-xterm-hardening/server/src/ws.test.ts
```

Add a `describe('heartbeat')` block with an integration test using the existing test harness.

Run:

```bash
pnpm --filter @muxpad/server test
```

Expected: PASS.

**Step 5: Client heartbeat state machine in `XtermPane.tsx`**

Add imports:

```ts
import { encodePing } from '@muxpad/shared';
```

Inside `connect()`, after `wsRef.current = ws;`:

```ts
      const heartbeatEnabled = settings.experimental.heartbeat;
      const HEARTBEAT_IDLE_MS = 15_000;
      const HEARTBEAT_PONG_MS = 5_000;
      let lastActivityAt = Date.now();
      let pongWaitTimer: number | null = null;
      let idleTimer: number | null = null;
      const armIdle = () => {
        if (!heartbeatEnabled) return;
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        idleTimer = window.setTimeout(() => {
          dbg('heartbeat ping');
          safeSend(encodePing());
          pongWaitTimer = window.setTimeout(() => {
            dbg('heartbeat pong timeout — force-closing');
            try { ws.close(); } catch { /* ignore */ }
          }, HEARTBEAT_PONG_MS);
        }, HEARTBEAT_IDLE_MS - (Date.now() - lastActivityAt));
      };
      const observeActivity = () => {
        lastActivityAt = Date.now();
        if (pongWaitTimer !== null) {
          window.clearTimeout(pongWaitTimer);
          pongWaitTimer = null;
        }
        armIdle();
      };
```

In the `'open'` handler, add `armIdle();` at the end.

Extend the `'message'` handler to call `observeActivity()` first thing, and handle the pong:

```ts
        observeActivity();
        ...
        } else if (msg.kind === 'pong') {
          // observeActivity already cleared pongWaitTimer.
        }
```

In `'close'` handler, clear timers:

```ts
        if (idleTimer !== null) window.clearTimeout(idleTimer);
        if (pongWaitTimer !== null) window.clearTimeout(pongWaitTimer);
```

In the cleanup `return () => { ... }`, add:

```ts
      // timers are tied to the inner ws closure and cleared by its onclose;
      // no extra cleanup needed here.
```

**Step 6: Build + lint + tests**

```bash
pnpm --filter @muxpad/shared test
pnpm --filter @muxpad/server test
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
pnpm --filter @muxpad/server build
```

All green.

**Step 7: Manual smoke**

Toggle `experimental.heartbeat` on. With pane active and idle, open devtools network → WS; after 15s of silence you should see one `0x05` frame each way. Simulate stuck WS by adding a breakpoint in the server `ping` handler (or `kill -STOP` the server process briefly) — confirm client force-closes after 5s and reconnect kicks in.

**Step 8: Commit**

```bash
git add shared/src/ws-protocol.ts shared/src/ws-protocol.test.ts server/src/ws.ts server/src/ws.test.ts web/src/components/XtermPane.tsx
git commit -m "feat: WS ping/pong heartbeat (experimental)

Symptom targeted: silent disconnects on Cloudflare tunnels, mobile
background tabs, NAT timeouts — where ws.onclose never fires.

Adds OP_PING / OP_PONG (single-byte opcodes) to the binary protocol.
Server replies pong immediately on ping. Client arms a 15s idle
timer post-message; if it fires, sends a ping and starts a 5s pong
deadline. Missing pong → force-close → existing exponential reconnect.

Gated by settings.experimental.heartbeat (default off).

Rollback: revert this commit. Server-side handler accepts and replies
to pings unconditionally, which is harmless when the client never sends
them; safe to leave even on rollback of the client portion."
```

---

## Task 11: Live font/theme update (experimental.liveFontUpdate)

**Why:** the current effect dependency list `[paneId, settings.fontFamily, settings.fontSize, settings.theme]` causes a full Terminal teardown + rebuild on every font/theme change, losing scrollback and re-establishing the WS attach. 247's pattern shows `term.options.fontSize = N; term.refresh(0, rows-1); fit()` works if you bracket with multi-step refits.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

**Step 1:** Split the effect dependencies. Change the effect's dep array from:

```ts
  }, [paneId, settings.fontFamily, settings.fontSize, settings.theme]);
```

to:

```ts
  }, [paneId]);
```

Keep the existing teardown-on-change as the *fallback* behavior. Introduce a *second* `useEffect` for live updates, gated on the flag.

**Step 2:** Hoist `term` to a ref so the new effect can reach it:

Near the other refs (around line 67):

```ts
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
```

Inside the existing effect, after the `term` and `fit` are created:

```ts
    termRef.current = term;
    fitRef.current = fit;
```

In cleanup, before `term.dispose()`:

```ts
      if (termRef.current === term) termRef.current = null;
      if (fitRef.current === fit) fitRef.current = null;
```

**Step 3:** Add the live-update effect immediately below the existing one:

```ts
  // Live font/theme update path. When experimental.liveFontUpdate is on, we
  // mutate term.options instead of recreating the Terminal — scrollback is
  // preserved and the WS attach isn't re-established. Multi-step refit handles
  // xterm's async cell-metric measurement after a font swap.
  useEffect(() => {
    if (!settings.experimental.liveFontUpdate) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    term.options.fontFamily = settings.fontFamily;
    term.options.fontSize = settings.fontSize;
    term.options.theme = themeFor(settings.theme);
    void document.fonts.load(`${settings.fontSize}px ${settings.fontFamily}`).finally(() => {
      term.refresh(0, term.rows - 1);
      const steps = [0, 100, 250];
      steps.forEach((delay) => window.setTimeout(() => {
        try { fit.fit(); } catch { /* ignore */ }
      }, delay));
    });
  }, [settings.fontFamily, settings.fontSize, settings.theme, settings.experimental.liveFontUpdate]);
```

**Step 4:** Re-add the font/theme dependencies to the *fallback* effect so existing behavior continues when the flag is off. Change the effect signature to:

```ts
  const liveFontEnabled = settings.experimental.liveFontUpdate;
  useEffect(() => {
    ...
  }, [paneId, liveFontEnabled ? null : settings.fontFamily, liveFontEnabled ? null : settings.fontSize, liveFontEnabled ? null : settings.theme]);
```

(When liveFontEnabled is true, deps become `[paneId, null, null, null]` and font/theme changes don't trigger teardown. When false, behavior is identical to today.)

**Step 5: Build + lint + test**

```bash
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

**Step 6: Manual repro of smoke section D**

Toggle `experimental.liveFontUpdate` on. Change font in settings. Confirm scrollback preserved, cell metrics correct, no WS reconnect. Toggle off, change font, confirm current behavior (teardown + lost scrollback).

**Step 7: Commit**

```bash
git add web/src/components/XtermPane.tsx
git commit -m "feat(web): live font/theme update without Terminal recreate (experimental)

Symptom targeted: smoke section D.
Adds a second useEffect that mutates term.options.{fontFamily,
fontSize,theme} and re-fits via 0/100/250ms multi-step retries when
experimental.liveFontUpdate is on. Scrollback survives, WS attach
stays put.

When the flag is off, the existing teardown-on-change effect runs as
before via gated deps.

Rollback: revert this commit, or toggle the flag off."
```

---

## Task 12: `visualViewport` and `screen.orientation` listeners

**Why:** mobile Safari fires neither `window.resize` nor `ResizeObserver` reliably when the on-screen keyboard shows/hides or on rotation. visualViewport is the iOS-recommended path.

**Files:**
- Modify: `web/src/components/XtermPane.tsx`

**Step 1:** After the existing `window.addEventListener('resize', onWindowResize);` line, add:

```ts
    const vv = window.visualViewport;
    const onViewport = () => scheduleRefit();
    vv?.addEventListener('resize', onViewport);
    const onOrientation = () => scheduleRefit();
    window.screen.orientation?.addEventListener('change', onOrientation);
```

**Step 2:** In cleanup, add:

```ts
      vv?.removeEventListener('resize', onViewport);
      window.screen.orientation?.removeEventListener('change', onOrientation);
```

**Step 3: Build + lint**

```bash
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

Expected: green. Both APIs are present in modern Safari, Chrome, Firefox. The optional-chained `?.` handles older browsers gracefully.

**Step 4: Manual smoke (mobile-only, optional)**

If a mobile device is handy, open the app and rotate — confirm terminal re-fits without a window resize from a desktop window manager.

**Step 5: Commit**

```bash
git add web/src/components/XtermPane.tsx
git commit -m "feat(web): visualViewport + orientation resize triggers

Catches iOS keyboard show/hide and device rotation, which fire
neither window.resize nor ResizeObserver. Routes through the
existing scheduleRefit() trailing-edge debounce so behavior on
desktop is unchanged.

Rollback: revert this commit."
```

---

## Task 13: Flip stable flags to default-on

**Why:** after manual dogfooding (use the app yourself for a few days with all experimental flags on, run through the smoke checklist), the proven-stable ones should default on so non-power-users benefit.

**Files:**
- Modify: `web/src/settings.ts`

**Step 1:** Edit `EXPERIMENTAL_DEFAULTS` based on dogfood results. Likely candidates for default-on: `syncBlocks`, `writeChunkCap`. Likely to stay default-off (mobile-specific or invasive): `heartbeat` (needs production traffic), `liveFontUpdate` (only kicks in on font change, low blast radius — could flip).

Sketch:

```ts
const EXPERIMENTAL_DEFAULTS: ExperimentalFlags = {
  syncBlocks: true,
  writeChunkCap: true,
  heartbeat: false,
  liveFontUpdate: true,
};
```

**Step 2:** Update `web/src/settings.test.ts` to reflect new defaults.

**Step 3: Run tests + lint + build**

```bash
pnpm --filter @muxpad/web test
pnpm --filter @muxpad/web lint
pnpm --filter @muxpad/web build
```

**Step 4: Commit**

```bash
git add web/src/settings.ts web/src/settings.test.ts
git commit -m "chore(web): default sync-blocks, write-chunk-cap, live-font-update on

After dogfooding, these three behaviors are net positive with no
observed regressions. Heartbeat remains opt-in pending real-world
mobile/tunnel testing.

Rollback: revert this commit, which restores all flags to default
off. Individual users can override via localStorage."
```

---

## Done

After all 13 commits land, run the full smoke checklist top to bottom. Open a PR from `xterm-hardening` to `main` summarizing the symptoms-fixed table.

**Rollback summary (surgical):**
- Scrollbar freeze regressed? `git revert <task-3-sha>`
- SIGWINCH flood regressed? `git revert <task-4-sha>` (and optionally Task 7)
- Paste regressed? `git revert <task-6-sha>`
- Renderer artifacts during streaming? Toggle `experimental.syncBlocks` and `experimental.writeChunkCap` off (or revert Tasks 8/9).
- Reconnect issues? Toggle `experimental.heartbeat` off (or revert Task 10).
- Font change broken? Toggle `experimental.liveFontUpdate` off (or revert Task 11).
- Total revert of the branch: `git checkout main && git branch -D xterm-hardening && git worktree remove ../webagents-xterm-hardening` and use the `pre-xterm-overhaul` tag if you set one.

---
