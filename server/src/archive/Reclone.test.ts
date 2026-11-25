import {
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
import { recloneOne } from './Reclone.js';

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
});
