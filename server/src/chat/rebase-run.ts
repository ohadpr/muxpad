import type Database from 'better-sqlite3';
import { rewriteResumeCmd } from '../agent-resume-repair.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { rebaseBriefing, wrapRebase } from './rebase.js';
import {
  type TranscriptRebaseResult,
  discardRebasedTranscript,
  transcriptRebase,
} from './transcript-rebase.js';

/**
 * PERFORM a rebase.
 *
 * ── THE DEFAULT: SAME TURNS, NEW BASE ────────────────────────────────────
 * "i want the history but I WANT IT REBASED ON THE NEW INSTRUCTIONS." The
 * default is the TRANSCRIPT rebase (transcript-rebase.ts): a new session file
 * holding the same real turns minus every stale instruction that leaked into
 * them, resumed by a fresh runner whose system prompt is today's. The order is
 * the same refuse-before-destroy order as below — the new transcript is
 * written and verified FIRST, the pane is pointed at it only then, and a
 * respawn that throws puts the old `--resume` back and deletes the new file.
 *
 * It falls back to the BRIEFING path — everything below — when a transcript
 * cannot be replayed: a codex/cursor chat, a single turn too large to keep
 * whole, a file that fails the integrity check. A pane on another machine is
 * refused outright; the briefing could not read it either.
 *
 * ── THE FALLBACK: brief, then boot the chat fresh and hand it the briefing ─
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
}

/**
 * `transcript` — the default: keep the turns, drop the stale instructions.
 * `fresh` — skip straight to the briefing: a new, empty session seeded with a
 *           summary. For when the user WANTS the history out of the window.
 */
export type RebaseMode = 'transcript' | 'fresh';

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
      mode: 'fresh';
      queued: boolean;
      chars: number;
      /** Why the transcript rebase was not used, when it was tried. */
      fallback?: string;
    }
  | {
      ok: false;
      code:
        | 'not_found'
        | 'not_an_agent'
        | 'elsewhere'
        | 'no_briefing'
        | 'not_delivered'
        | 'respawn_failed';
      message: string;
    };

export async function runRebase(
  deps: RebaseDeps,
  paneId: string,
  mode: RebaseMode = 'transcript',
): Promise<RebaseResult> {
  const panes = new PaneStore(deps.db);
  const pane = panes.getById(paneId);
  if (!pane) return { ok: false, code: 'not_found', message: 'pane not found' };
  const cmd = pane.startup_cmd ?? '';
  if (!cmd.startsWith('muxpad agent')) {
    return {
      ok: false,
      code: 'not_an_agent',
      message: 'only an agent chat can be rebased — this pane runs no agent',
    };
  }

  let fallback: string | undefined;
  if (mode === 'transcript') {
    const t = await (deps.transcript ?? transcriptRebase)(deps.db, paneId);
    if (!t.ok && t.reason === 'elsewhere') {
      return { ok: false, code: 'elsewhere', message: t.detail };
    }
    if (t.ok) {
      // ONLY NOW is anything about the pane changed: the new transcript exists
      // and has passed checkTranscript. Nothing before this line touched the
      // pane, the session row or the old file.
      const next = rewriteResumeCmd(cmd, t.sid, 'claude');
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

  const briefing = await (deps.brief ?? rebaseBriefing)(deps.db, paneId);
  if (!briefing) {
    // Deliberately BEFORE anything destructive. "Could not summarise" must
    // never become "summarised to nothing, and your chat is gone".
    return {
      ok: false,
      code: 'no_briefing',
      message: `could not write a briefing from this chat — nothing was changed${
        fallback ? ` (transcript rebase refused: ${fallback})` : ''
      }`,
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
    ...(fallback ? { fallback } : {}),
  };
}
