import type Database from 'better-sqlite3';

/**
 * MACHINES muxpad can run a pane on.
 *
 * ── WHY A STORE AND NOT A COLUMN LOOKUP ───────────────────────────────────
 * "Which machine is this pane on" is about to be asked from the pane runtime,
 * the ptyd client, the rail, the spawn path and the chat binder. The answer
 * must come from ONE place: the whole failure mode of a multi-machine cockpit
 * is two call sites disagreeing about where something lives and quietly
 * acting on different machines.
 *
 * ── `local` IS A ROW ──────────────────────────────────────────────────────
 * Seeded by migration 49 and not removable. The alternative — a nullable
 * `node_id` meaning "here" — gives every caller two spellings of the same
 * fact and a branch to forget. One kind of node, always resolvable.
 *
 * ── STATE IS THE LINK, NOT THE MACHINE ────────────────────────────────────
 * A node can be powered on, healthy and still `down` to us, because what is
 * being reported is whether WE hold a connection to it. And a stored `up` is
 * never believed on boot: it describes a socket that cannot have survived the
 * process. {@link resetLinkStates} runs at startup for exactly that reason —
 * it is the difference between "I have not checked" and "I checked and it is
 * there", which is the one distinction a rail badge must not get wrong.
 */

export const LOCAL_NODE_ID = 'local';

/** What a link can be. `unauthorized` is deliberately distinct from `down`:
 *  a node that refuses our credential is a configuration problem the user has
 *  to act on, and rendering it as merely offline hides that. */
export type NodeState = 'unknown' | 'up' | 'down' | 'unauthorized';

export interface NodeRow {
  id: string;
  name: string;
  /** `wss://…` for a remote node; null for `local`, which needs no link. */
  endpoint: string | null;
  /** The node's public key, pinned at pairing. Null until paired. */
  pubkey: string | null;
  state: NodeState;
  last_seen: number | null;
  /** JSON: os, arch, cpus, memory — whatever the agent reported. */
  capabilities: string | null;
  created_at: number;
}

const STATES: readonly NodeState[] = ['unknown', 'up', 'down', 'unauthorized'];

function toRow(r: Record<string, unknown>): NodeRow {
  const raw = String(r.state ?? 'unknown') as NodeState;
  return {
    id: String(r.id),
    name: String(r.name),
    endpoint: (r.endpoint as string | null) ?? null,
    pubkey: (r.pubkey as string | null) ?? null,
    // An unrecognised state is 'unknown', never a crash and never passed
    // through: this value reaches a UI badge, and a row that renders as
    // garbage is worse than one that renders as "I have not checked".
    state: STATES.includes(raw) ? raw : 'unknown',
    last_seen: (r.last_seen as number | null) ?? null,
    capabilities: (r.capabilities as string | null) ?? null,
    created_at: Number(r.created_at ?? 0),
  };
}

export class NodeStore {
  constructor(private readonly db: Database.Database) {}

  list(): NodeRow[] {
    return (
      this.db
        .prepare('SELECT * FROM nodes ORDER BY (id = ?) DESC, name')
        .all(LOCAL_NODE_ID) as Array<Record<string, unknown>>
    ).map(toRow);
    // `local` first, then by name: the machine you are on is the one you look
    // for least and should still be at a predictable place in the list.
  }

  get(id: string): NodeRow | null {
    const r = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return r ? toRow(r) : null;
  }

  /** Is there more than one machine? The rail's node badge hangs off this, so
   *  an install that never adds one looks exactly as it does today. */
  isMultiNode(): boolean {
    const r = this.db.prepare('SELECT COUNT(*) AS n FROM nodes').get() as { n: number };
    return r.n > 1;
  }

  add(input: {
    id: string;
    name: string;
    endpoint: string;
    pubkey?: string | null;
    at?: number;
  }): NodeRow {
    this.db
      .prepare(
        `INSERT INTO nodes (id, name, endpoint, pubkey, state, created_at)
         VALUES (?, ?, ?, ?, 'unknown', ?)`,
      )
      .run(input.id, input.name, input.endpoint, input.pubkey ?? null, input.at ?? Date.now());
    return this.get(input.id) as NodeRow;
  }

  /**
   * Rename a machine, or point it at a new address.
   *
   * Re-pointing resets `state` to `unknown` and clears `capabilities`: both
   * described whatever answered at the OLD address, and carrying them over
   * would show a reachable Linux box at an endpoint nothing has dialled yet.
   */
  update(id: string, patch: { name?: string; endpoint?: string }): void {
    if (patch.name !== undefined)
      this.db.prepare('UPDATE nodes SET name = ? WHERE id = ?').run(patch.name, id);
    if (patch.endpoint !== undefined)
      this.db
        .prepare(
          "UPDATE nodes SET endpoint = ?, state = 'unknown', capabilities = NULL WHERE id = ?",
        )
        .run(patch.endpoint, id);
  }

  /**
   * Report what a link now knows. `last_seen` moves only on `up`, because its
   * job is "when did this machine last actually answer" — stamping it on a
   * failed attempt would make a node that has been unreachable for a week
   * look like it replied a second ago.
   */
  setState(id: string, state: NodeState, at: number = Date.now()): void {
    if (state === 'up') {
      this.db.prepare('UPDATE nodes SET state = ?, last_seen = ? WHERE id = ?').run(state, at, id);
      return;
    }
    this.db.prepare('UPDATE nodes SET state = ? WHERE id = ?').run(state, id);
  }

