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
  /**
   * The ONE query string this shape may carry, rebuilt verbatim.
   *
   * A query is normally a refusal (see `handle`), because it is free text that
   * survives the path rebuild. Naming the exact permitted value keeps that
   * property: the host's string is compared and then thrown away, never
   * parsed and never passed on.
   */
  query?: string;
  /**
   * Rebuild the BODY, for a shape where the body is not free text.
   *
   * Absent means the body rides through as sent, which is right for the two
   * places where arbitrary content IS the feature — a card's markup and a
   * message's text. Present means the host's JSON never reaches the router:
   * named fields are validated and a new object is built from them, same
   * discipline as the path. `null` is a refusal.
   */
  rebuildBody?: (raw: string | undefined, ctx: BodyContext) => string | null;
}

/** What a body rebuilder may consult. The principal is not negotiable. */
interface BodyContext {
  nodeId: string;
  /** Does this pane live on the calling host? */
  paneIsOurs: (paneId: string) => boolean;
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
  // ── muxpad agent new ────────────────────────────────────────────────────
  //
  // A chat that cannot delegate is half a chat, and a sub-chat of a VM chat
  // belongs on the VM — which is now what happens without being asked, because
  // `nodeForBootstrap` inherits the parent's machine.
  //
  // THE BODY IS REBUILT, and this is the shape that most needs it. The route
  // itself is already the careful one — it takes no `startup_cmd` and no
  // command of any kind, and gates `model` against a charset precisely because
  // it is baked into a shell string. What a rebuild adds is that a field
  // nobody audited cannot arrive at all, today or after someone extends the
  // route: only the six below survive.
  {
    method: 'POST',
    pattern: /^\/api\/tabs$/,
    parts: [],
    rebuild: () => '/api/tabs',
    rebuildBody: (raw, ctx) => {
      let v: Record<string, unknown>;
      try {
        v = JSON.parse(raw ?? '{}') as Record<string, unknown>;
      } catch {
        return null;
      }
      // THE PARENT IS THE AUTHORISATION. A host may spawn a worker FROM one of
      // its own chats, which is also what pins the new pane to that machine —
      // without it the workspace default decides, and a host could get a pane
      // on the mac by naming a workspace.
      const parent = v.spawned_by_pane;
      if (typeof parent !== 'string' || !ID.test(parent) || !ctx.paneIsOurs(parent)) return null;
      const str = (x: unknown, re: RegExp): string | undefined =>
        typeof x === 'string' && re.test(x) ? x : undefined;
      const out: Record<string, unknown> = {
        bootstrap: 'agent',
        spawned_by_pane: parent,
        // Belt and braces with nodeForBootstrap's inheritance: say it outright,
        // so this cannot start landing elsewhere if that rule is ever relaxed.
        node_id: ctx.nodeId,
      };
      // Enum-valued, so an exact membership test rather than a charset.
      if (v.backend === 'claude' || v.backend === 'codex' || v.backend === 'cursor')
        out.backend = v.backend;
      if (v.mode === 'chat' || v.mode === 'agent') out.mode = v.mode;
      const model = str(v.model, /^[A-Za-z0-9._[\]-]{1,64}$/);
      if (model) out.model = model;
      // A tab label. Length-capped and stripped of control characters — it is
      // rendered in the rail and nothing else.
      if (typeof v.name === 'string' && v.name.trim())
        // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the point
        out.name = v.name.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
      // The worker's directory ON ITS OWN MACHINE. Absolute only; it is the
      // host choosing a path on its own disk, which is not an escalation, and
      // a relative one would be resolved against whatever cwd ptyd has.
      // Absolute, printable, bounded. The NUL and the control range are
      // excluded by the positive class rather than by a negated one, so the
      // rule reads as "what a path may contain".
      const cwd = str(v.cwd, /^\/[\x20-\x7e\u00a0-\uffff]{0,512}$/);
      if (cwd) out.cwd = cwd;
      return JSON.stringify(out);
    },
  },
  // ── muxpad publish: the CLI's pre-flight ────────────────────────────────
  //
  // AND IT IS NOT OPTIONAL, which is why it is here. Asked before every
  // publish to learn whether the server already knows its public base. A 404
  // reads as "unanswered", and the CLI's fallback ladder for that is to derive
  // the tailnet name and then EXEC TAILSCALE to create a funnel mapping — on
  // a machine that has no business doing either, and on a mac that is a TCC
  // prompt on somebody's physical screen. Observed: a publish from the VM hung
  // past two minutes in exactly that ladder while the artifact itself had
  // already transferred fine.
  //
  // The answer is a public base URL and a cache flag — the url is on the
  // printed link of every artifact, so there is nothing here a publisher does
  // not already have.
  {
    method: 'GET',
    pattern: /^\/api\/publish\/base$/,
    parts: [],
    rebuild: () => '/api/publish/base',
    query: 'probe=0',
  },
  // ── muxpad publish ──────────────────────────────────────────────────────
  //
  // The one in-pane verb whose payload is BYTES. Published artifacts are
  // served from this machine's disk behind the single public tunnel, and the
  // file is on the host — so the body's `path` is not dispatched at all: it
  // names what the SERVER then asks that host to send, and publish is handed
  // the staged copy. See `handlePublish`.
  //
  // Publishing is already public by definition, so there is no secret
  // boundary being crossed here — which is also why artifacts were always
  // going to live on the server rather than be proxied per request.
  {
    method: 'POST',
    pattern: /^\/api\/publish$/,
    parts: [],
    rebuild: () => '/api/publish',
  },
  // The CLI reads `panes[0].id` back off the new tab, to address the worker it
  // just made. Scoped like everything else: a tab with a pane on this host.
  {
    method: 'GET',
    pattern: /^\/api\/tabs\/([^/]+)$/,
    parts: ['tab'],
    rebuild: ([t]) => `/api/tabs/${t}`,
  },
];

