import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArchiveDb } from './ArchiveDb.js';
import { Archiver } from './Archiver.js';
import { recloneOne, reclonePass } from './Reclone.js';

const DAY = 24 * 3600_000;
const old = (p: string) => {
  const t = new Date(Date.now() - 2 * DAY);
  utimesSync(p, t, t);
};

describe('recloneOne', () => {
  let root: string;
  let src: string;
  let arch: string;
  const body = Buffer.from('{"a":1}\n{"b":2}\n'.repeat(5000));

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'muxpad-reclone-'));
    mkdirSync(join(root, 'archive'));
    src = join(root, 'src.jsonl');
    arch = join(root, 'archive', 'sid.jsonl');
    writeFileSync(src, body);
    writeFileSync(arch, body, { mode: 0o644 });
    old(src);
    old(arch);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const target = () => ({ sourcePath: src, archivedAbs: arch, offset: body.length });

  it('replaces a settled, identical mirror with a clone — same bytes, new inode, mirror metadata kept', async () => {
    const before = statSync(arch);
    const r = await recloneOne(target());
    // Non-APFS tmpdir (CI on Linux) cannot clone; that refusal is the contract.
    if (r.outcome === 'clone-unsupported') return;
    expect(r.outcome).toBe('recloned');
    expect(readFileSync(arch).equals(body)).toBe(true);
    const after = statSync(arch);
    expect(after.ino).not.toBe(before.ino);
    expect(after.mode & 0o777).toBe(before.mode & 0o777);
    expect(Math.round(after.mtimeMs)).toBe(Math.round(before.mtimeMs));
    expect(readFileSync(src).equals(body)).toBe(true); // source untouched
  });

  it('refuses when a single byte differs, and leaves the mirror exactly as it was', async () => {
    const tampered = Buffer.from(body);
    tampered[tampered.length - 3] = 0x39;
    writeFileSync(arch, tampered);
    old(arch);
    const ino = statSync(arch).ino;
    const r = await recloneOne(target());
    if (r.outcome === 'clone-unsupported') return;
    expect(r.outcome).toBe('differs');
    expect(statSync(arch).ino).toBe(ino);
    expect(readFileSync(arch).equals(tampered)).toBe(true);
  });

  it('skips recent writes, a gone source, a size mismatch, and sealed versions', async () => {
    writeFileSync(src, body); // fresh mtime
    expect((await recloneOne(target())).outcome).toBe('not-settled');
    old(src);
    expect((await recloneOne({ ...target(), offset: body.length - 8 })).outcome).toBe('mid-update');
    expect(
      (await recloneOne({ ...target(), archivedAbs: join(root, 'archive', 'sid.v2.jsonl') }))
        .outcome,
    ).toBe('sealed');
    rmSync(src);
    expect((await recloneOne(target())).outcome).toBe('source-gone');
  });

  it('leaves no temp file behind on any refusal', async () => {
    const tampered = Buffer.from(body);
    tampered[0] = 0x20;
    writeFileSync(arch, tampered);
    old(arch);
    await recloneOne(target());
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(root, 'archive'))).toEqual(['sid.jsonl']);
  });

  // ONE BAD FILE IS NOT A BAD VOLUME. The caller stops the whole pass on
  // `clone-unsupported`, so an unreadable source reported that way became a
  // permanent barrier: every later file queued behind it, every hour. The
  // verdict about the volume has to come from the volume.
  it('reports an unreadable source as an error, and the pass goes on to the next file', async () => {
    const { chmodSync } = await import('node:fs');
    const second = join(root, 'archive', 'other.jsonl');
    const secondSrc = join(root, 'src2.jsonl');
    writeFileSync(secondSrc, body);
    writeFileSync(second, body);
    old(secondSrc);
    old(second);
    chmodSync(src, 0o000);
    try {
      let stopped = false;
      const tally = await reclonePass(
        [target(), { sourcePath: secondSrc, archivedAbs: second, offset: body.length }],
        {
          pauseMs: 0,
          // This test owns both files outright, which is the only reason it
          // may pass no lock. See the single-writer note in Reclone.ts.
          around: (_t, fn) => fn(),
          onResult: (_t, r) => {
            // A VOLUME verdict (non-APFS tmpdir, e.g. CI on Linux) is the one
            // reason to skip. `cp -c:` in the detail means a FILE failure was
            // reported as a volume one, which is exactly the bug — never a
            // reason to stop asserting.
            if (r.outcome === 'clone-unsupported' && !r.detail?.startsWith('cp -c:')) {
              stopped = true;
            }
          },
        },
      );
      if (stopped) return; // non-APFS tmpdir: nothing to assert about either file
      expect(tally.byOutcome.error?.files).toBe(1);
      expect(tally.byOutcome['clone-unsupported']).toBeUndefined();
      expect(tally.recloned).toEqual([second]);
    } finally {
      chmodSync(src, 0o644);
    }
  });
});

