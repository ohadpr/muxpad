import type { AgentMode, LayoutNode, PaneSpec, Tab, UrlHealth, Workspace } from '@muxpad/shared';

/**
 * Turn a failed response into something a human can read.
 *
 * The API answers errors as `{error:{code,message}}`, and the old wrapper
 * threw the raw body — so a refused action surfaced in the UI as literal
 * `409 {"error":{"code":"conflict","message":"…"}}`. Pull the message out
 * when the envelope is there; fall back to the status for anything else
 * (HTML error pages, proxies, an empty body).
 */
async function errorEnvelope(res: Response): Promise<{ message: string; code: string | null }> {
  const text = await res.text().catch(() => '');
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown; code?: unknown } };
    const m = body?.error?.message;
    const code = typeof body?.error?.code === 'string' ? body.error.code : null;
    if (typeof m === 'string' && m.trim()) return { message: m, code };
  } catch {
    // not our envelope — fall through
  }
  return {
    message: text.trim() ? `${res.status} ${text.slice(0, 200)}` : `request failed (${res.status})`,
    code: null,
  };
}

/**
 * A non-2xx response, carrying the STATUS alongside the human message.
 *
 * Callers used to get a bare Error and could only string-match, so a refusal
 * that means something specific (409 "this chat already has messages") was
 * indistinguishable from a generic failure and the UI couldn't act on the
 * server's answer. Still an Error, so every existing `e instanceof Error`
 * message path keeps working unchanged.
 */
