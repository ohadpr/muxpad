import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Lifecycle for muxpad's SEEDED, USER-OWNED files — `agent-instructions.md`
 * (agent-instructions.ts) and `do-mode.md` (agent-modes.ts).
 *
 * THE BUG THIS EXISTS TO FIX
 * --------------------------
 * Both files used to be seeded with a bare `if (!existsSync(path)) write(...)`.
 * That is correct for "never clobber the user's edits" and catastrophic for
 * everything else: an install that booted ONCE keeps its first-ever default
 * forever. Shipping an improved seed changed nothing on any machine that had
 * already run muxpad — including the developer's own, where the file still
 * taught the retired `busy|idle` vocabulary long after the five-state model
 * shipped. The feature was invisible to every agent, silently, with no notice.
 *
 * THE POLICY
 * ----------
 * The file stays USER-OWNED. Hand edits are never overwritten. But muxpad can
 * now tell the three cases apart:
 *
 *   missing            → write the current seed ('created')
 *   == current seed    → nothing to do ('current')
 *   a KNOWN default    → an untouched default from an older muxpad; rewrite it
 *                        to the current seed ('refreshed')
 *   anything else      → the user's file. NEVER touched. If the shipped
 *                        default MOVED since muxpad last wrote this file, the
 *                        current seed is written alongside as
 *                        `<name>.default.md` (so a diff is one command) and a
 *                        one-line boot notice fires ONCE ('stale'); quiet on
 *                        every later boot, and quiet entirely when the user
 *                        simply edited an up-to-date file ('customized').
 *   empty/whitespace   → a deliberate opt-out (readAgentInstructions treats an
 *                        empty file as "inject nothing"), so muxpad shuts up
 *                        entirely ('optout').
 *
 * HOW "A KNOWN DEFAULT" IS RECOGNISED — two sources, both needed:
 *
 *   1. `<dataDir>/.seed-stamps.json` records the sha256 of the exact bytes
 *      muxpad itself last wrote for each file. This is the forward-looking
 *      half and needs no maintenance: every write stamps itself.
 *   2. `legacyDefaults` — a frozen list of the sha256 of every default shipped
 *      BEFORE the stamp file existed. Purely a migration aid for installs that
 *      predate this module, where no stamp can possibly exist. It never needs
 *      to grow: anything written from here on is stamped.
 *
 * A checksum rather than a version integer written into the file itself: the
 * stamp must not appear in the injected prompt (it is fed to a model verbatim),
 * and a user who edits the file must not be able to accidentally preserve a
 * stamp that then makes muxpad classify their edits as pristine.
 */

const STAMPS_NAME = '.seed-stamps.json';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export interface SeedSpec {
  /** muxpad's data dir (`~/.muxpad` unless MUXPAD_DATA_DIR says otherwise). */
  dataDir: string;
  /** Bare file name inside the data dir, e.g. `agent-instructions.md`. */
  name: string;
  /** The default this BUILD ships. */
  seed: string;
  /** sha256 of every default shipped before `.seed-stamps.json` existed. */
  legacyDefaults: readonly string[];
}

export type SeedAction =
  | 'created' // no file — wrote the seed
  | 'current' // already byte-identical to the shipped seed
  | 'refreshed' // was an untouched OLDER default — rewritten
  | 'stale' // user's file, and the shipped default changed → notice
  | 'customized' // user's file, already told them about this default
  | 'optout'; // emptied on purpose — nothing injected, nothing to say

export interface SeedOutcome {
  action: SeedAction;
  /** Absolute path of the user-owned file. */
  path: string;
  /** Absolute path of the shipped-default sidecar (stale/customized only). */
  defaultPath?: string;
}

export function seedFilePath(dataDir: string, name: string): string {
  return join(dataDir, name);
}

/** `agent-instructions.md` → `agent-instructions.default.md`. */
export function shippedDefaultPath(dataDir: string, name: string): string {
  const i = name.lastIndexOf('.');
  const stem = i > 0 ? name.slice(0, i) : name;
  const ext = i > 0 ? name.slice(i) : '';
  return join(dataDir, `${stem}.default${ext}`);
}

type Stamps = Record<string, string>;

function readStamps(dataDir: string): Stamps {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, STAMPS_NAME), 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Stamps = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>))
      if (typeof v === 'string') out[k] = v;
    return out;
  } catch {
    // Missing, unreadable or corrupt → behave exactly like a fresh install.
    // The legacy-hash list still recognises untouched old defaults, and the
    // worst case is that a pristine file is misread as user-owned, which
    // errs toward NOT overwriting. Never throw at boot over a cache file.
    return {};
  }
}

