import type Database from 'better-sqlite3';
import { LOCAL_NODE_ID, NodeStore } from '../store/NodeStore.js';
import { findTranscript, muxpadLocate } from './TranscriptReader.js';

/**
 * MAY THIS SERVER READ THIS PANE'S TRANSCRIPT FROM ITS OWN DISK?
 *
 * ── WHY A CHOKEPOINT, AND WHY THE RETURN TYPE IS NOT `string | null` ─────
 *
 * The transcript locators search BY SESSION ID on the server's filesystem,
 * with no notion of which machine a pane belongs to. A trust review found what
 * that allows: a compromised host reports its own pane's sid as some PERSONAL
 * chat's sid — the runner `hello` validates the sid's SHAPE and nothing more —
 * and the server then serves that conversation as the remote pane's history.
 * Session ids are not secret; they sit in plain sight as `--resume <sid>`.
 *
 * I first "fixed" this at two call sites and wrote a commit saying the server
 * "never" reads its own disk for another machine's chat. A second review
 * counted the readers: there were seven, and I had gated two. The remaining
 * five were `has-messages`, `worker-answer`, `headline`'s `readRecentTurns`,
 * `summarize` and the archiver. One chokepoint closes all of them, and a new
 * reader that forgets to ask simply has no path to call.
 *
 * ── THE THREE ANSWERS MUST STAY APART ────────────────────────────────────
 *
 * `string | null` would be a trap, because `null` reads naturally as "there is
 * no transcript" — and for one caller that is the DESTRUCTIVE answer.
 * `agentPaneHasMessages` treats "no file" as "this chat never spoke", and its
 * own comment says a false negative there is a destroyed conversation. So a
 * remote pane must make it answer TRUE, not false.
 *
 * Hence a discriminated result. A caller has to decide what "not mine to read"
 * means for its own job, and cannot get there by accident:
 *
 *   local     · the pane is here and the file is at `path`
 *   absent    · the pane is here and has written nothing yet
 *   elsewhere · the pane lives on another machine. NOT absent. Whatever the
 *               safe direction is for this caller, it is not "no history".
 */
export type TranscriptAccess =
  | { kind: 'local'; path: string }
  | { kind: 'absent' }
  | { kind: 'elsewhere'; nodeId: string };

/**
 * Resolve a pane's transcript, refusing anything that is not this machine's.
 *
 * `assistant` picks the locator cascade: Claude writes
 * `~/.claude/projects/**<sid>.jsonl`, codex/cursor write the muxpad-normalised
 * log. Unknown/absent is treated as non-Claude, which is the cheaper lookup
 * and the correct one for every backend muxpad writes itself.
 *
 * A pane with NO ROW is `elsewhere`, not `local`. {@link NodeStore.nodeForPane}
 * maps a missing pane to `local` — correct for its own purpose, since that is
 * the pre-migration meaning — but here it would turn "I have never heard of
 * this pane" into "go ahead and search my disk by this id", which is precisely
 * the sid-swap the chokepoint exists to stop.
 */
export function transcriptForPane(
  db: Database.Database,
  paneId: string,
  sid: string | null | undefined,
  assistant?: string | null,
): TranscriptAccess {
  const row = db.prepare('SELECT node_id FROM panes WHERE id = ?').get(paneId) as
    | { node_id: string | null }
    | undefined;
  if (!row) return { kind: 'elsewhere', nodeId: 'unknown' };
  const nodeId = row.node_id ?? LOCAL_NODE_ID;
  if (nodeId !== LOCAL_NODE_ID) return { kind: 'elsewhere', nodeId };
  if (!sid) return { kind: 'absent' };
  const path = (assistant === 'claude' ? findTranscript(sid) : null) ?? muxpadLocate(sid);
  return path ? { kind: 'local', path } : { kind: 'absent' };
}

/**
 * Is this pane's history readable here at all?
 *
 * For the callers that only need the yes/no and have their own handling for
 * the file itself. Deliberately NOT a `path` helper — that would re-create the
 * `string | null` trap one layer up.
 */
export function transcriptIsLocal(db: Database.Database, paneId: string): boolean {
  const row = db.prepare('SELECT node_id FROM panes WHERE id = ?').get(paneId) as
    | { node_id: string | null }
    | undefined;
  return !!row && (row.node_id ?? LOCAL_NODE_ID) === LOCAL_NODE_ID;
}

/**
 * The NAME of the machine a pane runs on, or null when it runs here.
 *
 * Null for local is the whole point: callers use it as "is this remote", so
 * there is one question and not two. A node row deleted from under a live pane
 * is named by its id rather than reported as local — that is the single thing
 * an indicator like this must never get wrong.
 */
export function remoteHostName(db: Database.Database, paneId: string): string | null {
  const row = db.prepare('SELECT node_id FROM panes WHERE id = ?').get(paneId) as
    | { node_id: string | null }
    | undefined;
  const nodeId = row?.node_id ?? LOCAL_NODE_ID;
  if (nodeId === LOCAL_NODE_ID) return null;
  return new NodeStore(db).get(nodeId)?.name ?? nodeId;
}

/** The node a pane belongs to, for a message that names the machine. */
export function nodeLabelForPane(db: Database.Database, paneId: string): string {
  return new NodeStore(db).get(new NodeStore(db).nodeForPane(paneId))?.name ?? 'another machine';
}
