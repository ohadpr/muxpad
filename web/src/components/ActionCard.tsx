import { type ChatAction, actionIntegration } from '@muxpad/shared';
import { useState } from 'react';
import './ActionCard.css';
import { SlackLogo } from './SlackLogo';

/**
 * ONE ACT ON AN OUTSIDE SYSTEM, as a card in the conversation that did it.
 *
 * ── WHY A CARD AND NOT A LINE OF PROSE ───────────────────────────────────
 * The transcript already holds the agent SAYING it posted to Slack. That is
 * its account of its own effect, and it is written before the effect is known:
 * every outbound integration goes through an approval, so at the moment the
 * sentence is written the answer is "waiting". A minute later "did that
 * actually go?" had no surface at all — the approval alert is transient and
 * disappears the moment it is answered.
 *
 * So the same shape as a sub-chat: a card at the point in the log where the
 * thing happened, carrying its own outcome, with the conversation continuing
 * past it.
 *
 * ── GENERIC, AND THE INTEGRATION IS ONLY A GLYPH ─────────────────────────
 * Everything rendered here comes off {@link ChatAction}: a title, an optional
 * body, an optional link, and a state. Slack is the first producer; email and
 * WhatsApp are a case in {@link Glyph} and a producer on the server. Nothing
 * about Slack reaches this file beyond its logo.
 */

export interface ActionCardProps {
  action: ChatAction;
  /** Injected in tests. */
  now?: number;
}

/** What each state SAYS. Short, and never a spinner: `pending` is a real and
 *  usually long-lived state — somebody has to approve it — not a load. */
const SAYS: Record<ChatAction['state'], string> = {
  pending: 'waiting for you',
  sent: 'sent',
  // Kept apart from `failed` for the same reason `unauthorized` is kept apart
  // from `down` in the machines list: one is a decision and the other is a
  // fault, and drawing a decision as a failure invites a retry.
  declined: 'declined',
  failed: 'failed',
};

export function ActionCard({ action }: ActionCardProps) {
  const [open, setOpen] = useState(false);
  const body = action.body?.trim();
  return (
    <div className="action-card" data-state={action.state} data-kind={action.kind}>
      <span className="action-card__glyph" aria-hidden="true">
        <Glyph kind={action.kind} />
      </span>
      <div className="action-card__body">
        <div className="action-card__head">
          <span className="action-card__title">{action.title}</span>
          {/* The state is a WORD, not a colour alone — the dot beside it is the
              same fact for a glance, and the two together survive both a
              colourblind reader and a greyscale screenshot. */}
          <span className="action-card__state">{SAYS[action.state]}</span>
        </div>
        {action.detail ? <div className="action-card__detail">{action.detail}</div> : null}
        {/* WHAT WAS SENT, folded. A card sits in the log where the reader is
            scrolling past it, and a long message pinned open pushes the
            conversation off the screen — but the message IS the thing you came
            to check, so it is one click away and never a round trip. */}
        {body ? (
          <>
            <button
              type="button"
              className="action-card__toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              {open ? 'Hide message' : 'Show message'}
            </button>
            {open ? <pre className="action-card__text">{body}</pre> : null}
          </>
        ) : null}
      </div>
      {/* Only when the outside system gave us somewhere to go. A link that
          might 404 is worse than no link on a card whose whole job is to be
          trusted about what happened. */}
      {action.url ? (
        <a
          className="action-card__link"
          href={action.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          Open
        </a>
      ) : null}
    </div>
  );
}

/**
 * The integration's mark.
 *
 * Keyed on the part before the dot, so every Slack verb shares one glyph and a
 * new integration is one case. An unknown integration gets a neutral mark
 * rather than nothing: a card with no glyph reads as a broken card, and a
 * client older than the server WILL meet kinds it has not heard of.
 */
function Glyph({ kind }: { kind: string }) {
  switch (actionIntegration(kind)) {
    case 'slack':
      return <SlackLogo />;
    default:
      // An arrow leaving a box: "this went out of muxpad", which is the one
      // thing every action has in common.
      return (
        // biome-ignore lint/a11y/noSvgWithoutTitle: decorative — the wrapper is aria-hidden and the card's text carries the meaning
        <svg viewBox="0 0 16 16" width="15" height="15" fill="none">
          <path
            d="M9.25 2.75H13.25V6.75M13.25 2.75L8 8"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d="M12.25 9.75v2.5a1.5 1.5 0 0 1-1.5 1.5h-7a1.5 1.5 0 0 1-1.5-1.5v-7a1.5 1.5 0 0 1 1.5-1.5h2.5"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      );
  }
}
