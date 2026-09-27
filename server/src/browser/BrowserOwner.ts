import type Database from 'better-sqlite3';

/**
 * Which conversation a browser belongs to.
 *
 * Needed because the two facts arrive at different times. The TAB is known when
 * the browser is registered — the agent's MCP wrapper passes it — but the
 * MOMENT worth putting in that conversation happens later, when a page is
 * actually visited. Recording the card at registration was the bug: the wrapper
 * runs when the agent's session starts, so "Browser opened" was stamped before
 * the person had typed anything and sorted above the prompt that caused it.
 *
 * The tab id cannot be recovered from the profile name, which is why this
 * exists rather than a bit of string arithmetic: a session profile is
 * `s-<tabid>` LOWERCASED (profile names are slugs), and a tab id is an
 * uppercase ULID. A card is shown only in the chat whose id matches exactly, so
 * a lowercased one would be a card that appears nowhere.
 */
export class BrowserOwner {
  constructor(private readonly db: Database.Database) {}

  private key(profile: string): string {
    return `browser_owner_${profile}`;
  }

  set(profile: string, tabId: string): void {
    this.db
      .prepare(
        'INSERT INTO globals (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(this.key(profile), tabId);
  }

  get(profile: string): string | null {
    const row = this.db.prepare('SELECT value FROM globals WHERE key = ?').get(this.key(profile)) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  clear(profile: string): void {
    this.db.prepare('DELETE FROM globals WHERE key = ?').run(this.key(profile));
  }
}
