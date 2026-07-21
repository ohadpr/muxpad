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
  | { kind: 'media'; media: Exclude<AttachmentKind, 'file'>; path: string; name: string; url: string }
  | { kind: 'file'; path: string; name: string; url: string };

/** Split message text into plain runs and attachment references (classified
 *  by type), preserving order. */
export function splitMessageAttachments(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(ATTACHMENT_PATH_RE)) {
    const name = m[1];
    if (!name) continue;
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
