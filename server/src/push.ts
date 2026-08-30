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

/**
 * How long the push service holds an undelivered message for a device it
 * can't currently reach.
 *
 * Was 300s, which quietly made push useless for the case it exists to serve:
 * a phone asleep in a pocket, on a flaky cell, or simply off for a bit misses
 * the window and the "your agent is waiting on you" ping is dropped with no
 * retry and no trace. An hour is the point where the notification stops being
 * useful and starts being archaeology — an agent that asked a question 90
 * minutes ago is either finished or long stalled, and buzzing then is noise.
 *
 * An hour of holding is only safe because of `topicFor()` below: without
 * collapsing, a device that comes back after 30 minutes would get every
 * queued ping at once.
 */
const PUSH_TTL_SECONDS = 3600;

/**
 * Collapse key. The push service keeps only the LATEST undelivered message
 * per (subscription, topic) — so a pane that rang five times while the phone
 * was unreachable delivers one current notification instead of a five-deep
 * stack of stale ones. We reuse the payload's `tag` (the pane id for pane
 * notifications), which is already the client-side collapse key, so the
 * server-side and client-side coalescing agree.
 *
 * The Topic header is constrained to <=32 base64url characters; anything that
 * doesn't fit is dropped rather than risking a 400 from the push service.
 */
function topicFor(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  return /^[A-Za-z0-9_-]{1,32}$/.test(tag) ? tag : undefined;
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
   * Send `payload` to every stored subscription. Permanently-dead
   * subscriptions are pruned; other failures are logged and left in place
   * so a transient push-service outage doesn't wipe the table. Pruned
   * statuses: 404/410 (user removed the PWA / cleared site data) AND
   * 401/403 (the subscription was minted under DIFFERENT VAPID keys —
   * after a key rotation or vapid.json loss every old subscription fails
   * this way forever; retaining them spams errors on every send and can
   * never recover — the client re-subscribes with the current key on its
   * next enable/boot check).
   */
  async send(payload: PushPayload): Promise<void> {
    const rows = this.db
      .prepare('SELECT endpoint, subscription FROM push_subscriptions')
      .all() as SubscriptionRow[];
    const body = JSON.stringify(payload);
    const topic = topicFor(payload.tag);
    await Promise.all(
      rows.map(async (row) => {
        try {
          await webpush.sendNotification(JSON.parse(row.subscription), body, {
            TTL: PUSH_TTL_SECONDS,
            // Every push muxpad sends is "a human is being waited on" — the
            // notifier already suppresses anything the user can see for
            // themselves (see Presence). `normal` lets a dozing device defer
            // delivery to its next wake-up, which is exactly the latency this
            // whole path exists to avoid.
            urgency: 'high',
            ...(topic ? { topic } : {}),
          });
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410 || status === 401 || status === 403) {
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

/**
 * "Is the user actively at a device right now?" — fed by a client-side
 * heartbeat (foreground + user interaction) POSTed to /api/presence. Push
 * notifications are HELD while active on any device: the in-app UI already
 * shows the update, so a buzz is just noise. When every device goes quiet
 * (backgrounded, asleep, away) past the window, notifications resume.
 */
export class Presence {
  private lastActiveAt = 0;
  /** Default window: a heartbeat within this long ago counts as "active". */
  constructor(private readonly windowMs = 75_000) {}
  mark(): void {
    this.lastActiveAt = Date.now();
  }
  isActive(): boolean {
    return Date.now() - this.lastActiveAt < this.windowMs;
  }
}

export function createPaneNotifier(
  db: Database.Database,
  push: PushService,
  presence?: Presence,
): PaneNotifier {
  const panes = new PaneStore(db);
  const tabs = new TabStore(db);
  const workspaces = new WorkspaceStore(db);
  return (paneId, body) => {
    // Hold the push while the user is active on any device — they can see it.
    if (presence?.isActive()) return;
    const pane = panes.getById(paneId);
    const tab = pane ? tabs.getById(pane.tab_id) : null;
    const ws = tab ? workspaces.getById(tabs.getWorkspaceId(tab.id) ?? '') : null;
    void push.send({
      // Title is just the tab name — the workspace ("— Personal") was noise on
      // a phone's one line; ws is still resolved below for the deep-link slug.
      title: tab ? tab.name : 'muxpad',
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
  /** Held while the user is active on any device (see Presence). */
  presence?: Presence;
  /** Injectable clock for tests. */
  now?: () => number;
  graceMs?: number;
}): () => void {
  const { events, db, push, presence, now = Date.now, graceMs = 15_000 } = opts;
  const notify = createPaneNotifier(db, push, presence);
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