export class ApiError extends Error {
  readonly status: number;
  /**
   * The envelope's machine-readable `code`, when it had one.
   *
   * The status alone is too coarse for the refusals that matter: `has_messages`
   * and `mid_turn` are both 409 and mean opposite things to the UI (one says
   * "your view of this chat is wrong", the other says "not yet"). The
   * alternative — matching on the human sentence — breaks the first time the
   * wording is improved.
   */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null = null) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

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
  if (!res.ok) {
    const { message, code } = await errorEnvelope(res);
    throw new ApiError(message, res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface TabWithPanes extends Tab {
  panes: PaneSpec[];
}

/** A folder the user has recently worked in — a one-tap option in the
 *  launch card. `path` is already snapped to its project root, so the chip
 *  and the session that starts from it name the same directory. */
export interface RecentFolder {
  path: string;
  name: string;
  /** `~`-relative form, for the chip's second line. */
  short: string;
  hasProject: boolean;
}

export interface AgentLaunchOptions {
  folders: RecentFolder[];
  /** Per-backend model lists, absent for a backend that has never run here —
   *  the card then offers only the harness's own default, which is honest. */
  models: Record<string, Array<{ value: string; displayName: string; resolvedModel?: string }>>;
  home: string;
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
  /** One pane, decorated (title/attention/busy/…) + isRunning. */
  getPane: (id: string) =>
    req<PaneSpec & { isRunning: boolean }>(`/api/panes/${encodeURIComponent(id)}`),

  // ── Workspaces (the new top-level concept) ─────────────────────────────

  /** `all: true` includes hidden workspaces — the caller is responsible for
   *  keeping them out of user-facing lists. */
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
      /** Agent behavior mode for an 'agent' bootstrap (default 'deep'). */
      mode?: AgentMode;
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
      /** Living sidebar: hold this tab at the top of its workspace block, in
       *  the manual drag order (unpinned tabs are auto-sorted). */
      pinned?: boolean;
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
      /** Behavior overlay for an agent pane: 'do' = the house chat, 'deep' =
       *  a raw harness session. Internal plumbing; never named in the UI. */
      mode?: AgentMode;
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

  /** Choose the harness for an EMPTY agent pane — sets the backend (and,
   *  optionally, the folder and model it starts with) and respawns the runner. */
  setAgentBackend: (
    paneId: string,
    backend: 'claude' | 'codex' | 'cursor',
    /** Omit to keep the pane's current overlay; pass 'deep' for a RAW
     *  session of the harness (no house contract on top). */
    mode?: AgentMode,
    /** Chosen at the moment of picking, in the launch card. Omit either to
     *  keep the pane's folder / let the harness pick its own model. */
    start?: { cwd?: string | undefined; model?: string | undefined },
  ) =>
    req<{
      backend: 'claude' | 'codex' | 'cursor';
      mode: AgentMode;
      /** The folder the session ACTUALLY got. The server snaps the request to
       *  the project root, so echoing our own input can name a different
       *  folder than the one running. Always prefer this. */
      cwd: string | null;
      model: string | null;
    }>(`/api/panes/${paneId}/agent-backend`, {
      method: 'POST',
      body: JSON.stringify({
        backend,
        ...(mode ? { mode } : {}),
        ...(start?.cwd ? { cwd: start.cwd } : {}),
        ...(start?.model ? { model: start.model } : {}),
      }),
    }),

  /** Folder + model choices for the empty chat's launch card, in one read.
   *  See server/src/routes/agent-launch.ts for why they travel together. */
  agentLaunchOptions: () => req<AgentLaunchOptions>('/api/agent-launch/options'),

  /** Convert an agent pane into a plain terminal (clears the startup command,
   *  flips to the terminal face, respawns). */
  convertPaneToTerminal: (paneId: string) =>
    req<void>(`/api/panes/${paneId}/as-terminal`, { method: 'POST' }),

  /** Convert an agent pane into a blank URL pane (URL chrome auto-focused). */
  convertPaneToWeb: (paneId: string) =>
    req<void>(`/api/panes/${paneId}/as-web`, { method: 'POST' }),

  /** Change a pane's working directory and respawn it there. */
  setPaneCwd: (paneId: string, cwd: string) =>
    req<void>(`/api/panes/${paneId}/cwd`, { method: 'POST', body: JSON.stringify({ cwd }) }),

  // Move a pane to another tab (any workspace). `toTabId` targets an
  // existing tab; `newTab` extracts it into a fresh tab — in `toWorkspaceId`
  // if given (dropping a pane on a workspace header), otherwise its own
  // workspace. The PTY keeps running — only the pane's parent tab + both
  // tabs' layouts change.
  movePane: (id: string, dest: { toTabId?: string; newTab?: boolean; toWorkspaceId?: string }) =>
    req<MovePaneResult>(`/api/panes/${id}/move`, {
      method: 'POST',
      body: JSON.stringify({
        to_tab_id: dest.toTabId,
        new_tab: dest.newTab,
        to_workspace_id: dest.toWorkspaceId,
      }),
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
      /** Agent behavior mode. Takes effect immediately for the NEXT message
       *  (the live session gets a one-time in-band note; the full
       *  system-prompt overlay lands on the pane's next respawn). */
      mode?: AgentMode;
    },
  ) =>
    req<PaneSpec>(`/api/panes/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  respawnPane: (id: string) => req<void>(`/api/panes/${id}/respawn`, { method: 'POST' }),

  /**
   * Ask the SERVER whether this pane's web-face URL is actually serving.
   *
   * The page can only probe with `fetch(mode:'no-cors')`, and an opaque
   * response has no readable status — so `tailscale serve` answering 502 for a
   * dead local backend looks exactly like a healthy 200, and the user gets a
   * silent blank iframe. The server shares a machine with the app, isn't bound
   * by CORS, and can read the real status. See face-switch.ts's probeUrlLive
   * for how the two probes are combined.
   *
   * Throws (like every `req` call) when the endpoint itself is unavailable —
   * callers fall back to the opaque probe rather than treating that as "dead".
   */
  paneUrlHealth: (paneId: string, url: string) =>
    req<UrlHealth>(
      `/api/panes/${encodeURIComponent(paneId)}/url-health?url=${encodeURIComponent(url)}`,
    ),

  /** Summarize an agent pane's conversation to its deliverable (document
   *  surface's collapse-to-summary). Best-effort — returns empty strings if the
   *  transcript/session isn't available yet. */
  summarizePane: (paneId: string) =>
    req<{ summary: string; title: string; artifacts: string[] }>(`/api/panes/${paneId}/summarize`, {
      method: 'POST',
    }),

  /**
   * Repair phone-dictation mishearings in composed text ("crown schedule" →
   * "cron schedule"). Returns the corrected text for the human to REVIEW — it
   * sends nothing, and the caller must never treat it as send-ready.
   *
   * Throws `ApiError` on every failure (502 when the model is unreachable).
   * There is no silent-success path: a caller that swallows the throw would
   * teach the user that cleanup ran and found nothing wrong.
   */
  cleanTranscript: (text: string) =>
    req<{ text: string; changed: boolean }>('/api/clean-transcript', {
      method: 'POST',
      body: JSON.stringify({ text }),
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
