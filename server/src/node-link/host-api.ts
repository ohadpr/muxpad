import type Database from 'better-sqlite3';
import { LOCAL_NODE_ID } from '../store/NodeStore.js';

/**
 * WHAT A HOST MAY ASK THIS SERVER TO DO.
 *
 * An agent in a remote pane runs the same in-pane CLI as a local one —
 * `muxpad card`, `muxpad say`, `muxpad agent send` — and every one of those is
 * an HTTP call to the server. The host cannot dial this machine, so the call
 * rides up the link and is answered here.
 *
 * ── THIS IS NOT "THE SERVER'S API", AND THAT IS THE WHOLE POINT ───────────
 *
 * The first design said the host would open a stream carrying "one HTTP
 * request/response" against the server's own app. A trust review priced that
 * at code execution on this machine in a single request, and it was right:
 * `POST /api/tabs/:id/panes` takes a `startup_cmd` from the body, `/api/apps`
 * autostarts a command every boot, `/api/crons` survives reboots,
 * `POST /api/publish {path}` would put `~/.ssh` and `~/.muxpad/api-secret` on
 * the public internet, and `/api/panes/:id/input` types into live terminals on
 * the user's desk. A host that is a shared VM administered by other people
 * must not be one request away from any of that.
 *
 * So the surface is an ALLOWLIST OF SHAPES, not a path filter:
 *
 *  1. The method and path must match one of the patterns below, exactly.
 *  2. Every id in the path is validated against its own charset and then the
 *     path is REBUILT from the captures. The host's string never reaches the
 *     router, so traversal (`../`), query strings and encoded separators
 *     cannot survive the trip.
 *  3. Every id must belong to THIS host. The principal is the link object —
 *     `nodeId` is what this server dialled, not something the host said. The
 *     earlier version of this check read `x-muxpad-node-id`, a header nothing
 *     wrote and a host could have shaped.
 *  4. Only then is the reconstructed request dispatched, with headers we
 *     build ourselves.
 *
 * Anything else is 404 with no detail — a host learns nothing about what
 * exists here from being refused.
 */

/** One allowed shape: a method, a path pattern, and what each capture is. */
interface Allowed {
  method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** Captures are named by what they must be, which is what gets checked. */
  pattern: RegExp;
  /** `tab` / `pane` must be owned by the calling host; `name` is just a label. */
  parts: Array<'tab' | 'pane' | 'name'>;
  /** Rebuild the path from validated captures. */
  rebuild: (c: string[]) => string;
}

/** Ids are ULIDs/ULID-ish; a card name is the CLI's own charset. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const CARD_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

const ALLOWED: Allowed[] = [
  // ── muxpad card ─────────────────────────────────────────────────────────
  {
    method: 'GET',
    pattern: /^\/api\/tabs\/([^/]+)\/cards$/,
    parts: ['tab'],
    rebuild: ([t]) => `/api/tabs/${t}/cards`,
  },
  {
    method: 'GET',
    pattern: /^\/api\/tabs\/([^/]+)\/cards\/([^/]+)$/,
    parts: ['tab', 'name'],
    rebuild: ([t, n]) => `/api/tabs/${t}/cards/${n}`,
  },
  {
    method: 'PUT',
    pattern: /^\/api\/tabs\/([^/]+)\/cards\/([^/]+)$/,
    parts: ['tab', 'name'],
    rebuild: ([t, n]) => `/api/tabs/${t}/cards/${n}`,
  },
  {
    method: 'DELETE',
    pattern: /^\/api\/tabs\/([^/]+)\/cards\/([^/]+)$/,
    parts: ['tab', 'name'],
    rebuild: ([t, n]) => `/api/tabs/${t}/cards/${n}`,
  },
  // ── muxpad say ──────────────────────────────────────────────────────────
  //
  // The key is not a secret (anything running as this user can read the file);
  // it is what makes text that MENTIONS the marker distinguishable from an
  // invocation of it. No id, so nothing to scope.
  {
    method: 'GET',
    pattern: /^\/api\/say\/key$/,
    parts: [],
    rebuild: () => '/api/say/key',
  },
  // ── muxpad agent send ───────────────────────────────────────────────────
  //
  // Host-scoped by rule, not by accident: a VM chat may message VM panes and
  // no others. See the host-scoping principle — a compromised host cannot
  // reach another machine's chats by design rather than by a check.
  {
    method: 'POST',
    pattern: /^\/api\/agent-sessions\/([^/]+)\/send$/,
    parts: ['pane'],
    rebuild: ([p]) => `/api/agent-sessions/${p}/send`,
  },
];

export interface HostApiDeps {
  db: Database.Database;
  /** Dispatch a request this module built. Never the host's own. */
  fetch: (req: Request) => Response | Promise<Response>;
  /** This server's own base, for an absolute URL and a same-origin Origin. */
  selfUrl: string;
  /** The install credential, so the dispatched request satisfies api-auth. */
  apiKey: () => string | null;
}

