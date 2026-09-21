// The runner's argv, parsed STRICTLY — because the alternative has already
// cost a conversation.
//
// `muxpad agent`'s flags used to be read with four `indexOf` calls, which is a
// parser with no opinion about anything it doesn't recognise. Whatever it
// failed to understand quietly became the absence of a flag, and the absence
// of `--resume` is not a small default: it is "mint a brand-new session". In a
// pane that already had one, that new session says hello, the server's
// self-heal rewrite re-points `current_sid` and `startup_cmd` at it (dropping
// `--backend` on the way), and the real conversation is stranded under an id
// nothing points at any more. `muxpad agent --help` did exactly that to pane
// 01M2R8RT874AC74YR6899FH2ZG — three days of history, recovered afterwards by
// agent-resume-repair.ts.
//
// `--help` was just the first token someone happened to type. Under the old
// scan the same thing was true of `--resume=<sid>` — and `--flag=value` is the
// form the REST of this CLI teaches (`muxpad agent new --model=… --mode=chat`,
// `muxpad agent respawn --all --backend=claude`, every `muxpad cron` flag) — of
// a misspelt `--resme`, of `--resume` with its value missing, of a stray
// positional, and of `--backend codx` (which quietly ran CLAUDE against a codex
// pane's thread id and then converted the pane's harness for good).
//
// Hence the contract here: the runner starts a session only on argv it fully
// understood. Anything else is a loud refusal with usage — a pane that won't
// boot is a five-second fix; a pane that booted the wrong session is a
// forensics job.
//
// The ONE deliberate leniency is `--mode`: an unknown mode WORD is warned about
// and ignored (the pane row is the source of truth and the server converges the
// runner with a `mode` frame right after hello), so a mode spelling from a
// newer server can never brick a pane. A missing or flag-shaped `--mode` VALUE
// is still an error — that is a malformed command, not a newer vocabulary.
import { BASELINE_AGENT_MODE } from '@muxpad/shared';
import { type AgentMode, type BackendId, isBackendId, parseAgentMode } from './protocol.js';

export const RUNNER_USAGE = `usage: muxpad agent [--backend claude|codex|cursor] [--mode chat|agent]
                    [--model <id>] [--resume <session-id>] [--pick]

  Runs the in-pane agent runner. Drive it from the pane's Chat face.
  --resume is written into the pane's startup command by the server; you do
  not normally type it.

  Session-management subcommands (these do NOT start a runner):
    muxpad agent new | list | respawn | send | transcript | wait`;

export interface RunnerArgs {
  /** `--resume <ref>`: the session to continue (null = mint a fresh one). */
  requestedSid: string | null;
  /** `--model <id>`: a launch-time model pin, opaque to the harness. */
  requestedModel: string | null;
  /** `--backend <id>`: which agent CLI/SDK drives the pane. */
  requestedBackend: BackendId;
  /** `--mode chat|agent`: the LAUNCH mode (absent = baseline, see index.ts). */
  requestedMode: AgentMode;
  /** `--pick`: start no session; the chat face shows the harness picker. */
  pick: boolean;
  /** Non-fatal complaints, logged once the pane's log exists. */
  warnings: string[];
}

export type RunnerArgsResult =
  | { kind: 'run'; args: RunnerArgs }
  | { kind: 'help' }
  | { kind: 'error'; message: string };

/** Flags that take a value, in either `--flag value` or `--flag=value` form. */
const VALUE_FLAGS = new Set(['--resume', '--model', '--backend', '--mode']);
/** Flags that take none. */
const BOOL_FLAGS = new Set(['--pick']);

export function parseRunnerArgs(argv: readonly string[]): RunnerArgsResult {
  // Usage FIRST, wherever it appears and whatever it sits next to. Asking a
  // subcommand what it does is a reflex, and it must never be a destructive one
  // — not even when the rest of the command line is nonsense.
  if (argv.some((a) => a === '--help' || a === '-h')) return { kind: 'help' };

  const args: RunnerArgs = {
    requestedSid: null,
    requestedModel: null,
    requestedBackend: 'claude',
    requestedMode: BASELINE_AGENT_MODE,
    pick: false,
    warnings: [],
  };
  const seen = new Set<string>();
  const fail = (message: string): RunnerArgsResult => ({
    kind: 'error',
    message: `muxpad agent: ${message}`,
  });
  // A repeated flag is refused rather than resolved. First-wins (what `indexOf`
  // did) silently prefers the STALE `--resume` in `--resume A --resume B`,
  // which is precisely the shape a rewrite bug leaves behind; last-wins is just
  // the opposite guess. Neither is knowledge.
  const once = (flag: string): string | null => {
    if (seen.has(flag)) return `${flag} given more than once`;
    seen.add(flag);
    return null;
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    let name = token;
    let value: string | null = null;
    const eq = token.startsWith('--') ? token.indexOf('=') : -1;
    if (eq !== -1) {
      name = token.slice(0, eq);
      value = token.slice(eq + 1);
    }

    if (BOOL_FLAGS.has(name)) {
      if (value !== null) return fail(`${name} takes no value (got ${token})`);
      const dup = once(name);
      if (dup) return fail(dup);
      args.pick = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      return fail(
        `unrecognised option ${token} — refusing to start a session rather than guess.\n${RUNNER_USAGE}`,
      );
    }
    const dup = once(name);
    if (dup) return fail(dup);
    if (value === null) {
      const next = argv[i + 1];
      // A value that is really the next flag is a MISSING value. Taking it
      // literally is how `--resume --backend codex` ended up trying to resume a
      // session called "--backend" — a sid the server's hello guard rejects, so
      // the pane attaches to nothing and looks merely "quiet".
      if (next === undefined || next.startsWith('-')) return fail(`${name} needs a value`);
      value = next;
      i++;
    }
    if (value === '') return fail(`${name} needs a value`);

    switch (name) {
      case '--resume':
        args.requestedSid = value;
        break;
      case '--model':
        args.requestedModel = value;
        break;
      case '--backend': {
        if (!isBackendId(value)) {
          // Never fall back to claude here. The runner would hello
          // `backend: claude`, the self-heal rewrite would drop the pane's real
          // `--backend`, and the pane would convert harness permanently with
          // its old thread left behind.
          return fail(`unknown --backend '${value}' (claude|codex|cursor)`);
        }
        args.requestedBackend = value;
        break;
      }
      case '--mode': {
        const mode = parseAgentMode(value);
        if (mode) args.requestedMode = mode;
        else
          args.warnings.push(`ignoring unknown --mode '${value}' (the server sets the real one)`);
        break;
      }
    }
  }

  // `--pick` starts NO session, so anything about a session next to it is an
  // instruction that will be silently dropped. (agent-resume-repair's
  // rewriteResumeCmd appends `--resume <sid>` to whatever a pane's command is,
  // and `muxpad agent --pick` is a command.)
  if (args.pick && (args.requestedSid || args.requestedBackend !== 'claude')) {
    return fail('--pick starts no session — it cannot be combined with --resume/--backend');
  }
  return { kind: 'run', args };
}
