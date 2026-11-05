/**
 * WHERE THE PROTECTED TREE LIVES, per platform.
 *
 * One root holding code, runtime, policy and state — the same single-tree
 * layout on both platforms, because every protected-path check walks from the
 * file to `/` and a split layout doubles the number of ancestries that have to
 * be right. Only the root differs:
 *
 *   macOS   /Library/muxpad-broker      LaunchDaemon, `_muxbroker`
 *   Linux   /opt/muxpad-broker          systemd unit, `muxbroker`
 *
 * `/opt` rather than an FHS split across `/etc` and `/var/lib`: this tree is
 * one self-contained appliance installed from a pinned release, not a package
 * whose config an administrator is expected to edit in place. It is also what
 * keeps the installer's path checks a single loop.
 *
 * A platform with no root here is REFUSED rather than defaulted. The paths are
 * compared by exact string at startup (see main.mjs), so a wrong root is not a
 * misconfiguration that degrades — it is a broker that will not start, which is
 * the correct outcome for the process holding the Slack token.
 */
const ROOTS = { darwin: '/Library/muxpad-broker', linux: '/opt/muxpad-broker' };

// Both read once, at load. The refusal names the platform that HAD no root,
// which is the one the operator needs to see — not whatever `process.platform`
// says at the moment some later call happens to fail.
const PLATFORM = process.platform;
export const BROKER_ROOT = ROOTS[PLATFORM] ?? null;

/** A path inside the protected tree, or a throw on an unsupported platform. */
export function brokerPath(...parts) {
  if (!BROKER_ROOT) throw Error(`Protected deployment is not supported on ${PLATFORM}`);
  return [BROKER_ROOT, ...parts].join('/');
}
