// "The history was one row away the whole time."
//
// THE BUG THIS EXISTS FOR. A pane's `agent_sessions.current_sid` is the resume
// target: it is what the server bakes into `panes.startup_cmd` as
// `--resume <sid>`, and what every chat/search/summary read keys off. It can
// DRIFT onto a session that never wrote a transcript — a stray `muxpad agent`
// in the pane's shell mints a fresh session, hellos, and the self-heal rewrite
// in ws.ts dutifully re-points the pane at it. Nothing is deleted: the real
// conversation's sid is still in `lineage` and in the append-only
// `session_history` registry, and its transcript is still on disk. But the
// resume path, finding no transcript for the target, starts fresh and SAYS
// nothing interesting about it — so the pane shows an empty chat and the user
// reads it as "my conversation got cleared".
//
// Observed in the wild: pane 01M2R8RT874AC74YR6899FH2ZG carried four sids over
// three days. The DB pointed at the one with no transcript; the other one held
// 1,788 events.
//
// WHAT THIS DOES. Before a resume target is typed into a shell, check that it
// actually HAS a transcript. If it doesn't, walk the pane's own session_history
// most-recent-first and recover the newest sid that does. The registry is
// already the durable pane↔sid record (migration 20) — this just reads it.
//
// WHAT IT DELIBERATELY DOES NOT DO. It never invents a recovery for a pane
// that simply has no history: no candidate with a transcript ⇒ null, no write,
// no log, no push. A freshly-created pane must still start fresh and QUIET.
// The "it had turns and the transcript is gone anyway" case is not ours either
// — session-marks.ts already tells those two apart, and the runner shouts
// about it with the mark in hand (see backends/claude.ts). This module only
// speaks when it can actually fix something.
import type Database from 'better-sqlite3';
import { findTranscript, muxpadLocate } from './chat/TranscriptReader.js';

/**
 * The same charset gate the hello handler applies, and for the same reason:
 * a recovered sid is about to be written into `startup_cmd`, which PaneRuntime
 * TYPES INTO A SHELL. A sid that can't pass this is not recovered.
 */
const SID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * How many of a pane's historical sids we are willing to probe for a
 * transcript. Not a recency cutoff — see `planResumeRepair` — purely a bound on
 * filesystem work, since `findTranscript` stats once per Claude project dir.
 * A pane with more than this many sessions is pathological; the newest 64 will
 * contain the one anybody wants back.
 */
export const MAX_RESUME_CANDIDATES = 64;

/** Backend ids that may be written into a startup command. */
const BACKENDS = new Set(['claude', 'codex', 'cursor']);

/**
 * Both transcript stores, cheapest first. Claude writes
 * `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd>/<sid>.jsonl`; codex and cursor
 * write the muxpad-normalized log at `<dataDir>/agent-transcripts/<sid>.jsonl`.
 *
 * BOTH are searched for EVERY candidate, regardless of what the row says the
 * pane's assistant is. A pane that was converted between harnesses has sids of
 * both shapes in its history, and the row's `assistant` describes the pane's
 * CURRENT harness, not the one that wrote the history we're trying to recover.
 * (`muxpadLocate` is one stat; `findTranscript` is a directory scan — so the
 * cheap one goes first. We only need existence, not which store.)
 */
export function locateAnyTranscript(sid: string): string | null {
  return muxpadLocate(sid) ?? findTranscript(sid);
}

/** A resume target with no transcript, and the sid we can put in its place. */
export interface ResumeRepair {
  pane_id: string;
  /** The drifted resume target — a session with no transcript anywhere. */
  from: string | null;
  /** The pane's most recent sid that DOES have one. */
  to: string;
  /** The harness that wrote `to`, per session_history (null if unrecorded). */
  assistant: string | null;
  /** How many of the pane's historical sids had a transcript. */
  candidates: number;
}

export interface RepairDeps {
  /** Injectable for tests; production uses {@link locateAnyTranscript}. */
  locate?: (sid: string) => string | null;
}

interface HistoryRow {
  sid: string;
  assistant: string | null;
  last_seen: number | null;
}

