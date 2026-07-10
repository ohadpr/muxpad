// Chat messages carry a host-local absolute path to a pasted/picked image
// (…/attachments/<hash>.<ext>); the pixels live on the server host, so every
// device loads them through the serve route, keyed by bare filename.

import { IMAGE_EXT_ALTERNATION } from '@muxpad/shared';

// Match an attachments-dir path token: any non-space run ending in
// `/attachments/<file>.<img-ext>`. Absolute paths never contain spaces, so a
// greedy \S* cleanly captures the whole path while the group grabs the name.
// The extension set is the shared pipeline-wide map — never a local list.
const ATTACHMENT_PATH_RE = new RegExp(
  `\\S*/attachments/([\\w.-]+\\.(?:${IMAGE_EXT_ALTERNATION}))`,
  'gi',
);

export function attachmentUrl(name: string): string {
  return `/api/panes/attachments/${encodeURIComponent(name)}`;
}

export type MessagePart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; path: string; name: string; url: string };

/** Split user-message text into plain runs and image-attachment references. */
export function splitMessageAttachments(text: string): MessagePart[] {
  const parts: MessagePart[] = [];
  let last = 0;
  for (const m of text.matchAll(ATTACHMENT_PATH_RE)) {
    const name = m[1];
    if (!name) continue;
    const start = m.index ?? 0;
    if (start > last) parts.push({ kind: 'text', text: text.slice(last, start) });
    parts.push({ kind: 'image', path: m[0], name, url: attachmentUrl(name) });
    last = start + m[0].length;
  }
  if (last < text.length) parts.push({ kind: 'text', text: text.slice(last) });
  return parts;
}