describe('Archiver re-clone pass', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('records cloned_offset after a reclone and does not revisit the file', async () => {
    root = mkdtempSync(join(tmpdir(), 'muxpad-reclone-arch-'));
    const projects = join(root, 'projects');
    mkdirSync(join(projects, 'p'), { recursive: true });
    const srcPath = join(projects, 'p', 'sid1.jsonl');
    writeFileSync(srcPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const archive = new ArchiveDb(join(root, 'archive.sqlite'));
    const archiveDir = join(root, 'archive');
    const archiver = new Archiver({
      archive,
      archiveDir,
      claudeProjectsDir: projects,
      muxpadTranscriptsDir: join(root, 'mx'),
      reclone: { settleMs: DAY, intervalMs: 0 },
    });
    await archiver.sweep();
    await archiver.idle();
    expect(archive.getFile(srcPath)?.cloned_offset).toBe(-1);
    old(srcPath);
    old(join(archiveDir, 'sid1.jsonl'));
    await archiver.reclonePassNow();
    const row = archive.getFile(srcPath);
    const probe = await open(srcPath, 'r');
    await probe.close();
    if (row?.cloned_offset === -1) return; // non-APFS: clone-unsupported
    expect(row?.cloned_offset).toBe(row?.offset);
    const ino = statSync(join(archiveDir, 'sid1.jsonl')).ino;
    await archiver.reclonePassNow();
    expect(statSync(join(archiveDir, 'sid1.jsonl')).ino).toBe(ino); // not redone
    archiver.stop();
    archive.close();
  });

  // A FILE THAT WILL NEVER CLONE SHOULD BE ASKED ONCE. A differing mirror was
  // re-read in full every hour for the same answer, and logged every time —
  // on a 500 MB transcript that is the pass's whole budget spent on a verdict
  // already known. The verdict is pinned to the offset, so a new append asks
  // again, which is the only event that can change it.
  it('does not re-examine a differing mirror until its offset moves', async () => {
    root = mkdtempSync(join(tmpdir(), 'muxpad-reclone-settled-'));
    const projects = join(root, 'projects');
    mkdirSync(join(projects, 'p'), { recursive: true });
    const srcPath = join(projects, 'p', 'sid2.jsonl');
    writeFileSync(srcPath, '{"type":"user","message":{"role":"user","content":"hi"}}\n');
    const archive = new ArchiveDb(join(root, 'archive.sqlite'));
    const archiveDir = join(root, 'archive');
    const archiver = new Archiver({
      archive,
      archiveDir,
      claudeProjectsDir: projects,
      muxpadTranscriptsDir: join(root, 'mx'),
      // An hour's interval so only the explicit passes below run: this test
      // counts passes, and a sweep-triggered one would be indistinguishable.
      reclone: { settleMs: DAY, intervalMs: 3600_000, logPath: join(root, 'reclone.log') },
    });
    await archiver.sweep();
    await archiver.idle();
    const mirror = join(archiveDir, 'sid2.jsonl');
    const offset = archive.getFile(srcPath)?.offset as number;
    // Same length, different bytes: the compare must refuse.
    const tampered = Buffer.from(readFileSync(mirror));
    tampered[0] = 0x20;
    writeFileSync(mirror, tampered);
    // Count of "I compared this file and it differs" lines; the pass writes
    // one per file it actually read, which is the cost under test.
    const log = () => {
      try {
        return readFileSync(join(root, 'reclone.log'), 'utf8')
          .split('\n')
          .filter((l) => l.includes('"outcome":"differs"')).length;
      } catch {
        return 0;
      }
    };
    old(srcPath);
    old(mirror);
    await archiver.reclonePassNow();
    // Let the sweep's own first pass land too, so what follows is steady state.
    await new Promise((r) => setTimeout(r, 25));
    if (archive.getFile(srcPath)?.reclone_settled_at === -1) return; // non-APFS
    expect(archive.getFile(srcPath)?.reclone_settled_at).toBe(offset);

    const asked = log();
    expect(asked).toBeGreaterThan(0); // it did read the file, once
    await archiver.reclonePassNow(); // the whole point: it must not read it again
    expect(log()).toBe(asked);
    expect(readFileSync(mirror).equals(tampered)).toBe(true);

    // An append moves the offset, so the verdict no longer matches and the
    // file is eligible again — the skip is pinned to a length, not to a path.
    appendFileSync(srcPath, '{"type":"user","message":{"role":"user","content":"more"}}\n');
    await archiver.sweep();
    await archiver.idle();
    const grown = archive.getFile(srcPath);
    expect(grown?.offset).toBeGreaterThan(offset);
    expect(grown?.reclone_settled_at).not.toBe(grown?.offset);
    archiver.stop();
    archive.close();
  });
});
