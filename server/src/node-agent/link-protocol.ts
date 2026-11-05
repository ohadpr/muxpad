/**
 * THE HOST LINK PROTOCOL — what travels on the one socket per host.
 *
 * ── WHY HERE AND NOT IN ptyd's PROTOCOL ──────────────────────────────────
 * I first put the transcript messages in `ptyd/protocol.ts`. Wrong component:
 * ptyd imports `fs`, `http`, `ws` and `PaneManager` and nothing else. It has
 * no database, so it cannot turn a pane id into a session id, and it has no
 * business reading transcripts. The node agent is the half that faces the
 * network and can hold state, so the link — and everything that is not a pty
 * operation — belongs to it.
 *
 * ── ONE SOCKET, THREE CONVERSATIONS ──────────────────────────────────────
 * The server dials the agent once. Messages carry a `ch` (channel) tag so one
 * socket can serve three unrelated conversations without a stream
 * multiplexer: each message is already a complete JSON envelope, so routing is
 * a switch, not a framing layer.
 *
 *   ptyd       · passthrough. The agent forwards the payload verbatim to its
 *                local ptyd control socket and forwards replies back, so
 *                ptyd's own protocol is untouched and ptyd never learns that
 *                a network exists.
 *   transcript · the agent tails a chat's file HERE and pushes rendered
 *                events. See transcript-subscriptions.ts for why the host
 *                does the reading.
 *   runner     · an agent runner on this machine cannot dial the server, so
 *                its frames ride up this socket and the server's sends ride
 *                down. This is what makes a chat on a remote host possible at
 *                all, and it is also where the host learns a fresh chat's
 *                session id — from the runner's own `hello`, which is the only
 *                place that id exists before anything is written.
 *
 * Direction is NOT constrained by who dialled. The socket is bidirectional
 * once open; the host has pushed events up ptyd's control socket since ptyd
 * was written. Conflating "cannot initiate a connection" with "cannot send"
 * is what sent me down a multiplexer design for a problem that did not exist.
 */

/** Which conversation a message belongs to. */
export type LinkChannel = 'ptyd' | 'transcript' | 'runner' | 'api' | 'files' | 'search';

/** Server → host. */
export type LinkDown =
  /** Forward verbatim to the local ptyd control socket. */
  | { ch: 'ptyd'; payload: string }
  /** Start tailing this pane's chat. The host resolves the sid itself. */
  | { ch: 'transcript'; op: 'subscribe'; paneId: string; tailBytes?: number }
  | { ch: 'transcript'; op: 'unsubscribe'; paneId: string }
  | { ch: 'transcript'; op: 'loadOlder'; paneId: string }
  /** A frame bound for the runner in `paneId` (a send, stop, model switch). */
  | { ch: 'runner'; op: 'frame'; paneId: string; frame: unknown }
  /** The server is ready to adopt this pane's runner; the host may attach it. */
  | { ch: 'runner'; op: 'adopt'; paneId: string }
  /** Search this host's own archive. `q` is a raw FTS5 expression. */
  | { ch: 'search'; op: 'query'; id: string; q: string; limit: number; role?: string }
  /** Send me this path's contents. See the `files` channel note. */
  | { ch: 'files'; op: 'fetch'; id: string; path: string }
  /** The answer to one `api` request. `id` is the host's own correlation id. */
  | {
      ch: 'api';
      op: 'response';
      id: string;
      status: number;
      body: string;
      contentType?: string;
    };

