import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ChatEvent, InboundSender } from '@muxpad/shared';
import { inboundTextKey } from '@muxpad/shared';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { MentionChat } from '../lib/chat-mention';
import { matchInboundSenders } from '../lib/inbound-senders';
import { ChatMentionContext, MentionMessage } from './ChatPane';

/**
 * A MESSAGE FROM ANOTHER AGENT IS NOT A MESSAGE THE HUMAN TYPED.
 *
 * `muxpad agent send` delivers a real message — muxpad does not write the
 * agent's transcript, it tails the harness's file — so a coordinator's
 * multi-paragraph brief has rendered on the receiving side as an ordinary user
 * bubble, indistinguishable from something the person typed. This is the
 * end-to-end of the fix: recorded rows in, a card out, and the human's own
 * messages left exactly as they were.
 */

const SRC = readFileSync(join(__dirname, 'ChatPane.tsx'), 'utf8');

function chat(tabName: string): MentionChat {
  return {
    tabId: tabName.toLowerCase(),
    tabName,
    tabSlug: 'abc123',
    workspaceId: 'w1',
    workspaceSlug: 'personal',
    workspaceName: 'Personal',
    paneIds: [],
    chip: { name: tabName, icon: '🤖' },
  };
}

const user = (id: string, text: string, ts = 1): ChatEvent =>
  ({ kind: 'user', id, ts, text }) as ChatEvent;

const row = (text: string, from: string | null, at = 100): InboundSender => ({
  key: inboundTextKey(text),
  at,
  from_tab_id: from,
});

const COORDINATOR = chat('coordinator');

/**
 * Render one bubble the way the conversation does — through the same context
 * the transcript's rows resolve against, with the map built by the same
 * function ChatPane builds it with. Nothing about the join is re-implemented
 * here, which is the point: this fails if either half drifts.
 */
function bubble(events: readonly ChatEvent[], senders: readonly InboundSender[], which = 0) {
  const inbound = matchInboundSenders(events, senders);
  const e = events[which] as Extract<ChatEvent, { kind: 'user' }>;
  return html(
    <ChatMentionContext.Provider value={{ corpus: [COORDINATOR], open: () => {}, inbound }}>
      <MentionMessage eventId={e.id} text={e.text} />
    </ChatMentionContext.Provider>,
  );
}

describe('a message delivered by another chat', () => {
  const events = [user('e1', 'Take the sidebar work and report back.')];
  const senders = [row('Take the sidebar work and report back.', 'coordinator')];

  it('renders as a CARD that names the sending chat', () => {
    const out = bubble(events, senders);
    expect(out).toContain('chat-mention-card');
    expect(out).toContain('coordinator');
    expect(out).toContain('sent this');
  });

  it('is not an ordinary bubble', () => {
    expect(bubble(events, senders)).not.toContain('chat-bubble');
  });

  it('still shows the message itself', () => {
    // A card that hides what was said is worse than the bubble it replaced.
    expect(bubble(events, senders)).toContain('Take the sidebar work and report back.');
  });
});

describe('a message the human typed', () => {
  const events = [user('e1', 'what is the status?')];

  it('renders exactly as it always has — an ordinary bubble, no card', () => {
    const out = bubble(events, []);
    expect(out).toContain('chat-bubble');
    expect(out).not.toContain('chat-mention-card');
  });

  it('stays a bubble even while OTHER messages in the chat have cards', () => {
    // The mixed transcript — a coordinator briefing a chat the human also talks
    // to — which is the only case where getting this wrong is visible.
    const mixed = [user('e1', 'a brief from the boss', 10), user('e2', 'thanks, carry on', 20)];
    const rows = [row('a brief from the boss', 'coordinator')];
    expect(bubble(mixed, rows, 0)).toContain('chat-mention-card');
    expect(bubble(mixed, rows, 1)).toContain('chat-bubble');
    expect(bubble(mixed, rows, 1)).not.toContain('chat-mention-card');
  });
});

describe('a message with no sender recorded', () => {
  it('renders as today — a message that predates the feature is not attributed', () => {
    // The stated constraint: "inventing an attribution is not" an acceptable
    // answer for a message already in the transcript when this shipped.
    const events = [user('e1', 'an old brief nobody recorded')];
    const out = bubble(events, []);
    expect(out).toContain('chat-bubble');
    expect(out).not.toContain('chat-mention-card');
  });

  it('renders as today when muxpad recorded the send but cannot name the chat', () => {
    const events = [user('e1', 'from nowhere')];
    const out = bubble(events, [row('from nowhere', null)]);
    expect(out).toContain('chat-bubble');
    expect(out).not.toContain('chat-mention-card');
  });
});

describe('the wiring in ChatPane', () => {
  it('does not add anything to the text the model receives', () => {
    // THE CONSTRAINT THAT GOVERNS THIS WHOLE FEATURE. The card is presentation;
    // the prompt the worker is handed must be byte-identical to what was sent,
    // or every worker's behaviour changes by accident. The provenance therefore
    // arrives as a ROW matched to the bubble — never a marker spliced into it,
    // which is what `<muxpad-cron>` deliberately does and this must not.
    expect(SRC).toContain('inbound?.get(eventId)');
    expect(SRC).not.toContain('<muxpad-from');
    expect(SRC).not.toContain('renderInboundMarker');
  });

  it('resolves the sending chat LIVE from the corpus, not from a stored name', () => {
    // So a chat renamed since it sent the message shows its current name — and
    // so a caller cannot make a card claim a chat it is not.
    expect(SRC).toContain('corpus.find((c) => c.tabId === fromTabId)');
  });

  it('asks the server once per conversation, keyed on messages actually arriving', () => {
    // Not a poll. A chat the human types into has unattributed bubbles by
    // definition, so "re-ask while something is unattributed" would re-ask
    // forever; the newest user message is the real staleness signal.
    expect(SRC).toContain('loadInboundSenders(myTabId)');
    expect(SRC).toContain('}, [myTabId, newestUserId]);');
    expect(SRC.split('const inboundByEvent').length - 1).toBe(1);
  });

  it('pulls the corpus in for these cards, which carry no marker to scan for', () => {
    expect(SRC).toContain('if (!transcriptNeedsCorpus && inboundSenders.length > 0)');
  });
});
