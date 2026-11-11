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
        | 'respawn_failed';
      message: string;
    };

export async function runRebase(
  deps: RebaseDeps,
  paneId: string,
  mode: RebaseMode = 'auto',
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

  if (mode !== 'fresh' && !transcriptIsLocal(deps.db, paneId)) {
    return {
      ok: false,
      code: 'elsewhere',
      message: 'this chat runs on another machine; it has to be rebased there',
    };
  }

  let fallback: string | undefined;
  if (mode === 'auto') {
    const t = await (deps.transcript ?? transcriptRebase)(deps.db, paneId);
    if (!t.ok && t.reason === 'elsewhere') {
      return { ok: false, code: 'elsewhere', message: t.detail };
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
