// THE REVERSIBILITY GATE — a NAMED LIST of irreversible verbs, not a vibe.
//
// ── Why a list and not a judgement ──────────────────────────────────────────
//
// Two systems, opposite failure modes, same lesson. xAI's Grok Bot gates on
// concrete named actions — send, publish, buy, delete — and that is the part of
// it that works: the rule is auditable, a human can read the list and disagree
// with it, and nothing has to infer intent at 2am. Instinct's failures ran the
// other way: it acted freely, and the ones that hurt were all irreversible —
// nobody minds an agent reading the wrong file twice.
//
// So this file is a list. Every entry names an action, not a risk level, and
// the whole list fits on a screen on purpose: a gate you cannot recite is a
// gate you cannot reason about, and a gate that fires often is one people learn
// to dismiss without reading. Reversible work stays completely frictionless —
// that is the entire promise of Chat mode and this must not dent it.
//
// ── The criterion, stated once ──────────────────────────────────────────────
//
// An action is gated when its EFFECT ESCAPES THE MACHINE OR DESTROYS THE ONLY
// COPY. Concretely, the four verbs:
//
//   send        — speaks as the user to someone or something else
//   publish     — puts bytes somewhere the user cannot take them back from
//   spend       — moves money
//   delete      — destroys data with no undo
//   credentials — changes who can act as the user
//
// That criterion is why a project `.env` edit is NOT here (edit it back) while
// `~/.ssh/authorized_keys` is (it changes who can log in), and why `git reset
// --hard` is NOT here (reflog) while `git push` is (someone else has it now).
//
// ── What this is not ────────────────────────────────────────────────────────
//
// NOT A SANDBOX. `eval "$(echo git push)"` walks straight through it, and no
// amount of pattern work fixes that — the model can always construct a command
// this file cannot read. The threat model is an ACCIDENT: an over-eager agent,
// or, once voice exists, a MISHEARD instruction. In text the composer is the
// eyeball — a misheard `pane send` is arbitrary shell execution, and a human
// reads it before it runs. Voice deletes the composer. This is what replaces
// that eyeball. Claiming more than that would be worse than claiming nothing.

/**
 * SCOPE — narrow on purpose, and stated plainly.
 *
 * The gate runs in CHAT MODE ONLY. Agent mode is muxpad's raw face: it is
 * documented as `--dangerously-skip-permissions` parity, it is what you pick
 * when you want the agent to get on with it, and putting a confirmation in
 * front of that would be answering a question nobody asked. Chat mode is the
 * conversational face — the one a voice layer will drive, and the one where
 * there is no composer for a human to read before something runs.
 *
 * `MUXPAD_GATE=off` turns it off outright. There is deliberately no way to turn
 * it ON for Agent mode from the environment: a gate with two scopes is two
 * behaviours to reason about, and the narrow one is the defensible one.
 */
export function gateEnabled(
  mode: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.MUXPAD_GATE === 'off') return false;
  return mode === 'chat';
}

/** The named verbs. This list IS the policy. */
export type IrreversibleVerb = 'send' | 'publish' | 'spend' | 'delete' | 'credentials';

export interface GatedAction {
  verb: IrreversibleVerb;
  /** Chip label for the question UI. ≤16 chars (AgentQuestion.header's cap). */
  header: string;
  /** The one line the user reads: what is about to happen, and why it sticks. */
  why: string;
  /** The concrete command or path, shown verbatim under the options. */
  detail: string;
}

// ── Tokenising a shell command, just enough ─────────────────────────────────

/** One token of a command, with whether it was quoted. */
interface Token {
  text: string;
  quoted: boolean;
}

/**
 * Split a command segment into tokens, keeping quoted runs whole and FLAGGED.
 *
 * The quoted flag is load-bearing: `git commit -m "push it later"` must not
 * read as a push. Matching only ever looks at unquoted tokens, so a word
 * inside an argument string can never trip a verb.
 */
function tokenize(segment: string): Token[] {
  const out: Token[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let sawQuote = false;
  const flush = () => {
    if (cur || sawQuote) out.push({ text: cur, quoted: sawQuote });
    cur = '';
    sawQuote = false;
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i] as string;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      sawQuote = true;
      continue;
    }
    if (/\s/.test(c)) {
      flush();
      continue;
    }
    cur += c;
  }
  flush();
  return out;
}

/**
 * Split a command line into the individual commands it runs.
 *
 * `cd repo && git push` is a push, and a gate that only read the first command
 * would miss every one of them — chaining is how agents write shell.
 */
function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\n|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Env-var assignments and `sudo`/`command`/`nohup` prefixes, stripped. */
function stripPrefixes(tokens: Token[]): Token[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t) break;
    // An env assignment may itself be quoted (`GIT_SSH_COMMAND="ssh -i k"`),
    // so the assignment shape is tested BEFORE the unquoted requirement.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t.text)) {
      i++;
      continue;
    }
    if (t.quoted) break;
    if (['sudo', 'command', 'nohup', 'time'].includes(t.text)) {
      i++;
      continue;
    }
    break;
  }
  return tokens.slice(i);
}

