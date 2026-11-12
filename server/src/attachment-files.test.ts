import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { attachmentNameProblem, readAttachmentForRelay } from './attachment-files.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'muxpad-att-files-'));
  mkdirSync(join(dir, 'attachments'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('attachmentNameProblem', () => {
  it('accepts a bare attachment name', () => {
    expect(attachmentNameProblem('3f2a9c1e.png')).toBeNull();
  });
  it('refuses traversal, directories, NUL and non-strings', () => {
    for (const n of ['../x.png', 'a/x.png', '/etc/x.png', 'x\0.png', '..', '', 7])
      expect(attachmentNameProblem(n)).toBe('bad name');
  });
  it('refuses an unknown extension', () => {
    expect(attachmentNameProblem('run.sh')).toBe('unsupported type');
  });
});

describe('readAttachmentForRelay', () => {
  it('refuses a file over the ceiling with a reason that names the limit, before reading it', () => {
    writeFileSync(join(dir, 'attachments', 'big.png'), Buffer.alloc(3_000_001));
    const got = readAttachmentForRelay(dir, 'big.png', 2_000_000);
    expect(got).toEqual({
      ok: false,
      reason: 'too large to transfer (4 MB; the limit is 2 MB)',
    });
  });
  it('reads one at the ceiling', () => {
    writeFileSync(join(dir, 'attachments', 'ok.png'), Buffer.alloc(10, 1));
    const got = readAttachmentForRelay(dir, 'ok.png', 10);
    expect(got.ok && got.size).toBe(10);
  });
});
