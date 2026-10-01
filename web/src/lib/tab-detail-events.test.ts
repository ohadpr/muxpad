import type { PaneSpec } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import { mergePaneUpdated } from './tab-detail-events';

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
