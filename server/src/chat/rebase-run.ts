import { ROW_NOT_FOUND } from '@muxpad/shared';
import type Database from 'better-sqlite3';
import { rewriteResumeCmd } from '../agent-resume-repair.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { rebaseBriefing, wrapRebase } from './rebase.js';
import { transcriptIsLocal } from './transcript-access.js';
import {
  type TranscriptRebaseResult,
  discardRebasedTranscript,
  transcriptRebase,
} from './transcript-rebase.js';

/**
 * PERFORM a rebase.
 *
 * There is ONE control and it promises ONE thing: **this conversation, on
 * today's instructions.** See {@link RebaseMode} for the order it tries things
 * in. Every path keeps the conversation except `fresh`, which is reachable only
 * by asking for it by name.
 *
 * ── STEP 1: THE TRANSCRIPT REBASE ────────────────────────────────────────
 * A new session file holding the same real turns minus every stale
 * instruction that leaked into them (transcript-rebase.ts), resumed by a fresh
 * runner whose system prompt is today's. Refuse-before-destroy: the new
 * transcript is written and verified FIRST, the pane is pointed at it only
 * then, and a respawn that throws puts the old `--resume` back and deletes the
 * new file.
 *
 * ── STEP 2: RESUME ───────────────────────────────────────────────────────
 * When the transcript cannot be replayed — a codex/cursor chat, one turn too
 * large to keep whole, a file that fails its integrity check — the `--resume`
 * stays exactly as it is and only the process is replaced. Still a rebase of
 * the base: the system prompt is rebuilt at every runner start. Still every
 * message.
 *
 * A pane on another machine is refused outright, by both steps.
 *
 * ── `fresh`: brief, then boot the chat fresh and hand it the briefing ────
 *
 * {@link rebaseBriefing} writes the briefing; this is the part that acts on
 * it, and the order is the whole design:
 *
 *   1. BRIEF FIRST, and refuse if it fails. The briefing is written from the
 *      transcript the OLD session is still sitting on. A rebase that killed
 *      the runner first and then failed to summarise would have thrown away a
 *      working chat for nothing — see the best-effort contract on
 *      rebaseBriefing.
 *   2. Drop `--resume`. That flag is the only thing tying the pane to its old
 *      session; without it the runner mints a fresh one, which is what
 *      re-reads today's generated instructions (agent-files.ts) instead of
 *      the ones the old session was born with.
 *   3. Kill, then start. Same two calls the respawn route makes.
 *   4. Submit the briefing. It does NOT need the runner to be up: a
 *      runner-owned pane with nothing connected queues, and the queue drains
 *      the moment the new session hellos. So there is no poll loop here and
 *      no window where the briefing can be dropped on the floor.
 *
 * THIS KILLS WHAT THE PANE WAS HOLDING — background subagents, scheduled
 * wake-ups, an in-flight turn. That is why it is a verb the user types and
 * never something muxpad decides to do for them.
 */

/**
 * The startup command with its `--resume` removed, so the next boot is a NEW
 * conversation.
 *
 * Exported for its own test: the rest of the command is a user's — a model, a
 * backend, a mode, anything hand-typed — and a rebase that mangled it would
 * silently change what the chat IS while claiming only to refresh it.
 */