export interface HostApiDeps {
  db: Database.Database;
  /**
   * Pull a path off a host into a staging dir here, for `muxpad publish`.
   *
   * Optional: absent means publishing from a host is refused like anything
   * else not on the list, which is the right default for a link that has no
   * file channel.
   */
  fetchFromHost?: (
    nodeId: string,
    path: string,
  ) => Promise<{ path: string; dispose: () => void } | { error: string }>;
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
    if (rawPath.includes('#')) return NOT_FOUND;
    const qAt = rawPath.indexOf('?');
    const path = qAt === -1 ? rawPath : rawPath.slice(0, qAt);
    const query = qAt === -1 ? null : rawPath.slice(qAt + 1);
    // Publishing is the one shape that is not "validate, then dispatch": the
    // bytes have to be fetched off the host first, and the path that reaches
    // publish is OURS, never the host's.
    if (method.toUpperCase() === 'POST' && path === '/api/publish')
      return this.handlePublish(nodeId, body);
    for (const a of ALLOWED) {
      if (a.method !== method.toUpperCase()) continue;
      const m = a.pattern.exec(path);
      if (!m) continue;
      // A query the shape does not name is a refusal, not something to strip:
      // stripping would silently change the meaning of the call.
      if (query !== null && query !== a.query) return NOT_FOUND;
      const captures = m.slice(1).map((s) => decodeURIComponent(s));
      if (!this.capturesOk(nodeId, a.parts, captures)) return NOT_FOUND;
      let out = body;
      if (a.rebuildBody) {
        const rebuilt = a.rebuildBody(body, {
          nodeId,
          paneIsOurs: (paneId) => this.paneIsOn(nodeId, paneId),
        });
        if (rebuilt === null) return NOT_FOUND;
        out = rebuilt;
      }
      // Rebuilt from the SHAPE, not from the request — the host's own string
      // has been compared and discarded.
      const dest = a.rebuild(captures) + (a.query && query !== null ? `?${a.query}` : '');
      return this.dispatch(a.method, dest, out);
    }
    return NOT_FOUND;
  }

  /**
   * `muxpad publish` from a chat on another machine.
   *
   * Three steps, in this order, because each one guards the next:
   *
   *  1. REBUILD the body. `name`, `update`, `days` and `audience` are the only
   *     fields that survive; `public_base_url` is dropped so the server's own
   *     default decides the link, which is the durable one.
   *  2. FETCH the host's path into a staging dir under the data dir. The
   *     host's `path` string is used for nothing else — it never reaches the
   *     publish route, so none of that route's filesystem reasoning (is this
   *     the public dir, is it an ancestor of it) is being asked to defend
   *     against a remote path it cannot stat.
   *  3. DISPATCH with the staged path, then delete the staging tree whatever
   *     happened.
   */
  private async handlePublish(nodeId: string, body?: string): Promise<HostApiResult> {
    const fetchFromHost = this.deps.fetchFromHost;
    if (!fetchFromHost) return NOT_FOUND;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(body ?? '{}') as Record<string, unknown>;
    } catch {
      return NOT_FOUND;
    }
    const src = v.path;
    // Absolute only, like the route itself requires — and this one is a path
    // on ANOTHER machine, so there is nothing here that could usefully check
    // more than its shape.
    if (typeof src !== 'string' || !src.startsWith('/') || src.includes('\0')) return NOT_FOUND;
    const out: Record<string, unknown> = {};
    // WHICH CHAT PUBLISHED IT, and it must be one of this host's own — the
    // artifact list of a chat on the mac is not somewhere a VM may write.
    if (typeof v.pane === 'string' && ID.test(v.pane) && this.paneIsOn(nodeId, v.pane))
      out.pane = v.pane;
    if (typeof v.name === 'string' && /^[a-z0-9-]{1,64}$/.test(v.name)) out.name = v.name;
    if (v.update === true) out.update = true;
    if (typeof v.days === 'number' && Number.isFinite(v.days) && v.days > 0 && v.days <= 3650)
      out.days = Math.floor(v.days);
    if (v.audience === 'public' || v.audience === 'private') out.audience = v.audience;
    // `update` without a name is the route's own 400; let it say so rather
    // than refusing with a 404 that reads as "no such thing".
    const staged = await fetchFromHost(nodeId, src);
    if ('error' in staged)
      return {
        status: 502,
        body: JSON.stringify({ error: { code: 'host_unreachable', message: staged.error } }),
        contentType: 'application/json',
      };
    try {
      return await this.dispatch(
        'POST',
        '/api/publish',
        JSON.stringify({ ...out, path: staged.path }),
      );
    } finally {
      // Publish COPIES into the public dir, so the staged tree is dead the
      // moment the route returns — and a staging dir left behind in the data
      // dir is invisible debris that nothing else sweeps.
      staged.dispose();
    }
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
