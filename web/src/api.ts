import type { LayoutNode, PaneSpec, Tab, Workspace } from '@muxpad/shared';

async function req<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
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
  to_tab: Tab;
  /** True if the source tab was deleted because the pane was its last one. */
  from_tab_removed: boolean;
}

export const api = {
  // ── Workspaces (the new top-level concept) ─────────────────────────────

  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),

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

  createTab: (workspaceId: string, body: { name?: string; layout?: LayoutNode } = {}) =>
    req<Tab>('/api/tabs', {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId, ...body }),
    }),

  getTab: (id: string) => req<TabWithPanes>(`/api/tabs/${id}`),

  patchTab: (
    id: string,
    patch: { name?: string; slug?: string; icon?: string; layout?: LayoutNode },
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
    } = {},
  ) =>
    req<PaneSpec>(`/api/tabs/${tabId}/panes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deletePane: (id: string) => req<void>(`/api/panes/${id}`, { method: 'DELETE' }),

  // Move a pane to another tab in the same workspace. `toTabId` targets an
  // existing tab; `newTab` extracts it into a fresh tab. The PTY keeps
  // running — only the pane's parent tab + both tabs' layouts change.
  movePane: (id: string, dest: { toTabId?: string; newTab?: boolean }) =>
    req<MovePaneResult>(`/api/panes/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ to_tab_id: dest.toTabId, new_tab: dest.newTab }),
    }),

  // Move a whole tab (and its panes) to a different workspace.
  moveTabToWorkspace: (id: string, workspaceId: string) =>
    req<Tab>(`/api/tabs/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({ workspace_id: workspaceId }),
    }),

  patchPane: (id: string, patch: { kind?: 'shell' | 'url'; url?: string | null }) =>
    req<PaneSpec>(`/api/panes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  respawnPane: (id: string) => req<void>(`/api/panes/${id}/respawn`, { method: 'POST' }),

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
