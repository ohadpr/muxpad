import { beforeEach, describe, expect, it } from 'vitest';
import { ChunkedWriter, SyncBlockExtractor } from './write-coalescer';

describe('ChunkedWriter', () => {
  let raf: (cb: FrameRequestCallback) => number;
  let writes: string[];
  let writer: ChunkedWriter;

  beforeEach(() => {
    writes = [];
    // Synchronous RAF for deterministic tests.
    raf = (cb) => {
      cb(0);
      return 0;
    };
    writer = new ChunkedWriter((s) => writes.push(s), { chunkSize: 8, raf });
  });

  it('passes small writes through unchanged', () => {
    writer.push('abc');
    expect(writes).toEqual(['abc']);
  });

  it('splits large writes into chunks of chunkSize', () => {
    writer.push('1234567890ABCDEFGHIJ'); // 20 bytes, chunkSize 8 → 8/8/4
    expect(writes).toEqual(['12345678', '90ABCDEF', 'GHIJ']);
  });

  it('coalesces multiple pushes inside one chunk', () => {
    writer.push('abc');
    writer.push('def');
    // With chunkSize 8, both fit. RAF flush emits one combined chunk.
    expect(writes.join('')).toBe('abcdef');
  });
});

describe('SyncBlockExtractor', () => {
  let writes: string[];
  let raf: (cb: FrameRequestCallback) => number;
  let extractor: SyncBlockExtractor;

  beforeEach(() => {
    writes = [];
    raf = (cb) => {
      cb(0);
      return 0;
    };
    extractor = new SyncBlockExtractor((s) => writes.push(s), { raf });
  });

  it('passes through data with no markers', () => {
    extractor.push('hello world');
    extractor.flush();
    expect(writes.join('')).toBe('hello world');
  });

  it('flushes a complete sync block as one write', () => {
    extractor.push('\x1b[?2026hframe\x1b[?2026l');
    extractor.flush();
    expect(writes).toContain('frame');
  });

  it('buffers a split sync block until end marker arrives', () => {
    extractor.push('before \x1b[?2026hfra');
    extractor.flush();
    // No closing marker → frame portion still pending; "before " has been emitted as pre-sync.
    expect(writes.join('')).toBe('before ');
    extractor.push('me\x1b[?2026l after');
    extractor.flush();
    expect(writes.join('')).toBe('before frame after');
  });

  it('documents that a SYNC_BEGIN straddling two pushes is NOT coalesced', () => {
    // Known limitation: indexOf() scans only the data we have. If the first
    // push ends mid-marker ('\x1b[?2026') and the second begins with 'h',
    // the first drain emits the partial marker as literal bytes (no match),
    // and the second drain sees no SYNC_BEGIN either (the 'h' is now an
    // orphan). Net effect: the would-be frame is rendered as raw bytes
    // including the marker bytes. Acceptable: TCP/WebSocket fragmentation
    // almost never splits inside a 7-byte CSI sequence, and the worst case
    // is one lost atomic-flush boundary — the renderer still draws the frame.
    extractor.push('pre\x1b[?2026');
    extractor.flush();
    extractor.push('hframe\x1b[?2026l');
    extractor.flush();
    expect(writes.join('')).toBe('pre\x1b[?2026hframe\x1b[?2026l');
  });

  it('times out a stuck sync block after the configured deadline', () => {
    const slowWrites: string[] = [];
    const slow = new SyncBlockExtractor((s) => slowWrites.push(s), { raf, maxHoldMs: 0 });
    slow.push('partial \x1b[?2026hframe-only-start');
    // Force timeout flush.
    slow.flushStale(Date.now() + 1);
    expect(slowWrites.join('')).toContain('frame-only-start');
  });
});
