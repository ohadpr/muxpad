/**
 * Write text to the clipboard, working in both secure and non-secure
 * contexts.
 *
 * Why this exists: navigator.clipboard is undefined whenever the page is not
 * a secure context — the app served over http://<hostname> or
 * http://<lan-ip> rather than localhost/https (e.g. Tailscale serve). In that
 * situation the only thing that works is the legacy
 * document.execCommand('copy') path via a temporary, off-screen <textarea>.
 *
 * Returns true if the write is believed to have succeeded.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  // Preferred path: async Clipboard API (secure contexts only).
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission denied or context lost — fall through to the legacy path.
  }

  // Legacy fallback: execCommand('copy') from a hidden textarea. Works in
  // non-secure contexts where navigator.clipboard is unavailable.
  if (typeof document === 'undefined') return false;
  // Save the element that currently owns focus so we can restore it after
  // .select() steals focus to our hidden textarea. Without this, anything
  // typing into xterm (which is just a focused textarea) loses focus the
  // moment a TUI emits OSC 52 — and xterm's ClipboardAddon routes OSC 52
  // through here. That bug surfaces as the focused pane silently going
  // inactive whenever a shell/TUI writes to the clipboard.
  const prevActive = document.activeElement as HTMLElement | null;
  const ta = document.createElement('textarea');
  ta.value = text;
  // Keep it out of view and out of layout flow, but still selectable.
  ta.style.position = 'fixed';
  ta.style.top = '-9999px';
  ta.style.left = '-9999px';
  ta.setAttribute('readonly', '');
  ta.setAttribute('aria-hidden', 'true');
  document.body.appendChild(ta);
  try {
    ta.select();
    ta.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    document.body.removeChild(ta);
    // Restore focus to whatever element had it before. focus() is a no-op
    // if the element is no longer focusable or has been removed from DOM.
    if (prevActive && typeof prevActive.focus === 'function') {
      try {
        prevActive.focus({ preventScroll: true });
      } catch {
        // ignore — element may have been disposed mid-write
      }
    }
  }
}

/**
 * Read text from the clipboard. Only the secure-context Clipboard API can
 * read; there is no non-secure fallback for reads (execCommand('paste') is
 * not supported by browsers). Returns '' when unavailable.
 */
export async function readClipboard(): Promise<string> {
  try {
    return (await navigator.clipboard?.readText()) ?? '';
  } catch {
    return '';
  }
}
