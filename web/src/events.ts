import { type MuxpadEvent, MuxpadEventSchema } from '@muxpad/shared';

/**
 * Singleton client for the server-pushed event stream at /ws/events.
 *
 * Auto-reconnects with exponential backoff (250ms → 5s). On every
 * successful (re)connect, fires every reconnect subscriber so each
 * consumer can refetch its own baseline and recover from any events
 * missed while the socket was down. Events that fire during a
 * disconnect window are NOT replayed — subscribers are expected to
 * idempotently re-sync on reconnect.
 *
 * Two subscription channels:
 *   - subscribe(handler)            — every validated MuxpadEvent
 *   - subscribeReconnect(handler)   — fires on every successful RE-connect
 *                                     (not on the first connect: nothing was
 *                                     missed yet, and boot already fetches)
 *   - subscribeResync(handler)      — reconnect PLUS document-visible, so a
 *                                     mosaic with no poll can recover even
 *                                     when iOS leaves the socket "OPEN"
 *
 * Bad event payloads are dropped with a warning, never thrown, so a
 * single broken event can't tear down the stream.
 */
type EventHandler = (e: MuxpadEvent) => void;
type ReconnectHandler = () => void;

let ws: WebSocket | null = null;
let started = false;
const eventHandlers = new Set<EventHandler>();
const reconnectHandlers = new Set<ReconnectHandler>();
let reconnectDelayMs = 250;
let reconnectTimer: number | undefined;
/**
 * The FIRST open is a connect, not a re-connect. Handlers exist to recover
 * events missed during a gap, and there is no gap before the first connect —
 * every consumer's mount-time fetch is already in flight or done. Firing them
 * anyway meant the socket handshake (a few ms after boot, same origin) kicked
 * off a duplicate `GET /api/workspaces?all=1` on every single cold load.
 *
 * A first socket that DIES before onopen is a different story: boot fetches
 * already landed while we were deaf, so the eventual successful open must
 * resync. `sawDisconnect` is that gap flag.
 */
let everConnected = false;
let sawDisconnect = false;
/** Wall-clock of the last hide, for the iOS zombie force-close. */
let hiddenAt = 0;
/** Same gate XtermPane uses: a quick flip is not a background kill. */
const HIDDEN_RESUME_MS = 2000;

function endpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/events`;
}

function dropSocket(): void {
  if (!ws) return;
  const dying = ws;
  ws = null;
  dying.onclose = null;
  dying.onopen = null;
  dying.onmessage = null;
  dying.onerror = null;
  try {
    dying.close();
  } catch {
    // already closing
  }
}

function connect(): void {
  if (ws) return;
  ws = new WebSocket(endpoint());
  ws.onopen = () => {
    reconnectDelayMs = 250;
    const isReconnect = everConnected || sawDisconnect;
    everConnected = true;
    if (!isReconnect) return;
    for (const h of reconnectHandlers) {
      try {
        h();
      } catch (err) {
        console.warn('reconnect handler threw', err);
      }
    }
  };
  ws.onmessage = (m) => {
    let e: MuxpadEvent;
    try {
      e = MuxpadEventSchema.parse(JSON.parse(m.data));
    } catch (err) {
      console.warn('bad event payload', err);
      return;
    }
    // Isolate handlers: one throwing subscriber must not skip the rest
    // (handlers run in registration order; a throw used to drop every later
    // one, e.g. the active TabView's pane/layout sync).
    for (const h of eventHandlers) {
      try {
        h(e);
      } catch (err) {
        console.warn('event handler threw', err);
      }
    }
  };
  ws.onclose = () => {
    sawDisconnect = true;
    ws = null;
    window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
  };
  ws.onerror = () => ws?.close();
}

function reconnectNow(): void {
  window.clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  reconnectDelayMs = 250;
  dropSocket();
  connect();
}

function onVisibility(): void {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
  hiddenAt = 0;
  // Known-closed: skip leftover backoff so pane detail does not sit 5s stale.
  if (ws === null) {
    reconnectNow();
    return;
  }
  // iOS routinely kills sockets of backgrounded pages without firing close.
  // Force-cycle after a real hide so subscribeReconnect actually runs.
  if (hiddenFor >= HIDDEN_RESUME_MS) reconnectNow();
}

/**
 * Open the singleton connection. Idempotent — safe to call from multiple
 * boot paths. The `started` flag (not `ws`) is the guard because `ws` is
 * briefly null in the reconnect window and we don't want a parallel boot
 * call to launch a second socket.
 */
export function startEvents(): void {
  if (started) return;
  started = true;
  document.addEventListener('visibilitychange', onVisibility);
  connect();
}

export function subscribe(handler: EventHandler): () => void {
  eventHandlers.add(handler);
  return () => {
    eventHandlers.delete(handler);
  };
}

export function subscribeReconnect(handler: ReconnectHandler): () => void {
  reconnectHandlers.add(handler);
  return () => {
    reconnectHandlers.delete(handler);
  };
}

/**
 * Reconnect handlers plus an immediate run when the document becomes
 * visible. TabView's mosaic has no poll; an OPEN zombie events socket never
 * fires reconnect, so visibility is the HTTP backstop.
 */
export function subscribeResync(handler: ReconnectHandler): () => void {
  const unsub = subscribeReconnect(handler);
  const onVisible = () => {
    if (document.visibilityState !== 'visible') return;
    try {
      handler();
    } catch (err) {
      console.warn('resync handler threw', err);
    }
  };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    unsub();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
