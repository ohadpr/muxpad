import type { LayoutNode, PaneSpec, Tab, Workspace } from '@muxpad/shared';

/** The one JSON fetch wrapper — exported so feature libs (push, …) don't
 *  grow divergent copies of the same content-type/error/204 handling. */
export async function req<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface TabWithPanes extends Tab {
  panes: PaneSpec[];
}

export interface MovePaneResult {
  pane: PaneSpec | null;
  from_tab_id: string;
  /** Source workspace — may differ from the destination's (cross-ws moves). */
  from_workspace_id?: string;
  to_tab: Tab;
  /** True if the source tab was deleted because the pane was its last one. */
  from_tab_removed: boolean;
}

export const api = {
  // ── CEO (the pinned singleton agent pane) ──────────────────────────────

  /** Resolve (ensuring, server-side) the singleton CEO pane's ids + the
   *  workspace/tab slugs that route to it. */
  getCeo: () =>
    req<{ pane_id: string; tab_id: string; workspace_slug: string; tab_slug: string }>('/api/ceo'),

  /** One pane, decorated (title/attention/busy/…) + isRunning. */
  getPane: (id: string) =>
    req<PaneSpec & { isRunning: boolean }>(`/api/panes/${encodeURIComponent(id)}`),

  // ── Workspaces (the new top-level concept) ─────────────────────────────

  /** `all: true` includes hidden system workspaces (e.g. the CEO's) — the
   *  caller is responsible for keeping them out of user-facing lists. */
  listWorkspaces: (opts?: { all?: boolean }) =>
    req<Workspace[]>(`/api/workspaces${opts?.all ? '?all=1' : ''}`),

  createWorkspace: (name?: string) =>
    req<Workspace>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
    }),

  getWorkspace: (id: string) => req<Workspace>(`/api/workspaces/${id}`),

  patchWorkspace: (id: string, patch: { name?: string; slug?: string }) =>
    req<Workspace>(`/api/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteWorkspace: (id: string) => req<void>(`/api/workspaces/${id}`, { method: 'DELETE' }),

  reorderWorkspaces: (ids: string[]) =>
    req<void>('/api/workspaces/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // ── Tabs (per-workspace, what was historically called "workspaces") ───

  listTabs: (workspaceId: string) =>
    req<Tab[]>(`/api/tabs?workspaceId=${encodeURIComponent(workspaceId)}`),

  createTab: (
    workspaceId: string,
    body: {
      name?: string;
      layout?: LayoutNode;
      // Atomic tab-with-pane creation (the tabs-first default): 'shell' =
      // full-size terminal, 'agent' = a chat-native agent session.
      bootstrap?: 'shell' | 'agent';
      cwd?: string;
      // Which agent backend an 'agent' bootstrap runs. 'pick' creates it pending
      // (harness chosen in the chat page); default claude.
      backend?: 'claude' | 'codex' | 'cursor' | 'pick';
    } = {},
  ) =>
    req<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    }),

  getTab: (id: string) => req<TabWithPanes>(`/api/tabs/${id}`),

  patchTab: (
    id: string,
    patch: {
      name?: string;
      slug?: string;
      icon?: string;
      layout?: LayoutNode;
      view_mode?: 'split' | 'tabbed';
    },
  ) =>
    req<Tab>(`/api/tabs/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteTab: (id: string) => req<void>(`/api/tabs/${id}`, { method: 'DELETE' }),

  markTabSeen: (id: string) => req<void>(`/api/tabs/${id}/seen`, { method: 'POST' }),

  // Manually flag a tab unread — restores its attention dot until viewed.
  markTabUnread: (id: string) => req<void>(`/api/tabs/${id}/unread`, { method: 'POST' }),

  // Surgical "I'm looking at this one pane right now" used by mobile.
  // Keeps other panes' attention flags alive so the pane dropdown can
  // surface them.
  markPaneSeen: (id: string) => req<void>(`/api/panes/${id}/seen`, { method: 'POST' }),

  reorderTabs: (ids: string[]) =>
    req<void>('/api/tabs/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // ── Panes ──────────────────────────────────────────────────────────────

  createPane: (
    tabId: string,
    body: {
      kind?: 'shell' | 'url';
      url?: string;
      shell?: string;
      startup_cmd?: string | null;
      cwd?: string;
      env?: Record<string, string> | null;
      inherit_cwd_from?: string;
      face?: 'terminal' | 'web' | 'chat';
      /** Server places the pane atomically (root append) — for callers
       *  without a local layout to patch (CLI, the nav sheet). */
      append_to_layout?: boolean;
    } = {},
  ) =>
    req<PaneSpec>(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deletePane: (id: string) => req<void>(`/api/panes/${id}`, { method: 'DELETE' }),

  /** Choose the harness for a pending ('muxpad agent --pick') agent pane —
   *  sets the backend + respawns the runner. */
  setAgentBackend: (paneId: string, backend: 'claude' | 'codex' | 'cursor') =>
    req<void>(`/api/panes/${paneId}/agent-backend`, {
      method: 'POST',
      body: JSON.stringify({ backend }),
    }),

  /** Convert a pending harness-pick pane into a plain terminal. */
  convertPickToTerminal: (paneId: string) =>
    req<void>(`/api/panes/${paneId}/as-terminal`, { method: 'POST' }),

  /** Convert a pending harness-pick pane into a blank URL pane (URL chrome focused). */
  convertPickToWeb: (paneId: string) =>
    req<void>(`/api/panes/${paneId}/as-web`, { method: 'POST' }),

  /** Change a pane's working directory and respawn it there. */
  setPaneCwd: (paneId: string, cwd: string) =>
    req<void>(`/api/panes/${paneId}/cwd`, { method: 'POST', body: JSON.stringify({ cwd }) }),

  // Move a pane to another tab (any workspace). `toTabId` targets an
  // existing tab; `newTab` extracts it into a fresh tab. The PTY keeps
  // running — only the pane's parent tab + both tabs' layouts change.
  movePane: (id: string, dest: { toTabId?: string; newTab?: boolean }) =>
    req<MovePaneResult>(`/api/panes/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ to_tab_id: dest.toTabId, new_tab: dest.newTab }),
    }),

  // Merge a whole tab into another: every pane moves over (keeping strip
  // order), the emptied source tab is deleted. Panes keep running.
  mergeTab: (id: string, intoTabId: string) =>
    req<{ to_tab: Tab; from_tab_id: string; moved_pane_ids: string[] }>(`/api/tabs/${id}/merge`, {
      method: 'POST',
      body: JSON.stringify({ into_tab_id: intoTabId }),
    }),

  // Move a whole tab (and its panes) to a different workspace.
  moveTabToWorkspace: (id: string, workspaceId: string) =>
    req<Tab>(`/api/tabs/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  patchPane: (
    id: string,
    patch: {
      kind?: 'shell' | 'url';
      url?: string | null;
      name?: string | null;
      face?: 'terminal' | 'web' | 'chat';
      face_url?: string | null;
    },
  ) =>
    req<PaneSpec>(`/api/panes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  respawnPane: (id: string) => req<void>(`/api/panes/${id}/respawn`, { method: 'POST' }),

  /** Summarize an agent pane's conversation to its deliverable (document
   *  surface's collapse-to-summary). Best-effort — returns empty strings if the
   *  transcript/session isn't available yet. */
  summarizePane: (paneId: string) =>
    req<{ summary: string; title: string; artifacts: string[] }>(`/api/panes/${paneId}/summarize`, {
      method: 'POST',
    }),

  uploadAttachment: async (paneId: string, blob: Blob, name: string): Promise<{ path: string }> => {
    const fd = new FormData();
    fd.append('file', blob, name);
    const res = await fetch(`/api/panes/${paneId}/attachments`, {
      method: 'POST',
      body: fd,
    });
    if (!res.ok) throw new Error(await res.text());
    return (await res.json()) as { path: string };
  },
};
