# RV3 — mutation test of `server/src/connectors` at HEAD `3b2337f`

Lane: the test suite. Everything below is **CHECKED** (run) unless marked
**REASONED**. Nothing here touched msgvault data, Google, Slack or the broker:
the only external binary I ran was `msgvault --help`.

## The number

**928 mutants, 303 survive** (32.9% of the 920 that compile).

- **Generated:** 838 by a line-based operator generator, plus 90 hand-written
  semantic mutants that the operators cannot express (for example "read by
  path instead of fd" or "a write relabelled as a read").
- **Invalid:** 8 did not compile, so they are excluded from the count.
- **Killed:** 614 failed a test outright. Another 3 hung in an infinite loop
  in the ancestor walk; the harness kills those at 30 s and counts them as
  killed.
- **Survived:** 303. Every one is listed in the appendix.

The suite ran unmodified each time: 92 tests in 4 files.

| file | mutants | survived |
|---|---|---|
| scope.ts | 439 | 108 |
| registry.ts | 208 | 99 |
| passthrough.ts | 281 | 96 |

How the 303 survivors break down:

- **30 type-only** (`T`): the line is a type, which esbuild removes before
  the code runs, so no test could kill it.
- **24 equivalent** (`E`): the code changes, but nothing reachable behaves
  differently. Each one is in the appendix with its reason.
- **249 real gaps.** Only 5 of these change nothing but a reason string. The
  other 244 change a decision, a field in the audit record, or the shape of
  a command.

**About the earlier "23 of 39":** that was a hand-picked set run against
`6770682`. The equivalent figure here is my 90 hand-written semantic mutants,
of which **42 survive**. The systematic count, the 303 above, is the real
number for HEAD.

**With the tests in Part 3 added, 60 survive.** Those are the 30 type-only,
the 24 equivalent, and 6 more:

- **4 need a decision before a test can be written** (see #8 and #10):
  - 10057: `mayPaneUse`'s default policy;
  - 10034: the tie-break;
  - 10069: `-o=x`;
  - 10090: group-*writable* archive.
- **2 are a known bug that still throws instead of answering** (298 and 300).

On the 60, the counts are CHECKED, but the remaining 6 are REASONED to
need a decision rather than another test.

Harness: `/tmp/rv3mut/harness/`. It works on a scratch copy outside Dropbox and
never writes to the shared tree.
- `gen.mjs` makes the operator mutants, and `manual.mjs` holds the 90 by hand.
- `run.mjs` runs them, 8 at a time, with `--reporter=json`, and records which
  tests fail for each mutant.
- `run2.mjs` runs the deletion of each test assertion.
- `results.json` is the run before the new tests and `after_merged.json` the
  run after.

To re-run: `cd /tmp/rv3mut/harness && node gen.mjs && W=8 node run.mjs`.

Operators applied, on every non-comment line:
- delete each statement, object or array element;
- negate each `if`, and force it true and false;
- swap `===`/`!==` and `<`/`<=`/`>`/`>=` both ways;
- swap `&&`/`||`/`??`, and drop each arm;
- delete each unary `!`;
- change numbers by +1, −1, to 0 and ×1000, and flip each octal mode bit;
- flip `true`/`false`;
- replace each string and template with a sentinel;
- regexes: drop `^` and `$`, add `/i`, widen `{0,31}`;
- change return values (`null`→string, `UNSCOPED`↔sealed, `ok:true`→`false`);
- swap `.includes`→prefix, drop `Object.hasOwn`, drop `.trim`/`.sort`, flip
  SQL `ASC`/`DESC`, `IS NOT NULL` and `LIMIT`.

The test files were mutated as well. Each of their 183 `expect(` lines was
switched off with `false && expect(…)`, and the suite was re-run against
every source mutant that the test holding that line was the only one to
kill.

**125 of the 183 assertions guard nothing unique.** Switching any one of
them off lets no extra mutant survive. By file:
- `scope.test.ts`: 77 of 103;
- `registry.test.ts`: 18 of 26;
- `passthrough.test.ts`: 26 of 49;
- `passthrough.bypass.test.ts`: 4 of 5.

No test kills zero mutants. The weakest kill 1–3, and none of those kills is
unique to them:
- "maps no command onto a send or a calendar invite";
- "does not flag a draft";
- "holds even if the table itself says otherwise".

---

## Part 1 — Findings, most severe first

### 1. HIGH — Nothing independent checks "no write rides a timed grant" — CHECKED

The tests derive their expectations from the table under test, so relabelling
a write as a read changes the expectation too. Each of these survives the whole
suite and turns a write into a **timed read**, which an existing day-grant
would then cover:

| mutant | effect |
|---|---|
| 10061 `'slack.dm': {kind:'read', timed:true}` | DMs sent under a day grant |
| 10059 `'slack.react'` → read/timed | reactions under a day grant |
| 10062 `'msgvault.draft.delete'` → read/timed | deleting drafts under a day grant |
| 10081 `COMMAND_VERBS['draft-delete'] = 'msgvault.message.read'` | same, via the command map |
| 10082 `COMMAND_VERBS['draft-edit'] = 'msgvault.search.read'` | editing drafts under a day grant |
| 435/436 etc. `slack.upload/edit/unpost/dm/react` lose `notifiesOthers` | the prompt stops saying it reaches other people |

The model review saw `react` and the `COMMAND_VERBS` remaps at `6770682`.
At HEAD they still survive, and so do `dm`, `draft.delete` and every
`notifiesOthers` flag except `post`'s and `calendar.write`'s.

Altogether 72 mutants of the verb table survive (group `R-table`). Every
verb's `kind`, `timed` and `notifiesOthers`, and every key, can change without
a test failing, except these:
- `slack.post` and `slack.search`;
- `msgvault.search.read`, `calendar.read`, `calendar.write` and `calendar.invite`'s reason.

**Why no test notices:** "holds for every write in the table" iterates `VERBS`
and filters `rule.kind === 'write'`, so a relabelled verb leaves the loop.
"Asks for a verb the registry can classify" checks only `ok`, not `kind`.
`passthrough.bypass.test.ts` checks one draft verb, `draft-reply`.

**Fix:** Part 3, "the verb table, pinned literally" and "COMMAND_VERBS is
exactly this table". A literal expected table is the independent oracle. It
kills all 72 `R-table` mutants and all 42 `P-verbs` mutants.

### 2. HIGH — Token minting is one map line from passing as a timed read — CHECKED

`judgeArgv(['agent-token','issue', …])` returns `{ok:true, command:'agent-token issue'}`.
Only the *absence* of a `COMMAND_VERBS` entry stops it.

Mutant 10086 adds `'agent-token issue': 'msgvault.stats.read'`, which turns
minting a delegation token into a timed stats read. It survives.

The test called "maps no command onto a send or a calendar invite" only greps
for `/send/` and `calendar.invite`. And there is no test, unit or bypass, that
names `agent-token` at all. The same holds for `query`: mapping it (10085)
survives as well. That is harmless today only because `REFUSED_COMMANDS`
catches it first.

**Fix:** pin the map exactly (Part 3), and add an end-to-end case for
`agent-token issue` ("no draft verb, and no token minting, rides a timed grant
end to end").

### 3. MEDIUM — A read error after a trusted open still fails OPEN, untested — CHECKED

Mutant 260 has `loadPolicy`'s outer `catch` return `UNSCOPED`. With it, an
`EIO` on a root-owned policy file switches scoping off without a word.

Review 2 listed this survivor. It still survives at HEAD, although the
injected `PolicyIO` added in `8f3313f` now makes the test three lines long.
Mutants 258 and 259, on the same line, survive too.

**Fix:** Part 3, "a READ that throws seals" and "an FSTAT that throws seals".

### 4. MEDIUM — The fixtures test a schema production does not have — CHECKED

The real schema differs from the fixtures in two ways (`migrations.ts:1577`
and `:1585`):
- `panes.node_id` is `TEXT NOT NULL DEFAULT 'local'`, and `PaneStore.create`
  writes `'local'`;
- `runMigrations` inserts a `nodes` row with the id `local`.

Both hand-written fixtures in `scope.test.ts` instead use
`CREATE TABLE panes (id, node_id)` with `node_id = NULL` for a local pane, and
have no `local` node.

So:
- **The `raw === null` arm is dead in production, and it is the only local
  path the suite exercises.** The test called "resolves a pane with no node
  row as local" pins a state the schema rejects.
- **The live path has no test.** That path is `node_id = 'local'`, resolved
  by the `raw === LOCAL_NODE_ID` arm, or by `NodeStore.get('local')` when the
  arm is dropped. Mutant 330 survives, and it would be *killed* on the fixture
  schema were a `'local'` pane in it. It is equivalent only because the real
  `local` node row exists.
- **The fixtures also allow states production cannot reach.** One is a
  `NULL` node. Another is a pane with no tab: the real table has `tab_id NOT
  NULL` and foreign keys.

**Fix:** build the database with `runMigrations` and the real stores (Part 3,
"mayPaneUse on the REAL schema"). Keep the hand-written schema only for
states that genuinely need forging, like a blank `node_id`, which the real
route accepts.

### 5. MEDIUM — A test pins the denylist behaviour a previous review asked to remove — CHECKED

`passthrough.test.ts:91` reads:

```ts
expect(v.ok, sub).toBe(true); // not on the ban list…
```

It runs over `calendar create|update|delete|move|respond`. The model review's
#7 fix, "make `judgeArgv` itself refuse an unmapped command", would *fail*
this test. As written, it locks in the two-list design that review called
the bug.

The "fail-closed half" is `verbForCommand(…) === null`, and it has no
production caller. `rg` finds no import of any of the three modules outside
`server/src/connectors/`. The only place that composition exists is the
`asked` helper inside `passthrough.bypass.test.ts`.

**Fix:** once `judgeArgv` refuses unmapped commands, change line 91 to
`toBe(false)`. Until then, add a comment saying the assertion is expected to
flip.

### 6. MEDIUM — `enforced` and `origin` on enforced decisions are unpinned — CHECKED

18 mutants survive in three groups (`S-decision`, `S-unknownfields`,
`S-directedfields`):

- **`enforced` reads `false` on a decision that was enforced.** This covers
  all three `mayUse` outcomes (119, 131, 136), the unknown-pane refusal (323,
  10047), the unknown-machine refusal (347) and the directed refusal (377,
  10054). The audit record would then say "nothing was scoped" about a
  decision that was. The module's header calls this flag the honest part of
  the design, yet only `UNSCOPED` pins it.
- **The unknown-pane refusal reports `origin: 'local'` (10048).** That
  attributes a request from a non-existent chat to the mini.
- **The directed refusal drops its `origin` (376).**

**Fix:** assert whole decision objects with `toEqual`, not `.ok` (Part 3, "every
decision says whether it was enforced…" and "mayPaneUse refusals, whole").

### 7. MEDIUM — Unknown chats are refused while scoping is off, but no test says so — CHECKED

Mutant 10049 is `if (!row && policy.enforce)`. Mutant 10050 is the same for
an unknown machine. Both survive: every unknown-pane test passes
`enforce: true`.

`UNSCOPED` is the shipping state, so these mutants would let an invented pane
id get `ok:true` in production today.

**Fix:** Part 3, "unknown pane is refused even while scoping is OFF".

### 8. MEDIUM-LOW — The laundering window and the sender lookup are still unpinned, and two of their bugs are still there — CHECKED

- **The window constant is unpinned.** `15→14/16/15000` and `60_000→59999/60001/×1000`
  all survive (263–270, 10042), and so does the boundary swap `>`→`>=` (287).
- **Future-dated rows are unpinned.** A row in the future currently still
  directs the chat, which errs toward refusing; `Math.abs` would make it
  forget instead (10041).
- **The sender tab's machine is unpinned.** Changing "first pane" to "newest
  pane" survives (295, 10036). That launders through a tab holding both a
  local and a VM pane.
- **The model review's #8 bugs are still in HEAD.** Two `it.fails` tests in
  Part 3 pass today, which proves both:
  - a sender tab that no longer exists makes `directingOrigin` return `null`,
    which allows the request;
  - a sender on `node_id ""` counts as `local`.

  Mutants that *fix* them survive the current suite (10038, 10039, 10040). The
  `it.fails` markers are written to flip once the code is fixed. Mutants
  298/300 (crash instead of `null`) still survive, because the `it.fails`
  test passes either way.
- **The tie-break is undecided (10034).** `ORDER BY i.at DESC` with no
  tie-break orders two directions in the same millisecond arbitrarily. A
  test now would pin an arbitrary answer, so this needs `, i.rowid DESC` in
  the code first.

### 9. LOW-MEDIUM — Policy-file parsing is unpinned at the edges — CHECKED

- **A `"*"` entry would allow everyone (10019).** So would trimming or
  lower-casing entries read from the *file* (10016, 10017). The exact-match
  tests vary the origin, never the policy.
- **Dropping the key regex's `$` survives (62).** Keys like `slack.post` and
  `slack evil` would then be accepted. So does widening `{0,31}` (64).
- **Empty strings in a list are kept (72, 75).** Review 1 found this; it
  still survives.
- **Non-strings in a list are kept (74, 10015).**
- **A missing `allow`, or `"allow": null`, throws (51, 55).** It throws out of
  `readPolicy`. In `loadPolicy` the same input becomes a "could not be read"
  seal, which is the wrong reason.
- **`parsePolicy('')` and `parsePolicy(null)` returning `UNSCOPED` is
  unpinned (12–25).** That is nine mutants on one line.
- **The BOM strip only matters at the start, and that is unpinned (28,
  10013).**

**Fix:** Part 3, "policy entries are taken literally".

### 10. LOW — Most of what the suite calls "needs root" doesn't — CHECKED

The comment at `scope.ts:218-226`, and the suite's layout, treat `realIO` as
untestable. Review 2's survivors `O_NONBLOCK` (10001) and read-by-fd (10003)
still survive, and so do deleting `realIO.read`, `lstat` or `close`, and
`'utf8'`→anything (179–182). None of them needs root:

- `/usr/share/misc/syscalls.json` ships with macOS and is a trusted file:
  - root-owned, mode 0444, one link;
  - under `/usr/share/misc`, `/usr/share`, `/usr` and `/`, all root-owned 0755.

  `loadPolicy(SYS, realIO)` walks the entire trusted success path for real
  and returns `{enforce:false, allow:{}}`. That kills "read by path".
- A FIFO made with `mkfifo` in the temp directory proves `O_NONBLOCK`. The
  open runs in a child process with a timeout, because a blocking open would
  wedge the test worker.
- Opening a file, replacing it by `rename`, then reading through the fd proves
  that `realIO.read` reads the opened file.

**One branch does need root:** `mayPaneUse`'s default parameter
`policy = loadPolicy()` (10057). The default is only distinguishable from
`UNSCOPED` if `/Library/muxpad/connectors.json` exists. **Fix:** make the
policy argument required, so each call site has to name its source.

### 11. LOW — The suite depends on not running as root — REASONED

"SEALS everything when the file is not root-owned" writes a file in
`os.tmpdir()` and expects `/not root-owned/`.

Under root, which is what the `trayo` VM's passwordless sudo or a Docker CI
gives you, the file *is* root-owned. The walk would then stop at a
world-writable ancestor such as `/tmp` (1777) with "writable by its group or
by everyone". The regex would fail.

**Fix:** assert `p.problem` matches `/not root-owned|writable/`, or skip when
`process.getuid?.() === 0`.

### 12. LOW — `VERBS` is a mutable export — CHECKED

The Part 3 belt tests work by writing into `VERBS`. That proves any code in
the process can add `'msgvault.send'` at runtime, and `classify` will accept
it.

These modules are advisory, so this is low. Still, the mutability is the
only reason the belt can be tested at all. **Fix:** freeze the table and
export `classifyWith(table, verb)` for the test.

### 13. LOW — `judgeArgv` can return `ok:true` on a refusal path, and no test notices — CHECKED

- **Flags only (704).** The `head === undefined` branch can return `ok:true`.
  The test asserts only `.reason`, so a name of "refuses nothing to run"
  promises more than the test checks.
- **A non-string argument (646, 648, 651).** The `typeof raw !== 'string'`
  branch can be deleted or return `ok:true`. Argv from an HTTP body is not
  guaranteed to be strings.
- **Unpinned lists.** 14 of the 16 `NESTED` parents (28 mutants), 4
  `REFUSED_COMMANDS` entries (`export-attachment`, `export-discord`, `skills`,
  `openapi`) and `--help`/`-h` in `VALUELESS_FLAGS` can each be deleted
  without a test failing.

### 14. INFO — The comments overstate what the code decides — REASONED

- `scope.ts:162-164` and `scope.test.ts:5` say this is "the function that
  decides whether a personal chat can touch the work Slack". The broker
  decides; this is the advisory copy. The header of the same file says so,
  but the docstring a reader lands on does not.
- `registry.test.ts`'s describe, "no write may ride a grant approved
  earlier", reads like an enforcement test. What it really tests is a table
  muxpad's own agents can edit.

## Part 2 — Verified sound (killed, CHECKED)

- **`if`, `!` and comparisons.** Every `if` negation (45 of 45) and every
  unary-`!` deletion (17 of 17) is killed. So is every comparison swap in
  `passthrough.ts`.
- **The ancestor walk.** Review 2's survivors are now all killed:
  - starting at the grandparent, or at the file itself;
  - stopping below `/`;
  - an `lstat` error read as `null`;
  - dropping the symlink, uid or mode check;
  - accepting uid 501;
  - each single-bit mode weakening, on the file and on the directories.

  The walk's terminators all hang or fail.
- **Opening the file.**
  - `O_NOFOLLOW` dropped: killed.
  - `fstat` replaced by `lstat(path)`: killed.
  - EACCES read as `UNSCOPED`: killed.
  - Empty or whitespace-only file not sealed: killed.
  - `enforce` treated as truthy or default-on: killed.
  - A sealed policy that allows something, or is not enforced: killed.
- **The laundering query.** The wash (`IS NOT NULL` dropped), taking the
  oldest direction, joining on the sender, skipping local senders, a 15 ms
  window, and blank-origin-as-local (the old bug) are all killed. So is
  skipping the node-existence check.
- **Problem substitution.** Every origin-path substitution mutant is killed.
- **`FORBIDDEN_FLAGS`.** All 12 delete and rename mutants are killed. So are
  the forbidden check run on the raw token (where the `=` form would escape),
  both `flagName` mutants, short flags treated as operands, the nested
  subcommand taken from the last bare token, a nested command collapsed to
  its parent, and the refused check run on the last bare token.
- **`mediationReady`.** Every branch except its "no archive" reason text is
  killed.

## Part 3 — Tests that kill the survivors

Paste the file below as `server/src/connectors/rv3.test.ts`. It runs against
the current tree and passes, 43 tests. It reaches
`broker/core.mjs` with `../../../broker` and spawns `tsx` from `server/`.

With it added, the full mutant run goes from 303 survivors to 60: the 30
type-only, the 24 equivalent and the 6 named in "The number". Run
`biome format` on it, because I matched behaviour, not the repo's line width.

```ts
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { judgeArgv, mediationReady, passthroughCommands, verbForCommand } from './passthrough.js';
import { REFUSED_COMMANDS, VERBS, classify, verbsOf } from './registry.js';
import {
  DIRECTED_WINDOW_MS,
  POLICY_PATH,
  UNSCOPED,
  ancestorProblem,
  directingOrigin,
  loadPolicy,
  mayPaneUse,
  mayUse,
  parsePolicy,
  readPolicy,
  realIO,
} from './scope.js';

// ─────────────────────────────── scope: decisions ───────────────────────────

describe('every decision says whether it was enforced, and where it came from', () => {
  const P = { enforce: true, allow: { slack: ['trayo'], empty: [] as string[] } };
  it('no entry', () => {
    expect(mayUse('msgvault', 'trayo', P)).toEqual({
      ok: false,
      origin: 'trayo',
      enforced: true,
      reason: `no machine is allowed to use msgvault — edit ${POLICY_PATH} as root`,
    });
  });
  it('an EMPTY list is "no machine", not "scoped to nobody"', () => {
    expect(mayUse('empty', 'trayo', P).reason).toMatch(/^no machine is allowed to use empty/);
  });
  it('wrong machine', () => {
    expect(mayUse('slack', 'local', P)).toEqual({
      ok: false,
      origin: 'local',
      enforced: true,
      reason: 'slack is scoped to trayo; this chat runs on local',
    });
  });
  it('allowed, enforced', () => {
    expect(mayUse('slack', 'trayo', P)).toEqual({ ok: true, origin: 'trayo', enforced: true });
  });
  it('the policy path is the root-owned one', () => {
    expect(POLICY_PATH).toBe('/Library/muxpad/connectors.json');
  });
});

describe('policy entries are taken literally', () => {
  const p = (allow: unknown) => readPolicy(JSON.stringify({ enforce: true, allow }));
  it('does not trim, fold case or honour a wildcard in the FILE', () => {
    expect(mayUse('slack', 'trayo', p({ slack: ['Trayo'] })).ok).toBe(false);
    expect(mayUse('slack', 'trayo', p({ slack: [' trayo'] })).ok).toBe(false);
    expect(mayUse('slack', 'trayo', p({ slack: ['*'] })).ok).toBe(false);
  });
  it('drops empty strings and non-strings from a list', () => {
    expect(p({ slack: ['', 'trayo'] }).allow.slack).toEqual(['trayo']);
    expect(p({ slack: [['trayo'], { length: 1 }, 7, 'x'] }).allow.slack).toEqual(['x']);
    expect(mayUse('slack', '', p({ slack: ['', 'trayo'] })).ok).toBe(false);
  });
  it('rejects keys that are not whole connector names', () => {
    expect(Object.keys(p({ 'slack.post': ['t'], 'slack evil': ['t'], ['a'.repeat(33)]: ['t'] }).allow)).toEqual([]);
    expect(Object.keys(p({ ['a'.repeat(32)]: ['t'] }).allow)).toEqual(['a'.repeat(32)]);
  });
  it('strips only a LEADING BOM', () => {
    const raw = '{"enforce":true,"allow":{"sl﻿ack":["trayo"]}}';
    expect(parsePolicy(raw)?.allow).toEqual({});
    expect(parsePolicy(`﻿${raw}`)?.allow).toEqual({});
  });
  it('a policy with no allow, or a null one, parses rather than throwing', () => {
    expect(readPolicy('{"enforce":true}')).toEqual({ enforce: true, allow: {} });
    expect(readPolicy('{"enforce":true,"allow":null}')).toEqual({ enforce: true, allow: {} });
  });
  it('parsePolicy reads nothing as UNSCOPED, not as "not a policy"', () => {
    expect(parsePolicy('')).toEqual(UNSCOPED);
    expect(parsePolicy(null)).toEqual(UNSCOPED);
    expect(parsePolicy(undefined)).toEqual(UNSCOPED);
  });
});

// ─────────────────────────────── scope: the file ────────────────────────────

describe('loadPolicy, through the injected seam', () => {
  const FILE = { isFile: () => true, uid: 0, mode: 0o644, nlink: 1 } as never;
  const DIR = { isFile: () => false, isDirectory: () => true, isSymbolicLink: () => false, uid: 0, mode: 0o755 } as never;
  const io = (over: Partial<import('./scope.js').PolicyIO>) => ({
    open: () => 3,
    fstat: () => FILE,
    read: () => '{"enforce":true,"allow":{"slack":["trayo"]}}',
    close: () => {},
    lstat: () => DIR,
    ...over,
  });
  it('a READ that throws seals', () => {
    const p = loadPolicy('/L/c.json', io({ read: () => { throw new Error('EIO'); } }));
    expect(p).toEqual({ enforce: true, allow: {}, problem: '/L/c.json could not be read' });
  });
  it('an FSTAT that throws seals', () => {
    const p = loadPolicy('/L/c.json', io({ fstat: () => { throw new Error('EBADF'); } }));
    expect(p.enforce).toBe(true);
    expect(p.problem).toBe('/L/c.json could not be read');
  });
});

describe('the REAL filesystem calls, without root', () => {
  // A root-owned, 0444, single-link regular file under root-owned 0755
  // directories ships with macOS. It is not a policy, but it is TRUSTED, so
  // it walks every realIO call on the success path — no root needed.
  const SYS = '/usr/share/misc/syscalls.json';
  it.skipIf(!existsSync(SYS))('loads a real root-owned file through realIO', () => {
    expect(ancestorProblem(SYS, realIO)).toBeNull();
    expect(loadPolicy(SYS, realIO)).toEqual({ enforce: false, allow: {} });
  });
  it('the real ancestor walk names a directory the test user owns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv3-'));
    expect(ancestorProblem(join(dir, 'c.json'), realIO)).toMatch(/is not root-owned$|is a symlink$/);
  });
  it('realIO.read reads the OPEN file, not whatever the path names now', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv3-'));
    const f = join(dir, 'c.json');
    writeFileSync(f, 'first');
    const fd = realIO.open(f);
    writeFileSync(join(dir, 'other'), 'second');
    renameSync(join(dir, 'other'), f);
    expect(realIO.read(fd)).toBe('first');
    realIO.close(fd);
  });
  it('realIO.open does not hang on a FIFO, and loadPolicy seals it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rv3-'));
    const fifo = join(dir, 'c.json');
    execFileSync('mkfifo', [fifo]);
    // In a child, because a blocking open would wedge this worker for good.
    const r = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '-e',
        `import('${join(__dirname, 'scope.ts')}').then(m => console.log(JSON.stringify(m.loadPolicy(${JSON.stringify(fifo)}))))`,
      ],
      { timeout: 8000, encoding: 'utf8', cwd: join(__dirname, '../..') },
    );
    expect(r.error, 'open blocked on the FIFO').toBeUndefined();
    expect(JSON.parse(r.stdout).problem).toMatch(/not a regular file/);
  });
});

// ─────────────────────────────── scope: panes ───────────────────────────────

describe('mayPaneUse on the REAL schema', () => {
  const real = async () => {
    const { runMigrations } = await import('../store/migrations.js');
    const { WorkspaceStore } = await import('../store/WorkspaceStore.js');
    const { TabStore } = await import('../store/TabStore.js');
    const { PaneStore } = await import('../store/PaneStore.js');
    const db = new Database(':memory:');
    runMigrations(db);
    const ws = new WorkspaceStore(db).create({ name: 'W' });
    const tab = new TabStore(db).create({ name: 'T', layout: 'x', workspace_id: ws.id });
    const pane = new PaneStore(db).create({ tab_id: tab.id });
    return { db, pane };
  };
  it('a pane created the normal way stores "local", and that is local', async () => {
    const { db, pane } = await real();
    expect((db.prepare('SELECT node_id FROM panes WHERE id = ?').get(pane.id) as { node_id: unknown }).node_id).toBe('local');
    const policy = { enforce: true, allow: { msgvault: ['local'] } };
    expect(mayPaneUse(db, 'msgvault', pane.id, policy)).toEqual({ ok: true, origin: 'local', enforced: true });
  });
});

describe('mayPaneUse refusals, whole', () => {
  const db = () => {
    const d = new Database(':memory:');
    d.exec('CREATE TABLE panes (id TEXT PRIMARY KEY, node_id TEXT)');
    d.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, endpoint TEXT, status TEXT, last_seen INTEGER, capabilities TEXT, created_at INTEGER)');
    d.prepare("INSERT INTO nodes (id, name, endpoint) VALUES ('trayo','VM','ws://x')").run();
    d.prepare("INSERT INTO panes VALUES ('p-vm','trayo'), ('p-empty',''), ('p-gone','removed')").run();
    return d;
  };
  const policy = { enforce: true, allow: { slack: ['trayo'] } };
  it('unknown pane', () => {
    expect(mayPaneUse(db(), 'slack', 'invented', policy)).toEqual({
      ok: false,
      origin: '',
      enforced: true,
      reason: 'no such chat — a connector is used by a chat, and that one does not exist',
    });
  });
  it('unknown pane is refused even while scoping is OFF', () => {
    expect(mayPaneUse(db(), 'slack', 'invented', UNSCOPED)).toMatchObject({ ok: false, enforced: false });
    expect(mayPaneUse(db(), 'slack', 'p-gone', UNSCOPED)).toMatchObject({ ok: false, enforced: false });
  });
  it('pane ids match exactly', () => {
    expect(mayPaneUse(db(), 'slack', 'P-VM', policy).ok).toBe(false);
  });
  it('unknown machine, and a blank one', () => {
    expect(mayPaneUse(db(), 'slack', 'p-gone', policy)).toEqual({
      ok: false,
      origin: 'removed',
      enforced: true,
      reason: "that chat's machine is not one muxpad knows (removed)",
    });
    expect(mayPaneUse(db(), 'slack', 'p-empty', policy)).toMatchObject({ ok: false, origin: '', enforced: true });
  });
  it('directed refusal carries the worker origin and enforced:true', () => {
    expect(mayPaneUse(db(), 'slack', 'p-vm', policy, 'local')).toEqual({
      ok: false,
      origin: 'trayo',
      enforced: true,
      reason: 'this chat may use slack, but it was directed to by a chat on local, which may not',
    });
  });
  it('a sealed policy names its problem on the directed path too', () => {
    // Not reachable today (a sealed policy refuses the origin first); pins the
    // wrapper so a reorder cannot drop it.
    const sealed = { enforce: true, allow: { slack: ['trayo'] }, problem: 'tampered' };
    expect(mayPaneUse(db(), 'slack', 'p-vm', sealed, 'local').reason).toBe('tampered');
  });
});

describe('directingOrigin, the edges', () => {
  const mk = () => {
    const d = new Database(':memory:');
    d.exec(`CREATE TABLE panes (id TEXT PRIMARY KEY, tab_id TEXT, node_id TEXT, created_at INTEGER);
            CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, endpoint TEXT);
            CREATE TABLE inbound_messages (id TEXT PRIMARY KEY, tab_id TEXT, at INTEGER, text_key TEXT, from_tab_id TEXT)`);
    d.prepare("INSERT INTO nodes VALUES ('trayo','VM','ws://x')").run();
    d.prepare("INSERT INTO panes VALUES ('p-vm','t-vm','trayo',1), ('p-local','t-local','local',1)").run();
    return d;
  };
  const direct = (d: Database.Database, into: string, from: string, at: number) =>
    d.prepare('INSERT INTO inbound_messages VALUES (?,?,?,?,?)').run(`i${at}${from}`, into, at, 'k', from);

  it('the window is fifteen minutes, inclusive', () => {
    expect(DIRECTED_WINDOW_MS).toBe(900_000);
    const d = mk();
    direct(d, 't-vm', 't-local', 0);
    expect(directingOrigin(d, 'p-vm', DIRECTED_WINDOW_MS)).toBe('local');
    expect(directingOrigin(d, 'p-vm', DIRECTED_WINDOW_MS + 1)).toBeNull();
  });
  it('a row from the future still directs — the error is toward refusing', () => {
    const d = mk();
    direct(d, 't-vm', 't-local', 10 * DIRECTED_WINDOW_MS);
    expect(directingOrigin(d, 'p-vm', 0)).toBe('local');
  });
  it("a sender tab's machine is its FIRST pane's", () => {
    const d = mk();
    d.prepare("INSERT INTO panes VALUES ('s1','t-mixed','local',1), ('s2','t-mixed','trayo',2)").run();
    direct(d, 't-vm', 't-mixed', 100);
    expect(directingOrigin(d, 'p-vm', 100)).toBe('local');
  });
  // These two are BUGS today (review 4 #8). Written as the behaviour the
  // module's own rule demands; `it.fails` until the code is fixed, then flip.
  it.fails('a sender tab that no longer exists does not wash the direction', () => {
    const d = mk();
    direct(d, 't-vm', 't-deleted', 100);
    expect(directingOrigin(d, 'p-vm', 100)).not.toBeNull();
  });
  it.fails('a blank-node sender is not local', () => {
    const d = mk();
    d.prepare("INSERT INTO panes VALUES ('s','t-blank','',1)").run();
    direct(d, 't-local', 't-blank', 100);
    expect(directingOrigin(d, 'p-local', 100)).not.toBe('local');
  });
});

// ─────────────────────────────── registry ───────────────────────────────────

describe('the verb table, pinned literally', () => {
  // An independent oracle: the old tests iterated VERBS itself, so relabelling
  // a write as a read relabelled the expectation with it.
  const W = (n?: true) => ({ kind: 'write', timed: false, ...(n ? { notifiesOthers: true } : {}) });
  const R = { kind: 'read', timed: true };
  const EXPECTED: Record<string, object> = {
    'slack.read': R, 'slack.search': R, 'slack.channels': R, 'slack.users': R, 'slack.thread': R,
    'slack.post': W(true), 'slack.dm': W(true), 'slack.react': W(true), 'slack.edit': W(true),
    'slack.unpost': W(true), 'slack.upload': W(true),
    'msgvault.search.read': R, 'msgvault.message.read': R, 'msgvault.attachment.read': R,
    'msgvault.stats.read': R, 'msgvault.calendar.read': R, 'msgvault.calendar.event.read': R,
    'msgvault.draft.create': W(), 'msgvault.draft.edit': W(), 'msgvault.draft.delete': W(),
    'msgvault.calendar.write': W(true),
    'msgvault.calendar.invite': {
      kind: 'write', timed: false, notifiesOthers: true,
      refuse: 'a calendar invite emails the attendees, which is sending mail under another name',
    },
  };
  it('VERBS is exactly this table', () => {
    expect(VERBS).toEqual(EXPECTED);
  });
  it('classify agrees, verb by verb', () => {
    for (const [v, rule] of Object.entries(EXPECTED) as Array<[string, { kind: string; timed: boolean; notifiesOthers?: true; refuse?: string }]>) {
      expect(classify(v), v).toEqual(
        rule.refuse
          ? { ok: false, kind: rule.kind, timed: false, reason: rule.refuse }
          : { ok: true, kind: rule.kind, timed: rule.timed, ...(rule.notifiesOthers ? { notifiesOthers: true } : {}) },
      );
    }
  });
  it("the Slack half is exactly the broker's TEAM_ACTIONS", () => {
    const src = readFileSync(join(__dirname, '../../../broker/core.mjs'), 'utf8');
    const block = src.match(/const TEAM_ACTIONS = Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
    const team = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(team.length).toBe(11);
    expect(verbsOf('slack')).toEqual(team);
  });
  it('verbsOf is sorted and needs the dot', () => {
    expect(verbsOf('msgvault')).toEqual(Object.keys(EXPECTED).filter((k) => k.startsWith('msgvault.')).sort());
    expect(verbsOf('slack.')).toEqual([]);
  });
});

describe('the belt, with a doctored table', () => {
  const doctor = (v: string, rule: object, f: () => void) => {
    (VERBS as Record<string, unknown>)[v] = rule;
    try { f(); } finally { delete (VERBS as Record<string, unknown>)[v]; }
  };
  it('a write the table calls timed is still not timed', () => {
    doctor('x.write', { kind: 'write', timed: true }, () => expect(classify('x.write').timed).toBe(false));
  });
  it('a read the table calls untimed stays untimed', () => {
    doctor('x.read', { kind: 'read', timed: false }, () => expect(classify('x.read').timed).toBe(false));
  });
  it('a refusal is untimed even if the table says timed', () => {
    doctor('x.no', { kind: 'read', timed: true, refuse: 'no' }, () =>
      expect(classify('x.no')).toEqual({ ok: false, kind: 'read', timed: false, reason: 'no' }),
    );
  });
});

// ─────────────────────────────── passthrough ────────────────────────────────

describe('the pass-through, pinned literally', () => {
  it('REFUSED_COMMANDS is exactly this, and judgeArgv refuses every one', () => {
    const EXPECTED = ['query', 'create-subset', 'export-token', 'export-messages', 'export-eml',
      'export-attachment', 'export-attachments', 'export-discord', 'backup', 'gc', 'remove-account',
      'credentials', 'tui', 'mcp', 'serve', 'daemon', 'setup', 'update', 'skills', 'openapi'];
    expect([...REFUSED_COMMANDS].sort()).toEqual([...EXPECTED].sort());
    for (const c of EXPECTED) expect(judgeArgv([c, 'x']), c).toMatchObject({ ok: false, command: c });
  });
  it('every nested parent is looked up as a PAIR', () => {
    for (const p of ['calendar', 'person', 'identity', 'message-tags', 'collection', 'organization',
      'employment', 'relationship-type', 'attribute-definition', 'carddav', 'documents', 'embeddings',
      'multimodal', 'docbank', 'agent-token', 'claude-account']) {
      expect(judgeArgv([p, 'sub', 'arg']), p).toEqual({ ok: true, command: `${p} sub` });
      expect(verbForCommand(p), p).toBeNull();
    }
  });
  it('COMMAND_VERBS is exactly this table', () => {
    const EXPECTED: Record<string, string> = {
      search: 'msgvault.search.read',
      'show-message': 'msgvault.message.read', 'show-thread': 'msgvault.message.read',
      'list-accounts': 'msgvault.stats.read', 'list-senders': 'msgvault.stats.read',
      'list-domains': 'msgvault.stats.read', 'list-labels': 'msgvault.stats.read',
      stats: 'msgvault.stats.read', meetings: 'msgvault.message.read', media: 'msgvault.message.read',
      'calendar list': 'msgvault.calendar.read', 'calendar show': 'msgvault.calendar.event.read',
      'calendar freebusy': 'msgvault.calendar.read', 'calendar conflicts': 'msgvault.calendar.read',
      'person find': 'msgvault.message.read', 'person show': 'msgvault.message.read',
      'person list': 'msgvault.message.read',
      'draft-compose': 'msgvault.draft.create', 'draft-reply': 'msgvault.draft.create',
      'draft-forward': 'msgvault.draft.create', 'draft-edit': 'msgvault.draft.edit',
      'draft-delete': 'msgvault.draft.delete', 'draft-get': 'msgvault.message.read',
    };
    expect(passthroughCommands()).toEqual(Object.keys(EXPECTED).sort());
    for (const [c, v] of Object.entries(EXPECTED)) expect(verbForCommand(c), c).toBe(v);
  });
  it('no draft verb, and no token minting, rides a timed grant end to end', () => {
    for (const argv of [['draft-delete', 'id'], ['draft-edit', 'id', '--text=x'], ['agent-token', 'issue']]) {
      const j = judgeArgv(argv);
      const verb = j.ok ? verbForCommand(j.command as string) : null;
      expect(verb === null || classify(verb).timed === false, argv.join(' ')).toBe(true);
    }
  });
  it('--help and -h are value-less', () => {
    expect(judgeArgv(['search', '--help']).ok).toBe(true);
    expect(judgeArgv(['-h', 'search']).ok).toBe(true);
  });
  it('refusals are refusals, with their reasons', () => {
    expect(judgeArgv([])).toEqual({ ok: false, reason: 'say what to run, e.g. muxpad msgvault search "from:x"' });
    expect(judgeArgv(['--json'])).toEqual({ ok: false, reason: 'no subcommand — flags alone do nothing' });
    expect(judgeArgv(['search', ''])).toEqual({ ok: false, reason: 'an empty argument is not something muxpad can judge' });
    expect(judgeArgv([7 as unknown as string])).toEqual({ ok: false, reason: 'arguments must be strings' });
    expect(judgeArgv(['search', { toString: () => 'x' } as unknown as string]).ok).toBe(false);
  });
  it('mediationReady names a missing archive', () => {
    expect(mediationReady(null, 501)).toEqual({ ready: false, problem: 'no msgvault archive was found to mediate' });
  });
});
```

## Appendix — every survivor at HEAD (303), grouped

"after rv3 tests" is that mutant's status with Part 3 added.

Group legend:

- **T:** type-only; esbuild strips it, so it is unkillable.
- **E:** equivalent. Reasons, by mutant:
  - 9, 231, 249, 801, 802: `??` vs `||` on values that are never falsy-but-non-null.
  - 29: the BOM has no case.
  - 31: `v` stays undefined and is refused on the next line.
  - 54: `Object.entries` on a non-object primitive yields no valid key.
  - 276, 278, 281, 296: `.get()` takes the first row, whatever the `LIMIT`.
  - 330: the real schema has a `local` node row.
  - 334: `NodeStore.get('')` is null.
  - 343, 344, 346: `raw` cannot be null there.
  - 355: an `ok` decision never meets a sealed policy.
  - 367: equal origins pass `mayUse` identically.
  - 381: `d` is already ok.
  - 10014: masked by `Object.hasOwn`. It is defence in depth, so it is listed and not counted as a gap.
  - 10056: refused either way.
  - 10070: `raw === name` when there is no `=`.
  - 10073: every forbidden flag is lower-case `--`.
  - 10009 and 10079 were classed equivalent but changed the reason or the command, so the new tests kill them.
- **R-table:** the verb table (finding #1).
- **R-belt:** the timed belt (#1, #12).
- **R-refused:** `REFUSED_COMMANDS` entries (#13).
- **R-sort:** output order of `verbsOf` and `passthroughCommands`.
- **P-verbs:** the `COMMAND_VERBS` map (#1, #2).
- **P-nested:** `NESTED` (#13).
- **P-valueless:** `VALUELESS_FLAGS` (#13).
- **P-argv:** argv validation (#13).
- **P-ready:** reason text.
- **P-shorteq:** `-o=x` is accepted; the mutant refuses it, which is the safe direction. Needs a decision.
- **P-writebits:** a group-*writable* archive counts as mediated. Needs a decision.
- **S-path:** `POLICY_PATH`.
- **S-empty:** `parsePolicy` on empty or null (#9).
- **S-bom, S-keyre, S-list, S-noallow, S-emptylist:** policy parsing (#9).
- **S-decision, S-unknownfields, S-directedfields:** decision fields (#6).
- **S-unscopedunknown:** #7.
- **S-realio:** #10.
- **S-catch:** #3.
- **S-default:** #10; needs root or a refactor.
- **S-window, S-sendertab, S-vanished, S-blank, S-tiebreak:** #8.
- **S-nocase:** pane-id case folding in SQL.

#### E — 26

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 9 | scope.ts:107 | swap-logic: `return parsePolicy(raw) \|\| UNSCOPED;` | survived |
| 29 | scope.ts:126 | regex: `v = JSON.parse(raw.replace(/^\uFEFF/i, ''));` | survived |
| 31 | scope.ts:128 | delete `return null;` | survived |
| 54 | scope.ts:138 | drop-right-arm: `if (o.allow) {` | survived |
| 231 | scope.ts:280 | swap-logic: `return parsePolicy(raw) \|\| sealed(`${path} is not valid JSON`);` | survived |
| 249 | scope.ts:312 | swap-logic: `const bad = trustProblem(io.fstat(fd), path) \|\| ancestorProblem(path, io);` | survived |
| 276 | scope.ts:368 | const-num: `ORDER BY i.at DESC LIMIT 2`)` | survived |
| 278 | scope.ts:368 | const-num: `ORDER BY i.at DESC LIMIT 1000`)` | survived |
| 281 | scope.ts:368 | method: `ORDER BY i.at DESC LIMIT 2`)` | survived |
| 296 | scope.ts:372 | method: `.prepare('SELECT node_id AS n FROM panes WHERE tab_id = ? ORDER BY created_at ASC LIMIT 2'` | survived |
| 330 | scope.ts:417 | drop-right-arm: `raw === null` | survived |
| 334 | scope.ts:419 | drop-left-arm: `: new NodeStore(db).get(raw)` | survived |
| 343 | scope.ts:425 | swap-logic: `origin: raw \|\| '',` | survived |
| 344 | scope.ts:425 | drop-right-arm: `origin: raw,` | survived |
| 346 | scope.ts:425 | const-string: `origin: raw ?? 'MUT',` | survived |
| 355 | scope.ts:432 | drop-left-arm: `!policy.problem ? x : { ...x, reason: policy.problem };` | survived |
| 367 | scope.ts:436 | drop-right-arm: `if (directedBy) {` | survived |
| 381 | scope.ts:446 | ret: `return { ...d, ok: true };` | survived |
| 801 | passthrough.ts:216 | swap-logic: `return Object.hasOwn(COMMAND_VERBS, command) ? (COMMAND_VERBS[command] \|\| null) : null;` | survived |
| 802 | passthrough.ts:216 | drop-right-arm: `return Object.hasOwn(COMMAND_VERBS, command) ? (COMMAND_VERBS[command]) : null;` | survived |
| 10009 | scope.ts:312 | swap order of checks | killed |
| 10014 | scope.ts:137 | ordinary-prototype allow | survived |
| 10056 | scope.ts:433 | directed skips origin check | survived |
| 10070 | passthrough.ts:147 | valueless by name | survived |
| 10073 | passthrough.ts:140 | forbidden lowercased | survived |
| 10079 | passthrough.ts:167 | agent-token not nested | killed |

#### P-argv — 8

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 638 | passthrough.ts:125 | if-false: `if (false)` | killed |
| 644 | passthrough.ts:126 | const-string: `return { ok: false, reason: 'MUT' };` | killed |
| 646 | passthrough.ts:130 | delete `if (typeof raw !== 'string') return { ok: false, reason: 'arguments mu` | killed |
| 648 | passthrough.ts:130 | if-false: `if (false) return { ok: false, reason: 'arguments must be strings' };` | killed |
| 651 | passthrough.ts:130 | const-bool: `if (typeof raw !== 'string') return { ok: true, reason: 'arguments must be strings' };` | killed |
| 653 | passthrough.ts:130 | const-string: `if (typeof raw !== 'string') return { ok: false, reason: 'MUT' };` | killed |
| 661 | passthrough.ts:132 | const-string: `return { ok: false, reason: 'MUT' };` | killed |
| 704 | passthrough.ts:159 | const-bool: `if (head === undefined) return { ok: true, reason: 'no subcommand — flags alone do nothing` | killed |

#### P-nested — 28

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 609 | passthrough.ts:102 | delete `'identity',` | killed |
| 610 | passthrough.ts:102 | const-string: `'MUT',` | killed |
| 611 | passthrough.ts:103 | delete `'message-tags',` | killed |
| 612 | passthrough.ts:103 | const-string: `'MUT',` | killed |
| 613 | passthrough.ts:104 | delete `'collection',` | killed |
| 614 | passthrough.ts:104 | const-string: `'MUT',` | killed |
| 615 | passthrough.ts:105 | delete `'organization',` | killed |
| 616 | passthrough.ts:105 | const-string: `'MUT',` | killed |
| 617 | passthrough.ts:106 | delete `'employment',` | killed |
| 618 | passthrough.ts:106 | const-string: `'MUT',` | killed |
| 619 | passthrough.ts:107 | delete `'relationship-type',` | killed |
| 620 | passthrough.ts:107 | const-string: `'MUT',` | killed |
| 621 | passthrough.ts:108 | delete `'attribute-definition',` | killed |
| 622 | passthrough.ts:108 | const-string: `'MUT',` | killed |
| 623 | passthrough.ts:109 | delete `'carddav',` | killed |
| 624 | passthrough.ts:109 | const-string: `'MUT',` | killed |
| 625 | passthrough.ts:110 | delete `'documents',` | killed |
| 626 | passthrough.ts:110 | const-string: `'MUT',` | killed |
| 627 | passthrough.ts:111 | delete `'embeddings',` | killed |
| 628 | passthrough.ts:111 | const-string: `'MUT',` | killed |
| 629 | passthrough.ts:112 | delete `'multimodal',` | killed |
| 630 | passthrough.ts:112 | const-string: `'MUT',` | killed |
| 631 | passthrough.ts:113 | delete `'docbank',` | killed |
| 632 | passthrough.ts:113 | const-string: `'MUT',` | killed |
| 633 | passthrough.ts:114 | delete `'agent-token',` | killed |
| 634 | passthrough.ts:114 | const-string: `'MUT',` | killed |
| 635 | passthrough.ts:115 | delete `'claude-account',` | killed |
| 636 | passthrough.ts:115 | const-string: `'MUT',` | killed |

#### P-ready — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 817 | passthrough.ts:252 | const-string: `if (!db) return { ready: false, problem: 'MUT' };` | killed |

#### P-shorteq — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10069 | passthrough.ts:146 | = only for long | survived |

#### P-valueless — 4

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 597 | passthrough.ts:89 | delete `'--help',` | killed |
| 598 | passthrough.ts:89 | const-string: `'MUT',` | killed |
| 599 | passthrough.ts:90 | delete `'-h',` | killed |
| 600 | passthrough.ts:90 | const-string: `'MUT',` | killed |

#### P-verbs — 42

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 737 | passthrough.ts:188 | delete `'show-message': 'msgvault.message.read',` | killed |
| 738 | passthrough.ts:188 | const-string: `'MUT': 'msgvault.message.read',` | killed |
| 740 | passthrough.ts:189 | delete `'show-thread': 'msgvault.message.read',` | killed |
| 741 | passthrough.ts:189 | const-string: `'MUT': 'msgvault.message.read',` | killed |
| 743 | passthrough.ts:190 | delete `'list-accounts': 'msgvault.stats.read',` | killed |
| 744 | passthrough.ts:190 | const-string: `'MUT': 'msgvault.stats.read',` | killed |
| 746 | passthrough.ts:191 | delete `'list-senders': 'msgvault.stats.read',` | killed |
| 747 | passthrough.ts:191 | const-string: `'MUT': 'msgvault.stats.read',` | killed |
| 749 | passthrough.ts:192 | delete `'list-domains': 'msgvault.stats.read',` | killed |
| 750 | passthrough.ts:192 | const-string: `'MUT': 'msgvault.stats.read',` | killed |
| 752 | passthrough.ts:193 | delete `'list-labels': 'msgvault.stats.read',` | killed |
| 753 | passthrough.ts:193 | const-string: `'MUT': 'msgvault.stats.read',` | killed |
| 755 | passthrough.ts:194 | delete `stats: 'msgvault.stats.read',` | killed |
| 757 | passthrough.ts:195 | delete `meetings: 'msgvault.message.read',` | killed |
| 759 | passthrough.ts:196 | delete `media: 'msgvault.message.read',` | killed |
| 761 | passthrough.ts:200 | delete `'calendar list': 'msgvault.calendar.read',` | killed |
| 762 | passthrough.ts:200 | const-string: `'MUT': 'msgvault.calendar.read',` | killed |
| 764 | passthrough.ts:201 | delete `'calendar show': 'msgvault.calendar.event.read',` | killed |
| 765 | passthrough.ts:201 | const-string: `'MUT': 'msgvault.calendar.event.read',` | killed |
| 770 | passthrough.ts:203 | delete `'calendar conflicts': 'msgvault.calendar.read',` | killed |
| 771 | passthrough.ts:203 | const-string: `'MUT': 'msgvault.calendar.read',` | killed |
| 773 | passthrough.ts:204 | delete `'person find': 'msgvault.message.read',` | killed |
| 774 | passthrough.ts:204 | const-string: `'MUT': 'msgvault.message.read',` | killed |
| 776 | passthrough.ts:205 | delete `'person show': 'msgvault.message.read',` | killed |
| 777 | passthrough.ts:205 | const-string: `'MUT': 'msgvault.message.read',` | killed |
| 779 | passthrough.ts:206 | delete `'person list': 'msgvault.message.read',` | killed |
| 780 | passthrough.ts:206 | const-string: `'MUT': 'msgvault.message.read',` | killed |
| 782 | passthrough.ts:207 | delete `'draft-compose': 'msgvault.draft.create',` | killed |
| 783 | passthrough.ts:207 | const-string: `'MUT': 'msgvault.draft.create',` | killed |
| 788 | passthrough.ts:209 | delete `'draft-forward': 'msgvault.draft.create',` | killed |
| 789 | passthrough.ts:209 | const-string: `'MUT': 'msgvault.draft.create',` | killed |
| 791 | passthrough.ts:210 | delete `'draft-edit': 'msgvault.draft.edit',` | killed |
| 792 | passthrough.ts:210 | const-string: `'MUT': 'msgvault.draft.edit',` | killed |
| 794 | passthrough.ts:211 | delete `'draft-delete': 'msgvault.draft.delete',` | killed |
| 795 | passthrough.ts:211 | const-string: `'MUT': 'msgvault.draft.delete',` | killed |
| 797 | passthrough.ts:212 | delete `'draft-get': 'msgvault.message.read',` | killed |
| 798 | passthrough.ts:212 | const-string: `'MUT': 'msgvault.message.read',` | killed |
| 10081 | passthrough.ts:211 | draft-delete → read | killed |
| 10082 | passthrough.ts:210 | draft-edit → read | killed |
| 10083 | passthrough.ts:212 | draft-get → delete | killed |
| 10085 | passthrough.ts:194 | query mapped | killed |
| 10086 | passthrough.ts:194 | agent-token issue mapped | killed |

#### P-writebits — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10090 | passthrough.ts:259 | read\|write | survived |

#### R-belt — 5

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 518 | registry.ts:139 | swap-logic: `timed: rule.kind === 'read' \|\| rule.timed,` | killed |
| 519 | registry.ts:139 | drop-right-arm: `timed: rule.kind === 'read',` | killed |
| 520 | registry.ts:139 | drop-left-arm: `timed: rule.timed,` | killed |
| 10065 | registry.ts:134 | refusal timed from table | killed |
| 10066 | registry.ts:139 | belt removed | killed |

#### R-refused — 8

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 550 | registry.ts:193 | delete `'export-attachment',` | killed |
| 551 | registry.ts:193 | const-string: `'MUT',` | killed |
| 554 | registry.ts:195 | delete `'export-discord',` | killed |
| 555 | registry.ts:195 | const-string: `'MUT',` | killed |
| 576 | registry.ts:206 | delete `'skills',` | killed |
| 577 | registry.ts:206 | const-string: `'MUT',` | killed |
| 578 | registry.ts:207 | delete `'openapi',` | killed |
| 579 | registry.ts:207 | const-string: `'MUT',` | killed |

#### R-sort — 3

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 526 | registry.ts:150 | delete `.sort();` | killed |
| 527 | registry.ts:150 | method: `;` | killed |
| 806 | passthrough.ts:221 | method: `return Object.keys(COMMAND_VERBS);` | killed |

#### R-table — 72

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 389 | registry.ts:62 | delete `'slack.read': { kind: 'read', timed: true },` | killed |
| 390 | registry.ts:62 | const-bool: `'slack.read': { kind: 'read', timed: false },` | killed |
| 391 | registry.ts:62 | const-string: `'MUT': { kind: 'read', timed: true },` | killed |
| 392 | registry.ts:62 | const-string: `'slack.read': { kind: 'MUT', timed: true },` | killed |
| 397 | registry.ts:64 | delete `'slack.channels': { kind: 'read', timed: true },` | killed |
| 398 | registry.ts:64 | const-bool: `'slack.channels': { kind: 'read', timed: false },` | killed |
| 399 | registry.ts:64 | const-string: `'MUT': { kind: 'read', timed: true },` | killed |
| 400 | registry.ts:64 | const-string: `'slack.channels': { kind: 'MUT', timed: true },` | killed |
| 401 | registry.ts:65 | delete `'slack.users': { kind: 'read', timed: true },` | killed |
| 402 | registry.ts:65 | const-bool: `'slack.users': { kind: 'read', timed: false },` | killed |
| 403 | registry.ts:65 | const-string: `'MUT': { kind: 'read', timed: true },` | killed |
| 404 | registry.ts:65 | const-string: `'slack.users': { kind: 'MUT', timed: true },` | killed |
| 405 | registry.ts:66 | delete `'slack.thread': { kind: 'read', timed: true },` | killed |
| 406 | registry.ts:66 | const-bool: `'slack.thread': { kind: 'read', timed: false },` | killed |
| 407 | registry.ts:66 | const-string: `'MUT': { kind: 'read', timed: true },` | killed |
| 408 | registry.ts:66 | const-string: `'slack.thread': { kind: 'MUT', timed: true },` | killed |
| 410 | registry.ts:67 | const-bool: `'slack.post': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 413 | registry.ts:67 | const-string: `'slack.post': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 414 | registry.ts:68 | delete `'slack.dm': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 415 | registry.ts:68 | const-bool: `'slack.dm': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 416 | registry.ts:68 | const-bool: `'slack.dm': { kind: 'write', timed: false, notifiesOthers: false },` | killed |
| 417 | registry.ts:68 | const-string: `'MUT': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 418 | registry.ts:68 | const-string: `'slack.dm': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 419 | registry.ts:69 | delete `'slack.react': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 420 | registry.ts:69 | const-bool: `'slack.react': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 421 | registry.ts:69 | const-bool: `'slack.react': { kind: 'write', timed: false, notifiesOthers: false },` | killed |
| 422 | registry.ts:69 | const-string: `'MUT': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 423 | registry.ts:69 | const-string: `'slack.react': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 424 | registry.ts:70 | delete `'slack.edit': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 425 | registry.ts:70 | const-bool: `'slack.edit': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 426 | registry.ts:70 | const-bool: `'slack.edit': { kind: 'write', timed: false, notifiesOthers: false },` | killed |
| 427 | registry.ts:70 | const-string: `'MUT': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 428 | registry.ts:70 | const-string: `'slack.edit': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 429 | registry.ts:71 | delete `'slack.unpost': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 430 | registry.ts:71 | const-bool: `'slack.unpost': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 431 | registry.ts:71 | const-bool: `'slack.unpost': { kind: 'write', timed: false, notifiesOthers: false },` | killed |
| 432 | registry.ts:71 | const-string: `'MUT': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 433 | registry.ts:71 | const-string: `'slack.unpost': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 434 | registry.ts:72 | delete `'slack.upload': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 435 | registry.ts:72 | const-bool: `'slack.upload': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 436 | registry.ts:72 | const-bool: `'slack.upload': { kind: 'write', timed: false, notifiesOthers: false },` | killed |
| 437 | registry.ts:72 | const-string: `'MUT': { kind: 'write', timed: false, notifiesOthers: true },` | killed |
| 438 | registry.ts:72 | const-string: `'slack.upload': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 444 | registry.ts:89 | const-bool: `'msgvault.message.read': { kind: 'read', timed: false },` | killed |
| 446 | registry.ts:89 | const-string: `'msgvault.message.read': { kind: 'MUT', timed: true },` | killed |
| 447 | registry.ts:90 | delete `'msgvault.attachment.read': { kind: 'read', timed: true },` | killed |
| 448 | registry.ts:90 | const-bool: `'msgvault.attachment.read': { kind: 'read', timed: false },` | killed |
| 449 | registry.ts:90 | const-string: `'MUT': { kind: 'read', timed: true },` | killed |
| 450 | registry.ts:90 | const-string: `'msgvault.attachment.read': { kind: 'MUT', timed: true },` | killed |
| 452 | registry.ts:91 | const-bool: `'msgvault.stats.read': { kind: 'read', timed: false },` | killed |
| 454 | registry.ts:91 | const-string: `'msgvault.stats.read': { kind: 'MUT', timed: true },` | killed |
| 460 | registry.ts:93 | const-bool: `'msgvault.calendar.event.read': { kind: 'read', timed: false },` | killed |
| 462 | registry.ts:93 | const-string: `'msgvault.calendar.event.read': { kind: 'MUT', timed: true },` | killed |
| 464 | registry.ts:94 | const-bool: `'msgvault.draft.create': { kind: 'write', timed: true },` | killed |
| 466 | registry.ts:94 | const-string: `'msgvault.draft.create': { kind: 'MUT', timed: false },` | killed |
| 468 | registry.ts:95 | const-bool: `'msgvault.draft.edit': { kind: 'write', timed: true },` | killed |
| 470 | registry.ts:95 | const-string: `'msgvault.draft.edit': { kind: 'MUT', timed: false },` | killed |
| 472 | registry.ts:96 | const-bool: `'msgvault.draft.delete': { kind: 'write', timed: true },` | killed |
| 474 | registry.ts:96 | const-string: `'msgvault.draft.delete': { kind: 'MUT', timed: false },` | killed |
| 476 | registry.ts:97 | const-bool: `'msgvault.calendar.write': { kind: 'write', timed: true, notifiesOthers: true },` | killed |
| 479 | registry.ts:97 | const-string: `'msgvault.calendar.write': { kind: 'MUT', timed: false, notifiesOthers: true },` | killed |
| 481 | registry.ts:99 | delete `kind: 'write',` | killed |
| 482 | registry.ts:99 | const-string: `kind: 'MUT',` | killed |
| 483 | registry.ts:100 | delete `timed: false,` | killed |
| 484 | registry.ts:100 | const-bool: `timed: true,` | killed |
| 485 | registry.ts:101 | delete `notifiesOthers: true,` | killed |
| 486 | registry.ts:101 | const-bool: `notifiesOthers: false,` | killed |
| 10059 | registry.ts:69 | react relabelled read | killed |
| 10060 | registry.ts:72 | upload loses notifiesOthers | killed |
| 10061 | registry.ts:68 | dm relabelled read | killed |
| 10062 | registry.ts:96 | draft.delete relabelled read | killed |
| 10063 | registry.ts:90 | attachment.read untimed | killed |

#### S-blank — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10040 | scope.ts:375 | blank sender stays blank | killed |

#### S-bom — 2

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 28 | scope.ts:126 | regex: `v = JSON.parse(raw.replace(/\uFEFF/, ''));` | killed |
| 10013 | scope.ts:126 | strip every BOM | killed |

#### S-catch — 3

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 258 | scope.ts:316 | delete `return sealed(`${path} could not be read`);` | killed |
| 259 | scope.ts:316 | const-template: `return sealed('MUT');` | killed |
| 260 | scope.ts:316 | ret: `return UNSCOPED;` | killed |

#### S-decision — 6

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 117 | scope.ts:176 | delete `origin,` | killed |
| 118 | scope.ts:177 | delete `enforced: true,` | killed |
| 119 | scope.ts:177 | const-bool: `enforced: false,` | killed |
| 130 | scope.ts:187 | delete `enforced: true,` | killed |
| 131 | scope.ts:187 | const-bool: `enforced: false,` | killed |
| 136 | scope.ts:192 | const-bool: `return { ok: true, origin, enforced: false };` | killed |

#### S-default — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10057 | scope.ts:382 | default policy UNSCOPED | survived |

#### S-directedfields — 4

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 376 | scope.ts:441 | delete `origin,` | killed |
| 377 | scope.ts:442 | delete `enforced: by.enforced,` | killed |
| 10053 | scope.ts:439 | directed path: no problem substitution | killed |
| 10054 | scope.ts:442 | directed refusal enforced:false | killed |

#### S-empty — 9

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 12 | scope.ts:121 | delete `if (raw === null \|\| raw === undefined \|\| raw === '') return UNSCOPED;` | killed |
| 14 | scope.ts:121 | if-false: `if (false) return UNSCOPED;` | killed |
| 19 | scope.ts:121 | swap-logic: `if (raw === null && raw === undefined \|\| raw === '') return UNSCOPED;` | killed |
| 20 | scope.ts:121 | drop-right-arm: `if (raw === null\|\| raw === '') return UNSCOPED;` | killed |
| 21 | scope.ts:121 | drop-left-arm: `if ( raw === undefined \|\| raw === '') return UNSCOPED;` | killed |
| 22 | scope.ts:121 | swap-logic: `if (raw === null \|\| raw === undefined && raw === '') return UNSCOPED;` | killed |
| 23 | scope.ts:121 | drop-right-arm: `if (raw === null \|\| raw === undefined) return UNSCOPED;` | killed |
| 24 | scope.ts:121 | drop-left-arm: `if ( raw === '') return UNSCOPED;` | killed |
| 25 | scope.ts:121 | const-string: `if (raw === null \|\| raw === undefined \|\| raw === 'MUT') return UNSCOPED;` | killed |

#### S-emptylist — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 111 | scope.ts:173 | drop-right-arm: `if (!allowed)` | killed |

#### S-keyre — 2

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 62 | scope.ts:140 | regex: `if (!/^[a-z][a-z0-9_-]{0,31}/.test(k)) continue;` | killed |
| 64 | scope.ts:140 | regex: `if (!/^[a-z][a-z0-9_-]{0,1031}$/.test(k)) continue;` | killed |

#### S-list — 7

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 72 | scope.ts:142 | swap-cmp: `const nodes = list.filter((n): n is string => typeof n === 'string' && n.length >= 0);` | killed |
| 74 | scope.ts:142 | swap-logic: `const nodes = list.filter((n): n is string => typeof n === 'string' \|\| n.length > 0);` | killed |
| 75 | scope.ts:142 | drop-right-arm: `const nodes = list.filter((n): n is string => typeof n === 'string');` | killed |
| 10015 | scope.ts:142 | drop typeof string filter | killed |
| 10016 | scope.ts:142 | trim node names | killed |
| 10017 | scope.ts:142 | lowercase node names | killed |
| 10019 | scope.ts:183 | wildcard entry | killed |

#### S-noallow — 3

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 51 | scope.ts:138 | if-true: `if (true) {` | killed |
| 53 | scope.ts:138 | swap-logic: `if (o.allow \|\| typeof o.allow === 'object') {` | killed |
| 55 | scope.ts:138 | drop-left-arm: `if ( typeof o.allow === 'object') {` | killed |

#### S-nocase — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10044 | scope.ts:397 | pane id NOCASE | killed |

#### S-path — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 5 | scope.ts:93 | const-string: `export const POLICY_PATH = 'MUT';` | killed |

#### S-realio — 6

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 179 | scope.ts:240 | delete `read: (fd) => readFileSync(fd, 'utf8'),` | killed |
| 180 | scope.ts:240 | const-string: `read: (fd) => readFileSync(fd, 'MUT'),` | killed |
| 181 | scope.ts:241 | delete `close: (fd) => closeSync(fd),` | killed |
| 182 | scope.ts:242 | delete `lstat: (path) => lstatSync(path),` | killed |
| 10001 | scope.ts:238 | drop O_NONBLOCK | killed |
| 10003 | scope.ts:240 | realIO.read by path | killed |

#### S-sendertab — 2

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 295 | scope.ts:372 | method: `.prepare('SELECT node_id AS n FROM panes WHERE tab_id = ? ORDER BY created_at DESC LIMIT 1` | killed |
| 10036 | scope.ts:372 | sender: newest pane | killed |

#### S-tiebreak — 1

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10034 | scope.ts:368 | order by insertion | survived |

#### S-unknownfields — 8

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 321 | scope.ts:403 | delete `origin: '',` | killed |
| 322 | scope.ts:403 | const-string: `origin: 'MUT',` | killed |
| 323 | scope.ts:404 | delete `enforced: policy.enforce,` | killed |
| 342 | scope.ts:425 | delete `origin: raw ?? '',` | killed |
| 345 | scope.ts:425 | drop-left-arm: `origin: '',` | killed |
| 347 | scope.ts:426 | delete `enforced: policy.enforce,` | killed |
| 10047 | scope.ts:404 | unknown pane enforced:true | killed |
| 10048 | scope.ts:403 | unknown pane origin local | killed |

#### S-unscopedunknown — 2

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 10049 | scope.ts:400 | unknown pane allowed when unscoped | killed |
| 10050 | scope.ts:422 | unknown machine allowed when unscoped | killed |

#### S-vanished — 5

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 298 | scope.ts:374 | delete `if (!sender) return null;` | survived |
| 300 | scope.ts:374 | if-false: `if (false) return null;` | survived |
| 303 | scope.ts:374 | ret: `if (!sender) return 'MUT';` | killed |
| 10038 | scope.ts:374 | missing sender → local | killed |
| 10039 | scope.ts:374 | missing sender → unknown machine | killed |

#### S-window — 9

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 263 | scope.ts:355 | const-num: `export const DIRECTED_WINDOW_MS = 16 * 60_000;` | killed |
| 264 | scope.ts:355 | const-num: `export const DIRECTED_WINDOW_MS = 14 * 60_000;` | killed |
| 266 | scope.ts:355 | const-num: `export const DIRECTED_WINDOW_MS = 15000 * 60_000;` | killed |
| 267 | scope.ts:355 | const-num: `export const DIRECTED_WINDOW_MS = 15 * 60001;` | killed |
| 268 | scope.ts:355 | const-num: `export const DIRECTED_WINDOW_MS = 15 * 59999;` | killed |
| 270 | scope.ts:355 | const-num: `export const DIRECTED_WINDOW_MS = 15 * 60000000;` | killed |
| 287 | scope.ts:370 | swap-cmp: `if (!row \|\| now - row.at >= DIRECTED_WINDOW_MS) return null;` | killed |
| 10041 | scope.ts:370 | future rows forgotten | killed |
| 10042 | scope.ts:355 | window x1000 | killed |

#### T — 30

| id | at | mutation | after rv3 tests |
|---|---|---|---|
| 1 | scope.ts:83 | delete `export type ConnectorId = string;` | survived |
| 2 | scope.ts:87 | delete `enforce: boolean;` | survived |
| 3 | scope.ts:89 | delete `allow: Record<ConnectorId, string[]>;` | survived |
| 89 | scope.ts:150 | delete `ok: boolean;` | survived |
| 90 | scope.ts:152 | delete `origin: string;` | survived |
| 91 | scope.ts:154 | delete `enforced: boolean;` | survived |
| 92 | scope.ts:156 | delete `reason?: string;` | survived |
| 172 | scope.ts:228 | delete `open(path: string): number;` | survived |
| 173 | scope.ts:229 | delete `fstat(fd: number): Stats;` | survived |
| 174 | scope.ts:230 | delete `read(fd: number): string;` | survived |
| 175 | scope.ts:231 | delete `close(fd: number): void;` | survived |
| 176 | scope.ts:232 | delete `lstat(path: string): Stats;` | survived |
| 314 | scope.ts:399 | delete `\| undefined;` | survived |
| 382 | registry.ts:42 | delete `export type VerbKind = 'read' \| 'write';` | survived |
| 383 | registry.ts:42 | const-string: `export type VerbKind = 'MUT' \| 'write';` | survived |
| 384 | registry.ts:42 | const-string: `export type VerbKind = 'read' \| 'MUT';` | survived |
| 385 | registry.ts:45 | delete `kind: VerbKind;` | survived |
| 386 | registry.ts:47 | delete `timed: boolean;` | survived |
| 387 | registry.ts:49 | delete `notifiesOthers?: boolean;` | survived |
| 388 | registry.ts:51 | delete `refuse?: string;` | survived |
| 490 | registry.ts:109 | delete `ok: boolean;` | survived |
| 491 | registry.ts:110 | delete `kind?: VerbKind;` | survived |
| 492 | registry.ts:113 | delete `timed: boolean;` | survived |
| 493 | registry.ts:114 | delete `notifiesOthers?: boolean;` | survived |
| 494 | registry.ts:115 | delete `reason?: string;` | survived |
| 580 | passthrough.ts:64 | delete `ok: boolean;` | survived |
| 581 | passthrough.ts:66 | delete `command?: string;` | survived |
| 582 | passthrough.ts:67 | delete `reason?: string;` | survived |
| 807 | passthrough.ts:244 | delete `uid: number;` | survived |
| 808 | passthrough.ts:245 | delete `mode: number;` | survived |
