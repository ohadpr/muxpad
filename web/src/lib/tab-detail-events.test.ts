import type { PaneSpec, Tab } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { applyTabUpdated, mergePaneUpdated } from './tab-detail-events';

const held = {
  id: 'p1',
  tab_id: 't1',
  kind: 'shell',
  title: 'vim notes.md',
  foreground_cmd: 'vim',
  attention: false,
  status: 'idle',
} as unknown as PaneSpec;

describe('mergePaneUpdated', () => {
  // decoratePane sends `title: null` / `foreground_cmd: null` when the runtime
  // is gone (pty exit, or the ptyd-restart prune). That is the server SAYING
  // "there is none", the same answer the list endpoint gives — not omission.
  // Coalescing it with `??` kept the dead process's title on the pane label
  // until a resync.
  it('accepts an explicit null as a cleared value', () => {
    const next = mergePaneUpdated(held, {
      ...held,
      title: null,
      foreground_cmd: null,
    } as PaneSpec);
    expect(next.title).toBeNull();
    expect(next.foreground_cmd).toBeNull();
  });

  it('still preserves a decoration the payload omits', () => {
    const { title: _t, foreground_cmd: _f, ...raw } = held;
    const next = mergePaneUpdated(held, raw as PaneSpec);
    expect(next.title).toBe('vim notes.md');
    expect(next.foreground_cmd).toBe('vim');
  });
});

describe('applyTabUpdated', () => {
  const tab = {
    id: 't1',
    slug: 'notes',
    name: 'notes',
    layout: 'p1',
    view_mode: 'split',
    updated_at: 1,
    panes: [],
  } as unknown as Tab & { panes: PaneSpec[] };

  // The flip is PATCHed to the server and pushed as tab.updated, and the shared
  // schema says it "follows the user across devices". useTabViewMode reads it
  // off the tab this function produces — so a projection that drops it leaves
  // every OTHER open client on the old mode until a resync or remount.
  it('adopts a view_mode flipped on another device', () => {
    const next = applyTabUpdated(tab, { ...tab, view_mode: 'tabbed', updated_at: 2 }, true);
    expect(next.view_mode).toBe('tabbed');
  });

  it('holds the layout back while a local write is in flight', () => {
    const next = applyTabUpdated(tab, { ...tab, layout: 'p2', name: 'renamed' }, false);
    expect(next.layout).toBe('p1');
    expect(next.name).toBe('renamed');
  });
});
