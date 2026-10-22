import { describe, expect, it, vi } from 'vitest';
import {
  type UploadFn,
  type UploadItem,
  UploadQueue,
  formatBytes,
  summarize,
  summaryLabel,
} from './upload-queue';

/** A file that is only a name and a size — the queue never reads the bytes. */
const file = (name: string, size: number) => ({ file: { size } as Blob, name });

/** An upload the test drives by hand: resolve it, fail it, or feed it
 *  progress, one transfer at a time. */
function controllable() {
  const calls: {
    name: string;
    progress: (loaded: number, total?: number | null) => void;
    resolve: (path: string) => void;
    reject: (err: unknown) => void;
    signal: AbortSignal;
  }[] = [];
  const upload: UploadFn = (_file, name, { onProgress, signal }) =>
    new Promise((resolve, reject) => {
      calls.push({
        name,
        progress: (loaded, total = null) => onProgress(loaded, total),
        resolve: (path) => resolve({ path }),
        reject,
        signal,
      });
      signal.addEventListener('abort', () =>
        reject(new DOMException('Upload canceled', 'AbortError')),
      );
    });
  return { calls, upload };
}

function queue(upload: UploadFn, concurrency = 2) {
  const frames: UploadItem[][] = [];
  const q = new UploadQueue(upload, (items) => frames.push(items), concurrency);
  return { q, frames, last: () => frames[frames.length - 1] ?? [] };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the upload queue', () => {
  it('shows every picked file at once, in pick order, before a byte moves', async () => {
    // The old loop created a chip only AFTER each upload finished, so a pick of
    // five showed nothing for the length of the first transfer.
    const { upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('a.png', 10), file('b.png', 20), file('c.png', 30)]);
    expect(last().map((i) => i.name)).toEqual(['a.png', 'b.png', 'c.png']);
    expect(last().map((i) => i.state)).toEqual(['uploading', 'uploading', 'queued']);
    await flush();
  });

  it('runs two at a time, so the first file still finishes first', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('a', 1), file('b', 1), file('c', 1)]);
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
    calls[0]?.resolve('/p/a');
    await flush();
    expect(calls.map((c) => c.name)).toEqual(['a', 'b', 'c']);
    expect(last().find((i) => i.name === 'a')?.state).toBe('done');
    expect(last().find((i) => i.name === 'a')?.path).toBe('/p/a');
  });

  it('reports bytes as they go, and lands exactly full', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('big.mp4', 1000)]);
    calls[0]?.progress(250);
    expect(last()[0]?.loaded).toBe(250);
    // The last progress frame can disagree with the file size by a few bytes
    // (headers, rounding); a bar that stops at 99% reads as a stall.
    calls[0]?.progress(997);
    calls[0]?.resolve('/p/big.mp4');
    await flush();
    expect(last()[0]).toMatchObject({ state: 'done', loaded: 1000 });
  });

  it('keeps a canceled item visible, and frees its slot', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload, 1);
    q.add([file('a', 1), file('b', 1)]);
    expect(calls).toHaveLength(1);
    q.cancel(last()[0]!.id);
    await flush();
    // Visible, because a chip that vanishes mid-upload reads as a bug…
    expect(last()[0]).toMatchObject({ name: 'a', state: 'canceled' });
    // …and the next one starts, because the slot is free.
    expect(calls.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('does not overwrite a cancel with the failure the cancel caused', async () => {
    const { upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('a', 1)]);
    q.cancel(last()[0]!.id);
    await flush();
    expect(last()[0]?.state).toBe('canceled');
    expect(last()[0]?.error).toBeUndefined();
  });

  it('keeps the error sentence the server wrote', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('big.mov', 9)]);
    calls[0]?.reject(new Error('upload is 900 MB — the limit is 512 MB'));
    await flush();
    expect(last()[0]).toMatchObject({
      state: 'error',
      error: 'upload is 900 MB — the limit is 512 MB',
    });
  });

  it('retries the file it still holds, rather than asking for it again', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('a', 1)]);
    calls[0]?.reject(new Error('the connection dropped'));
    await flush();
    q.retry(last()[0]!.id);
    await flush();
    expect(calls).toHaveLength(2);
    expect(last()[0]?.error).toBeUndefined();
    calls[1]?.resolve('/p/a');
    await flush();
    expect(last()[0]?.state).toBe('done');
  });

  it('aborts a transfer that is removed, instead of leaving it writing', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('a', 1)]);
    const aborted = vi.fn();
    calls[0]?.signal.addEventListener('abort', aborted);
    q.remove(last()[0]!.id);
    await flush();
    expect(aborted).toHaveBeenCalled();
    expect(last()).toHaveLength(0);
  });

  it('ignores a progress frame for an item that is gone', async () => {
    const { calls, upload } = controllable();
    const { q, last } = queue(upload);
    q.add([file('a', 100)]);
    const id = last()[0]!.id;
    q.remove(id);
    expect(() => calls[0]?.progress(50)).not.toThrow();
    expect(last()).toHaveLength(0);
    await flush();
  });
});

describe('the one-line summary', () => {
  const item = (over: Partial<UploadItem>): UploadItem => ({
    id: 'x',
    name: 'f',
    size: 0,
    loaded: 0,
    state: 'queued',
    ...over,
  });

  it('measures progress in BYTES, not in files', () => {
    // Two files, and the big one is the whole wait: a count would say 50% with
    // 2% of the bytes moved.
    const s = summarize([
      item({ id: 'a', size: 1_000_000, loaded: 1_000_000, state: 'done' }),
      item({ id: 'b', size: 99_000_000, loaded: 0, state: 'uploading' }),
    ]);
    expect(Math.round(s.pct)).toBe(1);
    expect(s.done).toBe(1);
    expect(s.total).toBe(2);
  });

  it('drops canceled items out of the batch entirely', () => {
    const s = summarize([
      item({ id: 'a', size: 100, loaded: 100, state: 'done' }),
      item({ id: 'b', size: 900, state: 'canceled' }),
    ]);
    expect(s.total).toBe(1);
    expect(s.pct).toBe(100);
    expect(s.active).toBe(0);
  });

  it('still moves for blobs that do not know their size', () => {
    const s = summarize([item({ id: 'a', state: 'done' }), item({ id: 'b', state: 'uploading' })]);
    expect(s.pct).toBe(50);
  });

  it('says which file, how far, and how much — and nothing when idle', () => {
    expect(
      summaryLabel(
        summarize([
          item({ id: 'a', size: 2_000_000, loaded: 2_000_000, state: 'done' }),
          item({ id: 'b', size: 2_000_000, loaded: 1_000_000, state: 'uploading' }),
        ]),
      ),
    ).toBe('2 of 2 · 75% · 3.0 MB of 4.0 MB');
    expect(summaryLabel(summarize([item({ id: 'a', size: 10, loaded: 10, state: 'done' })]))).toBe(
      '',
    );
    expect(summaryLabel(summarize([item({ id: 'a', state: 'error' })]))).toBe('1 failed');
  });
});

describe('bytes for humans', () => {
  it('keeps every size to a few characters', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(64_000)).toBe('64 KB');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatBytes(312_000_000)).toBe('312 MB');
    expect(formatBytes(2_400_000_000)).toBe('2.4 GB');
  });
});
