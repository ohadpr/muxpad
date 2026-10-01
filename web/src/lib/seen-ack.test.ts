import { describe, expect, it } from 'vitest';
import { seenAckTarget } from './seen-ack';

describe('seenAckTarget — acknowledge what is on screen, nothing more', () => {
  it('split mosaic: every pane is visible, so the whole tab is seen', () => {
    expect(seenAckTarget({ singlePane: false, activePaneId: null, tabId: 't' })).toEqual({
      kind: 'tab',
      id: 't',
    });
  });

  it('single-pane view (mobile OR desktop tabbed): only the shown pane is seen', () => {
    // Desktop tabbed mode is singlePane with isMobile=false. A bulk ack here
    // cleared the bold on hidden siblings whose turns had just finished.
    expect(seenAckTarget({ singlePane: true, activePaneId: 'a', tabId: 't' })).toEqual({
      kind: 'pane',
      id: 'a',
    });
  });

  it('single-pane view with no resolved pane acknowledges nothing', () => {
    expect(seenAckTarget({ singlePane: true, activePaneId: null, tabId: 't' })).toBeNull();
  });
});
