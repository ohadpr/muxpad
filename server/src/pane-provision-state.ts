// THE PROVISION-FAILURE REGISTRY, alone in a file.
//
// Split from pane-provision.ts for ONE reason: `decoratePane` (ptyd-cache.ts)
// has to read it, and the provisioner has to call `decoratePane` to announce a
// failure. Keeping the map here is what stops that from being an import cycle.
//
// The WHY of the registry — what it is for, why it is in memory rather than in
// SQLite, and what the retry ladder around it does — is in pane-provision.ts,
// which is the file to read.
export interface ProvisionFailure {
  /** In the words of whatever refused: "posix_spawnp failed", "ptyd disconnected". */
  error: string;
  at: number;
  attempts: number;
}

const failures = new Map<string, ProvisionFailure>();

/** The reason this pane has no pty, or null if none was recorded. */
export function provisionError(paneId: string): string | null {
  return failures.get(paneId)?.error ?? null;
}

/** How many attempts were spent before giving up (0 if it never failed). */
export function provisionAttempts(paneId: string): number {
  return failures.get(paneId)?.attempts ?? 0;
}

/** Record a pane as out of attempts. */
export function setProvisionError(paneId: string, failure: ProvisionFailure): void {
  failures.set(paneId, failure);
}

/**
 * Forget a recorded failure; true iff there was one.
 *
 * Called by anything that starts the pane by another route — the respawn route
 * behind "Start agent", a runner hello, a delete — so the complaint can never
 * outlive the problem it describes.
 */
export function clearProvisionError(paneId: string): boolean {
  return failures.delete(paneId);
}

/** Test seam: this is module state shared by every caller in the process. */
export function resetProvisionErrors(): void {
  failures.clear();
}
