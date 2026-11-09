import type { SourceMark } from '../lib/approval-request';
import { SlackLogo } from './SlackLogo';

/**
 * THE MARKS ON AN APPROVAL CARD.
 *
 * Inert local vectors, like SlackLogo — an approval dialog must never load
 * third-party content, least of all from the service it is asking about.
 *
 * Each one is labelled with the DATA it stands for ("Mail", not "Gmail"):
 * what a person is approving is a read of their mail, and which vendor holds
 * it is the smaller fact. Which mark appears is decided by `marksFor`, from
 * the verb alone.
 */

const size = { width: 20, height: 20 } as const;

function GmailMark() {
  return (
    <svg {...size} viewBox="0 0 52 40" role="img" aria-label="Mail">
      <rect x="1" y="1" width="50" height="38" rx="4" fill="#fff" stroke="#dadce0" />
      <path d="M1 7.5 26 25 51 7.5" fill="none" stroke="#ea4335" strokeWidth="3.4" />
      <path d="M1 36V9l10 7.5v19.5z" fill="#4285f4" />
      <path d="M51 36V9L41 16.5V36z" fill="#34a853" />
      <path d="M1 8.5A4 4 0 0 1 5.6 3L11 7v9.5z" fill="#c5221f" />
      <path d="M51 8.5A4 4 0 0 0 46.4 3L41 7v9.5z" fill="#fbbc04" />
    </svg>
  );
}

function CalendarMark() {
  return (
    <svg {...size} viewBox="0 0 48 48" role="img" aria-label="Calendar">
      <rect
        x="3"
        y="7"
        width="42"
        height="38"
        rx="4"
        fill="#fff"
        stroke="#dadce0"
        strokeWidth="2"
      />
      <path d="M3 11a4 4 0 0 1 4-4h34a4 4 0 0 1 4 4v5H3z" fill="#1a73e8" />
      <path d="M14 3v8M34 3v8" stroke="#1a73e8" strokeWidth="3.4" strokeLinecap="round" />
      <path d="M19 26h10v3l-5 5h5v3H19v-3l5-5h-5z" fill="#1a73e8" />
    </svg>
  );
}

function ContactsMark() {
  return (
    <svg {...size} viewBox="0 0 48 48" role="img" aria-label="Contacts">
      <circle cx="19" cy="17" r="7.6" fill="#1a73e8" />
      <path d="M5 42c1.3-7.6 7-12 14-12s12.7 4.4 14 12z" fill="#1a73e8" />
      <circle cx="35.5" cy="15" r="5.6" fill="#34a853" />
      <path d="M44 38c-.6-5.4-3.2-8.8-7-9.9 2.6 2.6 4.3 6 4.9 9.9z" fill="#34a853" />
    </svg>
  );
}

export function SourceMarks({ marks }: { marks: readonly SourceMark[] }) {
  // No mark at all for a verb the table does not know. An absent mark says
  // "this card cannot tell you"; a guessed one would say something false.
  if (!marks.length) return null;
  return (
    <span className="slack-passkey-marks">
      {marks.map((m) => (
        <span key={m} className="slack-passkey-mark">
          {m === 'slack' ? (
            <SlackLogo />
          ) : m === 'gmail' ? (
            <GmailMark />
          ) : m === 'calendar' ? (
            <CalendarMark />
          ) : (
            <ContactsMark />
          )}
        </span>
      ))}
    </span>
  );
}
