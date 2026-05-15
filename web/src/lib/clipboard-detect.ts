export interface ClipboardSplit {
  /** True if every item is an image file (no text/HTML/non-image siblings). */
  imageOnly: boolean;
  /** Image MIME items that should be uploaded. */
  imageItems: DataTransferItem[];
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
