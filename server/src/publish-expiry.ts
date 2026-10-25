import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHEN A PUBLIC LINK STOPS ANSWERING — AND WHY THE FILES STAY.
 *
 * Every artifact muxpad publishes shares one public origin on the open
 * internet. Two things follow from that, and this module is the second:
 *
 *   · a slug must be UNGUESSABLE, or the domain is a directory anyone can walk
 *     (that half lives in routes/publish.ts, where the random suffix is minted);
 *   · a link must not live forever by default, because nothing published for a
 *     ten-minute look at a chart should still be serving a personal report to
 *     the internet a year later.
 *
 * The expiry is on the LINK, never on the bytes. An expired slug answers 410
 * and the directory is untouched on disk, so "extend that one" and "fix the
 * bug in that page" both remain possible for as long as the user keeps it.
 * Deletion stays a separate, explicit verb (`publish --rm`).
 *
 * The store is a small JSON file OUTSIDE `<dataDir>/public`, so it is never
 * itself servable: the public server has no API surface and no business
 * exposing the list of what exists.
 *
 * A slug with NO entry never expires. That is deliberate — it is the state of
 * every artifact published before this existed, and silently retiring links a
 * user may already have sent is not a migration, it is data loss by schedule.
 * The one-time backfill gives them a horizon explicitly.
 */

/** How long a new link answers for, unless the publisher says otherwise. */
export const DEFAULT_LIFESPAN_DAYS = 7;

const STORE_FILE = 'publish-expiry.json';
const DAY_MS = 86_400_000;

interface ExpiryRecord {
  /** Epoch ms after which the link answers 410. */
  expires: number;
  /** When it was published or last extended — for the listing, not the gate. */
  touched: number;
}

interface ExpiryStore {
  version: 1;
  slugs: Record<string, ExpiryRecord>;
}

/**
 * A FRESH store every time, never a shared constant.
 *
 * This was `{...EMPTY}` over a module-level literal — a SHALLOW copy, so every
 * fallback handed back the same `slugs` object and the first write mutated the
 * constant. One data dir's horizons then applied to every other, which in a
 * test suite is a confusing failure and in a multi-instance server is one
 * instance expiring another's links.
 */
function emptyStore(): ExpiryStore {
  return { version: 1, slugs: {} };
}

function storePath(dataDir: string): string {
  return join(dataDir, STORE_FILE);
}

export function loadExpiryStore(dataDir: string): ExpiryStore {
  try {
    const raw = JSON.parse(readFileSync(storePath(dataDir), 'utf8')) as ExpiryStore;
    if (!raw || typeof raw !== 'object' || typeof raw.slugs !== 'object') return emptyStore();
    return { version: 1, slugs: raw.slugs ?? {} };
  } catch {
    // Missing or corrupt reads as "nothing expires", which fails OPEN: a
    // broken store must not take every published link down with it.
    return emptyStore();
  }
}

function saveExpiryStore(dataDir: string, store: ExpiryStore): void {
  const tmp = `${storePath(dataDir)}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, storePath(dataDir));
}

/**
 * The owning artifact of a served path segment.
 *
 * `<slug>@2` is a ROTATION of `<slug>`, not an artifact of its own, so it
 * shares the owner's expiry — otherwise an expired link would still serve its
 * own previous version from a URL one character away.
 */
export function baseSlugOf(segment: string): string {
  const at = segment.indexOf('@');
  return at === -1 ? segment : segment.slice(0, at);
}

/** Epoch ms when this slug's link stops answering, or null for never. */
export function expiryOf(dataDir: string, segment: string): number | null {
  const rec = loadExpiryStore(dataDir).slugs[baseSlugOf(segment)];
  return rec ? rec.expires : null;
}

export function isExpired(dataDir: string, segment: string, now = Date.now()): boolean {
  const at = expiryOf(dataDir, segment);
  return at !== null && at <= now;
}

/** Set (or reset) a slug's horizon to `days` from now. Returns the new expiry. */
export function setLifespan(
  dataDir: string,
  slug: string,
  days: number = DEFAULT_LIFESPAN_DAYS,
  now = Date.now(),
): number {
  const store = loadExpiryStore(dataDir);
  const expires = now + Math.max(0, days) * DAY_MS;
  store.slugs[baseSlugOf(slug)] = { expires, touched: now };
  saveExpiryStore(dataDir, store);
  return expires;
}

/**
 * Push a horizon out by `days` — from NOW, not from the old expiry.
 *
 * Extending an already-expired link is the main reason this verb exists (the
 * user asked for that page back), and `expires + days` would hand them a link
 * that is still dead if it lapsed a fortnight ago.
 */
export function extendLifespan(
  dataDir: string,
  slug: string,
  days: number = DEFAULT_LIFESPAN_DAYS,
  now = Date.now(),
): number {
  const store = loadExpiryStore(dataDir);
  const base = baseSlugOf(slug);
  const current = store.slugs[base]?.expires ?? 0;
  const from = Math.max(current, now);
  const expires = from + Math.max(0, days) * DAY_MS;
  store.slugs[base] = { expires, touched: now };
  saveExpiryStore(dataDir, store);
  return expires;
}

/** Make a link answer forever again. The record is dropped, not zeroed. */
export function clearLifespan(dataDir: string, slug: string): void {
  const store = loadExpiryStore(dataDir);
  delete store.slugs[baseSlugOf(slug)];
  saveExpiryStore(dataDir, store);
}

/** Expire a link NOW, keeping the bytes. The counterpart of `--extend`. */
export function expireNow(dataDir: string, slug: string, now = Date.now()): void {
  const store = loadExpiryStore(dataDir);
  store.slugs[baseSlugOf(slug)] = { expires: now, touched: now };
  saveExpiryStore(dataDir, store);
}
