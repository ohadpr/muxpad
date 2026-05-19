import { describe, it, expect } from 'vitest';
import { EventBus } from './events.js';
import type { MuxpadEvent } from '@muxpad/shared';

describe('EventBus', () => {
  it('broadcasts to all subscribers', () => {
    const bus = new EventBus();
    const received: MuxpadEvent[][] = [[], []];
    const u1 = bus.subscribe((e) => received[0]!.push(e));
    const u2 = bus.subscribe((e) => received[1]!.push(e));
    bus.emit({ type: 'tab.removed', workspace_id: 'w', tab_id: 't' });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(1);
    u1();
    bus.emit({ type: 'tab.removed', workspace_id: 'w', tab_id: 't2' });
    expect(received[0]).toHaveLength(1);
    expect(received[1]).toHaveLength(2);
    u2();
  });

  it('subscriber errors do not stop other subscribers', () => {
    const bus = new EventBus();
    let okCalls = 0;
    bus.subscribe(() => {
      throw new Error('boom');
    });
    bus.subscribe(() => {
      okCalls++;
    });
    bus.emit({ type: 'workspace.removed', workspace_id: 'w' });
    expect(okCalls).toBe(1);
  });
});
