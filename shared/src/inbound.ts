/**
 * WHO SENT THIS MESSAGE — the provenance of a message delivered INTO a chat.
 *
 * `muxpad agent send` puts a message into another chat's conversation, and on
 * the receiving side it has always rendered as an ordinary user bubble: a
 * coordinator's multi-paragraph brief is indistinguishable from something the
 * human typed. This is the record that says otherwise.
 *
 * ─── Why this is not a marker in the text ────────────────────────────────────
 * The cron fire solves the same problem the other way — `renderCronMarker`
 * wraps the prompt in a `<muxpad-cron>` block that IS delivered to the model,
 * deliberately, because a scheduled job genuinely needs to tell the agent it is
 * not a human speaking.
 *
 * This must not do that. A chat-to-chat send is already addressed to the agent
 * by a peer that can say whatever it needs to in its own words; prepending a
 * block would change the prompt every worker in the fleet receives, which is a
 * behaviour change wearing a presentation change's clothes. So the provenance
 * lives in a muxpad-owned ROW instead — the `spawn_rounds` arrangement — and is
 * joined back to the transcript in the client.
 *
 * ─── Why the join key is a hash of the text ──────────────────────────────────
 * muxpad does not write the agent's transcript; it tails the harness's file. So
 * the row and the bubble have no shared id to join on, and the obvious
 * candidate — the timestamp — does not work: a send that arrives mid-turn is
 * persisted to the server-side queue and delivered whenever the current turn
 * ends, which on a long turn is many minutes later. The TEXT is the one thing
 * that survives that trip unchanged, so it is what the two sides agree on.
 */

/**
 * The join key for one delivered message.
 *
 * FNV-1a over the trimmed text, with the length mixed into the output. Not a
 * cryptographic hash and not trying to be: this is a lookup key for rows muxpad
 * wrote about its own sends, and a collision shows the wrong chat's name on a
 * card rather than leaking anything. What it has to be is (a) identical on both
 * sides and (b) synchronous — the browser computes it during render, where
 * SubtleCrypto's promise would be useless.
 *
 * TRIMMED because `submitSend` trims before it relays (see ws.ts), so the text
 * that reaches the transcript is already the trimmed form. Hashing the raw
 * argument would miss every message a shell heredoc gave a trailing newline.
 */
export function inboundTextKey(text: string): string {
  const s = text.trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    // 32-bit FNV prime multiply, via shifts — `* 16777619` loses precision
    // above 2^53 and would make the two implementations disagree.
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  // Length is the cheapest independent discriminator there is, and the messages
  // this keys are long: two briefs that collide in 32 bits are unlikely to also
  // be the same number of characters.
  return `${s.length.toString(36)}.${h.toString(36)}`;
}

/**
 * One recorded delivery — "this text arrived here, from there".
 *
 * `from_tab_id` is the SENDING CHAT, resolved server-side from the pane the
 * sender was running in. A tab id rather than a name on purpose: the name is
 * resolved live from the corpus at render time, so a chat that has since been
 * renamed shows its current name, and a caller cannot make a card claim to be
 * from a chat it is not.
 *
 * Null means muxpad knows a send happened but cannot name a chat behind it — an
 * unregistered caller, or a pane that has since been deleted. That renders as an
 * ordinary bubble; see the store.
 */
export interface InboundSender {
  /** `inboundTextKey` of the delivered text. */
  key: string;
  /** Epoch ms of the SEND, not of the delivery. */
  at: number;
  from_tab_id: string | null;
}