/**
 * A pane's sids from the append-only registry, MOST RECENT FIRST.
 *
 * Ordering is `last_seen DESC, sid ASC`:
 *
 *  - `last_seen` is muxpad's own record of when a sid was last the pane's live
 *    session. It is the direct answer to "which conversation was I in most
 *    recently", which is the question a recovery is asking.
 *  - Transcript MTIME was the alternative and is rejected: it measures the
 *    file, not the session, and it is the field a backup restore, an rsync or
 *    a folder-sync client rewrites wholesale. `last_seen` is ours.
 *  - `sid ASC` is a pure tiebreak so the pick is deterministic when two rows
 *    share a millisecond (they do — a boot writes several rows in one tick).
 */
export function paneSessionHistory(
  db: Database.Database,
  pane_id: string,
  limit = MAX_RESUME_CANDIDATES,
): HistoryRow[] {
  return db
    .prepare(
      `SELECT sid, assistant, last_seen FROM session_history
        WHERE pane_id = ?
        ORDER BY last_seen DESC, sid ASC
        LIMIT ?`,
    )
    .all(pane_id, limit) as HistoryRow[];
}

/**
 * Decide whether `pane_id`'s resume target needs recovering, and onto what.
 * Pure read — nothing is written. Returns null in every case that is NOT a
 * recoverable drift:
 *
 *  - no session row / no current_sid  → nothing was ever resumable;
 *  - the target HAS a transcript      → nothing is wrong;
 *  - no other sid has one             → genuinely nothing to recover (a
 *    never-used pane, or history that really is gone — session-marks.ts and
 *    the runner own that distinction, and saying anything here would either
 *    cry wolf at every new pane or duplicate their job).
 *
 * HOW FAR BACK IT LOOKS: all of it. There is deliberately no age cutoff — a
 * cutoff is just this bug again for any pane that sat idle longer than it, and
 * the registry is append-only and tiny. `MAX_RESUME_CANDIDATES` bounds the
 * filesystem probing, not the recency.
 *
 * WITH SEVERAL CANDIDATES: the newest wins, by the ordering above. The older
 * ones are not lost — they stay in session_history and in the archive, and the
 * search surface can still reach them. Resuming is about which conversation
 * the pane should BE in now, and that is the last one it was in.
 */
export function planResumeRepair(
  db: Database.Database,
  pane_id: string,
  deps: RepairDeps = {},
): ResumeRepair | null {
  const locate = deps.locate ?? locateAnyTranscript;
  const row = db
    .prepare('SELECT current_sid FROM agent_sessions WHERE pane_id = ?')
    .get(pane_id) as { current_sid: string | null } | undefined;
  const current = row?.current_sid ?? null;
  if (!current) return null;
  if (locate(current)) return null; // the target is fine

  let best: HistoryRow | null = null;
  let candidates = 0;
  for (const h of paneSessionHistory(db, pane_id)) {
    if (h.sid === current) continue;
    if (!SID_RE.test(h.sid)) continue; // never shell-bound an id we can't vouch for
    if (!locate(h.sid)) continue;
    candidates += 1;
    if (!best) best = h; // the list is already most-recent-first
  }
  if (!best) return null;
  return {
    pane_id,
    from: current,
    to: best.sid,
    assistant: best.assistant ?? null,
    candidates,
  };
}

/**
 * Re-point a startup command at `sid`, and at the harness that wrote it.
 *
 * Only the two flags that can strand history are touched; `--model`, `--mode`
 * and anything hand-typed survive untouched. A command with no `--resume` gains
 * one (a pane whose resume flag was stripped by the dead-session heal is
 * exactly the shape that strands history).
 *
 * Claude stays IMPLICIT — a bare `muxpad agent …` is claude — so recovering a
 * claude session never churns a command that didn't name a backend.
 */
