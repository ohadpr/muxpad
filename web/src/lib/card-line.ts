/** Collapsed cards preview their first content line; expanded cards render the
 * original source. Select the preview before markdown rendering so later
 * paragraphs, hard breaks and fenced tables cannot leak into the summary. */
const BLOCK_MARKER = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d{1,9}[.)]\s+)/;
const FENCE = /^\s{0,3}(`{3,}|~{3,})(.*)$/;
const RULE = /^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;

function literal(text: string): string {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

export function cardLineText(content: string): string {
  return (
    content
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ''
  );
}

/** Preserve inline formatting on the first nonempty markdown content line.
 * For a code-only card, skip the opening fence and preview its first row as a
 * code span, avoiding a preformatted block and its copy-button panel. */
export function cardLineMarkdown(content: string): string {
  let fence: string | null = null;
  for (const raw of content.split(/\r?\n/)) {
    const delimiter = FENCE.exec(raw);
    if (fence) {
      if (
        delimiter &&
        delimiter[1]![0] === fence[0] &&
        delimiter[1]!.length >= fence.length &&
        !delimiter[2]!.trim()
      ) {
        fence = null;
        continue;
      }
      const text = raw.replace(/\s+/g, ' ').trim();
      if (text) return literal(text);
      continue;
    }
    if (delimiter) {
      fence = delimiter[1]!;
      continue;
    }
    const text = raw.replace(BLOCK_MARKER, '').replace(/\s+/g, ' ').trim();
    if (text && !RULE.test(raw)) return text;
  }
  return '';
}
