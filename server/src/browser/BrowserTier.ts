import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * WHICH BROWSER A SESSION GETS, and why it is not a setting.
 *
 * Two binaries, and the gap between them is the whole problem: the headless
 * shell costs about 20 MB and is refused by sites that screen for bots; the
 * full browser gets through and costs 1,338 MB (measured, one session, two
 * pages). With a dozen session browsers the full one everywhere is an 18 GB
 * machine — the failure the idle reaper exists for.
 *
 * Nobody wants to answer "which browser?" in advance, and nobody can: you find
 * out when a site refuses you. So the tier is DISCOVERED. A session starts
 * light, and if its browser is turned away (see BotWall.ts) it is upgraded,
 * once, for as long as that browser lives.
 *
 * ─── WHY IT DOES NOT STICK ─────────────────────────────────────────────────
 *
 * The record is deliberately thrown away when the browser stops. A session
 * that needed the heavy browser for one checkout does not need it tomorrow,
 * and a tier that survived would mean the gigabyte is paid by every chat that
 * ever hit one wall, forever. Being walled again costs one upgrade and a
 * reload; keeping it costs memory for days.
 */

export type BrowserTier = 'light' | 'real';

/**
 * How many sessions may hold the full browser at once.
 *
 * At 1.3 GB each this is the whole memory argument, so it is a number and not
 * a feeling. Two covers the real case — a person working in one chat while a
 * scheduled job runs in another — and refuses the third rather than letting a
 * bad afternoon put ten of them up.
 */
export const MAX_REAL_BROWSERS = 2;

export interface TierRecord {
  tier: BrowserTier;
  /** Why it was upgraded — shown in the chat and the log. */
  why: string;
  at: number;
}

const FILE = 'browser-tiers.json';

export function tiersPath(dataDir: string): string {
  return join(dataDir, FILE);
}

export function readTiers(dataDir: string): Record<string, TierRecord> {
  try {
    const raw = JSON.parse(readFileSync(tiersPath(dataDir), 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, TierRecord> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const r = v as Partial<TierRecord>;
      if (r?.tier === 'real')
        out[k] = { tier: 'real', why: String(r.why ?? ''), at: Number(r.at ?? 0) };
    }
    return out;
  } catch {
    // No file, or one somebody edited into nonsense. Everything is light,
    // which is the safe direction: the cost of being wrong is a refused page,
    // not a machine out of memory.
    return {};
  }
}

export function tierOf(dataDir: string, profile: string): BrowserTier {
  return readTiers(dataDir)[profile]?.tier ?? 'light';
}

/**
 * Record an upgrade — or refuse it, when too many sessions already hold one.
 *
 * Returns what actually happened, because the caller has to tell somebody: an
 * upgrade that silently did not happen is a page that stays broken with no
 * explanation anywhere.
 */
export function upgrade(
  dataDir: string,
  profile: string,
  why: string,
  now = Date.now(),
  max = MAX_REAL_BROWSERS,
): { ok: true; already: boolean } | { ok: false; reason: string } {
  const tiers = readTiers(dataDir);
  if (tiers[profile]) return { ok: true, already: true };
  const held = Object.keys(tiers).length;
  if (held >= max)
    return {
      ok: false,
      reason: `${held} sessions already hold the full browser (limit ${max}) — close one, or open this page in a chat that has it`,
    };
  tiers[profile] = { tier: 'real', why, at: now };
  try {
    writeFileSync(tiersPath(dataDir), JSON.stringify(tiers, null, 1));
  } catch {
    return { ok: false, reason: 'could not record the upgrade' };
  }
  return { ok: true, already: false };
}

/** Forget a session's tier — called when its browser stops. See the note above
 *  on why this is not kept. */
export function clearTier(dataDir: string, profile: string): void {
  const tiers = readTiers(dataDir);
  if (!tiers[profile]) return;
  delete tiers[profile];
  try {
    writeFileSync(tiersPath(dataDir), JSON.stringify(tiers, null, 1));
  } catch {
    /* a tier we cannot forget is one extra heavy browser, not a failure */
  }
}