/** Host → server. */
export type LinkUp =
  /** A verbatim reply or push from the local ptyd. */
  | { ch: 'ptyd'; payload: string }
  | { ch: 'transcript'; op: 'events'; paneId: string; phase: string; events: unknown[] }
  | { ch: 'transcript'; op: 'title'; paneId: string; title: string }
  /** Could not tail: no runner here, no session yet, or not ours. Distinct
   *  from "no events" so the server renders a reason, not an empty chat. */
  | { ch: 'transcript'; op: 'unavailable'; paneId: string; reason: string }
  /** A runner frame from this machine — hello, turn-start, stream, turn-done,
   *  question, status, title, subagent, notify. */
  | { ch: 'runner'; op: 'frame'; paneId: string; frame: unknown }
  /** That pane's runner connected here / went away, so the server can
   *  register and tear down exactly as it does for a local runner. */
  | { ch: 'runner'; op: 'attached'; paneId: string }
  | { ch: 'runner'; op: 'detached'; paneId: string }
  /**
   * One file's bytes, base64, in order. `last` closes that file.
   *
   * `rel` is relative to the fetched path — empty for a single file, which is
   * what tells the server it is publishing a file rather than a directory.
   */
  | {
      ch: 'files';
      op: 'chunk';
      id: string;
      rel: string;
      b64: string;
      last: boolean;
    }
  /** Every file sent. `name` is the basename, so the published artifact keeps
   *  the filename the user named rather than a staging id. */
  | { ch: 'files'; op: 'done'; id: string; kind: 'file' | 'dir'; name: string }
  /** No such path, too big, not readable — said rather than left to time out. */
  | { ch: 'files'; op: 'error'; id: string; reason: string }
  /**
   * What this host's archive found. `hits` carries the same shape the local
   * search route returns, so the server can merge the two lists without a
   * translation layer that would have to be kept in step.
   */
  | {
      ch: 'search';
      op: 'hits';
      id: string;
      hits: unknown[];
      fallback: boolean;
    }
  /** No archive here, or the query blew up. Distinct from "no hits", which is
   *  an answer. */
  | { ch: 'search'; op: 'error'; id: string; reason: string }
  /**
   * One in-pane CLI call, for the server to answer.
   *
   * NOT "the server's API". The server routes these through a small allowlist
   * (host-api.ts) whose principal is the LINK, not a header — a host names a
   * path and a body and nothing else, and every id in that path must belong to
   * a pane on that host. The trust review's finding was that handing a host
   * `app.fetch` is code execution on this machine in one request, via
   * `startup_cmd` on `POST /api/tabs/:id/panes` alone.
   */
  | {
      ch: 'api';
      op: 'request';
      id: string;
      method: string;
      path: string;
      body?: string;
    };

export function encodeLink(m: LinkDown | LinkUp): string {
  return JSON.stringify(m);
}

/**
 * Parse, and reject anything that is not a well-formed envelope.
 *
 * Returns null rather than throwing: this runs on every message from a peer
 * that may be compromised, and a parse failure must close a message, never
 * the process.
 */
export function decodeLink(raw: string): (LinkDown | LinkUp) | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const ch = (v as { ch?: unknown }).ch;
  if (ch !== 'ptyd' && ch !== 'transcript' && ch !== 'runner' && ch !== 'api' && ch !== 'files')
    return null;
  return v as LinkDown | LinkUp;
}

/**
 * May the HOST send this message?
 *
 * The host may not drive pane lifecycle or ask the server to adopt things it
 * has not been offered — those are server→host directions. A host message on
 * a down-only op is a protocol violation, not a mistake to tolerate: the
 * trust review's point was that authority must not flow the wrong way up a
 * link just because the socket is bidirectional.
 */
export function hostMaySend(m: LinkDown | LinkUp): boolean {
  if (m.ch === 'ptyd') return true; // replies and ptyd's own pushes
  if (m.ch === 'transcript') return m.op === 'events' || m.op === 'title' || m.op === 'unavailable';
  if (m.ch === 'api') return m.op === 'request';
  // A host may ANSWER a fetch and never start one: `fetch` is the server
  // naming a path, and a host that could send one would be asking this machine
  // to read its own disk on the host's behalf.
  if (m.ch === 'files') return m.op === 'chunk' || m.op === 'done' || m.op === 'error';
  // Same rule as `files`: a host answers a query, it does not ask one. A host
  // that could send `query` would be asking the server to search ITS archive
  // — the direction the host-scoping rule exists to prevent.
  if (m.ch === 'search') return m.op === 'hits' || m.op === 'error';
  return m.op === 'frame' || m.op === 'attached' || m.op === 'detached';
}
