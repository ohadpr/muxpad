import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { normalizeProfileName } from './BrowserProfile.js';

/**
 * The picture on a browser card.
 *
 * A card that says "Amazon needs a login" is a claim you have to take on trust
 * and a tap to check. A card that SHOWS the sign-in page is the same claim with
 * its evidence attached — you can see what the agent actually landed on before
 * deciding whether to deal with it, and afterwards you can see what it did
 * without opening anything.
 *
 * ONE FILE PER MOMENT, not one per browser. A card is a thing that happened at a
 * time, and the picture belongs to that moment; a single "current.jpg" per
 * profile would rewrite history every time the page changed, so yesterday's
 * summons would illustrate itself with today's page.
 *
 * They are CACHE, not record. Nothing breaks without them: a shot that failed to
 * capture, a file deleted by hand, a browser that was gone before anyone asked —
 * all of it renders as the card without a picture, which is what the card was
 * before this existed.
 */

/** Where a profile's stills live. Under the data dir, one directory per profile. */
export function browserShotDir(dataDir: string, profile: string): string {
  return `${dataDir.replace(/\/+$/, '')}/browser-shots/${normalizeProfileName(profile)}`;
}

/** The file for one moment. Named by its timestamp, which is the moment's id. */
export function browserShotPath(dataDir: string, profile: string, at: number): string {
  return `${browserShotDir(dataDir, profile)}/${Math.floor(at)}.jpg`;
}

/**
 * How many stills a profile keeps.
 *
 * Below the event cap deliberately: the older moments in a long log are
 * scrolled far past, and a JPEG each for forty of them is a directory nobody
 * asked for. The cards still render — just without the picture.
 */
export const BROWSER_SHOT_CAP = 12;

/** The files to delete, oldest first, once a directory is over the cap. Pure. */
export function shotsToPrune(files: readonly string[], cap = BROWSER_SHOT_CAP): string[] {
  const stills = files
    .filter((f) => f.endsWith('.jpg'))
    .map((f) => ({ f, at: Number(f.slice(0, -4)) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at);
  return stills.slice(0, Math.max(0, stills.length - cap)).map((x) => x.f);
}

/**
 * Writes one still and prunes the old ones.
 *
 * Returns whether it landed, so the caller can record the moment WITHOUT a
 * picture rather than with a broken one — a card pointing at a file that is not
 * there is worse than a card with no picture, because it renders as a hole.
 */
export function saveBrowserShot(
  dataDir: string,
  profile: string,
  at: number,
  bytes: Uint8Array,
): boolean {
  if (!bytes.length) return false;
  try {
    const dir = browserShotDir(dataDir, profile);
    mkdirSync(dir, { recursive: true });
    writeFileSync(browserShotPath(dataDir, profile, at), bytes);
    for (const stale of shotsToPrune(readdirSync(dir))) {
      rmSync(`${dir}/${stale}`, { force: true });
    }
    return true;
  } catch {
    // Disk full, a permission, a profile removed underneath us. The card is
    // worth more than its illustration.
    return false;
  }
}

/** Forgets a profile's stills. Called when its browser is reaped. */
export function clearBrowserShots(dataDir: string, profile: string): void {
  try {
    rmSync(browserShotDir(dataDir, profile), { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}
