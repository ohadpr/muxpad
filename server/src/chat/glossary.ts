import { readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type Database from 'better-sqlite3';

/**
 * The vocabulary a speech-to-text pass needs in order to stop mangling this
 * user's world.
 *
 * iOS dictation has no way to learn domain words, so it renders "muxpad" as
 * "Max pad", "cron schedule" as "crown schedule", "ohados" as "Ohio". The fix
 * isn't a better recognizer — it's giving a cleanup model the list of names the
 * garbled phrase was probably reaching for.
 *
 * Two halves, deliberately:
 *   - STATIC: muxpad's own nouns. They never change, so they're a literal.
 *   - LIVE:   the names in this install right now — workspaces, tabs, panes,
 *             app slugs, published artifact slugs, and the directory basenames
 *             the panes are sitting in. Read at request time so the glossary
 *             tracks the user's world instead of rotting into a stale literal.
 */

/** muxpad's own vocabulary — the words the product is made of. */
export const STATIC_GLOSSARY: readonly string[] = [
  'muxpad',
  'ptyd',
  'pane',
  'tab',
  'workspace',
  'cron',
  'launchd',
  'Tailscale',
  'Funnel',
  'artifact',
  'publish',
  'subagent',
  'ohados',
  'Trayo',
  'GTM',
  'worktree',
  'xterm',
];

/**
 * Hard ceiling on glossary size. The glossary is prompt prefix on EVERY
 * cleanup call, so it is a per-call cost, not a one-time one — an install with
 * 400 panes must not quietly triple the price of every dictation fix. Static
 * terms are always kept; live names fill what's left, most-recent first.
 */
export const MAX_GLOSSARY_TERMS = 140;

/** Per-source row cap, so a huge install can't turn one readdir/SELECT into a
 *  multi-thousand-row scan on a request path. */
const PER_SOURCE_LIMIT = 200;

/** Longest term worth carrying. A 60-character tab name isn't a word anyone
 *  dictates; it's a sentence, and it only dilutes the list. */
const MAX_TERM_LENGTH = 40;

/**
 * Is this string worth teaching the model?
 *
 * Rejects the noise that dominates auto-generated names: pure numbers, ids,
 * single characters, anything without a letter. A term that a general-purpose
 * recognizer already gets right (an ordinary English word) costs a token and
 * buys nothing, but we can't tell those apart cheaply and a false keep is
 * harmless — so the filter is about SHAPE, not about vocabulary.
 */
export function isUsefulTerm(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  const t = raw.trim();
  if (t.length < 2 || t.length > MAX_TERM_LENGTH) return false;
  // Must contain a letter — drops "2", "v3.1", "----".
  if (!/[a-z]/i.test(t)) return false;
  // Drops ULIDs / hex slugs / uuid fragments: long, no separators, no vowels
  // in a human pattern. Cheap approximation — a 12+ char run of [0-9a-f] only.
  if (/^[0-9a-f]{12,}$/i.test(t)) return false;
  return true;
}

/**
 * Case-insensitive dedupe that keeps the FIRST spelling seen.
 *
 * Order matters at the call site: static terms go in first, so the canonical
 * "muxpad"/"Trayo" casing wins over a tab someone named "MUXPAD".
 */
export function dedupeTerms(terms: string[], limit = MAX_GLOSSARY_TERMS): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const term of terms) {
    const t = term.trim();
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= limit) break;
  }
  return out;
}

/** Published artifact slugs — directory names under `<dataDir>/public`.
 *  The filesystem is the source of truth for publishes (see routes/publish.ts),
 *  so this is a readdir, not a table. `slug@2` version dirs are the same noun
 *  as `slug`, so the suffix is stripped and the dedupe collapses them. */
function artifactSlugs(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'public'), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .slice(0, PER_SOURCE_LIMIT)
      .map((e) => e.name.replace(/@\d+$/, ''));
  } catch {
    // No publishes yet (or no dataDir) — not an error, just no terms.
    return [];
  }
}

/** `/Users/me/dev/2026/muxpad` → `muxpad`. The repo name is the word the user
 *  actually says out loud; the path never is. */
function dirBasenames(paths: Array<string | null>): string[] {
  const out: string[] = [];
  for (const p of paths) {
    if (!p) continue;
    const base = basename(p.replace(/\/+$/, ''));
    if (base && base !== '/' && base !== '~') out.push(base);
  }
  return out;
}

/**
 * Every live name in this install, newest-first within each source.
 *
 * One bounded SELECT per table — no per-row follow-ups, nothing that grows
 * with the number of panes beyond a single scan. Any source that throws
 * (a table a migration hasn't created yet on a half-upgraded db) contributes
 * nothing rather than failing the whole build.
 */
export function liveNames(db: Database.Database, dataDir: string): string[] {
  const rows = <T>(sql: string): T[] => {
    try {
      return db.prepare(sql).all() as T[];
    } catch {
      return [];
    }
  };

  const workspaces = rows<{ name: string }>(
    `SELECT name FROM workspaces ORDER BY updated_at DESC LIMIT ${PER_SOURCE_LIMIT}`,
  ).map((r) => r.name);
  const tabs = rows<{ name: string }>(
    `SELECT name FROM tabs ORDER BY updated_at DESC LIMIT ${PER_SOURCE_LIMIT}`,
  ).map((r) => r.name);
  const panes = rows<{ name: string | null; cwd: string | null }>(
    `SELECT name, cwd FROM panes ORDER BY created_at DESC LIMIT ${PER_SOURCE_LIMIT}`,
  );
  const apps = rows<{ slug: string; name: string; cwd: string | null }>(
    `SELECT slug, name, cwd FROM apps ORDER BY updated_at DESC LIMIT ${PER_SOURCE_LIMIT}`,
  );

  return [
    ...workspaces,
    ...tabs,
    ...panes.map((p) => p.name ?? ''),
    ...apps.flatMap((a) => [a.slug, a.name]),
    ...artifactSlugs(dataDir),
    ...dirBasenames([...panes.map((p) => p.cwd), ...apps.map((a) => a.cwd)]),
  ].filter(isUsefulTerm);
}

/**
 * The glossary for one cleanup request: static muxpad vocabulary first, then
 * whatever this install currently calls things.
 */
export function buildGlossary(db: Database.Database, dataDir: string): string[] {
  return dedupeTerms([...STATIC_GLOSSARY, ...liveNames(db, dataDir)]);
}

/** How long a built glossary is reused. Long enough that a burst of dictation
 *  fixes costs one build; short enough that a tab you just renamed is known by
 *  the time you dictate its name. */
export const GLOSSARY_TTL_MS = 60_000;

/**
 * `buildGlossary` behind a small time cache.
 *
 * The glossary is rebuilt from SQLite + a readdir on every call otherwise, and
 * the cleanup endpoint is tapped repeatedly while composing one message. The
 * cache is per-instance (constructed alongside the route) rather than module
 * state so tests — and a second server in the same process — don't share it.
 */
export function glossaryCache(
  db: Database.Database,
  dataDir: string,
  opts: { ttlMs?: number; now?: () => number } = {},
): () => string[] {
  const ttl = opts.ttlMs ?? GLOSSARY_TTL_MS;
  const now = opts.now ?? Date.now;
  let cached: string[] | null = null;
  let builtAt = 0;
  return () => {
    const t = now();
    if (!cached || t - builtAt >= ttl) {
      cached = buildGlossary(db, dataDir);
      builtAt = t;
    }
    return cached;
  };
}
