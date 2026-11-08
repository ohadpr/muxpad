import { describe, expect, it } from 'vitest';
import { type UploadItem, canSendDraft } from './upload-queue';

const chip = (state: UploadItem['state'], path?: string): UploadItem =>
  ({
    id: state + (path ?? ''),
    name: 'f',
    size: 1,
    loaded: 1,
    state,
    ...(path ? { path } : {}),
  }) as UploadItem;

describe('whether pressing send would do anything', () => {
  it('is false for an empty composer with nothing attached', () => {
    expect(canSendDraft('', [])).toBe(false);
    expect(canSendDraft('   \n  ', [])).toBe(false);
  });

  it('is TRUE for text alone, and for a finished attachment alone', () => {
    expect(canSendDraft('hi', [])).toBe(true);
    expect(canSendDraft('', [chip('done', '/a/b.png')])).toBe(true);
  });

  it('is false for a FAILED attachment over an empty composer — the reported bug', () => {
    // The chip stays in the row so you can see why it failed, nothing is
    // uploading, and the old condition counted it: the button rendered enabled
    // and did nothing when pressed, because the send guard drops it.
    expect(canSendDraft('', [chip('error')])).toBe(false);
  });

  it('is false for an attachment that finished without a path', () => {
    // A reference the agent cannot follow. The send guard drops it, so it
    // cannot count towards sending either.
    expect(canSendDraft('', [chip('done')])).toBe(false);
  });

  it('is false while anything is still uploading, text or not', () => {
    // So the message and its attachment travel together.
    expect(canSendDraft('hi', [chip('uploading')])).toBe(false);
    expect(canSendDraft('hi', [chip('queued')])).toBe(false);
  });

  it('ignores a canceled chip entirely', () => {
    expect(canSendDraft('', [chip('canceled')])).toBe(false);
    expect(canSendDraft('hi', [chip('canceled')])).toBe(true);
  });

  it('lets good text through beside a failed attachment', () => {
    // The failure is worth showing; it is not worth blocking the message.
    expect(canSendDraft('send anyway', [chip('error')])).toBe(true);
  });
});
