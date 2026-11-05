import type { Workspace } from '@muxpad/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, req } from '../api';

/**
 * SETTINGS → MACHINES.
 *
 * ── PAIRING IS HALF A DIALOG, AND IT SAYS SO ─────────────────────────────
 * It used to say a dialog could not do this honestly, which was right about
 * the OLD shape: the token had to be written on both machines by hand. This
 * machine's half is now automatic — `POST /api/nodes` mints the credential and
 * writes it 0600 here — so what is left for a person is the other half, one
 * line on the other box. That is what the form hands back, and it does not
 * pretend to have finished.
 *
 * There IS a default-host picker now, which there deliberately was not: it was
 * held back until a chat on another machine actually worked end to end, on the
 * grounds that a control which silently kept creating panes here would be
 * worse than no control. It works, so the picker is the thing that makes more
 * than one machine usable rather than a toggle you forget — Trayo work opens
 * on the Trayo VM because its workspace says so.
 *
 * So this exists to answer the question you actually have at 2am: WHICH
 * MACHINES DOES MUXPAD THINK IT HAS, AND CAN IT REACH THEM.
 *
 * ── THE FOUR STATES ARE NOT THREE ────────────────────────────────────────
 * `unauthorized` is kept distinct from `down` because it is a configuration
 * problem you have to act on — a machine that is running fine and simply has
 * no token here. Rendering it as merely offline hides that there is something
 * to do, and you would spend the morning restarting a healthy VM.
 *
 * `unknown` means "I have not checked yet", which is the honest state right
 * after a restart: a stored `up` describes a socket that cannot have survived
 * the process.
 */

/** What `POST /api/nodes` hands back. The token appears HERE and in no GET. */
interface Paired {
  node: NodeRow;
  token: string;
  install: string;
}

interface NodeRow {
  id: string;
  name: string;
  endpoint: string | null;
  state: 'unknown' | 'up' | 'down' | 'unauthorized';
  last_seen: number | null;
  capabilities: { platform?: string; arch?: string; cpus?: number; memoryGb?: number } | null;
  panes: number;
}

/** The id of the machine the server runs on. Mirrors LOCAL_NODE_ID. */
const LOCAL = 'local';

const LABEL: Record<NodeRow['state'], string> = {
  up: 'reachable',
  down: 'not reachable',
  unauthorized: 'needs a token',
  unknown: 'not checked yet',
};

/**
 * The sentence to show for a failed write.
 *
 * `ApiError` carries the server's own message, and these are the messages
 * worth reading verbatim — "1 pane still live on that machine" is the whole
 * answer, and a generic "could not remove" would send someone to the logs for
 * something the server already said.
 */
function messageOf(e: unknown): string {
  const m = (e as { message?: unknown } | null)?.message;
  return typeof m === 'string' && m.trim() ? m : 'That did not work.';
}

