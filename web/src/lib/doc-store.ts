// The document surface's client state. A document is an ordered list of blocks
// — plain text, or an "agent" block that embeds a live muxpad agent session.
//
// v0 persistence is deliberately localStorage: the HARD state (the agent
// conversation, its session, its artifacts) already lives durably on the muxpad
// server keyed by paneId, so the document itself only needs to remember the
// block order + each agent block's paneId + its cached collapsed summary. That
// makes the whole thing survive a reload on this device without any new server
// store — server-synced documents are the next step, not the bet we're testing.

import { api } from '../api';

export interface TextBlock {
  id: string;
  kind: 'text';
  content: string;
}

export interface AgentBlock {
  id: string;
  kind: 'agent';
  /** The muxpad agent pane backing this block (its conversation + artifacts). */
  paneId: string;
  collapsed: boolean;
  /** Cached deliverable view, refreshed on collapse. */
  title: string;
  summary: string;
  /** Attachment filenames the agent produced, surfaced as chips when collapsed. */
  artifacts: string[];
}

export type Block = TextBlock | AgentBlock;

export interface DocState {
  blocks: Block[];
}

const DOC_KEY = 'muxpad:doc:default:v1';
const BACKING_KEY = 'muxpad:doc:backing-tab:v1';

/** Short id for a block (client-only; not a server ulid). */
export function blockId(): string {
  return `b_${Math.random().toString(36).slice(2, 10)}`;
}

export function emptyDoc(): DocState {
  return { blocks: [{ id: blockId(), kind: 'text', content: '' }] };
}

export function loadDoc(): DocState {
  try {
    const raw = localStorage.getItem(DOC_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as DocState;
      if (parsed?.blocks?.length) return parsed;
    }
  } catch {
    // fall through to a fresh doc
  }
  return emptyDoc();
}

export function saveDoc(doc: DocState): void {
  try {
    localStorage.setItem(DOC_KEY, JSON.stringify(doc));
  } catch {
    // storage full / disabled — the in-memory doc still works this session
  }
}

/**
 * Agent panes need a tab to hang under (a pane row FKs a tab). The document
 * surface keeps ONE dedicated backing tab in the first workspace and reuses it
 * for every agent block. Cached in localStorage; re-created if the cached tab
 * was deleted out from under us.
 */
export async function ensureBackingTab(): Promise<string> {
  const cached = localStorage.getItem(BACKING_KEY);
  if (cached) {
    try {
      await api.getTab(cached);
      return cached;
    } catch {
      // deleted — fall through and make a new one
    }
  }
  const workspaces = await api.listWorkspaces();
  const ws = workspaces[0] ?? (await api.createWorkspace('Documents'));
  const tab = await api.createTab(ws.id, { name: '· document ·' });
  localStorage.setItem(BACKING_KEY, tab.id);
  return tab.id;
}

/** Create a fresh Claude agent pane under the backing tab for a new agent block. */
export async function createAgentPane(tabId: string): Promise<string> {
  const pane = await api.createPane(tabId, {
    // Concrete backend (no `--pick`) so the block is ready to talk immediately.
    startup_cmd: 'muxpad agent',
    face: 'chat',
    // We don't render the backing tab's mosaic, so layout placement is moot.
    append_to_layout: false,
  });
  return pane.id;
}
