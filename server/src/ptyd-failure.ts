/**
 * Why a pty operation failed, in the words of the thing that failed.
 *
 * NAME THE ERROR, NOT A COMPONENT. Five endpoints and the app registry used to
 * answer "ptyd is unreachable" for every failure, having thrown the real error
 * away with a bare `catch {}`. That sentence was false in the one case that
 * mattered: with the pty table full — macOS caps `/dev/ptmx` handles at
 * `kern.tty.ptmx_max`, 511 on this machine — ptyd is connected, answering, and
 * simply cannot make another pty. The day it happened every surface on the
 * cockpit blamed a healthy daemon, and hours went into the daemon before anyone
 * counted descriptors. The first true line printed afterwards was
 * `posix_spawnp failed`, which is the errno the kernel had been returning the
 * whole time.
 *
 * The 503 and its `ptyd_unavailable` code stay, because a client still needs
 * "could not start it, try again". Only the sentence a human reads changes, and
 * it changes from a guess about a component's health to what actually threw.
 */
export function whyNot(what: string, err: unknown): string {
  const why = err instanceof Error ? err.message : String(err);
  const reason = why.trim();
  return reason ? `cannot ${what}: ${reason}` : `cannot ${what}`;
}
