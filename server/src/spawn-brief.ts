/**
 * THE BRIEFING A SPAWNED CHAT IS BORN WITH — "and report back to the chat that
 * asked".
 *
 * ── THE EVIDENCE ─────────────────────────────────────────────────────────────
 * "I'm noticing a pattern of sub agents wrapping up their work and dying and the
 * main agent doesn't report it and sub agent is gone. I just got a push
 * notification about A2 completing their work and I come here and I can't find
 * anything about that subject."
 *
 * Every half of the round trip existed except the instruction. A chat DIRECTED at
 * from another chat's composer (`@Name do this`) is handed a marker plus a line
 * telling it to report back with `muxpad agent send <parentPane> '<muxpad-report
 * …>…'`, and when it does, the asking conversation renders the answer as a card
 * with the agent's own prose in it. A chat SPAWNED by `muxpad agent new` — which
 * is every worker an agent delegates to, and therefore nearly every child that
 * exists — was told none of that. It finished, retired with
 * `done_reason = 'delivered'` (tab-retire.ts's own word for "its result went back
 * to the parent as a card"), and the parent conversation held nothing.
 *
 * So a spawn carries the same contract as a direction, composed from the same
 * builder in `shared` (chat-direct.ts). Not a second format, not a second
 * delivery ledger: the report is a real message in a real transcript, which is
 * exactly why it is better than the local echo the `@` path also keeps.
 *
 * ── WHAT THIS FILE DECIDES ───────────────────────────────────────────────────
 * One thing, and it is the thing that can be wrong: WHICH PANE the report is
 * addressed to. It has to be a pane `submitSend` will accept — ws.ts rejects a
 * pane that is not runner-owned with "pane has no agent runner" — or the
 * instruction is a command that fails in the worker's face and the round trip is
 * worse than none.
 */
import { type PaneSpec, renderSpawnBriefing } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';

/**
 * Can this pane RECEIVE a `muxpad agent send`?
 *
 * The `startup_cmd` marker, deliberately — NOT `isAgentPane`, which also counts
 * a pane wearing the `chat` face. `submitSend`'s own gate is
 * `startup_cmd?.startsWith('muxpad agent')`, and this has to agree with the
 * thing that will actually accept the message rather than with the thing that
 * decides what icon to draw. A converted pane whose startup command still says
 * `zsh` renders as a chat and has no runner to drain a queue.
 */
function canReceiveSend(pane: PaneSpec | null | undefined): boolean {
  return pane?.startup_cmd?.startsWith('muxpad agent') ?? false;
}

/**
 * The pane of `tabId` a report should be sent to, or null.
 *
 * Prefers `preferPaneId` — the pane the spawn was made FROM, which is the
 * agent that asked for the work and the one whose conversation the answer
 * belongs in. Falls back to the parent tab's first runner-owned pane, in the
 * store's row order: a chat has exactly one agent pane (a chat's parallel work
 * is a child chat, not a second agent in the same tab — see
 * shared/agent-pane.ts), so "first" is "the one" in every case that is not a
 * hand-built split.
 *
 * Null when nothing there can take a message — a spawn made from a plain
 * TERMINAL pane in a tab with no agent in it. That is a real case (`muxpad agent
 * new` from a shell you opened yourself) and it gets no briefing rather than one
 * addressed at a pane that would reject it.
 */
export function reportTargetPane(
  db: Database.Database,
  tabId: string,
  preferPaneId?: string | undefined,
): string | null {
  const panes = new PaneStore(db);
  if (preferPaneId) {
    const preferred = panes.getById(preferPaneId);
    // …and it must belong to the parent tab. A pane id from somewhere else is
    // not the parent's conversation, whatever the caller meant by it.
    if (preferred?.tab_id === tabId && canReceiveSend(preferred)) return preferred.id;
  }
  for (const p of panes.listByTab(tabId)) if (canReceiveSend(p)) return p.id;
  return null;
}

/**
 * The preamble to prepend to a spawned chat's FIRST MESSAGE, or null.
 *
 * Returned to the caller (`POST /api/tabs`) rather than delivered from here, and
 * that is the whole shape of this fix. The server knows the parent, the parent's
 * pane and the child; it does NOT know the task — the spawner sends that itself,
 * in its own request, after the tab exists. So the server composes the half that
 * must not be improvised and hands it back; the spawner puts its task after it.
 * `renderDirectMarker` ends the block with a blank line, so
 * `brief + task` is byte-for-byte the string a one-shot compose would have made.
 *
 * Why not wrap it at delivery instead — in `submitSend`, where every message into
 * every agent pane already funnels? Because "is this the FIRST message to this
 * child" is not a fact that door has. It would have to be derived (an empty
 * transcript, a session with no sid) or stored, and a stored one is the ledger
 * this design exists to avoid. The spawner asking for a tab and then sending the
 * first message is one act by one caller; that is where the two halves are known
 * together.
 */
export function spawnBrief(
  db: Database.Database,
  input: {
    /** The resolved parent tab (already checked to exist by the caller). */
    parentTabId: string;
    /** The pane the spawn came from, when the caller knew one. */
    spawnedByPane?: string | undefined;
    childTabId: string;
    /** The child's own agent pane, when its bootstrap produced one. */
    childPane?: string | undefined;
  },
): string | null {
  const tabs = new TabStore(db);
  const parent = tabs.getById(input.parentTabId);
  if (!parent) return null;
  const parentPane = reportTargetPane(db, input.parentTabId, input.spawnedByPane);
  // No pane that can take a send → no instruction. A command the worker cannot
  // run teaches it that reporting does not work.
  if (!parentPane) return null;
  const child = tabs.getById(input.childTabId);
  return renderSpawnBriefing({
    childTabId: input.childTabId,
    ...(child?.name ? { childName: child.name } : {}),
    ...(input.childPane ? { childPane: input.childPane } : {}),
    parentName: parent.name,
    parentPane,
    // The task is the CALLER's half — see the note above.
    task: '',
  });
}
