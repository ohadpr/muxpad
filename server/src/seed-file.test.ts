import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type SeedSpec, reconcileSeedFile, seedNotice, sha256 } from './seed-file.js';

const V1 = '# instructions\nversion one\n';
const V2 = '# instructions\nversion two — now with more verbs\n';

describe('reconcileSeedFile', () => {
  let dir: string;
  const spec = (seed: string, legacy: readonly string[] = []): SeedSpec => ({
    dataDir: dir,
    name: 'agent-instructions.md',
    seed,
    legacyDefaults: legacy,
  });
  const file = (): string => join(dir, 'agent-instructions.md');
  const sidecar = (): string => join(dir, 'agent-instructions.default.md');
  const stamps = (): string => join(dir, '.seed-stamps.json');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'seed-file-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file on a fresh data dir and stamps what it wrote', () => {
    expect(reconcileSeedFile(spec(V1))).toEqual({ action: 'created', path: file() });
    expect(readFileSync(file(), 'utf8')).toBe(V1);
    expect(JSON.parse(readFileSync(stamps(), 'utf8'))).toEqual({
      'agent-instructions.md': sha256(V1),
    });
  });

  it('is a no-op when the file already matches the shipped seed', () => {
    reconcileSeedFile(spec(V1));
    expect(reconcileSeedFile(spec(V1))).toEqual({ action: 'current', path: file() });
    expect(existsSync(sidecar())).toBe(false);
  });

  it('THE BUG: an untouched OLD default is refreshed to the new seed', () => {
    // This is the whole point. Under the old `if (!existsSync)` rule the
    // machine kept V1 forever and every shipped improvement was invisible.
    reconcileSeedFile(spec(V1));
    expect(reconcileSeedFile(spec(V2))).toEqual({ action: 'refreshed', path: file() });
    expect(readFileSync(file(), 'utf8')).toBe(V2);
    // …and the refresh is idempotent, not a rewrite on every boot.
    expect(reconcileSeedFile(spec(V2)).action).toBe('current');
  });

  it('recognises a PRE-STAMP default via the legacy hash list and refreshes it', () => {
    // Simulates the real install: V1 on disk, written by a muxpad that had no
    // stamp file at all. Nothing but the hash list can tell it from an edit.
    writeFileSync(file(), V1);
    expect(reconcileSeedFile(spec(V2, [sha256(V1)])).action).toBe('refreshed');
    expect(readFileSync(file(), 'utf8')).toBe(V2);
  });

  it('NEVER overwrites a user-edited file, however far the seed has moved', () => {
    reconcileSeedFile(spec(V1));
    const mine = `${V1}\n## The territory\nmy own section\n`;
    writeFileSync(file(), mine);
    for (const seed of [V1, V2, `${V2}more`]) reconcileSeedFile(spec(seed));
    expect(readFileSync(file(), 'utf8')).toBe(mine);
  });

  it('editing an UP-TO-DATE file says nothing and drops no sidecar', () => {
    // Nothing shipped changed — the user just made the file theirs. Claiming
    // "the shipped default CHANGED" would be a lie, and a surprise
    // `agent-instructions.default.md` appearing next to it is noise.
    reconcileSeedFile(spec(V1));
    writeFileSync(file(), `${V1}## The territory\n`);
    const out = reconcileSeedFile(spec(V1));
    expect(out.action).toBe('customized');
    expect(seedNotice(out)).toBeNull();
    expect(existsSync(sidecar())).toBe(false);
    // …and when the seed DOES move later, they still hear about it.
    expect(reconcileSeedFile(spec(V2)).action).toBe('stale');
  });

  it('an edited file + a changed default → stale ONCE, then quiet', () => {
    reconcileSeedFile(spec(V1));
    writeFileSync(file(), `${V1}## The territory\n`);

    const first = reconcileSeedFile(spec(V2));
    expect(first.action).toBe('stale');
    expect(first.defaultPath).toBe(sidecar());
    expect(readFileSync(sidecar(), 'utf8')).toBe(V2); // diff target, current
    expect(seedNotice(first)).toContain('has your edits');
    expect(seedNotice(first)).toContain(sidecar());

    // Same default next boot → no nagging.
    const second = reconcileSeedFile(spec(V2));
    expect(second.action).toBe('customized');
    expect(seedNotice(second)).toBeNull();

    // The default moves again → they hear about it again.
    expect(reconcileSeedFile(spec(`${V2}\nand another verb\n`)).action).toBe('stale');
  });

  it('an emptied file is an opt-out — never re-seeded, never nagged about', () => {
    // readAgentInstructions treats empty as "inject nothing"; re-seeding would
    // silently undo the user's opt-out.
    writeFileSync(file(), '   \n\t\n');
    const out = reconcileSeedFile(spec(V2, [sha256(V1)]));
    expect(out.action).toBe('optout');
    expect(readFileSync(file(), 'utf8')).toBe('   \n\t\n');
    expect(existsSync(sidecar())).toBe(false);
    expect(seedNotice(out)).toBeNull();
  });

  it('a corrupt stamps file degrades to "treat as user-owned", never throws', () => {
    reconcileSeedFile(spec(V1));
    writeFileSync(stamps(), 'not json at all {{{');
    // With no usable stamp and no legacy hash, V1 reads as the user's file —
    // erring toward NOT overwriting, which is the safe direction.
    expect(reconcileSeedFile(spec(V2)).action).toBe('stale');
    expect(readFileSync(file(), 'utf8')).toBe(V1);
  });

  it('stamps a file that matches the seed but arrived by another route', () => {
    writeFileSync(file(), V1); // e.g. copied in by hand / restored from backup
    expect(reconcileSeedFile(spec(V1)).action).toBe('current');
    expect(JSON.parse(readFileSync(stamps(), 'utf8'))['agent-instructions.md']).toBe(sha256(V1));
    // …so the NEXT seed bump can refresh it instead of calling it an edit.
    expect(reconcileSeedFile(spec(V2)).action).toBe('refreshed');
  });

  it('keeps one stamp per file — two seeded files coexist', () => {
    reconcileSeedFile(spec(V1));
    reconcileSeedFile({ dataDir: dir, name: 'do-mode.md', seed: 'do\n', legacyDefaults: [] });
    expect(JSON.parse(readFileSync(stamps(), 'utf8'))).toEqual({
      'agent-instructions.md': sha256(V1),
      'do-mode.md': sha256('do\n'),
    });
  });

  it('NEVER throws when the file or the data dir cannot be written', () => {
    // This runs at the very top of index.ts, before the DB is open, under
    // launchd KeepAlive. A thrown EACCES is not an error message, it is a
    // restart loop — and the old `if (!existsSync) write` never wrote to an
    // existing file, so this failure mode is new with the refresh path.
    reconcileSeedFile(spec(V1));
    chmodSync(file(), 0o444); // pristine, but read-only
    expect(() => reconcileSeedFile(spec(V2))).not.toThrow();
    expect(readFileSync(file(), 'utf8')).toBe(V1); // left alone, not corrupted
    chmodSync(file(), 0o644);

    // Whole data dir read-only, with no file yet.
    const locked = mkdtempSync(join(tmpdir(), 'seed-ro-'));
    try {
      chmodSync(locked, 0o555);
      expect(() =>
        reconcileSeedFile({
          dataDir: locked,
          name: 'agent-instructions.md',
          seed: V1,
          legacyDefaults: [],
        }),
      ).not.toThrow();
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });

  it('the refresh notice names the file and promises edits are safe', () => {
    reconcileSeedFile(spec(V1));
    const notice = seedNotice(reconcileSeedFile(spec(V2))) ?? '';
    expect(notice).toContain(file());
    expect(notice).toMatch(/never overwrites edits/);
    expect(notice.split('\n')).toHaveLength(1); // ONE line at boot
  });
});
