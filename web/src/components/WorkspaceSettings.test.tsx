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
const slackToken = vi.fn();
const setSlackToken = vi.fn();
const clearSlackToken = vi.fn();
vi.mock('../api', () => ({
  api: {
    patchWorkspace: (...a: unknown[]) => patchWorkspace(...a),
    workspaceAgentInstructions: (...a: unknown[]) => workspaceAgentInstructions(...a),
    slackToken: (...a: unknown[]) => slackToken(...a),
    setSlackToken: (...a: unknown[]) => setSlackToken(...a),
    clearSlackToken: (...a: unknown[]) => clearSlackToken(...a),
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
  slackToken.mockReset().mockResolvedValue({ set: false, hint: null });
  setSlackToken.mockReset().mockResolvedValue({ set: true, hint: 'xoxp-…4f2a' });
  clearSlackToken.mockReset().mockResolvedValue({ set: false });
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

/**
 * THE CREDENTIAL FIELD IS WRITE-ONLY, and the panel is the only way in.
 *
 * It used to be a line in a dotfile that the CLI sourced into whichever pane
 * asked, so a refused chat could read it and bypass muxpad entirely. The
 * server holds it now. What this component must get right is narrow: never
 * render the token, and never offer the field somewhere the capability is off
 * — a credential prompt under a switch that is off is an invitation to paste
 * a company token into a personal workspace.
 */
describe('the Slack credential', () => {
  const cred = () => host.querySelector('.ws-settings__cred');

  it('is not offered at all while the capability is off', async () => {
    await mount({ slack: false });
    expect(cred()).toBeNull();
  });

  it('appears once the capability is on', async () => {
    await mount({ slack: true });
    expect(cred()).not.toBeNull();
    expect(cred()?.querySelector('input')?.getAttribute('type')).toBe('password');
  });

  it('saves a pasted token and clears the field', async () => {
    await mount({ slack: true });
    const input = cred()?.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, '  xoxp-abc  ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (cred()?.querySelector('button') as HTMLButtonElement).click());
    // Trimmed: a token pasted out of a web page arrives with whitespace, and
    // Slack rejects it with an error about auth rather than about spaces.
    expect(setSlackToken).toHaveBeenCalledWith('xoxp-abc');
  });

  it('shows only the tail of a stored one, never the token', async () => {
    slackToken.mockResolvedValue({ set: true, hint: 'xoxp-…4f2a' });
    await mount({ slack: true });
    await act(async () => {});
    expect(cred()?.textContent).toContain('xoxp-…4f2a');
    expect(cred()?.querySelector('input')).toBeNull();
  });

  it('surfaces the server’s refusal rather than swallowing it', async () => {
    // The wrong KIND of token is the common mistake — the app-level `xapp-`
    // sits next to the right one on Slack's own page — and the server's
    // message is the only thing that explains it.
    setSlackToken.mockRejectedValue(new Error('that is an app-level token (xapp-…)'));
    await mount({ slack: true });
    const input = cred()?.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'xapp-1');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => (cred()?.querySelector('button') as HTMLButtonElement).click());
    expect(host.querySelector('.ws-settings__err')?.textContent).toContain('app-level token');
  });
});
