import { describe, expect, it } from 'vitest';
import { splitClipboard } from './clipboard-detect';

function makeItem(kind: 'string' | 'file', type: string): DataTransferItem {
  return { kind, type } as unknown as DataTransferItem;
}
function makeData(items: DataTransferItem[]): DataTransfer {
  return { items: items as unknown as DataTransferItemList } as DataTransfer;
}

describe('splitClipboard', () => {
  it('detects image-only paste (single PNG file)', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png')]));
    expect(r.imageOnly).toBe(true);
    expect(r.imageItems).toHaveLength(1);
  });

  it('detects image-only paste with multiple images', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png'), makeItem('file', 'image/jpeg')]));
    expect(r.imageOnly).toBe(true);
    expect(r.imageItems).toHaveLength(2);
  });

  it('treats image + text as mixed (not image-only)', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png'), makeItem('string', 'text/plain')]));
    expect(r.imageOnly).toBe(false);
    expect(r.imageItems).toHaveLength(1);
  });

  it('treats text-only paste as not image-only', () => {
    const r = splitClipboard(makeData([makeItem('string', 'text/plain')]));
    expect(r.imageOnly).toBe(false);
    expect(r.imageItems).toHaveLength(0);
  });

  it('treats file (non-image) + image as mixed', () => {
    const r = splitClipboard(makeData([makeItem('file', 'image/png'), makeItem('file', 'application/pdf')]));
    expect(r.imageOnly).toBe(false);
  });
});
