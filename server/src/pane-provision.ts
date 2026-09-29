// MAKING A PANE'S PTY EXIST, AND SAYING SO WHEN IT CANNOT.
//
// ─── The bug ───────────────────────────────────────────────────────────────
// Every eager spawn in the tree asked ptyd for the pty inside a bare
// `catch {}`, on the stated reasoning that "the runtime spawns lazily when a
// client attaches". That is true of a TERMINAL pane and false of a CHAT pane:
// the chat view attaches to /ws/chat, never to the pty, so nothing behind the
// eager spawn ever runs. One rejected `ensurePane` and the chat was
// permanently dead — with correct rows, a correct startup_cmd, and no record
// anywhere of what went wrong.
//
// The user's report was "a new chat never starts its agent", and what they saw
// was ChatNoRunner: "Nothing running here · This chat has no agent yet ·
// [Start agent]". That screen is right for a pane that genuinely has none and
// is a LIE for one created two seconds ago, because it describes a steady
// state where there was a failure. It also asks the user to press a button to
// do the thing creating the chat was supposed to have done.
//
// ─── Why a retry, and why it comes first ───────────────────────────────────
// The failures that actually occur here are TRANSIENT, and both were observed
// on this machine:
//
//   · `ptyd disconnected` — PtydClient rejects synchronously whenever its
//     socket is not OPEN, so any ptyd restart or blip turns every create in
//     that window into a dead chat.
//   · `posix_spawnp failed` — the process table is full. ptyd is connected and
//     answering and simply cannot fork.
//
//     WHY IT FILLS, measured rather than assumed, because the obvious guess is
//     wrong: ptyd is NOT leaking zombies and NOT reaping late. Sampled on the
//     live daemon, its `<defunct>` children are all aged 00:00–00:03 and the
//     count goes 0 → 0 → 24 between samples seconds apart. They are reaped
//     promptly. What bursts is the SPAWNING: `PaneManager.pollCmds` fans out
//     over every live runtime at once on a 10s timer, each shelling out up to
//     two `execFile('ps')`, and `pollCwds` does an `execFileSync('lsof')` per
//     pane on a 30s timer. At ~100 panes that is 150–200 forks in one burst
//     every 10s — and the `lsof` one is SYNCHRONOUS, so it blocks the very
//     event loop that has to fork our pty. A create landing inside a burst is
//     the create that fails.
//
//     That is a real bug and it is not this file's: it lives in ptyd, which
//     only picks up changes on a restart that kills every pane on the machine.
//     The retry below is how we survive it in the meantime.
//
// Both clear on their own. So the first duty is to TRY AGAIN — a chat that
// provisions itself on the second attempt is a chat the user never had to
// think about. The recorded reason is what is left over when the ladder is
// genuinely exhausted, not the primary fix.
//
// ─── Why hasPane, and why not IMMEDIATELY ──────────────────────────────────
// ptyd's `ensurePane` handler replies `{ ok: true }` after `getOrCreate`, which
// ends in a synchronous `PaneRuntime.start()`. A spawn that THROWS therefore
// does come back as a rejection — but a pty that starts and exits on the spot
// (a bad shell path, a shell that dies on its rc files) acknowledges fine and
// is gone a tick later. `muxpad pane read` then says "pane has no live pty",
// which is exactly what was reported.
//
// So the success condition is "ptyd acknowledged AND still holds the pane" —
// but the second half only means anything AFTER A DELAY, and getting that wrong
// is the mistake this paragraph exists to stop someone repeating. `getOrCreate`
// registers the runtime before anything could observe it exit, so a same-tick
// `hasPane` answers true even for a pty that is already dying. Measured with
// SHELL pointed at a path that does not exist: node-pty spawns, ptyd acks,
// `hasPane` says TRUE, and the pane is gone a moment later with an EIO write.
// The first version of this checked immediately and passed a test it should
// have failed. See VERIFY_ALIVE_AFTER_MS.
//
// ─── Why it does not hold the response open ────────────────────────────────
// `POST /api/tabs` is the web sidebar's entire create path and 22688ec exists
// to stop it waiting on ptyd (measured: 19.5s and 38.6s under load, for row
// work that costs 4–90ms). So `provisionPane` hands back TWO promises: `first`,
// the initial attempt, which the create races against its 250ms cap; and
// `settled`, the whole ladder, which nobody on the request path awaits. The
// retries happen entirely after the user is already looking at their new chat.
import type Database from 'better-sqlite3';
import type { EventBus } from './events.js';
import { clearProvisionError, setProvisionError } from './pane-provision-state.js';
import { type PtydCache, decoratePane } from './ptyd-cache.js';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import type { PaneRuntimeSpec } from './runtime/PaneRuntime.js';
import { PaneStore } from './store/PaneStore.js';

