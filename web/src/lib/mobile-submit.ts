/**
 * Decide the frames to send when the mobile composer submits `text`.
 *
 * The submitting Enter MUST be a separate frame from the command text. If
 * they ride in one PTY read, Claude Code's paste detection sees a multi-char
 * burst ending in CR and treats the whole thing as a paste — the trailing CR
 * is then inserted as a literal newline at the prompt instead of submitting,
 * so the command just sits there. Sending the text first and a standalone CR
 * a beat later (see SUBMIT_ENTER_DELAY_MS in MobileInputBar) makes the CR read
 * as a real Enter keypress.
 *
 * Returns `text: null` for an empty submit (a bare blank Enter at the prompt);
 * in that case only `enter` is sent. The returned `text` never carries a
 * trailing CR — that invariant is what this split exists to guarantee.
 */
export function planSubmit(text: string): { text: string | null; enter: string } {
  return { text: text.length > 0 ? text : null, enter: '\r' };
}
