import type { Workspace, PaneSpec, LayoutNode } from '@muxpad/shared';

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

export interface WorkspaceWithPanes extends Workspace {
  panes: PaneSpec[];
}

export const api = {
  listWorkspaces: () => req<Workspace[]>('/api/workspaces'),

  createWorkspace: (name?: string) =>
    req<Workspace>('/api/workspaces', {
      method: 'POST',
      body: JSON.stringify(name ? { name } : {}),
    }),

  getWorkspace: (id: string) => req<WorkspaceWithPanes>(`/api/workspaces/${id}`),

  patchWorkspace: (
    id: string,
    patch: { name?: string; slug?: string; layout?: LayoutNode },
  ) =>
    req<Workspace>(`/api/workspaces/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  deleteWorkspace: (id: string) =>
    req<void>(`/api/workspaces/${id}`, { method: 'DELETE' }),

  markWorkspaceSeen: (id: string) =>
    req<void>(`/api/workspaces/${id}/seen`, { method: 'POST' }),

  reorderWorkspaces: (ids: string[]) =>
    req<void>('/api/workspaces/reorder', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  createPane: (
    workspaceId: string,
    body: {
      shell?: string;
      startup_cmd?: string | null;
      cwd?: string;
      env?: Record<string, string> | null;
      inherit_cwd_from?: string;
    } = {},
  ) =>
    req<PaneSpec>(`/api/workspaces/${workspaceId}/panes`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deletePane: (id: string) => req<void>(`/api/panes/${id}`, { method: 'DELETE' }),

  respawnPane: (id: string) =>
    req<void>(`/api/panes/${id}/respawn`, { method: 'POST' }),

  uploadAttachment: async (
    paneId: string,
    blob: Blob,
    name: string,
  ): Promise<{ path: string }> => {
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
