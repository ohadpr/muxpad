import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * WHICH PANE IS THIS PROCESS ACTUALLY RUNNING IN.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────
 * The Slack guard resolved pane → tab → workspace on the SERVER, and the
 * commit message was pleased with itself about that: "`MUXPAD_WORKSPACE_ID` is
 * a value the caller can set, and a guard that asks the thing it is guarding to
 * state its own identity is a guard in name only."
 *
 * It then took the pane id from `$MUXPAD_PANE_ID`, which is also a value the
 * caller can set. `MUXPAD_PANE_ID=<a Trayo pane> muxpad slack post …` from a
 * personal chat walked straight through. The spoof test covered the variable
 * that was no longer being used and not the one that was.
 *
 * ── WHY ANCESTRY, AFTER TWO OTHER IDEAS WERE MEASURED AND DROPPED ───────────
 * A process cannot choose its parent. Everything else that was considered can
 * be chosen or read:
 *
 *   the controlling terminal — the obvious answer, and dead on arrival here.
 *     Measured in a live agent pane: `ps -o tty= -p $$` → `??`. The agent
 *     runner is detached from the pty, so every tool call it makes has no
 *     controlling terminal at all and the check would refuse the main caller.
 *
 *   a per-pane secret in the env — genuinely strong on this OS, which was a
 *     surprise: macOS exposes no other process's environment, not through
 *     `ps -E` (measured: 0 hits against a process's own child) and not through
 *     `launchctl procinfo` (root only). But a secret in the environment is one
 *     `env` away from a transcript, and transcripts are readable across panes
 *     with `muxpad agent transcript`. Ancestry leaks nothing.
 *
 * So: the caller sends its own pid, the server walks `ppid` upward, and the
 * first ancestor that is a live pane's shell is the answer. To be attributed to
 * a workspace a process must really be running inside it.
 *
 * ── WHAT THIS IS NOT ────────────────────────────────────────────────────────
 * Not a boundary against a hostile process on this machine. Same uid, so it can
 * fork, debug, and read any file this server can. It is a boundary against a
 * HELPFUL agent reaching for a tool that is in arm's reach, which is the thing
 * that has actually gone wrong here. The only airtight version is a broker
 * under a second OS user.
 */

/** Deep enough for shell → agent → tool → subshell → `muxpad`, with room. */
const MAX_HOPS = 24;

export interface CallerPaneDeps {
  /** Live panes' shell pids — `PtydClient.panePids()`. */
  panePids: () => Promise<Array<{ id: string; pid: number }>>;
  /** Injected in tests; the real one shells out to `ps`. */
  parentOf?: (pid: number) => Promise<number | null>;
}

/**
 * One `ps` call for the whole process table, rather than one per hop.
 *
 * A hop-at-a-time walk is up to 24 `ps` invocations on a path that runs on
 * every Slack call, and each one races the table it is reading: a shell that
 * exits mid-walk turns the chain into a dead end and the caller gets refused
 * for a reason that has nothing to do with them. One snapshot is both faster
 * and self-consistent.
 */
async function processTable(): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  try {
    const { stdout } = await execFileAsync('ps', ['-Ao', 'pid=,ppid=']);
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (m) out.set(Number(m[1]), Number(m[2]));
    }
  } catch {
    // An unreadable process table means we cannot identify anybody. The caller
    // treats an empty map as "no answer", which fails closed.
  }
  return out;
}

/**
 * The pane `pid` is running inside, or null.
 *
 * Null means REFUSE, never "allow by default". The three ways to get it —
 * an unknown pid, a chain that reaches init without passing a pane, and an
 * older ptyd with no `panePids` RPC — are all cases where the server does not
 * know who is calling, and a capability check that does not know who is asking
 * has nothing to check.
 */
export async function callerPane(pid: number, deps: CallerPaneDeps): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  const panes = await deps.panePids();
  if (panes.length === 0) return null;
  const byPid = new Map(panes.map((p) => [p.pid, p.id]));

  // The caller's own pid can be a pane shell — `muxpad` typed at a prompt
  // replaces nothing, but a startup_cmd runs AS the shell on some paths.
  const self = byPid.get(pid);
  if (self) return self;

  const table = await processTable();
  const parent = deps.parentOf;
  let cur = pid;
  const seen = new Set<number>([pid]);
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const next = parent ? await parent(cur) : (table.get(cur) ?? null);
    if (next === null || next <= 1) return null;
    // A cycle is impossible in a real process tree and trivial in a mocked
    // one; refusing beats looping.
    if (seen.has(next)) return null;
    seen.add(next);
    const hit = byPid.get(next);
    if (hit) return hit;
    cur = next;
  }
  return null;
}
