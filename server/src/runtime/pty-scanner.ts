/**
 * Streaming scanner for PTY output. Emits two kinds of events while the
 * caller pushes raw bytes into feed():
 *
 *   - bel    a "real" BEL (0x07) was seen — one not used as the
 *            terminator of an OSC/DCS/APC/PM string. Used to surface
 *            "this pane needs attention" on the workspace tab bar.
 *
 *   - title  an OSC 0 / 1 / 2 sequence completed and the payload (the
 *            terminal title the program just set) is returned. zsh, bash,
 *            vim, claude code etc. all emit these. Used to label the pane.
 *
 * State is carried across feed() calls because a sequence can be split
 * across PTY chunks. Internal buffer for the OSC payload is hard-capped
 * so a malformed sequence can't grow forever.
 *
 * Recognized string-introducer prefixes (per ECMA-48 / xterm):
 *   ESC ]   OSC  — title (0/1/2), cwd (7), clipboard (52), …
 *   ESC P   DCS
 *   ESC ^   PM
 *   ESC _   APC
 * Each runs until ST (ESC \) or BEL.
 */

const OSC_BUFFER_LIMIT = 2048;

type State = 'normal' | 'esc' | 'osc' | 'osc-esc' | 'string-other' | 'string-other-esc';

export interface ScanEvents {
  bel: boolean;
  /** Most recent title set by an OSC 0/1/2 in this chunk, if any. */
  title?: string;
}

export class PtyScanner {
  private state: State = 'normal';
  private oscBuf = '';

  feed(data: string): ScanEvents {
    let bel = false;
    let title: string | undefined;

    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      switch (this.state) {
        case 'normal':
          if (ch === 0x1b) this.state = 'esc';
          else if (ch === 0x07) bel = true;
          break;

        case 'esc':
          if (ch === 0x5d) {
            // ESC ] — start of an OSC sequence we want to parse.
            this.state = 'osc';
            this.oscBuf = '';
          } else if (ch === 0x50 || ch === 0x5e || ch === 0x5f) {
            // DCS/PM/APC — content not interesting; just skip until terminator.
            this.state = 'string-other';
          } else {
            this.state = 'normal';
          }
          break;

        case 'osc':
          if (ch === 0x07 || ch === 0x1b) {
            // BEL terminates immediately; ESC may be the start of ST (ESC \).
            const parsed = parseOscTitle(this.oscBuf);
            if (parsed !== null) title = parsed;
            if (ch === 0x07) {
              this.state = 'normal';
              this.oscBuf = '';
            } else {
              this.state = 'osc-esc';
            }
          } else if (this.oscBuf.length < OSC_BUFFER_LIMIT) {
            this.oscBuf += data[i];
          }
          break;

        case 'osc-esc':
          // ESC inside an OSC. ESC \ is ST → terminate. Anything else: xterm
          // tolerates, treat as more body content.
          if (ch === 0x5c) {
            this.state = 'normal';
            this.oscBuf = '';
          } else {
            this.state = 'osc';
          }
          break;

        case 'string-other':
          if (ch === 0x07) this.state = 'normal';
          else if (ch === 0x1b) this.state = 'string-other-esc';
          break;

        case 'string-other-esc':
          if (ch === 0x5c) this.state = 'normal';
          else this.state = 'string-other';
          break;
      }
    }

    const result: ScanEvents = { bel };
    if (title !== undefined) result.title = title;
    return result;
  }
}

/**
 * OSC payloads are formatted "Ps;Pt" where Ps is the OSC code (0/1/2/7/52/…).
 * We accept 0 (icon + title), 1 (icon), 2 (window title) and return Pt.
 * Anything else (e.g. OSC 7 cwd, OSC 52 clipboard) returns null so the
 * caller ignores it.
 */
function parseOscTitle(buf: string): string | null {
  const semi = buf.indexOf(';');
  if (semi <= 0) return null;
  const ps = buf.slice(0, semi);
  if (ps !== '0' && ps !== '1' && ps !== '2') return null;
  return buf.slice(semi + 1);
}
