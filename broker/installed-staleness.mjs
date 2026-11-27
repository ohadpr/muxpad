/**
 * IS THE BROKER RUNNING THE CODE SOMEBODY LAST WROTE?
 *
 * The broker executes from `/Library/muxpad-broker/code/`, a root-owned copy
 * placed by `sudo bash broker/install.sh`. Editing `broker/*.mjs` in the repo
 * changes NOTHING until that runs. Nothing anywhere said so, and the
 * consequence was not subtle:
 *
 *   2026-11-25  the installed copy was ten days behind; two msgvault fixes
 *               committed that day were dead on arrival, and agents kept
 *               hitting the bug they had just "fixed".
 *   2026-11-27  still behind — now thirteen days — including the calendar fix
 *               written specifically to unbreak calendars.
 *
 * That is the whole shape of "msgvault is pathetically broken": the fixes were
 * real and none of them were running. It stayed invisible because the only way
 * to notice was to diff two directories nobody thinks about.
 *
 * So it is checkable, by anyone, in one command. It compares CONTENT rather
 * than timestamps: install.sh copies, so an installed file is newer than the
 * repo's even when it is the same bytes, and a timestamp check would cry wolf
 * on every install.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export const INSTALLED_CODE_DIR = '/Library/muxpad-broker/code';

const digest = (path) => {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
};

/**
 * Which shipped files differ from their installed copy.
 *
 * @returns `{ stale: string[], missing: string[], installed: boolean }`
 *   `missing` is a file the repo has and the install does not — a new module
 *   that has never been deployed, which is the same fault one step earlier.
 */
export function brokerDrift(repoDir, installedDir = INSTALLED_CODE_DIR) {
  let shipped;
  try {
    shipped = readdirSync(repoDir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  } catch {
    return { stale: [], missing: [], installed: false };
  }
  let installedFiles;
  try {
    installedFiles = new Set(readdirSync(installedDir));
  } catch {
    // Nothing installed at all is not drift; it is a machine that does not
    // run the broker, and saying "13 files are stale" there would be noise.
    return { stale: [], missing: [], installed: false };
  }
  const stale = [];
  const missing = [];
  for (const f of shipped) {
    if (!installedFiles.has(f)) {
      missing.push(f);
      continue;
    }
    const a = digest(join(repoDir, f));
    const b = digest(join(installedDir, f));
    if (a && b && a !== b) stale.push(f);
  }
  return { stale: stale.sort(), missing: missing.sort(), installed: true };
}

/** One line for a human, or null when the install matches the repo. */
export function driftReport(drift) {
  if (!drift.installed) return null;
  const n = drift.stale.length + drift.missing.length;
  if (n === 0) return null;
  const names = [...drift.missing.map((f) => `${f} (never installed)`), ...drift.stale];
  return [
    `The running broker is NOT the code in this repo: ${n} file(s) differ.`,
    `  ${names.join(', ')}`,
    '  Nothing you change in broker/ takes effect until: sudo bash broker/install.sh',
  ].join('\n');
}