/** Global flags that swallow the NEXT token as their value. */
const VALUE_FLAGS: Record<string, readonly string[]> = {
  git: ['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'],
  gh: ['-R', '--repo', '--hostname'],
};

/**
 * The positional subcommand path of a command: the unquoted, non-flag tokens
 * after the binary, with value-taking global flags' values skipped.
 *
 * `git -C /repo push` → ['push'];  `git log --grep push` → ['log', 'push']
 * (and only the FIRST element is ever compared, so the second cannot trip it).
 */
function subcommands(tokens: Token[], binary: string): string[] {
  const valueFlags = VALUE_FLAGS[binary] ?? [];
  const out: string[] = [];
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t || t.quoted) continue;
    if (t.text.startsWith('-')) {
      if (valueFlags.includes(t.text)) i++;
      continue;
    }
    out.push(t.text);
  }
  return out;
}

/** Unquoted flags present on a command (`-rf` counts as `-r` and `-f`). */
function flags(tokens: Token[]): Set<string> {
  const out = new Set<string>();
  for (const t of tokens.slice(1)) {
    if (t.quoted || !t.text.startsWith('-')) continue;
    if (t.text.startsWith('--')) out.add(t.text.split('=')[0] as string);
    else for (const ch of t.text.slice(1)) out.add(`-${ch}`);
  }
  return out;
}

/** Non-flag operands of a command, quoted ones included (they are paths). */
function operands(tokens: Token[]): string[] {
  return tokens
    .slice(1)
    .filter((t) => t.quoted || !t.text.startsWith('-'))
    .map((t) => t.text)
    .filter(Boolean);
}

// ── delete: what counts as data ─────────────────────────────────────────────

/**
 * Paths a recursive delete may take without asking.
 *
 * `rm -rf node_modules` is not a data loss event, it is Tuesday. Gating it
 * would fire the gate several times a day on something nobody wants to be
 * asked about, and a gate that fires on Tuesday is a gate people dismiss
 * blind — which is the specific way Grok Bot's approval cards stop working.
 * Everything here is machine-regenerable by definition.
 */
const DISPOSABLE = [
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)(dist|build|out|coverage)(\/|$)/,
  /(^|\/)\.(next|turbo|cache|vite|parcel-cache|pytest_cache|venv)(\/|$)/,
  /(^|\/)target(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /^\/(private\/)?tmp(\/|$)/,
  /^\/var\/folders\//,
  /\.tsbuildinfo$/,
  /\.log$/,
];

function isDisposable(path: string): boolean {
  return DISPOSABLE.some((re) => re.test(path));
}

// ── credentials: the files that ARE the user's identity ─────────────────────

/**
 * Files whose contents decide who can act as the user. A write here is not
 * "editing config" — it is changing access, and the token you overwrote was
 * the only copy.
 *
 * A project's own `.env` is deliberately ABSENT. It is edited constantly in
 * normal work and editing it back costs nothing, so it fails the criterion at
 * the top of this file; including it would be exactly the false gate on every
 * file write that would ruin Chat mode.
 */
const CREDENTIAL_FILES = [
  /(^|\/)\.ssh\//,
  /(^|\/)\.aws\/credentials$/,
  /(^|\/)\.npmrc$/,
  /(^|\/)\.netrc$/,
  /(^|\/)\.config\/gh\/hosts\.yml$/,
  /(^|\/)\.docker\/config\.json$/,
  /(^|\/)\.kube\/config$/,
];

// ── The list ────────────────────────────────────────────────────────────────

interface BashMatcher {
  verb: IrreversibleVerb;
  header: string;
  why: string;
  match(binary: string, subs: string[], f: Set<string>, ops: string[]): boolean;
}

/**
 * EVERY gated shell action, one entry each. Adding a verb is adding a row here
 * and a test in reversibility.test.ts — there is no other place policy lives.
 */