export interface HostApiResult {
  status: number;
  body: string;
  contentType?: string;
}

/** The refusal every rejected shape gets, so none of them is distinguishable. */
const NOT_FOUND: HostApiResult = {
  status: 404,
  body: JSON.stringify({ error: 'not found' }),
  contentType: 'application/json',
};

export class HostApi {
  constructor(private readonly deps: HostApiDeps) {}

  /**
   * Answer one request from `nodeId`.
   *
   * `nodeId` comes from the link object in this process. It is the only thing
   * here that establishes who is asking, and nothing on the wire can change it.
   */
  async handle(
    nodeId: string,
    method: string,
    rawPath: string,
    body?: string,
  ): Promise<HostApiResult> {
    // A host is never `local`: that id means "this machine", and honouring it
    // would hand a host the whole local pane set.
    if (!nodeId || nodeId === LOCAL_NODE_ID) return NOT_FOUND;
    // A QUERY STRING IS A REFUSAL, not something to strip. No allowed shape
    // takes one, so stripping would silently change the meaning of a call —
    // and the day a route here grows a parameter, the stripped version is a
    // request that did something subtly different from what was asked. The
    // rebuild step exists to remove free text from the path; a query is free
    // text that survives it.
    if (rawPath.includes('?') || rawPath.includes('#')) return NOT_FOUND;
    const path = rawPath;
    for (const a of ALLOWED) {
      if (a.method !== method.toUpperCase()) continue;
      const m = a.pattern.exec(path);
      if (!m) continue;
      const captures = m.slice(1).map((s) => decodeURIComponent(s));
      if (!this.capturesOk(nodeId, a.parts, captures)) return NOT_FOUND;
      return this.dispatch(a.method, a.rebuild(captures), body);
    }
    return NOT_FOUND;
  }

  /** Charset, then ownership, for each capture. Either failure is a 404. */
  private capturesOk(nodeId: string, parts: Allowed['parts'], captures: string[]): boolean {
    for (let i = 0; i < parts.length; i++) {
      const value = captures[i];
      if (!value) return false;
      const part = parts[i];
      if (part === 'name') {
        if (!CARD_NAME.test(value)) return false;
        continue;
      }
      if (!ID.test(value)) return false;
      if (part === 'pane' && !this.paneIsOn(nodeId, value)) return false;
      if (part === 'tab' && !this.tabIsOn(nodeId, value)) return false;
    }
    return true;
  }

  private paneIsOn(nodeId: string, paneId: string): boolean {
    const row = this.deps.db.prepare('SELECT node_id FROM panes WHERE id = ?').get(paneId) as
      | { node_id: string | null }
      | undefined;
    // A pane with no row is NOT this host's. Treating "never heard of it" as
    // ownership is the same mistake the transcript chokepoint exists to stop.
    return !!row && (row.node_id ?? LOCAL_NODE_ID) === nodeId;
  }

  /**
   * A tab belongs to a host when a pane of its lives there.
   *
   * A chat is one pane in one tab, so this is exact for the case that matters.
   * A mixed tab — panes on two machines — counts for both, which is correct:
   * the card belongs to the conversation, and both hosts are in it.
   */
  private tabIsOn(nodeId: string, tabId: string): boolean {
    const row = this.deps.db
      .prepare('SELECT 1 AS ok FROM panes WHERE tab_id = ? AND COALESCE(node_id, ?) = ? LIMIT 1')
      .get(tabId, LOCAL_NODE_ID, nodeId) as { ok?: number } | undefined;
    return !!row?.ok;
  }

  /**
   * Dispatch the request WE built.
   *
   * Headers are ours: the install credential so api-auth is satisfied, a
   * same-origin `Origin` so the CSRF guard sees what it expects, and nothing
   * the host sent. `Upgrade` cannot appear because we never copy a header.
   */
  private async dispatch(method: string, path: string, body?: string): Promise<HostApiResult> {
    const key = this.deps.apiKey();
    const headers: Record<string, string> = {
      origin: this.deps.selfUrl,
      ...(key ? { 'x-muxpad-key': key } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    };
    const req = new Request(`${this.deps.selfUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const res = await this.deps.fetch(req);
    const text = await res.text();
    const ct = res.headers.get('content-type');
    return { status: res.status, body: text, ...(ct ? { contentType: ct } : {}) };
  }
}
