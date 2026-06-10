export interface ClipboardSplit {
  /** True if every item is an image file (no text/HTML/non-image siblings). */
  imageOnly: boolean;
  /** Image MIME items that should be uploaded. */
  imageItems: DataTransferItem[];
}

/**
 * Text bundled with an image paste on macOS is often a transient file:// URL
 * to the screenshot on disk. Drop it so the muxpad attachment path is what
 * the TUI sees (Claude/Cursor both echo that path into the prompt).
 */
export function companionTextForImagePaste(text: string): string {
  const t = text.trim();
  if (!t) return '';
  if (!t.startsWith('file://')) return text;
  try {
    const { pathname } = new URL(t);
    if (/\.(png|jpe?g|gif|webp|tiff?|heic|avif)$/i.test(pathname)) return '';
  } catch {
    // not a parseable file URL — keep as-is
  }
  return text;
}

export function splitClipboard(data: DataTransfer): ClipboardSplit {
  const items = Array.from(data.items);
  const imageItems = items.filter((i) => i.kind === 'file' && i.type.startsWith('image/'));
  const hasNonImage = items.some((i) => !(i.kind === 'file' && i.type.startsWith('image/')));
  return {
    imageOnly: imageItems.length > 0 && !hasNonImage,
    imageItems,
  };
}