export function stripResume(cmd: string): string {
  return cmd
    .replace(/\s*--resume[ =][A-Za-z0-9._-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export interface RebaseDeps {
  db: Database.Database;
  /** `killPane` then `ensurePane` — the respawn route's own two calls. */
  respawn: (paneId: string) => Promise<void>;
  /** The agent bridge's `submitSend`; queues when no runner is connected. */
  submit: (
    paneId: string,
    text: string,
  ) => { status: 'sent' | 'queued' | 'rejected'; reason?: string | undefined };
  /** Injected in tests. */
  brief?: (db: Database.Database, paneId: string) => Promise<string | null>;
  /** Injected in tests; defaults to {@link transcriptRebase}. */
  transcript?: (db: Database.Database, paneId: string) => Promise<TranscriptRebaseResult>;
  /** Injected in tests; defaults to deleting the file. */
  discard?: (path: string) => void;
  /**
   * ── THE QUIESCE PROBES ───────────────────────────────────────────────────
   *
   * A rebase REPLACES THE CONVERSATION FILE and then kills the runner. Between
   * the snapshot and the kill it may wait on a model call (the briefing), and
   * anything that arrives in that window goes to the OLD runner and lands only
   * in the OLD file: a turn in flight loses its answer, a message loses itself,
   * and a sub-chat's report is marked delivered to a session that no longer
   * exists. Found by an adversarial review of the chat lifecycle, and the
   * repro is one click: send a long task, press Rebase.
   *
   * So the facts that say "not now" are asked for before anything is touched.
   * Each is optional and `undefined` means "nobody wired a probe", which reads
   * as quiet — the pre-existing behaviour, and what every test that does not
   * care about this gets.
   */
  /** Is a turn in flight? (the runner registry's own answer) */
  turnActive?: (paneId: string) => boolean | null;
  /** How many messages are waiting in this pane's send queue. */
  queued?: (paneId: string) => number;
  /** How many workers this chat is still waiting on. */
  openRounds?: (tabId: string) => number;
  /** How many finished workers' results have not reached this chat yet. */
  undeliveredRounds?: (tabId: string) => number;
}

/**
 * WHAT THE REBASE BUTTON MEANS, AND THE ORDER IT TRIES THINGS IN.
 *
 *   'auto'   what the button sends, and what every caller should want.
 *            Best available, in this order:
 *              1. TRANSCRIPT REBASE — the same turns replayed from a rewritten
 *                 session file with the stale instructions stripped out of
 *                 them. The only option that fixes rules quoted INSIDE the
 *                 history by old compactions.
 *              2. RESUME — leave `--resume` exactly as it is and replace only
 *                 the process. The system prompt is rebuilt from today's
 *                 agent-instructions.md at every runner start, so this is a
 *                 real rebase of the base; what it cannot do is touch what the
 *                 conversation itself says about old rules.
 *            If neither is possible it REFUSES and changes nothing.
 *
 *   'keep'   force step 2.
 *
 *   'fresh'  the escape hatch, and NOT reachable from the button: replace the
 *            session and seed it with a briefing. The history stays on disk
 *            and searchable but leaves the agent's window.
 *
 * WHY `fresh` IS NOT A FALLBACK. It answers a different question. Every other
 * mode keeps the conversation; that one summarises it away, and a button that
 * silently degrades from "keep your history" to "replace it with a summary"
 * would break its own promise at exactly the moment the user could not see it
 * happening. "i want the history but I WANT IT REBASED ON THE NEW
 * INSTRUCTIONS." A briefing is a compaction wearing a nicer name.
 */
export type RebaseMode = 'auto' | 'keep' | 'fresh';

export type RebaseResult =
  | {
      ok: true;
      mode: 'transcript';
      sid: string;
      /** Entries replayed verbatim, and whether an older span was briefed. */
      kept: number;
      briefed: boolean;
    }
  | {
      ok: true;
      mode: 'keep';
      /** Why the transcript rebase was not used, when `auto` tried it. */
      fallback?: string;
    }
  | { ok: true; mode: 'fresh'; queued: boolean; chars: number }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'not_an_agent'
        | 'elsewhere'
        | 'no_briefing'
        | 'not_delivered'
        | 'respawn_failed'
        | 'busy';
      message: string;
    };

export async function runRebase(
  deps: RebaseDeps,
  paneId: string,
  mode: RebaseMode = 'auto',
  /**
   * The pane that ASKED, when the request came from inside one.
   *
   * A chat rebasing ITSELF (`muxpad agent rebase` with no argument, which is
   * the documented spelling) is always mid-turn: the turn running the command
   * is the turn the quiesce check sees, so the refusal below made the verb
   * permanently impossible. It is also the one turn there is nothing to
   * protect in — its answer is "I rebased", and ending it is the act that was
   * asked for. "It ends … any running turn. That is why it is typed."
   *
   * Only the TURN check is waived. A queued message and a working sub-chat
   * are still lost by a rebase whoever asked for it, so they still refuse.
   */
  askedBy?: string,
): Promise<RebaseResult> {
  const panes = new PaneStore(deps.db);
  const pane = panes.getById(paneId);
  if (!pane) return { ok: false, code: 'not_found', message: ROW_NOT_FOUND };
  const cmd = pane.startup_cmd ?? '';
  if (!cmd.startsWith('muxpad agent')) {
    return {
      ok: false,
      code: 'not_an_agent',
      message: 'only a chat or an agent can be rebased — this is a terminal',
    };
  }

  // ── NOT WHILE SOMETHING IS IN FLIGHT ──────────────────────────────────────
  //
  // See the quiesce probes on RebaseDeps for what is lost. The refusal is the
  // whole fix: there is nothing to do with a turn that is half-answered except
  // let it finish, and a rebase is a deliberate act whose moment the user is
  // choosing anyway.
  const busy = whyBusy(deps, pane.tab_id, paneId, askedBy === paneId);
  if (busy) return { ok: false, code: 'busy', message: busy };

  // …AND ONE AT A TIME. Two rebases of one chat each mint a transcript and
  // respawn; the last `setStartupCmd` wins and the other file is orphaned on
  // disk and in the archive. A double-click is the way in.
  if (inFlight.has(paneId)) {
    return { ok: false, code: 'busy', message: 'this chat is already being rebased' };
  }
  inFlight.add(paneId);
  try {
    return await rebase(deps, panes, pane, paneId, cmd, mode);
  } finally {
    inFlight.delete(paneId);
  }
}

/** Rebases in flight, by pane — see the double-click note in `runRebase`. */
const inFlight = new Set<string>();

/**
 * Why a rebase must not run right now, or null.
 *
 * Phrased for a person, because this reaches the user as the button's error:
 * what is in the way, and therefore what they can do about it.
 */
function whyBusy(deps: RebaseDeps, tabId: string, paneId: string, isSelf: boolean): string | null {
  if (!isSelf && deps.turnActive?.(paneId) === true) {
    return 'this chat is in the middle of a turn — its answer would be lost. Wait for it to finish, or stop it first';
  }
  const queued = deps.queued?.(paneId) ?? 0;
  if (queued > 0) {
    return `${queued} message${queued === 1 ? '' : 's'} are still queued here — they would not survive the rebase`;
  }
  const rounds = deps.openRounds?.(tabId) ?? 0;
  if (rounds > 0) {
    return `${rounds} sub-chat${rounds === 1 ? ' is' : 's are'} still working — their results would arrive in a session that no longer exists`;
  }
  // …AND A WORKER THAT HAS FINISHED BUT NOT YET REPORTED. `openRounds` counts
  // `ended_at IS NULL` only, so it misses the gap between a worker's last turn
  // and its summary landing — up to RESULT_GRACE_MS, three minutes. A rebase
  // inside that window relays the report to the OLD runner during the
  // briefing call, stamps the round delivered, and then kills the session that
  // received it. The result is gone AND marked as read, which is the exact
  // loss this check exists to prevent; it was simply looking at the wrong
  // half of the round's life.
  const undelivered = deps.undeliveredRounds?.(tabId) ?? 0;
  if (undelivered > 0) {
    return `${undelivered} worker result${undelivered === 1 ? ' has' : 's have'} not reached this chat yet — a moment`;
  }
  return null;
}

async function rebase(
  deps: RebaseDeps,
  panes: PaneStore,
  pane: NonNullable<ReturnType<PaneStore['getById']>>,
  paneId: string,
  cmd: string,
  mode: RebaseMode,
): Promise<RebaseResult> {
  // ── A CHAT ON ANOTHER MACHINE CAN STILL BE REBASED ───────────────────────
  //
  // This refused outright: "this chat runs on another machine; it has to be
  // rebased there". There is no muxpad UI on that machine, so what it really
  // said was that a remote chat can never be rebased — and the owner hit
  // exactly that, pressing the button on a VM chat running stale
  // instructions.
  //
  // Only ONE of the two rebases needs local files. The TRANSCRIPT rebase
  // rewrites the session JSONL, which lives on the other host. `keep` does
  // not touch it at all: it leaves `--resume` alone and replaces the PROCESS,
  // and a new process reads today's agent-instructions.md at boot. That works
  // remotely exactly as it does here, because `killPane`/`ensurePane` resolve
  // the node from the pane (PaneRouter).
  //
  // So a remote chat falls back to `keep` and SAYS SO, rather than being told
  // no. What it loses is the rewrite of rules quoted inside the history; what
  // it gets is the thing it was asking for.
  const remote = !transcriptIsLocal(deps.db, paneId);
  const ELSEWHERE = 'the transcript is on another machine, so its history could not be rewritten';

  // Told, not silently dropped: `auto` promises the best available, so when
  // the best is not available the answer has to say which one it gave.
  let fallback: string | undefined = mode === 'auto' && remote ? ELSEWHERE : undefined;
  if (mode === 'auto' && !remote) {
    const t = await (deps.transcript ?? transcriptRebase)(deps.db, paneId);
    if (!t.ok && t.reason === 'elsewhere') {
      fallback = ELSEWHERE;
    }
    if (t.ok) {
      // ONLY NOW is anything about the pane changed: the new transcript exists
      // and has passed checkTranscript. Nothing before this line touched the
      // pane, the session row or the old file.
      // Strip first: rewriteResumeCmd only knows the spaced `--resume <sid>`,
      // and an `--resume=<sid>` left beside the new one would resume the OLD
      // conversation or neither.
      const next = rewriteResumeCmd(stripResume(cmd), t.sid, 'claude');
      panes.setStartupCmd(paneId, next);
      try {
        await deps.respawn(paneId);
      } catch (e) {
        // Put it back exactly. The old session file was never touched, so the
        // pane's next start resumes the conversation it had.
        panes.setStartupCmd(paneId, cmd);
        (deps.discard ?? discardRebasedTranscript)(t.path);
        return {
          ok: false,
          code: 'respawn_failed',
          message: `the chat could not be restarted, so it was left as it was: ${(e as Error).message}`,
        };
      }
      // The runner reports the sid on hello as well; recording it here means
      // every read in the gap (chat history, search, headline) already sees
      // the rebased conversation. The old sid stays in the lineage.
      new AgentSessionStore(deps.db).recordSessionId(paneId, t.sid);
      return { ok: true, mode: 'transcript', sid: t.sid, kept: t.kept, briefed: t.briefed };
    }
    fallback = `${t.reason}: ${t.detail}`;
  }

  // ── STEP 2 (and `keep`): the history rides along, only the process is new.
  // NEVER the briefing: `auto` falling through to `fresh` would turn "keep my
  // history" into "summarise it away" with nobody watching. The `--resume`
  // is not touched, so a respawn that throws has changed nothing.
  if (mode === 'auto' || mode === 'keep') {
    try {
      await deps.respawn(paneId);
    } catch (e) {
      return {
        ok: false,
        code: 'respawn_failed',
        message: `the chat could not be restarted: ${(e as Error).message}`,
      };
    }
    return { ok: true, mode: 'keep', ...(fallback ? { fallback } : {}) };
  }

  const briefing = await (deps.brief ?? rebaseBriefing)(deps.db, paneId);
  if (!briefing) {
    // Deliberately BEFORE anything destructive. "Could not summarise" must
    // never become "summarised to nothing, and your chat is gone".
    return {
      ok: false,
      code: 'no_briefing',
      message: 'could not write a briefing from this chat — nothing was changed',
    };
  }

  const fresh = stripResume(cmd);
  if (fresh !== cmd) panes.setStartupCmd(paneId, fresh);
  await deps.respawn(paneId);

  const sent = deps.submit(paneId, wrapRebase(briefing));
  if (sent.status === 'rejected') {
    return {
      ok: false,
      code: 'not_delivered',
      message: `the chat restarted but the briefing was refused: ${sent.reason ?? 'unknown'}`,
    };
  }
  return {
    ok: true,
    mode: 'fresh',
    queued: sent.status === 'queued',
    chars: briefing.length,
  };
}
