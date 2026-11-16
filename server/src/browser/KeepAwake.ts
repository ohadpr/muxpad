import { type ChildProcess, spawn } from 'node:child_process';

/**
 * Keeps this Mac from idle-sleeping while a person is on their way to a
 * browser that summoned them.
 *
 * A summons usually goes to a PHONE, and the browser it points at lives on this
 * machine. If the machine idle-sleeps in the minutes before the person arrives,
 * the viewer does not load and a merchant session that was fine at the summons
 * can time out underneath it. So a summons holds the machine awake for a while,
 * and the handback lets go.
 *
 * `/usr/bin/caffeinate` is part of macOS: no app bundle, no permission prompt,
 * no window. `-i` holds off IDLE sleep only — the display may still sleep and a
 * closed lid still wins, which is the right amount of reach for a convenience.
 * `-t` bounds it, so a handback that never comes cannot keep the machine up.
 *
 * Thirty minutes, the figure another harness ships for the same wait. Shorter
 * than the browser's own hold (AwaitingPerson.SUMMONS_HOLD_MS): a sleeping Mac
 * suspends Chrome, it does not kill it, so the page is still there on wake —
 * this only covers the window where somebody is most likely to be on their way.
 */
export const KEEP_AWAKE_SECONDS = 30 * 60;

type Spawn = (cmd: string, args: string[]) => ChildProcess;

export class KeepAwake {
  private readonly held = new Map<string, ChildProcess>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly run: Spawn = (cmd, args) =>
      spawn(cmd, args, { stdio: 'ignore', detached: false }),
  ) {}

  /** Hold the machine awake for this profile's summons. Re-raising restarts the clock. */
  hold(profile: string): void {
    if (this.platform !== 'darwin') return;
    this.release(profile);
    try {
      const child = this.run('/usr/bin/caffeinate', ['-i', '-t', String(KEEP_AWAKE_SECONDS)]);
      child.on('error', () => this.held.delete(profile));
      child.on('exit', () => {
        if (this.held.get(profile) === child) this.held.delete(profile);
      });
      this.held.set(profile, child);
    } catch {
      // A convenience. Failing to hold the machine awake must not fail a summons.
    }
  }

  release(profile: string): void {
    const child = this.held.get(profile);
    if (!child) return;
    this.held.delete(profile);
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }

  /** Profiles currently holding the machine awake — for tests and the log. */
  holding(): string[] {
    return [...this.held.keys()];
  }
}
