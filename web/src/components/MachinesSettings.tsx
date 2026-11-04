import type { Workspace } from '@muxpad/shared';
import { useCallback, useEffect, useState } from 'react';
import { api, req } from '../api';

/**
 * SETTINGS → MACHINES.
 *
 * ── NO PAIRING HERE, AND THAT IS NOT LAZINESS ────────────────────────────
 * There is no "add a machine" button. Adding one is a PAIRING flow — this
 * machine mints a credential, you run one line on the other box, and the token
 * has to land on disk at 0600 on both sides — which a settings dialog cannot
 * honestly do.
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
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

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

  if (failed) return <p className="machines-note">Could not read the machine list.</p>;
  if (!nodes) return <p className="machines-note">Loading…</p>;

  return (
    <div className="machines">
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
            <span>
              {n.panes} {n.panes === 1 ? 'pane' : 'panes'}
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
              No token for this machine on this one. Run <code>muxpad-node --init</code> there and
              put the value it prints in <code>~/.muxpad/node-tokens/{n.id}</code> here.
            </p>
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
      <p className="machines-note">
        Machines are paired from the command line — the credential has to be written to disk on both
        sides, which a dialog cannot do honestly. This view is for seeing what muxpad has and
        whether it can reach it.
      </p>
    </div>
  );
}
