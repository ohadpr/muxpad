import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MuxpadEvent } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import webpush from 'web-push';
import type { EventBus } from './events.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';

/**
 * Web Push for the installed PWA (iOS home-screen app included). VAPID
 * keys are generated once and persisted to `<dataDir>/vapid.json`;
 * subscriptions live in the `push_subscriptions` table (one row per
 * browser/device). Payloads are small JSON blobs the service worker
 * (web/public/sw.js) turns into showNotification() calls.
 *
 * NOTE: Web Push only works when the app is served from a secure context
 * (https). Over plain http the client can't even register a service
 * worker, so these routes sit dormant — harmless but unused.
 */

export interface PushPayload {
  title: string;
  body: string;
  /**
   * SPA path to open on tap, e.g. `/w/dev/t/muxpad?ptab=<id>&pane=<id>`.
   * The ptab/pane params are the COLD-START channel for pane focus: a tap
   * that boots the PWA fresh can't receive a SW postMessage reliably, so
   * the app reads them at boot (web/src/main.tsx) and strips them.
   */
  url: string;
  /** Pane-focus hints for the WARM path (SW → postMessage → open client). */
  tab_id?: string;
  pane_id?: string;
  /** Coalescing key — repeat notifications with the same tag replace. */
  tag?: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

interface SubscriptionRow {
  endpoint: string;
  subscription: string;
}

export class PushService {
  private readonly keys: VapidKeys;

  constructor(
    private readonly db: Database.Database,
    dataDir: string,
  ) {
    this.keys = loadOrCreateVapidKeys(dataDir);
    webpush.setVapidDetails(
      // VAPID `sub` — a contact URI the push service may use to reach the
      // operator. muxpad is self-hosted, so default to a placeholder and
      // let the operator override.
      process.env.MUXPAD_PUSH_SUBJECT ?? 'mailto:muxpad@example.com',
      this.keys.publicKey,
      this.keys.privateKey,
    );
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  subscribe(subscription: { endpoint: string }): void {
    this.db
      .prepare(
        `INSERT INTO push_subscriptions (endpoint, subscription, created_at)
         VALUES (?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET subscription = excluded.subscription`,
      )
      .run(subscription.endpoint, JSON.stringify(subscription), Date.now());
  }

  unsubscribe(endpoint: string): void {
    this.db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as {
      n: number;
    };
    return row.n;
  }

  /**
   * Send `payload` to every stored subscription. Dead subscriptions (the
   * push service answers 404/410 — user removed the PWA, cleared site
   * data, …) are pruned; other failures are logged and left in place so a
   * transient push-service outage doesn't wipe the table.
   */
  async send(payload: PushPayload): Promise<void> {
    const rows = this.db
      .prepare('SELECT endpoint, subscription FROM push_subscriptions')
      .all() as SubscriptionRow[];
    const body = JSON.stringify(payload);
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription), body, { TTL: 300 });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.unsubscribe(row.endpoint);
          } else {
            console.error(`push send failed (${status ?? 'no status'})`, err);
          }
        }
      }),
    );
  }
}

function loadOrCreateVapidKeys(dataDir: string): VapidKeys {
  const path = join(dataDir, 'vapid.json');
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8')) as VapidKeys;
  }
  const keys = webpush.generateVAPIDKeys();
  // Private key — keep it out of group/other hands like an ssh key.
  writeFileSync(path, JSON.stringify(keys, null, 2), { mode: 0o600 });
  return keys;
}

/**
 * Pane-scoped notification sender: resolves the pane's owning tab +
 * workspace into the "Tab — Workspace" title and the deep-link URL, so
 * every pane-triggered notification (BEL attention, chat turn-done, agent
 * question) lands the tap on the right tab. Callers supply only the body.
 */
export type PaneNotifier = (paneId: string, body: string) => void;

export function createPaneNotifier(db: Database.Database, push: PushService): PaneNotifier {
  const panes = new PaneStore(db);
  const tabs = new TabStore(db);
  const workspaces = new WorkspaceStore(db);
  return (paneId, body) => {
    const pane = panes.getById(paneId);
    const tab = pane ? tabs.getById(pane.tab_id) : null;
    const ws = tab ? workspaces.getById(tabs.getWorkspaceId(tab.id) ?? '') : null;
    void push.send({
      title: tab && ws ? `${tab.name} — ${ws.name}` : 'muxpad',
      body,
      url:
        tab && ws
          ? `/w/${ws.slug}/t/${tab.slug}?ptab=${encodeURIComponent(tab.id)}&pane=${encodeURIComponent(paneId)}`
          : '/',
      ...(tab ? { tab_id: tab.id, pane_id: paneId } : {}),
      tag: paneId,
    });
  };
}

/**
 * Bridge pane attention onto push: whenever a pane's attention flag rises
 * (BEL received — "this pane wants you"), notify every subscribed device
 * with a deep link to the owning workspace/tab.
 *
 * Rising-edge only: the EventBus emits `pane.updated` for every
 * title/fg/attention delta, so we track the last-seen attention per pane
 * and fire only on false→true.
 *
 * Startup grace: on a main-server restart, ptyd replays current pane
 * state — including attention flags that predate the restart. A pane
 * first seen inside the grace window is baselined silently instead of
 * notified, so a restart can't re-blast stale attention. After the
 * window, an unseen pane's first ring notifies normally.
 */
export function attachAttentionPush(opts: {
  events: EventBus;
  db: Database.Database;
  push: PushService;
  /** Injectable clock for tests. */
  now?: () => number;
  graceMs?: number;
}): () => void {
  const { events, db, push, now = Date.now, graceMs = 15_000 } = opts;
  const notify = createPaneNotifier(db, push);
  const lastAttention = new Map<string, boolean>();
  const bootAt = now();

  return events.subscribe((e: MuxpadEvent) => {
    if (e.type === 'pane.removed') {
      lastAttention.delete(e.pane_id);
      return;
    }
    if (e.type === 'pane.added') {
      lastAttention.set(e.pane.id, e.pane.attention ?? false);
      return;
    }
    if (e.type !== 'pane.updated') return;

    const attention = e.pane.attention ?? false;
    const prev = lastAttention.get(e.pane.id);
    lastAttention.set(e.pane.id, attention);
    if (prev === undefined && now() - bootAt < graceMs) return; // restart replay — baseline only
    if (prev === true || !attention) return; // not a rising edge

    const paneLabel = e.pane.name ?? e.pane.title ?? e.pane.foreground_cmd ?? 'a pane';
    notify(e.pane.id, `${paneLabel} wants your attention`);
  });
}