// The registry lives in pane-provision-state.ts (see the note there — it is
// what keeps decoratePane out of an import cycle with this file). Re-exported
// so callers have ONE module to import from.
export {
  clearProvisionError,
  provisionAttempts,
  provisionError,
  resetProvisionErrors,
  setProvisionError,
} from './pane-provision-state.js';

/**
 * The retry ladder, in ms of delay BEFORE each retry. Four attempts total.
 *
 * Shaped for the two real failure modes, both of which are a burst: the first
 * retry is quick because a momentarily-full process table usually is not full
 * 300ms later, and the tail is long enough to outlast a ptyd reconnect
 * (PtydClient backs off from 250ms) without leaving a broken chat looking
 * hopeful for a minute. Total ceiling ≈ 7.3s from the create.
 *
 * Deliberately bounded. An unbounded retry would hide a genuinely broken
 * machine behind a permanent spinner, and requirement 2 is that a chat which
 * cannot start SAYS so — a silent forever-retry is the same silence in a
 * different costume.
 */
export const PROVISION_RETRY_DELAYS_MS = [300, 1_000, 6_000] as const;

/**
 * How long after ptyd's acknowledgement we check that the pty is still there.
 *
 * Not zero, and that is the entire value of the check — see the note in
 * `attempt`. A pty that fails to exec is registered in ptyd's map first and
 * removed when its exit lands, so an immediate read cannot distinguish it from a
 * healthy shell. 750ms is comfortably past that and still well inside the window
 * where the user is watching "Starting…".
 *
 * Off the request path by construction: the create is released on the
 * acknowledgement, before this wait begins.
 */
const VERIFY_ALIVE_AFTER_MS = 750;

/**
 * WHY THE REGISTRY IS IN MEMORY, not in SQLite.
 *
 * A recorded failure describes a spawn THIS process attempted. A server restart
 * re-ensures every pane from ws.ts's self-heal path anyway, so a persisted
 * failure would outlive the condition it describes and print a stale complaint
 * over a chat that is working perfectly well.
 */
export interface ProvisionDeps {
  db: Database.Database;
  ptyd: PtydClient;
  cache: PtydCache;
  events: EventBus;
}