export function rewriteResumeCmd(cmd: string, sid: string, assistant: string | null): string {
  let out = cmd;
  out = out.includes('--resume ')
    ? out.replace(/--resume\s+[A-Za-z0-9._-]+/, `--resume ${sid}`)
    : `${out.trimEnd()} --resume ${sid}`;
  if (assistant && BACKENDS.has(assistant)) {
    const backendPart = assistant === 'claude' ? '' : `--backend ${assistant}`;
    if (/--backend\s+[A-Za-z]+/.test(out)) {
      out = backendPart
        ? out.replace(/--backend\s+[A-Za-z]+/, backendPart)
        : // Recovering a claude session out of a pane whose command says codex:
          // drop the flag rather than leave the wrong harness resuming the id.
          out.replace(/\s*--backend\s+[A-Za-z]+/, '');
    } else if (backendPart) {
      out = out.replace(/^(\S+\s+\S+)/, `$1 ${backendPart}`);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Apply a repair: `agent_sessions.current_sid` (+ `assistant`) and the pane's
 * `startup_cmd` both move to the recovered session.
 *
 * WHY WRITE BACK rather than resume-for-this-boot-only. The alternative keeps
 * the DB "honest about what the session was" — but that is not what those two
 * fields are. `lineage` and `session_history` are the historical record, they
 * keep every sid including the drifted one, and neither is touched here.
 * `current_sid` is a POINTER to the live conversation and `startup_cmd` is an
 * instruction to a shell; leaving them wrong means every later read (chat
 * history, search, summarize, headline, has-messages) still sees the empty
 * session, and the next respawn strands the history again. A recovery that has
 * to be re-derived on every boot is a recovery that is one code path away from
 * being lost again — which is how this stayed invisible for three days.
 *
 * `lineage` is NOT rewritten: the recovered sid is already in it, and the
 * drifted one belongs there too — it did happen.
 */
export function applyResumeRepair(db: Database.Database, repair: ResumeRepair): void {
  const now = Date.now();
  if (repair.assistant && BACKENDS.has(repair.assistant)) {
    db.prepare(
      'UPDATE agent_sessions SET current_sid = ?, assistant = ?, updated_at = ? WHERE pane_id = ?',
    ).run(repair.to, repair.assistant, now, repair.pane_id);
  } else {
    db.prepare('UPDATE agent_sessions SET current_sid = ?, updated_at = ? WHERE pane_id = ?').run(
      repair.to,
      now,
      repair.pane_id,
    );
  }
  const pane = db.prepare('SELECT startup_cmd FROM panes WHERE id = ?').get(repair.pane_id) as
    | { startup_cmd: string | null }
    | undefined;
  const cmd = pane?.startup_cmd;
  if (!cmd?.startsWith('muxpad agent')) return; // not ours to rewrite
  const next = rewriteResumeCmd(cmd, repair.to, repair.assistant);
  if (next !== cmd) db.prepare('UPDATE panes SET startup_cmd = ? WHERE id = ?').run(next, repair.pane_id);
}

/** Plan + apply for one pane. Returns what was done, or null if nothing was. */
export function repairPaneResume(
  db: Database.Database,
  pane_id: string,
  deps: RepairDeps = {},
): ResumeRepair | null {
  const repair = planResumeRepair(db, pane_id, deps);
  if (repair) applyResumeRepair(db, repair);
  return repair;
}

/**
 * Boot sweep: repair every agent pane whose resume target has been stranded.
 *
 * WHY AT BOOT and not only at resume time. Both, and they answer different
 * questions. A resume-time check catches drift that happens while the server is
 * up, but it only ever fixes the pane you are respawning — a pane that drifted
 * days ago and is sitting there looking empty is never respawned, so it is
 * never fixed, and the user has no way to know there is anything TO fix. The
 * boot pass fixes every already-drifted pane in one go, before any chat client
 * connects and reads `current_sid`.
 */
export function repairAllResumeTargets(db: Database.Database, deps: RepairDeps = {}): ResumeRepair[] {
  const panes = db
    .prepare("SELECT id FROM panes WHERE startup_cmd LIKE 'muxpad agent%'")
    .all() as Array<{ id: string }>;
  const repairs: ResumeRepair[] = [];
  for (const p of panes) {
    const r = repairPaneResume(db, p.id, deps);
    if (r) repairs.push(r);
  }
  return repairs;
}

/**
 * The sentence a human reads. One line, because the only thing that made this
 * bug survivable was that nobody ever said it out loud — and it has to work on
 * a lock screen as well as in a log.
 */
export function describeRepair(repair: ResumeRepair, paneLabel?: string | null): string {
  const where = paneLabel ? `${paneLabel}: ` : '';
  const others = repair.candidates > 1 ? ` (${repair.candidates} had one; took the newest)` : '';
  return `${where}recovered a stranded conversation — session ${repair.from?.slice(0, 8) ?? '?'} has no transcript, so this pane resumes ${repair.to.slice(0, 8)} instead${others}.`;
}
