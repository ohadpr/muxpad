import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChatNoRunner } from './ChatPane';

/**
 * THE EMPTY STATE OF AN AGENT PANE WITH NO PROCESS IN IT.
 *
 * The defect this guards: it used to say "No agent session here yet — start
 * one with `muxpad agent` (chat-native) or `muxpad claude` in the terminal."
 * Mobile is muxpad's primary surface. There is no terminal on a phone, so the
 * only action the screen offered could not be taken on the device most likely
 * to be showing it — and it appeared under a "New chat" button whose entire
 * job is to start an agent.
 *
 * Rendered to static markup: the assertions are about what the browser is
 * actually handed.
 */
const html = renderToStaticMarkup;

describe('a chat with no runner', () => {
  it('offers a BUTTON, not shell instructions', () => {
    const out = html(<ChatNoRunner busy={false} error={null} onStart={() => {}} />);
    expect(out).toContain('Start agent');
    expect(out).toMatch(/<button[^>]*>Start agent<\/button>/);
  });

  it('never tells a phone to go and use the terminal', () => {
    const out = html(<ChatNoRunner busy={false} error={null} onStart={() => {}} />);
    // The exact advice that was unreachable on the primary surface.
    expect(out).not.toContain('terminal');
    expect(out).not.toContain('muxpad agent');
    expect(out).not.toContain('muxpad claude');
    // …and no <code> block, which is the shape that advice always takes.
    expect(out).not.toContain('<code');
  });

  it('spins while starting instead of claiming nothing is running', () => {
    const out = html(<ChatNoRunner busy={true} error={null} onStart={() => {}} />);
    expect(out).toContain('Starting…');
    expect(out).toContain('chat-empty-spinner');
    // The button is GONE while busy — a second tap would kill the pty the
    // first one just spawned and restart the boot from zero.
    expect(out).not.toContain('Start agent');
  });

  it("surfaces the server's reason verbatim when the start fails", () => {
    // What POST /api/panes/:id/respawn actually answers when ptyd is down.
    const reason = 'cannot respawn pane: ptyd is not connected';
    const out = html(<ChatNoRunner busy={false} error={reason} onStart={() => {}} />);
    expect(out).toContain(reason);
    // A live region, so it is announced without stealing composer focus.
    expect(out).toMatch(/<output class="chat-convert-refusal"/);
    // The retry stays available — the failure is not a dead end.
    expect(out).toContain('Start agent');
  });
});