function writeStamp(dataDir: string, name: string, hash: string): void {
  const stamps = readStamps(dataDir);
  stamps[name] = hash;
  try {
    writeFileSync(join(dataDir, STAMPS_NAME), `${JSON.stringify(stamps, null, 2)}\n`);
  } catch {
    // A data dir we cannot write is a much bigger problem than a missing
    // stamp; degrade to "always treat as user-owned" rather than crash boot.
  }
}

/**
 * Reconcile one seeded file against the default this build ships. Pure of
 * console output — the caller (index.ts) decides how to surface
 * {@link seedNotice}, so tests and the runner stay silent.
 */
export function reconcileSeedFile(spec: SeedSpec): SeedOutcome {
  const path = seedFilePath(spec.dataDir, spec.name);
  const seedHash = sha256(spec.seed);
  const stamped = readStamps(spec.dataDir)[spec.name];

  /**
   * NOTHING here may throw. This runs at the very top of index.ts, before the
   * DB is even open, and muxpad is under launchd KeepAlive — an EACCES on a
   * read-only data dir would become a restart loop rather than an error. Every
   * write degrades to "leave it alone", which is also the safe direction.
   */
  const tryWrite = (to: string, body: string): boolean => {
    try {
      writeFileSync(to, body);
      return true;
    } catch {
      return false;
    }
  };

  let onDisk: string | null = null;
  if (existsSync(path)) {
    try {
      onDisk = readFileSync(path, 'utf8');
    } catch {
      // Unreadable but present: it is not ours to replace. Say nothing.
      return { action: 'customized', path };
    }
  }

  if (onDisk === null) {
    if (tryWrite(path, spec.seed)) writeStamp(spec.dataDir, spec.name, seedHash);
    return { action: 'created', path };
  }

  // Emptying the file is the documented way to opt out of the injection.
  // Re-seeding it would silently undo that, so an empty file ends the story.
  if (!onDisk.trim()) return { action: 'optout', path };

  const diskHash = sha256(onDisk);
  if (diskHash === seedHash) {
    // Already current. Stamp it anyway so a file that arrived by some other
    // route (a fresh checkout, a manual copy) is recognised next time.
    if (stamped !== seedHash) writeStamp(spec.dataDir, spec.name, seedHash);
    return { action: 'current', path };
  }

  const pristine = stamped === diskHash || spec.legacyDefaults.includes(diskHash);
  if (pristine) {
    if (!tryWrite(path, spec.seed)) return { action: 'customized', path };
    writeStamp(spec.dataDir, spec.name, seedHash);
    return { action: 'refreshed', path };
  }

  // The user's file, and it stays exactly as it is.
  //
  // Announce ONLY when the shipped default actually moved under them. Two
  // memos, and both are needed:
  //   · `stamped` is the seed muxpad last WROTE here. If it still equals the
  //     seed we ship, nothing changed — the user simply edited an up-to-date
  //     file, and there is nothing to tell them (nor any reason to drop a
  //     surprise `.default.md` next to it).
  //   · the sidecar is the seed we last ANNOUNCED. Once it matches, we have
  //     already said our piece and stay quiet on every later boot.
  // A pre-stamp install has no `stamped` at all; that DOES get one notice,
  // which is the entire point — its file is the stale one.
  const defaultPath = shippedDefaultPath(spec.dataDir, spec.name);
  if (stamped === seedHash) return { action: 'customized', path };
  let announced = false;
  try {
    announced = readFileSync(defaultPath, 'utf8') === spec.seed;
  } catch {
    announced = false;
  }
  if (announced) return { action: 'customized', path, defaultPath };
  // Keep the shipped default beside theirs so `diff` is one command. If it
  // cannot be written, the notice is still worth printing.
  tryWrite(defaultPath, spec.seed);
  return { action: 'stale', path, defaultPath };
}

/**
 * The one-line boot notice for an outcome, or null when there is nothing a
 * user needs to know. Deliberately quiet: only a REFRESH (muxpad changed a
 * file) and a newly-STALE user file (muxpad declined to) are worth a line.
 */
export function seedNotice(o: SeedOutcome): string | null {
  if (o.action === 'refreshed')
    return `muxpad: refreshed ${o.path} — it was an unmodified older default. Edit it to make it yours; muxpad never overwrites edits.`;
  if (o.action === 'stale')
    return `muxpad: ${o.path} has your edits and the shipped default CHANGED — yours is untouched. New default: ${o.defaultPath} · diff: diff "${o.defaultPath}" "${o.path}" · regenerate: rm "${o.path}" and restart muxpad.`;
  return null;
}
