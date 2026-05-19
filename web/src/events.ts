import { MuxpadEventSchema, type MuxpadEvent } from '@muxpad/shared';

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
 *   - subscribeReconnect(handler)   — fires on every successful (re)connect
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

function endpoint(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws/events`;
}

function connect(): void {
  ws = new WebSocket(endpoint());
  ws.onopen = () => {
    reconnectDelayMs = 250;
    for (const h of reconnectHandlers) {
      try { h(); } catch (err) { console.warn('reconnect handler threw', err); }
    }
  };
  ws.onmessage = (m) => {
    try {
      const e = MuxpadEventSchema.parse(JSON.parse(m.data));
      for (const h of eventHandlers) h(e);
    } catch (err) {
      console.warn('bad event payload', err);
    }
  };
  ws.onclose = () => {
    ws = null;
    window.setTimeout(connect, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5000);
  };
  ws.onerror = () => ws?.close();
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
