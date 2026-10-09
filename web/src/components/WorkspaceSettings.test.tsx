import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The panel that holds the one switch an agent is not allowed to throw.
 *
 * Two behaviours are the whole meaning of this component, and markup tests pass
 * just as happily with them inverted:
 *   · the instructions save on BLUR, not per keystroke;
 *   · a refused capability change puts the toggle BACK, because the server's
 *     refusal is the control working and a toggle left on would be a lie about
 *     what the agent can do.
 */

const patchWorkspace = vi.fn();
const workspaceAgentInstructions = vi.fn();
vi.mock('../api', () => ({
  api: {
    patchWorkspace: (...a: unknown[]) => patchWorkspace(...a),
    workspaceAgentInstructions: (...a: unknown[]) => workspaceAgentInstructions(...a),
  },
}));
vi.mock('../workspaces', () => ({ refreshWorkspaces: () => Promise.resolve([]) }));

const { WorkspaceSettings } = await import('./WorkspaceSettings');

const ws = {
  id: 'w1',
  name: 'Trayo',
  slug: 'trayo',
  tab_count: 4,
  instructions: 'old text',
  slack: false,
} as never;

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  patchWorkspace.mockReset().mockResolvedValue({});
  workspaceAgentInstructions.mockReset().mockResolvedValue({ text: 'COMPOSED' });
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const mount = (over: Record<string, unknown> = {}) =>
  act(() => {
    root.render(
      <WorkspaceSettings workspace={{ ...(ws as object), ...over } as never} onClose={() => {}} />,
    );
  });

/**
 * Typing, the way React can actually see.
 *
 * Assigning `el.value` directly is invisible: React caches the last value it
 * wrote on the node and treats an `input` event whose value matches that cache
 * as a no-op, so the state never moves — and then the blur test asserts against
 * an unchanged value and "no PATCH" looks like correct behaviour. Going through
 * the native setter updates the node the way a keystroke does.
 */
const type = (el: HTMLTextAreaElement, v: string) =>
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('instructions', () => {
  it('does not PATCH per keystroke', async () => {
    await mount();
    const ta = host.querySelector('textarea') as HTMLTextAreaElement;
    type(ta, 'new text');
    expect(patchWorkspace).not.toHaveBeenCalled();
  });

  it('PATCHes on blur', async () => {
    await mount();
    const ta = host.querySelector('textarea') as HTMLTextAreaElement;
    type(ta, 'new text');
    await act(async () => {
      // React's onBlur is delegated off `focusout` (17+). A `blur` event does
      // not bubble, so dispatching one here reaches no handler and the test
      // passes by measuring nothing.
      ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(patchWorkspace).toHaveBeenCalledWith('w1', { instructions: 'new text' });
  });

  it('does not PATCH an unchanged value', async () => {
    await mount();
    const ta = host.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      // React's onBlur is delegated off `focusout` (17+). A `blur` event does
      // not bubble, so dispatching one here reaches no handler and the test
      // passes by measuring nothing.
      ta.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
    expect(patchWorkspace).not.toHaveBeenCalled();
  });
});

describe('the Slack capability', () => {
  const toggle = () => host.querySelector('.ws-settings__toggle') as HTMLButtonElement;

  it('flips on and PATCHes', async () => {
    await mount();
    await act(async () => toggle().click());
    expect(patchWorkspace).toHaveBeenCalledWith('w1', { slack: true });
    expect(toggle().getAttribute('data-on')).toBe('true');
  });

  it('puts the switch BACK when the server refuses, and says why', async () => {
    patchWorkspace.mockRejectedValue(new Error('ui_only: an agent must not grant itself Slack'));
    await mount();
    await act(async () => toggle().click());
    expect(toggle().getAttribute('data-on')).toBeNull();
    expect(host.querySelector('.ws-settings__err')?.textContent).toContain('ui_only');
  });
});

describe('the preview', () => {
  it('is not fetched until it is opened — it is the whole prompt', async () => {
    await mount();
    expect(workspaceAgentInstructions).not.toHaveBeenCalled();
    await act(async () => (host.querySelector('.ws-settings__pvh') as HTMLButtonElement).click());
    expect(workspaceAgentInstructions).toHaveBeenCalledWith('w1');
    expect(host.querySelector('.ws-settings__pv')?.textContent).toBe('COMPOSED');
  });
});
