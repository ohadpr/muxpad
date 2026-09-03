import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AGENT_NOTES_SEED,
  GENERATED_BANNER,
  type MigratedFile,
  agentNotesPath,
  ensureAgentNotes,
  generatedBody,
  migrateAgentFileEdits,
  readAgentNotes,
  sha256,
  shippedBodyHashes,
  writeGeneratedFile,
} from './agent-files.js';
import { openDb } from './store/db.js';

const V1 = '# instructions\nversion one\n';
const V2 = '# instructions\nversion two — now with more verbs\n';

describe('generated prompt files', () => {
  let dir: string;
  const file = (): string => join(dir, 'agent-instructions.md');

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-files-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes the seed under a do-not-edit banner that names the notes file', () => {
    writeGeneratedFile(dir, 'agent-instructions.md', V1);
    const text = readFileSync(file(), 'utf8');
    expect(text).toBe(generatedBody(V1));
    expect(text.startsWith(GENERATED_BANNER)).toBe(true);
    expect(text).toContain(V1);
    expect(GENERATED_BANNER).toMatch(/do not edit/i);
    expect(GENERATED_BANNER).toContain('agent-notes.md');
    expect(GENERATED_BANNER.split('\n')).toHaveLength(1);
  });

  it('THE POINT: a changed seed lands on every boot, with no staleness to detect', () => {
    // The bug this design deletes: an install that booted once kept its
    // first-ever default forever, so shipped improvements were invisible.
    writeGeneratedFile(dir, 'agent-instructions.md', V1);
    writeGeneratedFile(dir, 'agent-instructions.md', V2);
    expect(readFileSync(file(), 'utf8')).toBe(generatedBody(V2));
  });

  it('overwrites a hand-edited generated file — it is muxpad’s, not the user’s', () => {
    writeGeneratedFile(dir, 'agent-instructions.md', V1);
    writeFileSync(file(), 'I edited the generated file\n');
    writeGeneratedFile(dir, 'agent-instructions.md', V1);
    expect(readFileSync(file(), 'utf8')).toBe(generatedBody(V1));
  });

  it('NEVER throws when the file or the data dir cannot be written', () => {
    // Boot path, under launchd KeepAlive: a thrown EACCES is not an error
    // message, it is a restart loop.
    writeGeneratedFile(dir, 'agent-instructions.md', V1);
    chmodSync(file(), 0o444);
    expect(() => writeGeneratedFile(dir, 'agent-instructions.md', V2)).not.toThrow();
    expect(readFileSync(file(), 'utf8')).toBe(generatedBody(V1)); // left alone
    chmodSync(file(), 0o644);

    const locked = mkdtempSync(join(tmpdir(), 'agent-files-ro-'));
    try {
      chmodSync(locked, 0o555);
      expect(() => writeGeneratedFile(locked, 'agent-instructions.md', V1)).not.toThrow();
      expect(() => ensureAgentNotes(locked)).not.toThrow();
      expect(readAgentNotes(locked)).toBeNull();
    } finally {
      chmodSync(locked, 0o755);
      rmSync(locked, { recursive: true, force: true });
    }
  });
});

describe('agent-notes.md — the user’s file', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-notes-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('is created once, with a comment explaining what it is for', () => {
    ensureAgentNotes(dir);
    const text = readFileSync(agentNotesPath(dir), 'utf8');
    expect(text).toBe(AGENT_NOTES_SEED);
    expect(text).toContain('<!--');
    expect(text).toContain('agent-instructions.md');
  });

  it('is NEVER touched again — that is the whole contract', () => {
    ensureAgentNotes(dir);
    writeFileSync(agentNotesPath(dir), 'projects live in ~/dev\n');
    for (let i = 0; i < 5; i++) ensureAgentNotes(dir);
    expect(readFileSync(agentNotesPath(dir), 'utf8')).toBe('projects live in ~/dev\n');
  });

  it('reads back, and is null when missing or emptied (an opt-out, not an error)', () => {
    expect(readAgentNotes(dir)).toBeNull();
    writeFileSync(agentNotesPath(dir), '  \n\t\n');
    expect(readAgentNotes(dir)).toBeNull();
    writeFileSync(agentNotesPath(dir), 'projects live in ~/dev\n');
    expect(readAgentNotes(dir)).toBe('projects live in ~/dev\n');
  });
});