const BASH_MATCHERS: readonly BashMatcher[] = [
  // ── send: speaks as the user ──────────────────────────────────────────────
  {
    verb: 'send',
    header: 'Type into pane',
    why: 'types a command straight into another pane’s shell, as you. It runs there immediately.',
    match: (b, s) => b === 'muxpad' && s[0] === 'pane' && (s[1] === 'send' || s[1] === 'keys'),
  },
  {
    verb: 'send',
    header: 'Message agent',
    why: 'sends a message to another agent as you, and it will act on it.',
    match: (b, s) => b === 'muxpad' && s[0] === 'agent' && s[1] === 'send',
  },
  {
    verb: 'send',
    header: 'Comment',
    why: 'posts publicly under your GitHub account. Edits leave a history.',
    match: (b, s) =>
      b === 'gh' &&
      ((s[0] === 'pr' && (s[1] === 'comment' || s[1] === 'review')) ||
        (s[0] === 'issue' && s[1] === 'comment')),
  },

  // ── publish: bytes you cannot take back ───────────────────────────────────
  {
    verb: 'publish',
    header: 'Push',
    why: 'publishes commits to the remote. Anyone with access can fetch them from that moment.',
    match: (b, s) => b === 'git' && s[0] === 'push',
  },
  // `muxpad publish` is NOT gated, deliberately, and this comment is the rule
  // rather than an omission.
  //
  // It failed the test this file is built on. The criterion is "escapes the
  // machine, or destroys the only copy" — publishing escapes, so it was in.
  // But the other half of the criterion is the one that matters here: gating
  // something done dozens of times a day is how an approval card becomes a
  // thing people tap through without reading, which costs more safety than it
  // buys on the rare call that deserved a stop. Reported from a live session
  // as "these stupid questions all the time".
  //
  // It is also the most reversible thing in this file: `muxpad publish --rm
  // <slug>` takes it down, an `--update=<slug>` republish keeps the previous
  // copy, and the target is a dedicated hardened static server that serves a
  // sandbox CSP and nothing else. Compare `git push` (rewriting history off
  // your machine) or `npm publish` (a version number that can never be reused)
  // — those stay.
  //
  // What publishing risks is CONTENT, not reach: putting something private on
  // a public URL. A prompt cannot evaluate that — it fires identically for a
  // chart and for a credentials file — so the control belongs where it can
  // work: the URL is printed on every publish, and `muxpad publish --rm`
  // undoes it in one command.
  {
    verb: 'publish',
    header: 'Re-point public origin',
    why: 'changes the base URL every published link is served from, including ones already shared.',
    // `--set-base` is the one `muxpad publish` form that is not cheap to undo:
    // it silently re-points links other people already hold.
    match: (b, s, f) => b === 'muxpad' && s[0] === 'publish' && f.has('--set-base'),
  },
  {
    verb: 'publish',
    header: 'Open PR',
    why: 'opens a pull request on the remote, visible to every collaborator.',
    match: (b, s) => b === 'gh' && s[0] === 'pr' && s[1] === 'create',
  },
  {
    verb: 'publish',
    header: 'Merge PR',
    why: 'merges into the target branch. The branch history changes for everyone.',
    match: (b, s) => b === 'gh' && s[0] === 'pr' && s[1] === 'merge',
  },
  {
    verb: 'publish',
    header: 'Release',
    why: 'creates a public release on the remote.',
    match: (b, s) => b === 'gh' && s[0] === 'release' && s[1] === 'create',
  },
  {
    verb: 'publish',
    header: 'npm publish',
    why: 'publishes to the registry. A published version can be deprecated but never replaced.',
    match: (b, s) => ['npm', 'pnpm', 'yarn'].includes(b) && s[0] === 'publish',
  },

  // ── spend: moves money ────────────────────────────────────────────────────
  //
  // Deliberately near-empty, and said out loud rather than padded: muxpad
  // exposes no payment surface, so there is nothing honest to list beyond a
  // payment CLI someone might have installed. The verb is NAMED so the day one
  // appears it has a home, instead of being argued about from scratch.
  {
    verb: 'spend',
    header: 'Charge',
    why: 'moves real money through your Stripe account.',
    match: (b, s) => b === 'stripe' && !['get', 'list', 'logs', 'listen'].includes(s[0] ?? ''),
  },

  // ── delete: no undo ───────────────────────────────────────────────────────
  {
    verb: 'delete',
    header: 'Delete files',
    why: 'recursively force-deletes files that are not build output. There is no trash and no undo.',
    match: (b, _s, f, ops) =>
      b === 'rm' &&
      f.has('-r') &&
      f.has('-f') &&
      ops.length > 0 &&
      ops.some((p) => !isDisposable(p)),
  },
  {
    verb: 'delete',
    header: 'Clean repo',
    why: 'force-deletes untracked files in the working tree. They were never committed, so nothing can restore them.',
    match: (b, s, f) => b === 'git' && s[0] === 'clean' && (f.has('-f') || f.has('--force')),
  },
  {
    verb: 'delete',
    header: 'Drop database',
    why: 'destroys a database.',
    match: (b, s) => b === 'dropdb' || (b === 'psql' && s.includes('DROP')),
  },

  // ── credentials: who can act as the user ──────────────────────────────────
  {
    verb: 'credentials',
    header: 'GitHub auth',
    why: 'changes which GitHub account this machine acts as.',
    match: (b, s) => b === 'gh' && s[0] === 'auth' && s[1] !== 'status',
  },
  {
    verb: 'credentials',
    header: 'Registry login',
    why: 'changes the npm identity stored on this machine.',
    match: (b, s) =>
      ['npm', 'pnpm', 'yarn'].includes(b) && ['login', 'logout', 'adduser'].includes(s[0] ?? ''),
  },
  {
    verb: 'credentials',
    header: 'Keychain',
    why: 'writes to or deletes from the macOS keychain.',
    match: (b, s) => b === 'security' && /^(add|delete|set)-/.test(s[0] ?? ''),
  },
  {
    verb: 'credentials',
    header: 'AWS profile',
    why: 'rewrites the AWS credentials on this machine.',
    match: (b, s) => b === 'aws' && s[0] === 'configure',
  },
  {
    verb: 'credentials',
    header: 'Git identity',
    why: 'changes the name or email every future commit on this machine is signed with.',
    match: (b, s, f) =>
      b === 'git' &&
      s[0] === 'config' &&
      (f.has('--global') || f.has('--system')) &&
      s.some((t) => t === 'user.email' || t === 'user.name' || t === 'user.signingkey'),
  },
];

