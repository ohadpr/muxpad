// Chat messages carry host-local absolute paths to shared attachments
// (…/attachments/<hash>.<ext>) — pasted user images, or files the agent shows
// via show_files (images, videos, docs). The bytes live on the server host, so
// every device loads them through the serve route keyed by bare filename.

import { ATTACHMENT_EXT_ALTERNATION, type AttachmentKind, attachmentKind } from '@muxpad/shared';

// Match an attachments-dir path token: any non-space run ending in
// `/attachments/<file>.<ext>` for a known attachment type. Absolute paths never
// contain spaces, so a greedy \S* captures the whole path while the group grabs
// the name. The extension set is the shared pipeline-wide map — never local.
const ATTACHMENT_PATH_RE = new RegExp(
  `\\S*/attachments/([\\w.-]+\\.(?:${ATTACHMENT_EXT_ALTERNATION}))`,
  'gi',
);

export function attachmentUrl(name: string): string {
  return `/api/panes/attachments/${encodeURIComponent(name)}`;
}

export type MessagePart =
  | { kind: 'text'; text: string }
  // `media` = image | video (rendered inline, grouped into a gallery when
  // several are adjacent); `file` = everything else (a click-to-open chip).
  | {
      kind: 'media';
      media: Exclude<AttachmentKind, 'file'>;
      path: string;
      name: string;
      url: string;
    }
  | { kind: 'file'; path: string; name: string; url: string };

/** Split message text into plain runs and attachment references (classified
 *  by type), preserving order. */
/**
 * Byte ranges that are CODE, and therefore not references to anything.
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * A message that SHOWS an attachment path — a worked example, a snippet of the
 * message format, documentation of this very pipeline — had its paths yanked
 * out of the fence and rendered as media. Two things broke at once, and the
 * second is the bad one:
 *
 *   · the paths rendered as broken images, because an example path names no
 *     real file;
 *   · and pulling them out CUT THE FENCE INTO PIECES. The ``` markers no
 *     longer paired up, so everything after the example rendered as one long
 *     code block — the rest of the message, swallowed.
 *
 * Observed on a message explaining this exact feature, which is the sort of
 * self-reference a chat about building a chat produces all day.
 *
 * Fences and inline spans both, because `like /x/attachments/a.png` in a
 * sentence is the same claim: this is text about a path, not a path.
 */
function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  // FENCED FIRST, and inline spans are then skipped inside them: a lone
  // backtick in a shell example would otherwise open a span that swallows half
  // the message.
  const fence = /^[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/gm;
  let open: { marker: string; start: number } | null = null;
  for (const m of text.matchAll(fence)) {
    const marker = m[1] ?? '';
    const info = (m[2] ?? '').trim();
    const at = m.index ?? 0;
    if (!open) {
      open = { marker, start: at };
      continue;
    }
    // A closing fence is the same character, at least as long, and bare.
    if (marker[0] === open.marker[0] && marker.length >= open.marker.length && !info) {
      ranges.push([open.start, at + m[0].length]);
      open = null;
    }
  }
  // An unterminated fence runs to the end — that is how a streaming message
  // looks before its closing marker has arrived.
  if (open) ranges.push([open.start, text.length]);

  const inFence = (i: number) => ranges.some(([a, b]) => i >= a && i < b);
  const runs = [...text.matchAll(/`+/g)].filter((m) => !inFence(m.index ?? 0));
  for (let i = 0; i < runs.length; i++) {
    const open_ = runs[i];
    if (!open_) continue;
    for (let j = i + 1; j < runs.length; j++) {
      const close = runs[j];
      if (close && close[0].length === open_[0].length) {
        ranges.push([open_.index ?? 0, (close.index ?? 0) + close[0].length]);
        i = j;
        break;
      }
    }
  }
  return ranges;
}

export function splitMessageAttachments(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  const code = codeRanges(text);
  let last = 0;
  for (const m of text.matchAll(ATTACHMENT_PATH_RE)) {
    const name = m[1];
    if (!name) continue;
    // Inside code it stays text — and `last` is deliberately NOT advanced, so
    // the surrounding block is emitted whole and markdown still sees a fence
    // with both of its markers.
    const at = m.index ?? 0;
    if (code.some(([a, b]) => at >= a && at < b)) continue;
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    const url = attachmentUrl(name);
    const kind = attachmentKind(name);
    parts.push(
      kind === 'file'
        ? { kind: 'file', path: m[0], name, url }
        : { kind: 'media', media: kind, path: m[0], name, url },
    );
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}

/**
 * Build the message that goes out: trimmed prose, then the composer's
 * attachment paths (the agent reads the path, not the pixels).
 *
 * A path the draft ALREADY references is not appended again. Attachments ride
 * in the composer's chips, not the draft text — but a path can still reach the
 * text (hand-typed, pasted as text, a draft left over from an older build), and
 * a second reference to one attachment draws the same image twice in the sent
 * bubble. Dedupe is by attachment FILENAME: the stored name is the identity,
 * the leading directory is just the host's data dir.
 */
export function composeOutgoingMessage(text: string, attachmentPaths: string[]): string {
  const prose = text.trim();
  const seen = new Set(
    splitMessageAttachments(prose)
      .filter((p): p is Exclude<MessagePart, { kind: 'text' }> => p.kind !== 'text')
      .map((p) => p.name),
  );
  const append: string[] = [];
  for (const path of attachmentPaths) {
    const name = path.split('/').pop() ?? path;
    if (seen.has(name)) continue;
    seen.add(name);
    append.push(path);
  }
  return [prose, ...append].filter(Boolean).join(' ');
}
