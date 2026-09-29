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

  /**
   * ─── "NO AGENT YET" MUST NOT STAND IN FOR "THE AGENT FAILED TO START" ─────
   *
   * The user's report was that a new chat never starts its agent, and what they
   * saw was the neutral screen above: "Nothing running here · This chat has no
   * agent yet · [Start agent]". Every word of it describes a STEADY STATE, and
   * it was being printed over a create whose pty spawn had failed seconds
   * earlier and been swallowed. So the screen asked them to press a button to
   * do the thing creating the chat was supposed to have done, and said nothing
   * about what had gone wrong — the silence was the bug, and this copy was the
   * face of it.
   *
   * The neutral wording STAYS for a pane that genuinely has no runner (a
   * converted terminal, a pane whose agent was killed). `failed` is what stops
   * it covering for a failure. Same verb, same button: the fix is the same, so
   * only the sentences change.
   */
  describe('when the server knows the agent FAILED to start', () => {
    const reason = 'cannot start the pty: posix_spawnp failed';
    const failed = () =>
      html(<ChatNoRunner busy={false} error={reason} failed={true} onStart={() => {}} />);

    it('says it could not start, not that it has none yet', () => {
      const out = failed();
      expect(out).toContain('could not start');
      // THE SENTENCE THAT WAS THE LIE. Its absence here is the assertion.
      expect(out).not.toContain('no agent yet');
      expect(out).not.toContain('Nothing running here');
    });

    it('names the reason, in the words of whatever refused', () => {
      expect(failed()).toContain('posix_spawnp failed');
    });

    it('offers a retry, labelled as one', () => {
      const out = failed();
      expect(out).toMatch(/<button[^>]*>Try again<\/button>/);
    });

    it('is byte-identical to the neutral state when NOT failed', () => {
      // The flag is the only difference, so a pane that merely has no runner
      // cannot drift into the failure copy by accident.
      const neutral = html(<ChatNoRunner busy={false} error={null} onStart={() => {}} />);
      const explicit = html(
        <ChatNoRunner busy={false} error={null} failed={false} onStart={() => {}} />,
      );
      expect(explicit).toBe(neutral);
      expect(neutral).toContain('This chat has no agent yet');
    });
  });
});
