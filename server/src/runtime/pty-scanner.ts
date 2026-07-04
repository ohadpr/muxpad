/**
 * Streaming scanner for PTY output. Emits these while the caller pushes raw
 * bytes into feed():
 *
 *   - bel    a "real" BEL (0x07) was seen — one not used as the
 *            terminator of an OSC/DCS/APC/PM string. Used to surface
 *            "this pane needs attention" on the workspace tab bar.
 *
 *   - title  an OSC 0 / 1 / 2 sequence completed and the payload (the
 *            terminal title the program just set) is returned. zsh, bash,
 *            vim, claude code etc. all emit these. Used to label the pane.
 *
 *   - markers  one OSC 7771 ("muxpad app-url") marker per completed
 *            sequence — the explicit, zero-false-positive way for a program
 *            (via the `muxpad app-url` helper) to declare the web app it
 *            serves. Payload: `7771;muxpad;app;url=<URL>[;label=<LABEL>]`.
 *
 *   - urls   plain http(s) URLs seen on completed output lines this chunk.
 *            RAW — not yet host/port-validated; the AppUrlTracker decides
 *            which are real local servers (host ∈ this machine's identity +
 *            actually listening). This is the noisy source, kept honest
 *            downstream by the listening probe, never auto-acted-on.
 *
 * State is carried across feed() calls because a sequence — or a line — can
 * be split across PTY chunks. Both internal buffers (OSC payload + printable
 * line) are hard-capped so neither a malformed escape nor a newline-less
 * stream (`yes`, a progress bar, a multi-MB single line) can grow memory
 * without bound. Retained state stays a few KB regardless of throughput.
 *
 * Recognized string-introducer prefixes (per ECMA-48 / xterm):
 *   ESC ]   OSC  — title (0/1/2), cwd (7), clipboard (52), app-url (7771), …
 *   ESC P   DCS
 *   ESC ^   PM
 *   ESC _   APC
 * Each runs until ST (ESC \) or BEL.
 */

const OSC_BUFFER_LIMIT = 2048;
// Printable-line buffer cap. A URL line is short (a server prints
// `Local: http://localhost:5173/` on its own); anything longer without a
// newline isn't a URL-bearing line, so on overflow we scan what we have and
// reset — bounding memory while still catching real (short) URL lines.
const LINE_BUFFER_LIMIT = 2048;
// muxpad's private OSC code for the app-url marker. High + namespaced by the
// `muxpad;app` prefix in the payload so it can't collide with a real OSC.
const APP_MARKER_OSC = '7771';

// Linear, anchored on the literal scheme — no nested quantifiers, so no
// catastrophic backtracking on adversarial input. Runs only on a completed,
// length-capped line.
const URL_RE = /https?:\/\/[^\s'"<>`]+/g;
// Trailing punctuation a URL printed in prose tends to pick up.
const URL_TRAILING_TRIM = /[.,;:!?)\]}>'"]+$/;

export interface AppUrlMarker {
  url: string;
  label?: string;
}

export interface ScanEvents {
  bel: boolean;
  /** Most recent title set by an OSC 0/1/2 in this chunk, if any. */
  title?: string;
  /** Raw http(s) URLs seen on completed lines this chunk (unvalidated). */
  urls?: string[];
  /** Explicit OSC 7771 app-url markers completed this chunk. */
  markers?: AppUrlMarker[];
}

type State = 'normal' | 'esc' | 'csi' | 'osc' | 'osc-esc' | 'string-other' | 'string-other-esc';

export class PtyScanner {
  private state: State = 'normal';
  private oscBuf = '';
  // Rolling buffer of printable characters on the current output line, used
  // to extract plain-text URLs. Reset on LF/CR and on overflow (see cap).
  private lineBuf = '';

  feed(data: string): ScanEvents {
    let bel = false;
    let title: string | undefined;
    let urls: string[] | undefined;
    let markers: AppUrlMarker[] | undefined;

    const scanLine = () => {
      if (this.lineBuf.length === 0) return;
      const found = extractUrls(this.lineBuf);
      if (found.length > 0) {
        if (!urls) urls = [];
        urls.push(...found);
      }
      this.lineBuf = '';
    };

    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      switch (this.state) {
        case 'normal':
          if (ch === 0x1b) this.state = 'esc';
          else if (ch === 0x07) bel = true;
          // LF or CR closes the current line for URL-scan purposes. CR
          // matters: progress bars/spinners redraw with CR and no LF, so
          // without resetting here the line buffer would grow unbounded.
          else if (ch === 0x0a || ch === 0x0d) scanLine();
          // Accumulate printable bytes (skip C0 controls + DEL). Hard cap:
          // on overflow scan what we have and reset so memory stays bounded.
          else if (ch >= 0x20 && ch !== 0x7f) {
            this.lineBuf += data[i];
            if (this.lineBuf.length >= LINE_BUFFER_LIMIT) scanLine();
          }
          break;

        case 'esc':
          if (ch === 0x5d) {
            // ESC ] — start of an OSC sequence we want to parse.
            this.state = 'osc';
            this.oscBuf = '';
          } else if (ch === 0x5b) {
            // ESC [ — CSI. Consume its parameter/intermediate/final bytes so
            // SGR colors etc. (ubiquitous around printed URLs) don't leak
            // into the line buffer as text.
            this.state = 'csi';
          } else if (ch === 0x50 || ch === 0x5e || ch === 0x5f) {
            // DCS/PM/APC — content not interesting; just skip until terminator.
            this.state = 'string-other';
          } else {
            this.state = 'normal';
          }
          break;

        case 'csi':
          // CSI runs until a final byte in 0x40–0x7e; params/intermediates
          // (0x20–0x3f) stay in this state.
          if (ch >= 0x40 && ch <= 0x7e) this.state = 'normal';
          break;

        case 'osc':
          if (ch === 0x07 || ch === 0x1b) {
            // BEL terminates immediately; ESC may be the start of ST (ESC \).
            const parsedTitle = parseOscTitle(this.oscBuf);
            if (parsedTitle !== null) title = parsedTitle;
            const marker = parseAppMarker(this.oscBuf);
            if (marker !== null) {
              if (!markers) markers = [];
              markers.push(marker);
            }
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
    if (urls !== undefined) result.urls = urls;
    if (markers !== undefined) result.markers = markers;
    return result;
  }
}

function extractUrls(line: string): string[] {
  const out: string[] = [];
  for (const m of line.matchAll(URL_RE)) {
    const cleaned = m[0].replace(URL_TRAILING_TRIM, '');
    if (cleaned) out.push(cleaned);
  }
  return out;
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

/**
 * Parse a muxpad app-url marker: `7771;muxpad;app;url=<URL>[;label=<LABEL>]`.
 * Returns null for any OSC that isn't this exact, namespaced shape, so a
 * stray OSC 7771 from another program (vanishingly unlikely, but cheap to
 * guard) can't masquerade as an app URL. A marker with no parseable `url=`
 * is dropped.
 */
function parseAppMarker(buf: string): AppUrlMarker | null {
  const parts = buf.split(';');
  if (parts[0] !== APP_MARKER_OSC || parts[1] !== 'muxpad' || parts[2] !== 'app') return null;
  let url: string | undefined;
  let label: string | undefined;
  for (const kv of parts.slice(3)) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    if (key === 'url') url = value;
    else if (key === 'label') label = value;
  }
  if (!url) return null;
  return label !== undefined ? { url, label } : { url };
}
