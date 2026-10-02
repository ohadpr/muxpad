import { defineWorkspace } from 'vitest/config';

/**
 * TWO PROJECTS, BECAUSE HALF THIS SUITE CANNOT SHARE A MACHINE WITH ITSELF.
 *
 * Measured: a full parallel `vitest run` reported 12–13 failures across 4–6
 * files. Every one of those files passes alone — 52 of 52 when re-run
 * file-by-file. They spawn REAL things (a ptyd over a unix socket, a main
 * server on a port, a fake runner process) and then contend for them.
 *
 * That is not a cosmetic annoyance, and "we know about those" is not a
 * mitigation. A suite that reports ~13 failures on a clean tree cannot gate
 * anything, and the cost is already proven: a genuine regression (a fixture
 * still reading `last_activity_at` after the ordering moved to `last_user_at`)
 * sat inside exactly this noise and was only caught by running the files one
 * at a time. The noise is not hiding nothing; it hid something once already.
 *
 * ── WHY A LIST AND NOT A GLOB ────────────────────────────────────────────────
 * `src/integration/**` is most of it but not all: `ws.test.ts`,
 * `tab-retire.ws.test.ts`, the agent-runner relay tests and the ptyd-client
 * tests all bind too, and they live beside pure unit files in the same folders.
 * The honest classifier is "does this file start a real listener or spawn a
 * process", which no path pattern expresses — so the serial set is explicit and
 * a new one has to be added here on purpose. A missing entry shows up as the
 * same flakiness this file exists to remove, which is a loud enough failure.
 *
 * ── THE DEFAULT STAYS COMPLETE ───────────────────────────────────────────────
 * `pnpm test` runs BOTH projects, one after the other (see package.json), so
 * nothing silently stops being covered — the slow half is the half that owns
 * the lifecycle paths. `pnpm test:fast` is the inner-loop subset for when you
 * are editing a pure module and know it.
 */
const SERIAL = [
  'src/integration/**/*.test.ts',
  'src/agent-runner/auth-recovery.test.ts',
  'src/agent-runner/notify.test.ts',
  'src/agent-runner/relay.test.ts',
  'src/agent-runner/subagent-leak.test.ts',
  'src/agent-runner/subagent-mirror.test.ts',
  'src/cli-spawn.test.ts',
  'src/cli-wrapper.test.ts',
  'src/lifecycle-queue.test.ts',
  'src/lifecycle-respawn.test.ts',
  'src/lifecycle-send.test.ts',
  'src/agent-resume-repair.test.ts',
  'src/ptyd-client/proxyAttach.test.ts',
  'src/ptyd/index.test.ts',
  'src/routes/browsers.test.ts',
  'src/routes/url-health.test.ts',
  'src/runtime/host-identity.test.ts',
  'src/tab-activity.ws.test.ts',
  'src/tab-retire.ws.test.ts',
  'src/voice/chat-presence.test.ts',
  'src/ws-respawn.test.ts',
  'src/ws.test.ts',
];

export default defineWorkspace([
  {
    extends: './vitest.config.ts',
    test: {
      name: 'unit',
      include: ['src/**/*.test.ts'],
      exclude: ['**/node_modules/**', '**/dist/**', ...SERIAL],
    },
  },
  {
    extends: './vitest.config.ts',
    test: {
      name: 'serial',
      include: SERIAL,
      // NOTE: `fileParallelism: false` DOES NOT WORK HERE. It is a root-level
      // option in vitest 2.1 and is silently ignored inside a workspace
      // project — setting it here looked right and changed nothing. The tell
      // was in the run summary: `tests 1011s` inside a `300s` wall clock, i.e.
      // still fanned out, and 3 of the phantom failures survived. The
      // serialisation is applied by the CLI flag on the `test:serial` script
      // (`--no-file-parallelism`), which is why that script must not be
      // inlined away.
      // These spawn processes and wait on real IO; the 10s default is sized
      // for pure units and is itself a source of false failures here.
      testTimeout: 60_000,
      hookTimeout: 60_000,
    },
  },
]);