describe('migrateAgentFileEdits — nothing the user wrote may be lost', () => {
  let dir: string;
  let db: Database.Database;
  const instructions = (): string => join(dir, 'agent-instructions.md');
  const doMode = (): string => join(dir, 'do-mode.md');
  const baks = (): string[] => readdirSync(dir).filter((f) => f.endsWith('.bak'));

  const FILES: readonly MigratedFile[] = [
    {
      name: 'agent-instructions.md',
      knownDefaults: [sha256(V1), sha256(V2)],
      appendToNotes: true,
    },
    { name: 'do-mode.md', knownDefaults: [sha256('# do\nbe brief\n')], appendToNotes: false },
  ];
  const migrate = () => migrateAgentFileEdits({ db, dataDir: dir, files: FILES });
  /** The rescued file NAMES — the detail (backup path, whether it reached the
   *  notes) is asserted where it matters. */
  const rescuedNames = (r: ReturnType<typeof migrate>): string[] => r.rescued.map((x) => x.name);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-migrate-'));
    db = openDb(':memory:');
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('(a) pristine install: nothing on disk, nothing to do', () => {
    expect(rescuedNames(migrate())).toEqual([]);
    expect(existsSync(instructions())).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('(b) an UNMODIFIED older default is recognised and simply dropped', () => {
    writeFileSync(instructions(), V1); // what an old muxpad wrote, untouched
    expect(rescuedNames(migrate())).toEqual([]);
    expect(baks()).toEqual([]);
    expect(existsSync(agentNotesPath(dir))).toBe(false);
    // …and the boot's generated write then lands on it, unobstructed.
    writeGeneratedFile(dir, 'agent-instructions.md', V2);
    expect(readFileSync(instructions(), 'utf8')).toBe(generatedBody(V2));
  });

  it('(c) a user-edited file: content moved into the notes AND kept as a .bak', () => {
    const mine = `${V1}\n## The territory\nprojects live in ~/dev\nask Ana about billing\n`;
    writeFileSync(instructions(), mine);

    expect(rescuedNames(migrate())).toEqual(['agent-instructions.md']);

    // Injected: the notes file now carries every line they wrote.
    const notes = readFileSync(agentNotesPath(dir), 'utf8');
    expect(notes).toContain('projects live in ~/dev');
    expect(notes).toContain('ask Ana about billing');
    expect(notes).toContain('## From agent-instructions.md (');
    expect(notes.startsWith(AGENT_NOTES_SEED.trimEnd())).toBe(true); // under the header
    // Belt and braces: the untouched original is beside it.
    expect(baks()).toHaveLength(1);
    expect(readFileSync(join(dir, baks()[0] as string), 'utf8')).toBe(mine);
    expect(notes).toContain(baks()[0] as string);
    // The old file is out of the way, so the generated write is unobstructed.
    expect(existsSync(instructions())).toBe(false);
  });

  it('reports what it moved and where, so the boot can say so out loud', () => {
    writeFileSync(instructions(), `${V1}\nmy own section\n`);
    writeFileSync(doMode(), '# my own contract\n');
    const { rescued } = migrate();
    expect(rescued).toHaveLength(2);
    for (const r of rescued) {
      expect(existsSync(r.backup)).toBe(true);
      expect(r.backup.startsWith(join(dir, r.name))).toBe(true);
    }
    expect(rescued.find((r) => r.name === 'agent-instructions.md')?.intoNotes).toBe(true);
    expect(rescued.find((r) => r.name === 'do-mode.md')?.intoNotes).toBe(false);
    expect(readdirSync(dir)).not.toContain('agent-notes.md.tmp'); // no litter
  });

  it('appends under a dated heading when the notes file already has content', () => {
    writeFileSync(agentNotesPath(dir), '# mine\nkeep me\n');
    writeFileSync(instructions(), `${V1}\nmy own section\n`);
    migrate();
    const notes = readFileSync(agentNotesPath(dir), 'utf8');
    expect(notes.startsWith('# mine\nkeep me')).toBe(true);
    expect(notes).toContain('my own section');
    expect(notes).toMatch(/## From agent-instructions\.md \(\d{4}-\d{2}-\d{2}\)/);
  });

  it('is one-shot and idempotent — a second boot imports nothing twice', () => {
    writeFileSync(instructions(), `${V1}\nmy own section\n`);
    migrate();
    const after = readFileSync(agentNotesPath(dir), 'utf8');
    expect(after.match(/my own section/g)).toHaveLength(1);

    // Boot again, generated file back in place — and again with a re-created
    // old file, which the marker must ignore.
    writeGeneratedFile(dir, 'agent-instructions.md', V2);
    expect(rescuedNames(migrate())).toEqual([]);
    writeFileSync(instructions(), 'something else entirely\n');
    expect(rescuedNames(migrate())).toEqual([]);
    expect(readFileSync(agentNotesPath(dir), 'utf8')).toBe(after);
    expect(baks()).toHaveLength(1);
  });

  it('an EMPTIED file is the old opt-out: nothing to rescue, no .bak, no notes', () => {
    writeFileSync(instructions(), '   \n\t\n');
    expect(rescuedNames(migrate())).toEqual([]);
    expect(baks()).toEqual([]);
    expect(existsSync(agentNotesPath(dir))).toBe(false);
  });

  it('an edited do-mode.md is kept as a .bak and NOT folded into the notes', () => {
    // Its contract only applies in ⚡ Do mode; the notes go into every session.
    writeFileSync(doMode(), '# my own contract\nbe brutal\n');
    expect(rescuedNames(migrate())).toEqual(['do-mode.md']);
    expect(baks()).toHaveLength(1);
    expect(baks()[0]).toMatch(/^do-mode\.md\.pre-notes-/);
    expect(existsSync(agentNotesPath(dir))).toBe(false);
    expect(existsSync(doMode())).toBe(false);
  });

  it('rescues both files in one pass', () => {
    writeFileSync(instructions(), `${V1}\nmine\n`);
    writeFileSync(doMode(), '# my own contract\n');
    expect(rescuedNames(migrate())).toEqual(['agent-instructions.md', 'do-mode.md']);
    expect(baks()).toHaveLength(2);
  });

  it('a read-only data dir: no throw, and it REFUSES to let the boot generate', () => {
    // The trap: a read-only DIRECTORY blocks the rename (a directory
    // operation) but NOT an overwrite of the still-writable file inside it.
    // "The rescue failed, so the write will fail too" is false, and believing
    // it would destroy the user's file on exactly the boot that meant to save
    // it. `safe: false` is what stops the caller writing.
    const mine = `${V1}\nmy own section\n`;
    writeFileSync(instructions(), mine);
    chmodSync(dir, 0o555);
    try {
      let out: ReturnType<typeof migrate> | undefined;
      expect(() => {
        out = migrate();
      }).not.toThrow();
      expect(out?.safe).toBe(false);
      expect(out?.rescued).toEqual([]);
      expect(readFileSync(instructions(), 'utf8')).toBe(mine);
      // Proof the guard is load-bearing: the write the caller skips WOULD land.
      writeGeneratedFile(dir, 'agent-instructions.md', V2);
      expect(readFileSync(instructions(), 'utf8')).toBe(generatedBody(V2));
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  it('a failed rescue is retried on the next boot, not marked done', () => {
    const mine = `${V1}\nmy own section\n`;
    writeFileSync(instructions(), mine);
    chmodSync(dir, 0o555);
    try {
      expect(migrate().safe).toBe(false);
    } finally {
      chmodSync(dir, 0o755);
    }
    // Permissions fixed → the next boot rescues it after all.
    const out = migrate();
    expect(out.safe).toBe(true);
    expect(rescuedNames(out)).toEqual(['agent-instructions.md']);
    expect(readFileSync(agentNotesPath(dir), 'utf8')).toContain('my own section');
  });

  it('merges into the notes via a temp file — a dead write can’t truncate them', () => {
    // The .bak covers the RESCUED content; it does not cover notes the user
    // had already written, so the merge must never leave a half-written file.
    const mine = `${V1}\nmy own section\n`;
    writeFileSync(instructions(), mine);
    writeFileSync(agentNotesPath(dir), '# mine\nkeep me\n');
    migrate();
    const notes = readFileSync(agentNotesPath(dir), 'utf8');
    expect(notes.startsWith('# mine\nkeep me')).toBe(true);
    expect(notes).toContain('my own section');
    expect(readdirSync(dir)).not.toContain('agent-notes.md.tmp');
  });

  it('a notes file that cannot be replaced: content still lands in the .bak', () => {
    const mine = `${V1}\nmy own section\n`;
    writeFileSync(instructions(), mine);
    mkdirSync(agentNotesPath(dir)); // pathological: the notes path is a DIR
    writeFileSync(join(agentNotesPath(dir), 'x'), 'x'); // …and not an empty one
    const out = migrate();
    expect(out.rescued[0]?.intoNotes).toBe(false);
    expect(readFileSync(join(dir, baks()[0] as string), 'utf8')).toBe(mine);
    expect(readdirSync(dir)).not.toContain('agent-notes.md.tmp'); // cleaned up
  });

  it('an unreadable DB is NOT read as “already migrated” — it generates nothing', () => {
    // The direction that matters: guessing "done" here would hand the user's
    // still-unrescued file straight to the generated write.
    const bare = openDb(':memory:');
    bare.exec('DROP TABLE globals');
    writeFileSync(instructions(), `${V1}\nmine\n`);
    const out = migrateAgentFileEdits({ db: bare, dataDir: dir, files: FILES });
    expect(out.safe).toBe(false);
    expect(out.rescued).toEqual([]);
    expect(readFileSync(instructions(), 'utf8')).toBe(`${V1}\nmine\n`);
    bare.close();
  });

  it('a GENERATED file is a known default — a lost marker cannot re-import it', () => {
    // Files on disk carry the banner; the shipped-default hashes must cover
    // that body too, or muxpad's own docs get imported into the user's notes
    // (and injected twice) the first time the marker goes missing.
    const files: readonly MigratedFile[] = [
      {
        name: 'agent-instructions.md',
        knownDefaults: shippedBodyHashes(V1),
        appendToNotes: true,
      },
    ];
    writeGeneratedFile(dir, 'agent-instructions.md', V1);
    const out = migrateAgentFileEdits({ db, dataDir: dir, files });
    expect(out.rescued).toEqual([]);
    expect(baks()).toEqual([]);
    expect(existsSync(agentNotesPath(dir))).toBe(false);
  });
});