export interface ProvisionHandles {
  /**
   * The FIRST attempt only. Resolves (never rejects) as soon as ptyd has
   * answered it, one way or the other — this is what a create races against
   * its latency cap.
   */
  first: Promise<void>;
  /**
   * The whole ladder: resolves (never rejects) once the pane is provisioned or
   * every attempt is spent. What a delete chases, and what tests await.
   */
  settled: Promise<void>;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const reason = (err: unknown): string => {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.trim() || 'the pty could not be started';
};

/**
 * Ensure `spec`'s pty exists, retrying a failure per PROVISION_RETRY_DELAYS_MS
 * and recording the reason if it never lands.
 *
 * `attempts` overrides the number of tries (1 = no retries) — used by the
 * paths that are already a user-initiated retry, where a second ladder
 * underneath the first only delays the honest answer.
 */
export function provisionPane(
  deps: ProvisionDeps,
  spec: PaneRuntimeSpec & { attempts?: number },
): ProvisionHandles {
  const panes = new PaneStore(deps.db);
  const total = spec.attempts ?? PROVISION_RETRY_DELAYS_MS.length + 1;
  // Assigned synchronously by the Promise executor below; the no-op initialiser
  // is only there because TS cannot see that.
  let resolveFirst: () => void = () => {};
  const first = new Promise<void>((r) => {
    resolveFirst = r;
  });

  /**
   * One attempt: ask, then — after a beat — check that what we asked for is
   * still there. `onAsked` fires the moment ptyd has answered, before the
   * liveness check, so the create path can be released on the acknowledgement.
   */
  const attempt = async (
    onAsked: () => void,
  ): Promise<{ ok: true } | { ok: false; why: string }> => {
    try {
      await deps.ptyd.ensurePane(spec);
    } catch (err) {
      onAsked();
      return { ok: false, why: reason(err) };
    }
    onAsked();
    // A pane whose row has gone while we were asking is a DELETE that raced this
    // spawn, and the liveness wait below must not extend the ladder for it: the
    // cascade books a chaser kill on `settled` (see inFlightSpawns in
    // agent-tab.ts), so every extra millisecond here is an extra millisecond of
    // orphaned pty. Return at once, with nothing to report about a pane nobody
    // wants.
    if (rowStillThere() !== true) return { ok: true };
    // ─── ACKNOWLEDGED IS NOT ALIVE ────────────────────────────────────────
    // ptyd replies `{ ok: true }` once `getOrCreate` has returned, and
    // `getOrCreate` registers the runtime BEFORE anything could have observed
    // it exit. So a `hasPane` read in the same tick answers true even for a pty
    // that is already dying — measured: with SHELL pointed at a path that does
    // not exist, node-pty spawns, ptyd acks, `hasPane` says true, and the pane
    // is gone a moment later with a failed write. Reading it immediately was
    // therefore worth nothing, which is how the first version of this passed a
    // test it should have failed.
    //
    // The delay buys the whole check. It costs the request path nothing — this
    // runs after `onAsked`, and the caller is racing that against its own cap.
    await sleep(VERIFY_ALIVE_AFTER_MS);
    try {
      if (!(await deps.ptyd.hasPane(spec.id))) {
        return { ok: false, why: 'the pty exited immediately after starting' };
      }
    } catch {
      // hasPane itself failed (ptyd went away between the two calls). The
      // ensurePane DID succeed, so treat the pane as provisioned rather than
      // retrying on the strength of a second, unrelated failure — a spurious
      // re-ensure is how one pane ends up with two live shells.
      return { ok: true };
    }
    return { ok: true };
  };

  /**
   * Does the pane row still exist?
   *
   * `null` means "cannot tell" — the handle was closed under us, which happens
   * to every test that finishes before the ladder does and would otherwise
   * throw here, unhandled, on a promise nobody holds. An unhandled rejection
   * takes the whole server down, so this is the one read that must not throw:
   * "cannot tell" is treated as "stop", the conservative end (we do not
   * re-ensure a pane we can no longer confirm anyone wants).
   */
  const rowStillThere = (): boolean | null => {
    try {
      return panes.getById(spec.id) !== null;
    } catch {
      return null;
    }
  };

  const settled = (async () => {
    let why = '';
    for (let i = 0; i < total; i++) {
      // A row that has gone means the pane was deleted while we were retrying.
      // Re-ensuring it would leave ptyd holding a pty with nothing behind it:
      // invisible to every UI and unreachable by anything except the straggler
      // reconcile, which only runs on a ptyd restart (i.e. one that kills every
      // pane on the machine). Bail silently — there is no failure worth
      // reporting about a pane nobody wants.
      if (i > 0 && rowStillThere() !== true) {
        clearProvisionError(spec.id);
        return;
      }
      const result = await attempt(i === 0 ? resolveFirst : () => {});
      if (result.ok) {
        // Announce a RECOVERY too: a chat showing the failure must drop it the
        // moment a later attempt lands, or the user is told to retry something
        // that is already running.
        if (clearProvisionError(spec.id)) announce(deps, spec.id);
        return;
      }
      why = result.why;
      const delay = PROVISION_RETRY_DELAYS_MS[i];
      if (i < total - 1 && delay !== undefined) await sleep(delay);
    }
    // Out of attempts. Record it, then tell every open surface — see announce.
    if (rowStillThere() !== true) return;
    setProvisionError(spec.id, { error: why, at: Date.now(), attempts: total });
    announce(deps, spec.id);
    console.error(`[provision] ${spec.id}: ${why} (after ${total} attempts)`);
  })().catch(() => {
    // The contract is that NEITHER handle rejects: `settled` is awaited by
    // nobody on the request path (the delete chaser attaches a `.then`), and a
    // rejection there is an unhandled rejection, which is a dead server.
  });

  // `first` must resolve even if the ladder ends some way not anticipated here —
  // a create awaiting a promise that never settles is worse than the bug.
  void settled.finally(() => resolveFirst());
  return { first, settled };
}

/**
 * Fan the pane's current provision state out as `pane.updated`.
 *
 * Through decoratePane like every other pane payload, so the row carries its
 * live status/agents fields too — a raw row blanks the client's status rail.
 * `pane.updated` is the channel because the chat socket is already subscribed
 * to it, so an open chat learns in the same tick rather than on its 10s poll.
 *
 * Exported as `announceProvision` for the respawn route, which records its own
 * verdict (a user-initiated retry does not run a ladder) and still has to push it.
 */
export function announceProvision(deps: ProvisionDeps, paneId: string): void {
  announce(deps, paneId);
}

function announce(deps: ProvisionDeps, paneId: string): void {
  try {
    const row = new PaneStore(deps.db).getById(paneId);
    if (!row) return;
    deps.events.emit({
      type: 'pane.updated',
      tab_id: row.tab_id,
      pane: decoratePane(deps.cache, row, deps.db),
    });
  } catch {
    // Same reason as rowStillThere: this runs off the request path, long after
    // the caller has gone, and must never become an unhandled rejection. The
    // failure is already in the registry — only the push is lost, and the chat
    // socket's 10s session poll picks it up.
  }
}
