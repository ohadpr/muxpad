import type Database from 'better-sqlite3';

/**
 * Tiny server-side KV (migration 19) for singleton pointers — currently the
 * CEO pane/tab ids (`ceo_pane_id` / `ceo_tab_id`). Server-side rather than
 * the doc surface's localStorage-pointer trick because these pointers must
 * resolve identically from every browser/device.
 */
export class GlobalsStore {
  constructor(private readonly db: Database.Database) {}

  get(key: string): string | null {
    const r = this.db.prepare('SELECT value FROM globals WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return r?.value ?? null;
  }

  set(key: string, value: string): void {
    this.db
      .prepare(
        'INSERT INTO globals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, value);
  }
}