  /**
   * The login shell on a node, as that node reported it.
   *
   * `null` when the node has not described itself yet (or is this machine,
   * which has no link to ask). The CALLER decides what to do with that — a
   * pane created before the first `/self` lands must not get an invented
   * path, because the whole bug this exists for was a path from the wrong
   * machine.
   */
  shellFor(id: string): string | null {
    return this.capability(id, 'shell');
  }

  /**
   * A node's home directory, as that node reported it.
   *
   * What "this pane has no recorded cwd" has to mean on another machine. The
   * server's own answer is `/Users/…`, which on a Linux host is a path that
   * does not exist — and a pty spawned into one dies instantly.
   */
  homeFor(id: string): string | null {
    return this.capability(id, 'home');
  }

  /**
   * One absolute-path capability, or null.
   *
   * Absolute only: a relative or empty value would be resolved against
   * whatever cwd ptyd happens to have, which is not a choice anyone made.
   */
  private capability(id: string, key: 'shell' | 'home'): string | null {
    if (id === LOCAL_NODE_ID) return null;
    const raw = this.get(id)?.capabilities;
    if (!raw) return null;
    try {
      const c = JSON.parse(raw) as Record<string, unknown>;
      const v = c[key];
      return typeof v === 'string' && v.startsWith('/') ? v : null;
    } catch {
      return null;
    }
  }

  setCapabilities(id: string, capabilities: unknown): void {
    this.db
      .prepare('UPDATE nodes SET capabilities = ? WHERE id = ?')
      .run(JSON.stringify(capabilities), id);
  }

  /** Forget a node. `local` is refused — it is this machine, and a cockpit
   *  cannot be configured out of existence. Returns false if nothing went. */
  remove(id: string): boolean {
    if (id === LOCAL_NODE_ID) return false;
    return this.db.prepare('DELETE FROM nodes WHERE id = ?').run(id).changes > 0;
  }

  /**
   * At startup, no link exists yet — so no node is `up` except `local`, whose
   * "link" is a unix socket on this machine.
   *
   * Without this, a row that was `up` when the process died comes back up
   * claiming a connection that does not exist, and the rail shows a machine as
   * reachable until something tries to use it and fails. `unknown` is the
   * honest value and the UI has a distinct, quieter rendering for it.
   */
  resetLinkStates(): void {
    this.db.prepare("UPDATE nodes SET state = 'unknown' WHERE id <> ?").run(LOCAL_NODE_ID);
    this.db.prepare("UPDATE nodes SET state = 'up' WHERE id = ?").run(LOCAL_NODE_ID);
  }

  /**
   * Where should a NEW chat in this workspace be created?
   *
   * Falls back to `local` when the workspace names no default, AND when it
   * names one that no longer exists — a node removed out from under a
   * workspace must not make "new chat" fail, it must make it land here.
   */
  defaultNodeFor(workspaceId: string): string {
    const r = this.db
      .prepare('SELECT default_node_id AS d FROM workspaces WHERE id = ?')
      .get(workspaceId) as { d: string | null } | undefined;
    const wanted = r?.d ?? null;
    if (!wanted) return LOCAL_NODE_ID;
    return this.get(wanted) ? wanted : LOCAL_NODE_ID;
  }

  setDefaultNodeFor(workspaceId: string, nodeId: string | null): void {
    this.db
      .prepare('UPDATE workspaces SET default_node_id = ? WHERE id = ?')
      .run(nodeId, workspaceId);
  }

  /** Which machine owns this pane's pty. Unknown pane → `local`, which is the
   *  pre-migration meaning and keeps every caller from needing a null branch. */
  nodeForPane(paneId: string): string {
    const r = this.db.prepare('SELECT node_id AS n FROM panes WHERE id = ?').get(paneId) as
      | { n: string | null }
      | undefined;
    return r?.n ?? LOCAL_NODE_ID;
  }

  /**
   * A pane's cwd as RECORDED, with no local filesystem check.
   *
   * For a remote pane this is the only trustworthy copy: every spec-building
   * site runs the path through `safeCwd`, which stats it HERE and substitutes
   * this machine's home when it is absent — turning a perfectly good
   * /home/ohad/work into /Users/ohadpr and killing the pty on arrival.
   */
  cwdForPane(paneId: string): string | null {
    const r = this.db.prepare('SELECT cwd FROM panes WHERE id = ?').get(paneId) as
      | { cwd: string | null }
      | undefined;
    return r?.cwd ?? null;
  }

  /** How many panes live on each node — for Settings → Machines, and for
   *  refusing to remove a node that still owns chats. */
  paneCounts(): Map<string, number> {
    const rows = this.db
      .prepare('SELECT node_id AS id, COUNT(*) AS n FROM panes GROUP BY node_id')
      .all() as Array<{ id: string | null; n: number }>;
    return new Map(rows.map((r) => [r.id ?? LOCAL_NODE_ID, r.n]));
  }
}