/** Tools whose `file_path` argument is checked against CREDENTIAL_FILES. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit', 'MultiEdit']);

/**
 * Does this tool call do something that cannot be taken back?
 *
 * Returns null for everything else — which is the overwhelming majority, and
 * is the whole point. Reads, greps, builds, tests, local edits, commits: no
 * question, no pause, no chip to dismiss.
 */
export function classifyAction(toolName: string, toolInput: unknown): GatedAction | null {
  if (FILE_WRITE_TOOLS.has(toolName)) {
    const path = (toolInput as { file_path?: unknown } | null)?.file_path;
    if (typeof path === 'string' && CREDENTIAL_FILES.some((re) => re.test(path))) {
      return {
        verb: 'credentials',
        header: 'Credentials',
        why: 'writes to a file that decides who can act as you. Whatever it replaces is the only copy.',
        detail: path,
      };
    }
    return null;
  }

  if (toolName !== 'Bash' && toolName !== 'BashOutput') return null;
  const command = (toolInput as { command?: unknown } | null)?.command;
  if (typeof command !== 'string' || !command.trim()) return null;

  for (const raw of segments(command)) {
    const tokens = stripPrefixes(tokenize(raw));
    const first = tokens[0];
    if (!first || first.quoted) continue;
    // `/usr/local/bin/git` and `git` are the same verb.
    const binary = (first.text.split('/').pop() ?? first.text).trim();
    const subs = subcommands(tokens, binary);
    const f = flags(tokens);
    const ops = operands(tokens);
    for (const m of BASH_MATCHERS) {
      if (m.match(binary, subs, f, ops)) {
        return {
          verb: m.verb,
          header: m.header,
          why: m.why,
          detail: raw.length > 240 ? `${raw.slice(0, 240)}…` : raw,
        };
      }
    }
  }
  return null;
}

/**
 * The question a gated action renders as, in the shape muxpad ALREADY has:
 * `ask_user`'s `{t:'question'}` frame, the same tappable chips, the same
 * `blocked` pane status, the same push. Deliberately not a second approval UI —
 * a parallel one would be a parallel set of bugs, and the user would have to
 * learn which chip means what.
 *
 * The affirmative label is a constant because the ANSWER is compared against
 * it, and anything that is not exactly it — a second option, a typed reply, a
 * dismissal — is a NO. Fail closed, always.
 */
export const GATE_YES = 'Do it';
export const GATE_NO = 'Don’t';

export function gateQuestion(action: GatedAction): {
  question: string;
  header: string;
  multiSelect: boolean;
  options: Array<{ label: string; description?: string }>;
} {
  return {
    question: `This ${action.why} Go ahead?`,
    header: action.header,
    multiSelect: false,
    options: [
      { label: GATE_YES, description: action.detail },
      { label: GATE_NO, description: 'The agent is told you declined, and carries on without it.' },
    ],
  };
}

/**
 * Is this answer a yes? Only the exact affirmative label is.
 *
 * A typed custom answer ("not to main — use a branch") is a NO whose TEXT is
 * worth forwarding: it reaches the model as the denial reason, so the user's
 * correction steers the next attempt instead of being thrown away.
 */
export function isApproval(
  answers: Array<{ question: string; answers: string[] }> | null,
): boolean {
  if (!answers || answers.length === 0) return false;
  const picked = answers[0]?.answers ?? [];
  return picked.length === 1 && picked[0] === GATE_YES;
}

/** The user's own words from a refusal, if they typed any. */
export function denialNote(
  answers: Array<{ question: string; answers: string[] }> | null,
): string | null {
  const picked = answers?.[0]?.answers ?? [];
  const first = picked[0];
  if (!first || first === GATE_YES || first === GATE_NO) return null;
  return first.slice(0, 300);
}
