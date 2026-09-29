import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { normalizeProfileName } from './BrowserProfile.js';

/**
 * What the phone's keyboard actually did.
 *
 * The browser being driven runs on this machine; the keyboard that will not stay
 * up belongs to a handset somewhere else entirely, and no web page is told when
 * a keyboard opens or closes. So the only evidence available for the vanishing
 * keyboard has been a person describing what they saw — and three fixes in a row
 * were aimed at the wrong mechanism because of it.
 *
 * `visualViewport.height` is the witness the viewer can actually call: it
 * shrinks by the height of the keyboard and springs back when it goes. A shrink
 * followed by a growth, with no blur in between, is the keyboard being WITHDRAWN
 * from a field that still has focus — which is a completely different bug from
 * the field losing focus, and indistinguishable from it without this.
 *
 * A LOG, not a state. Nothing reads it back; it exists to be looked at after
 * somebody taps a field and says it happened again.
 */

/** Where a profile's keyboard log lives. One file, appended, under the data dir. */
export function keyboardLogPath(dataDir: string, profile: string): string {
  return `${dataDir.replace(/\/+$/, '')}/browser-keyboard-${normalizeProfileName(profile)}.log`;
}

/**
 * How big it may get before the front is dropped.
 *
 * Small on purpose. This is a diagnostic somebody reads by eye, and a phone that
 * is left on a page tapping fields could otherwise write until the disk noticed.
 */
export const KEYBOARD_LOG_CAP = 64 * 1024;

/**
 * One report, as the line that will be read.
 *
 * Pure, so the shape can be tested without a filesystem — and the shape is the
 * whole point: a timeline is only useful if the entries stay in order and carry
 * their times, and a JSON blob per report keeps both without needing a parser.
 */
export function keyboardLogLine(
  at: number,
  report: { what?: unknown; events?: unknown },
): string | null {
  if (!Array.isArray(report.events) || report.events.length === 0) return null;
  // Bounded here rather than trusted: this arrives over a socket from a page.
  const events = report.events.slice(0, 60);
  return `${JSON.stringify({ at: new Date(at).toISOString(), events })}\n`;
}

/**
 * Appends one report, trimming the front if the file has grown past the cap.
 *
 * Best-effort throughout: this is a note about a keyboard, and nothing about the
 * browser should fail because a note could not be written.
 */
export function appendKeyboardLog(
  dataDir: string,
  profile: string,
  report: { what?: unknown; events?: unknown },
  now: number = Date.now(),
): boolean {
  const line = keyboardLogLine(now, report);
  if (!line) return false;
  try {
    const path = keyboardLogPath(dataDir, profile);
    mkdirSync(dataDir, { recursive: true });
    try {
      if (statSync(path).size > KEYBOARD_LOG_CAP) {
        // Keep the RECENT half. The interesting tap is the one that just
        // happened, and a log that stops accepting new entries once it is full
        // would drop exactly that one.
        const kept = readFileSync(path, 'utf8').slice(-KEYBOARD_LOG_CAP / 2);
        writeFileSync(path, kept.slice(kept.indexOf('\n') + 1));
      }
    } catch {
      // No file yet, which is the ordinary case.
    }
    appendFileSync(path, line);
    return true;
  } catch {
    return false;
  }
}