function ago(at: number | null): string {
  if (!at) return 'never';
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function MachinesSettings() {
  const [nodes, setNodes] = useState<NodeRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ id: '', name: '', endpoint: '' });
  const [paired, setPaired] = useState<Paired | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  /** Re-read the machine list. Shared by the poll and by every write. */
  const refresh = useCallback(async () => {
    const r = await req<{ nodes?: NodeRow[] }>('/api/nodes');
    setNodes(r?.nodes ?? []);
    setFailed(false);
  }, []);

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspaces(await api.listWorkspaces());
    } catch {
      // The machine list is the point of this panel; losing the workspace
      // list hides the picker rather than breaking the view.
      setWorkspaces([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const r = await req<{ nodes?: NodeRow[] }>('/api/nodes');
        if (alive) {
          setNodes(r?.nodes ?? []);
          setFailed(false);
        }
      } catch {
        // A settings panel must not be the reason the dialog looks broken.
        if (alive) setFailed(true);
      }
    };
    void load();
    void loadWorkspaces();
    // Link state changes on its own (a VM sleeps, a link drops), so this is
    // the one settings panel that is worth polling — slowly.
    const t = setInterval(load, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [loadWorkspaces]);

  /**
   * Point a workspace at a machine.
   *
   * Optimistic, and it has to be: the select is the only feedback, so waiting
   * for the round trip leaves the old value under the cursor and reads as a
   * control that did not take. A failure puts it back and says so.
   */
  const setDefaultHost = async (w: Workspace, nodeId: string) => {
    const next = nodeId === LOCAL ? null : nodeId;
    const before = w.default_node_id ?? null;
    if (next === before) return;
    setWorkspaces((ws) =>
      (ws ?? []).map((x) => (x.id === w.id ? { ...x, default_node_id: next } : x)),
    );
    setSaving(w.id);
    try {
      await api.patchWorkspace(w.id, { default_node_id: next });
    } catch {
      setWorkspaces((ws) =>
        (ws ?? []).map((x) => (x.id === w.id ? { ...x, default_node_id: before } : x)),
      );
      setFailed(true);
    } finally {
      setSaving(null);
    }
  };

  /**
   * Pair a machine. The token comes back in THIS response and nowhere else,
   * so it is held in state until the panel is dismissed — a reload loses it,
   * which is correct: it is on disk here, and the only thing a person needs it
   * for is typing it over there.
   */
  const pair = async () => {
    setBusy(true);
    setPairError(null);
    try {
      const res = await req<Paired>('/api/nodes', {
        method: 'POST',
        body: JSON.stringify({
          id: draft.id.trim(),
          endpoint: draft.endpoint.trim(),
          ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
        }),
      });
      setPaired(res);
      setDraft({ id: '', name: '', endpoint: '' });
      setAdding(false);
      await refresh();
    } catch (e) {
      setPairError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  /**
   * Forget a machine.
   *
   * The 409 for "it still holds panes" is SHOWN rather than retried with
   * force: dropping the row under a live pane is how a chat silently moves to
   * the wrong computer, and a confirm here would be a button that removes
   * conversations. Forcing it is a command-line act.
   */
  const forget = async (n: NodeRow) => {
    setBusy(true);
    setPairError(null);
    try {
      await req<void>(`/api/nodes/${encodeURIComponent(n.id)}`, { method: 'DELETE' });
      await refresh();
      await loadWorkspaces();
    } catch (e) {
      setPairError(messageOf(e));
    } finally {
      setBusy(false);
    }
  };

  if (failed && !nodes) return <p className="machines-note">Could not read the machine list.</p>;
  if (!nodes) return <p className="machines-note">Loading…</p>;

  return (
    <div className="machines">
      {pairError ? <p className="machine-note machines-error">{pairError}</p> : null}
      {/* ── THE OTHER HALF OF PAIRING ──────────────────────────────────────
          Shown until dismissed, because it is the only place this token ever
          appears and it has to be typed on another computer. */}
      {paired ? (
        <div className="machine machine-paired">
          <div className="machine-head">
            <span className="machine-name">Now run this on {paired.node.name}</span>
          </div>
          <pre className="machine-install">{paired.install}</pre>
          <p className="machine-note">
            That machine needs the muxpad repo and a build first — <code>muxpad-node</code> ships
            with the server package. This one will dial it as soon as it is listening, and the row
            above goes green.
          </p>
          <button type="button" className="machine-btn" onClick={() => setPaired(null)}>
            Done
          </button>
        </div>
      ) : null}
      {nodes.map((n) => (
        <div className="machine" key={n.id} data-state={n.state}>
          <div className="machine-head">
            <span className="machine-dot" aria-hidden="true" />
            <span className="machine-name">{n.name}</span>
            <span className="machine-state">{LABEL[n.state]}</span>
          </div>
          <div className="machine-meta">
            {/* The endpoint is the useful fact for a remote one and noise for
                this machine, which has no link — its ptyd is a unix socket. */}
            {n.endpoint ? <span>{n.endpoint}</span> : <span>this machine</span>}
            {/* "chats", not "panes". A pane is the thing that holds one
                process and it is the right word in the code; on a settings
                row it is jargon for the number somebody actually wants, which
                is how much is running over there. */}
            <span>
              {n.panes} {n.panes === 1 ? 'chat' : 'chats'}
            </span>
            {n.capabilities?.platform ? (
              <span>
                {n.capabilities.platform}/{n.capabilities.arch}
                {n.capabilities.cpus ? ` · ${n.capabilities.cpus} cpu` : ''}
                {n.capabilities.memoryGb ? ` · ${n.capabilities.memoryGb}GB` : ''}
              </span>
            ) : null}
            {n.endpoint ? <span>seen {ago(n.last_seen)}</span> : null}
          </div>
          {n.state === 'unauthorized' ? (
            <p className="machine-note">
              No credential for this machine here. Remove it and pair it again — that mints a fresh
              token and prints the one line to run over there.
            </p>
          ) : null}
          {/* `local` has no remove: it is this machine, and a cockpit cannot
              be configured out of existence. */}
          {n.endpoint ? (
            <button
              type="button"
              className="machine-btn machine-forget"
              disabled={busy}
              onClick={() => void forget(n)}
            >
              Forget this machine
            </button>
          ) : null}
        </div>
      ))}
      {/* ── WHERE NEW CHATS GO ──────────────────────────────────────────────
          Hidden entirely on a one-machine install: a picker with a single
          option is a question with one answer, and this panel's job on that
          machine is to say "there is one of me". */}
      {nodes.length > 1 && workspaces && workspaces.length > 0 ? (
        <div className="machines-default-hosts">
          <h4 className="machines-subhead">Where new chats go</h4>
          {workspaces.map((w) => (
            <label className="machine-default-host" key={w.id}>
              <span className="machine-default-host-name">{w.name}</span>
              <select
                value={w.default_node_id ?? LOCAL}
                disabled={saving === w.id}
                onChange={(e) => void setDefaultHost(w, e.currentTarget.value)}
              >
                {nodes.map((n) => (
                  <option value={n.id} key={n.id}>
                    {n.name}
                    {n.state === 'up' || !n.endpoint ? '' : ` (${LABEL[n.state]})`}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="machines-note">
            A chat opens on its workspace's machine. A machine that has gone away falls back to this
            one rather than failing to open a chat.
          </p>
        </div>
      ) : null}
      {adding ? (
        <div className="machine machine-add">
          <div className="machine-head">
            <span className="machine-name">Pair a machine</span>
          </div>
          <label className="machine-field">
            <span>Id</span>
            <input
              value={draft.id}
              placeholder="trayo"
              onChange={(e) => setDraft((d) => ({ ...d, id: e.currentTarget.value }))}
            />
          </label>
          <label className="machine-field">
            <span>Name</span>
            <input
              value={draft.name}
              placeholder="Trayo dev VM"
              onChange={(e) => setDraft((d) => ({ ...d, name: e.currentTarget.value }))}
            />
          </label>
          <label className="machine-field">
            <span>Address</span>
            <input
              value={draft.endpoint}
              placeholder="ws://host.your-tailnet.ts.net:7797"
              onChange={(e) => setDraft((d) => ({ ...d, endpoint: e.currentTarget.value }))}
            />
          </label>
          <div className="machine-actions">
            <button
              type="button"
              className="machine-btn"
              disabled={busy || !draft.id.trim() || !draft.endpoint.trim()}
              onClick={() => void pair()}
            >
              {busy ? 'Pairing…' : 'Pair'}
            </button>
            <button type="button" className="machine-btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
          <p className="machine-note">
            This machine mints the credential and dials out; the other one only ever listens. The id
            is also its token's filename, so lowercase letters, digits, <code>-</code> and{' '}
            <code>_</code>.
          </p>
        </div>
      ) : (
        <button type="button" className="machine-btn" onClick={() => setAdding(true)}>
          + Pair a machine
        </button>
      )}
      <p className="machines-note">
        This machine issues the credential and the other is installed with it — that order is the
        point, not a convenience: the opposite one leaves an unauthenticated listener on the network
        for however long it takes you to finish.
      </p>
    </div>
  );
}
