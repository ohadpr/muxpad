import type Database from 'better-sqlite3';

/**
 * SETTINGS THAT BELONG TO THE INSTALL, not to a browser.
 *
 * The theme is the one that exists, and it is why this does: it used to be two
 * facts at once — a device default in localStorage and the chat's own on
 * `tabs.theme` — so switching chats repainted the whole window, rail included.
 * One theme, one place, pushed to every open window.
 *
 * ── A WHITELIST, AND WHY ─────────────────────────────────────────────────
 * The write route takes a key from a request, and this is a store whose whole
 * content is handed to every connected client on every change. An unbounded
 * key space would make it an arbitrary broadcast channel with a database
 * behind it: anything could write anything and every browser would receive
 * it. So the keys are enumerated here and the route refuses the rest.
 */
export const PREF_KEYS = ['theme'] as const;
export type PrefKey = (typeof PREF_KEYS)[number];

export function isPrefKey(k: string): k is PrefKey {
  return (PREF_KEYS as readonly string[]).includes(k);
}

/** Bounded, because the value is TEXT and it rides every push. */
export const MAX_PREF_BYTES = 256;

export class PrefStore {
  constructor(private readonly db: Database.Database) {}

  /**
   * Everything, as one object.
   *
   * Read and pushed as a set — a partial update would leave the client
   * merging, which is a second place for the two copies to disagree.
   */
  all(): Record<string, string> {
    try {
      const rows = this.db.prepare('SELECT key, value FROM app_prefs').all() as Array<{
        key: string;
        value: string;
      }>;
      const out: Record<string, string> = {};
      // Filtered on the way OUT as well as in: a row written by a build that
      // knew a key this one does not must not be served as if it were current.
      for (const r of rows) if (isPrefKey(r.key)) out[r.key] = r.value;
      return out;
    } catch {
      // A database that predates the table — the prefs are simply all default,
      // which is exactly what an empty object means to every reader.
      return {};
    }
  }

  get(key: PrefKey): string | null {
    const row = this.db.prepare('SELECT value FROM app_prefs WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  set(key: PrefKey, value: string): void {
    this.db
      .prepare(
        `INSERT INTO app_prefs (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, value, Date.now());
  }

  /** Back to the default, which is the ABSENCE of a row — not an empty string.
   *  A client reads "no value" as "use your own default", and the two have to
   *  stay tellable apart. */
  clear(key: PrefKey): void {
    this.db.prepare('DELETE FROM app_prefs WHERE key = ?').run(key);
  }
}
