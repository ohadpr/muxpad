/**
 * The collapsed card's ONE LINE, built as text rather than defended in CSS.
 *
 * ── WHY THIS IS NOT MORE CSS ──────────────────────────────────────────────
 * A collapsed card renders its markdown and relies on `white-space: nowrap`
 * plus a list of `display: inline` overrides to flatten the blocks onto the
 * line. That list has now been wrong three times, each time in the same shape:
 * it names the blocks it knows about, and markdown emits something it does not.
 *
 *   1. `.chat-card-line > *`       reached the WRAPPER only — `.chat-md`'s <p>
 *                                  children still laid out as blocks.
 *   2. the preview before it       same miss, same fix, shipped twice.
 *   3. the Investing card          a fenced table: `display: inline` on <pre>
 *                                  does nothing for the <code> inside it,
 *                                  which carries `white-space: pre` — and
 *                                  `white-space` on a descendant beats the
 *                                  line's `nowrap`. Six rows on "one line",
 *                                  inside a bordered panel, under a copy
 *                                  button, with three more lines above it from
 *                                  the two-space hard breaks.
 *
 * `br` is the part that cannot be fixed by inlining at all: a hard break breaks
 * the line whatever its `display` is. So the CSS approach was never complete —
 * it was a list of exceptions racing against a markdown renderer.
 *
 * FLATTENING THE SOURCE INSTEAD makes the line's height a function of the text
 * rather than of which elements happened to be styled: there is one paragraph,
 * always, so there is one line, always. It is also testable without a layout
 * engine, which the CSS rules were not — every one of the three regressions
 * above was found by eye, in the live app, after shipping.
 *
 * The CSS stays as it is. It is a sound second line of defence for inline
 * content, and removing it would be a third mechanism change in one fix.
 */

/** Markdown that STARTS a line and means "this is a block" — flattened away,
 *  because a heading or a bullet on a one-line card is a marker for a layout
 *  the line does not have. The text after it is the value. */
const BLOCK_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/;
/** An opening or closing fence, with an optional info string. */
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
/** A horizontal rule is pure layout. */
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

/** Wrap literal text so the markdown renderer cannot interpret it — a code
 *  span delimited by a backtick run longer than any inside it (CommonMark's
 *  own escape hatch), padded when the content starts or ends with a backtick. */
function literal(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/**
 * Collapse a markdown card to a single line of markdown.
 *
 * Inline formatting SURVIVES — bold, links and code spans are what makes a
 * one-line value readable, and they cost no height. Block structure does not:
 * paragraphs, list items and fenced rows become segments joined by a faint
 * separator, which is the one thing the flattening has to add (without it the
 * blocks butt together: "no action✅ no action").
 *
 * Fenced content is re-emitted as a code SPAN, not as prose: it is there
 * because somebody wanted it monospaced and literal, and prose would let a
 * `*` in an ASCII table start an emphasis run that never closes.
 */
export function cardLineMarkdown(content: string): string {
  const segments: string[] = [];
  let fence: string | null = null;
  let fenced: string[] = [];
  const flushFence = () => {
    const text = fenced.join(' · ').replace(/\s+/g, ' ').trim();
    if (text) segments.push(literal(text));
    fenced = [];
  };
  for (const raw of content.split('\n')) {
    const open = FENCE.exec(raw);
    if (fence) {
      // A closing fence is the same character, at least as long, and carries no
      // info string. Anything else is content, including a shorter run.
      if (open && open[1]![0] === fence[0] && open[1]!.length >= fence.length && !open[2]!.trim()) {
        fence = null;
        flushFence();
      } else fenced.push(raw);
      continue;
    }
    if (open) {
      fence = open[1]!;
      continue;
    }
    const line = raw.replace(BLOCK_MARKER, '').replace(/\s+/g, ' ').trim();
    if (!line || RULE.test(raw)) continue;
    segments.push(line);
  }
  // An unterminated fence is still content — a card written mid-edit, or one
  // whose closing fence was lost to a truncation, must not vanish.
  if (fence) flushFence();
  return segments.join(' · ');
}
