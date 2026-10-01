import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { documentVisible, seenAckTarget, useDocumentVisible } from './seen-ack';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

describe('documentVisible / useDocumentVisible — selected is not seen', () => {
  // A selected chat in a backgrounded browser stays `isActive`; the automatic
  // acks used to fire there and erase an unread mark nobody had displayed.
  let spy: ReturnType<typeof vi.spyOn> | null = null;
  const setVisibility = (v: DocumentVisibilityState) => {
    spy?.mockRestore();
    spy = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(v);
  };
  afterEach(() => {
    spy?.mockRestore();
    spy = null;
  });

  it('a hidden document is not visible', () => {
    setVisibility('hidden');
    expect(documentVisible()).toBe(false);
    setVisibility('visible');
    expect(documentVisible()).toBe(true);
  });

  it('the hook follows visibilitychange, so the seen-effect re-runs on return', () => {
    setVisibility('hidden');
    const seen: boolean[] = [];
    function Probe() {
      seen.push(useDocumentVisible());
      return null;
    }
    const host = document.createElement('div');
    const root = createRoot(host);
    act(() => root.render(<Probe />));
    expect(seen.at(-1)).toBe(false);
    setVisibility('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(seen.at(-1)).toBe(true);
    act(() => root.unmount());
  });
});
