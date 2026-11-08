# Code review 2 — 4171283 `fix(connectors): an unknown chat is not a local chat, and a bad policy seals`

Scope: `server/src/connectors/scope.ts` and `scope.test.ts` as of 4171283,
judged against `2026-11-05-connector-scope-code-review.md` (review 1).

**CHECKED** means I ran it, in a scratch copy at `/tmp/sab-scope2`: the real
`scope.ts` and `scope.test.ts`, a stub `NodeStore.ts` exporting only
`LOCAL_NODE_ID = 'local'`, in-memory SQLite, and for file cases real files on
this Mac, including root-owned ones under `/usr/share` and `/System/Library`.
**REASONED** means I argued it but did not run it. The mutation harness is
`/tmp/sab-scope2/mut.mjs` and `mut2.mjs`. The repo tree was not modified.

## Verdict

Two of review 1's nine findings are fully closed: #4 (prototype names) and #6
(the ACL comment). Six are partly closed and one (#8) is untouched.

The real holes are closed, and I re-ran each exploit to confirm. An invented
pane id and a deleted VM pane's id are both refused now. The trailing comma,
the BOM, and the EACCES, ENOTDIR and ELOOP errors all seal. The stat-then-read
race and the FIFO hang are gone.

Three things were moved rather than fixed:

- **`node_id: ""` still reads as `local`.** The commit, the code comment and a
  test all describe this as fixed. The test actually pins the old behaviour,
  with a false justification.
- **A trusted file can still turn scoping off silently.** An empty root-owned
  file reads as UNSCOPED with no `problem`, and so does a miscased `Enforce`.
- **The new defences have no tests.** No test ever runs the ancestor walk:
  nine sabotages of it survive, including deleting the call. The fd-based read,
  `fstat`, `O_NONBLOCK`, the EACCES branch and the read-failure `catch` each
  survive a revert too. The race and FIFO fixes could be undone by a refactor
  and all 26 tests would pass.

The one genuinely new defect is the hardlink check. It lets any agent seal
the policy with a single `ln`, and its comment gives the wrong reason for it.

Nothing found here widens a grant beyond what the api-secret already gives a
local agent. That is because of the advisory framing, not because the code is
tight. See "Advisory framing" at the end.

---

## Part 1 — review 1's findings, one by one

### #1 HIGH, unknown pane → `local` — PARTLY CLOSED

Re-run with policy `{enforce:true, allow:{slack:['trayo'], msgvault:['local']}}`
and a `panes` table using the production column definition
(`node_id TEXT NOT NULL DEFAULT 'local'`, from `migrations.ts:1577`):

| input | review 1 | now (CHECKED) |
|---|---|---|
| `mayPaneUse(db,'msgvault','does-not-exist')` | ok:true, local | **ok:false**, `origin:''`, "no such chat" ✔ |
| trayo pane id after its row is deleted | ok:true, local | **ok:false** ✔ |
| row with `node_id=''` | ok:true, local | **ok:true, origin:'local'** ✘ unchanged |
| row with the column default (`'local'`) | — | ok:true, local ✔ |

The deletion fix is load-bearing, and correct for a reason the commit does not
state. `pane-key.ts` derives a pane's key as `HMAC(secret, paneId)`. The key
is not stored, so it **stays valid after the row is deleted**. A VM agent whose
node was removed still holds a key that passes `verifyPaneKey`, which leaves
the existence check as the only thing between it and `local`. No route lets a
caller choose a pane id (`POST /api/panes` has no `id` field). No route changes
an existing pane's `node_id` either: the only `node_id = ?` write is the delete
in `routes/nodes.ts:194`. So the "deleted, then recreated with a different
node" path is not reachable today (CHECKED by grep).

**The `''` case is not closed.** Review 1's fix said: "No row, **or an empty or
non-string `node_id`**, means refuse … Drop the `|| LOCAL_NODE_ID`." The fix
keeps `row.n || LOCAL_NODE_ID` (`scope.ts:320`). Meanwhile:

- The comment at `scope.ts:304-309` lists "a pane created with `node_id: ""`"
  as one of the "three ways in, all of them real", followed by "So existence
  is asked separately". A `''` pane exists, so the existence check does nothing
  for it.
- The commit message also lists it among the closed bypasses.
- The test `treats an EMPTY node id as local, which the panes route accepts`
  (`scope.test.ts:280`) pins the hole. It justifies this by saying "`''` is how
  a pane on this machine can be recorded". **That is false:**
  - The column is `NOT NULL DEFAULT 'local'`.
  - `NodeStore.nodeForPane` uses `??`, so it returns `''` for such a row.
  - `PaneRouter.transportFor('')` throws `UnknownNodeError`.
  - Every other reader in the tree (`ws.ts`, `transcript-access.ts`,
    `search.ts`, `agent-resume-repair.ts`) uses `??`.

  So the rest of muxpad treats a `''` pane as "on an unknown machine", and it
  never spawns. `scope.ts` is the only reader that turns it into `local`.
- **Mutation proof (CHECKED):** applying review 1's fix (`if (!row.n)` refuse)
  *fails 2 tests*. So does matching the rest of the tree (`??`), which fails 1.
  The suite now defends the bug.

Practical impact is LOW. `POST /api/panes` writes the `''` row before the spawn
fails (`routes/panes.ts`, `panes.create` comes before any transport call). But
the pane never spawns, so no process ever receives its `MUXPAD_PANE_KEY`. A
local agent can already create a real `local` pane, so `''` gives it nothing
new. The finding is that the code, its comment, its commit and its test all
disagree with each other and with the rest of the codebase. **Fix:** drop the
`||`. Refuse a non-string, `''` or unknown node. Delete or invert the
`p-empty` test.

A related problem: the test fixture uses `node_id TEXT` (nullable) and a NULL
row for "local". Production cannot hold a NULL there. The `'local'` value a
real local pane carries is never exercised through `mayPaneUse`.

### #2 MEDIUM, a trusted file that does not parse fails open — PARTLY CLOSED

Re-run through `trustedBytes` (the trusted-bytes branch) and real files:

| input | now (CHECKED) |
|---|---|
| trailing comma | sealed, "not valid JSON" ✔ |
| UTF-8 BOM | parses ✔ |
| UTF-16LE bytes | sealed ✔ (fails closed) |
| whitespace only, `null`, `[]`, `7` | sealed ✔ |
| EACCES (parent `chmod 0`), ENOTDIR, dangling symlink (ELOOP) | sealed, errno in `problem` ✔ |
| **empty file** (0 bytes) | **`{enforce:false, allow:{}}`, no `problem`** ✘ |
| **`{"Enforce":true,…}`** | **`enforce:false`, no `problem`** ✘ unchanged |
| `{"enforce":"true",…}` | `enforce:false`, no `problem` ✘ |
| `{}` | UNSCOPED (arguably intended) |

The empty-file case is not hypothetical. I ran `loadPolicy` on a real
root-owned, 0644, nlink-1, 0-byte file
(`/System/Library/AssetsV2/.MARepoRepair`): the ancestor walk passed and the
result was UNSCOPED. The cause is `parsePolicy('')`, which returns `UNSCOPED`
rather than `null` (`scope.ts:121`). That contradicts its own docblock ("Parse,
or `null` for 'this is not a policy'"). Plausible ways to end up there:

- `sudo touch` before editing.
- A `sudo tee` that was interrupted.
- An editor that truncates and then crashes.

"Present, trusted, unparseable" seals. "Present, trusted, empty" does not, and
an empty file is the extreme of unparseable. The mutation that makes `''`
seal **survives** (CHECKED), so neither behaviour is pinned.

The miscased or stringy `enforce` was listed as a bullet in review 1 and is
not addressed. With `enforce` false, nothing is refused, and nothing reports
why. The fix is cheap: in the trusted branch, reject unknown top-level keys,
and require `typeof enforce === 'boolean'`.

The `readPolicy` docblock (`scope.ts:98-105`) still gives the `app_prefs`-era
reason: "a corrupt **pref** must not silently turn off a working Slack
connector". Review 1 called this out. It now sits directly above a
`parsePolicy` docblock that argues the opposite.

### #3 MEDIUM, ancestors unchecked — PARTLY CLOSED

Closed:

- **The race.** The file is opened once with `O_NOFOLLOW`, checked with
  `fstat(fd)` and read from the fd. A symlinked final component gets ELOOP and
  seals (CHECKED).
- **Hardlinking a root file into the policy directory.** Covered twice: by the
  walk, if the directory is agent-writable, and by `nlink !== 1`. I hardlinked
  `/private/etc/hosts` into a temp directory as `ohadpr`. It was refused as
  "more than one link". (The link has since been removed; hosts is back to
  nlink 1.)
- **Ancestor walk on absolute paths.** Correct, and it terminates:
  `dirname('/') === '/'`. The happy path works: `/usr/share/misc/syscalls.json`
  passed the walk (CHECKED). Paths containing `..` are walked by lexical
  prefix, and each prefix is `lstat`ed by full path, so the kernel resolves
  the intermediate components. In every case I traced, this checks a superset
  of the physical ancestors. A symlink anywhere in the chain is hit as the
  final component of some prefix, and seals (REASONED). Depth is bounded by
  the number of components. Mount and firmlink boundaries are fine: `/Library`
  `lstat`s as a root-owned 0755 directory (CHECKED).

Still open:

- **Deleting the file.** ENOENT returns UNSCOPED *before* the walk runs. If an
  ancestor is agent-writable, which is exactly the case the walk exists for,
  deleting the file still disables scoping. That was review 1's first attack
  under #3. An ENOENT should still walk: absent from a root-owned directory
  means UNSCOPED; absent from an agent-writable one means sealed.
- **Relative paths.** `dirname('connectors.json') === '.'` and
  `dirname('.') === '.'`, so the walk checks only the current directory and
  stops. I chdir'd to `/usr/share/misc` and `loadPolicy('syscalls.json')`
  passed having checked one directory (CHECKED). The broker's own
  `assertProtectedPath` (`broker/protected-path.mjs:61`) throws on a
  non-absolute path. This module should too. The default is absolute, so this
  is LOW.

TOCTOU between the fd and the walk: the walk re-resolves the path after the
`open`, so in principle the file it judges and the file it read can differ.
That does not matter. To swap any entry in a chain, an attacker needs write
access to a directory in that chain, and the walk requires every directory in
the chain to be root-owned and not group- or world-writable when it runs.
Getting a directory that was writable at `open` and is non-writable and
root-owned at the walk requires root. ACLs are the exception, and the comment
now concedes them (REASONED).

### #4 LOW–MED, prototype names throw — CLOSED

`constructor`, `__proto__`, `hasOwnProperty` and `toString` against a
parsed policy, a literal policy and a sealed policy through `mayPaneUse`: all
are refused, none throws, and the sealed case carries `problem` (CHECKED).

- **`__proto__` as a JSON key:** `JSON.parse` makes it an own property,
  `Object.entries` yields it, and the key regex drops it. If the regex were
  relaxed, assigning it on a null-prototype object creates an ordinary own
  property, so it would still be safe.
- **Duplicate keys:** the last one wins (`"enforce":true,"enforce":false` →
  false), which is standard JSON.parse behaviour. Worth knowing for a
  hand-edited file. Not a defect.

The null prototype is **not tested** (see Part 2, N5). `Object.hasOwn` alone
carries the test.

### #5 LOW, not a regular file — CLOSED in substance

- **FIFO:** with `O_NONBLOCK`, the open returns immediately, `fstat` reports
  not-a-file, and the policy seals without reading (CHECKED with `mkfifo`).
  `O_NONBLOCK` is doing real work here: without it, `open(O_RDONLY)` on a FIFO
  blocks the event loop until something writes.
- **Directory, `/dev/null`, `/dev/zero`:** each seals as "not a regular file"
  (CHECKED).
- **Huge regular file:** still read whole. There is no `st.size` cap, though
  root is needed to plant one. Add `if (st.size > 64 KiB) seal`.
- **`O_NONBLOCK` is untested:** removing it survives (Part 2).

### #6 LOW, ACLs invisible — CLOSED (as documentation)

The comment now says the file is checked "in the spirit of" `node-policy.json`
"though not as strictly", and names the ACL gap. I verified the broker's side:
`assertProtectedPath` runs `/bin/ls -lde` on the file and on every ancestor
and rejects any ACL entry. The comment is now accurate.

### #7 LOW, refusal text — PARTLY CLOSED

The dead "Settings → Connectors" link is gone. The text now names
`/Library/muxpad/connectors.json` and root (CHECKED).

Still open: the second half of review 1's finding. A sealed policy passed
straight to `mayUse` still produces the generic "no machine is allowed … edit
the file" reason instead of `problem`. `scope.test.ts:120` still does exactly
this. Only `mayPaneUse` does the substitution. The text now at least points at
the right file, which makes this a nuisance rather than misdirection.

### #8 LOW, no node-id normalisation — OPEN

Not touched. `{"slack":["Trayo ", " trayо"]}` (with a trailing space and a
Cyrillic `о`) loads as-is (CHECKED). Exact match is pinned now, so these fail
closed, but they are still never rejected at load. Apply the connector-id regex
to node ids.

### #9 Comments that oversell — PARTLY CLOSED

| claim | status |
|---|---|
| "THE ORIGIN … never taken from a request body … resolved here from the pane's own row" (`:31-33`); `ScopeDecision.origin` "resolved, never asserted" (`:151`) | **OPEN.** The row's `node_id` is `body.node_id` from `POST /api/panes`, unvalidated. It was asserted at creation and resolved at check time. |
| "a connector this build has never heard of is refused" (`:46-47`, and the test name at `scope.test.ts:25`) | **OPEN.** There is no registry. |
| "`enforced:false` travels with the allow" (`:42-44`) | **OPEN, and now false.** See N4: `enforced:false` now also travels with a refusal. |
| "exactly like the broker's node-policy.json" | **CLOSED.** Reworded and accurate (#6). |

### Review 1's test notes

| note | status |
|---|---|
| `mayPaneUse` has no tests | CLOSED: 6 tests (one pins the `''` hole, see #1) |
| exact-match semantics not pinned | CLOSED: prefix and case mutants killed (CHECKED) |
| mode and read-failure branches untestable | mode CLOSED via `trustProblem` table. **Read-failure `catch` → UNSCOPED still survives.** |
| "not root-owned" test fails when run as root | **OPEN, and now fails differently.** As root on Linux the temp file is root-owned, the walk then reaches `/tmp` (1777) and seals as "writable by its group or by everyone", and `toMatch(/not root-owned/)` fails. Skip when `getuid() === 0`. |
| temp dirs never removed | OPEN |

Review 1's ten mutation survivors, re-run against the new suite:

- **Seven are now killed:** case-insensitive match, prefix match, `/i` key
  regex, the `!v` guard, the mode check, the `problem` substitution, and the
  hard-wired origin.
- **Three still survive** (CHECKED):
  - dropping `|| allowed.length === 0`
  - dropping `&& n.length > 0`
  - read failure returning UNSCOPED

The commit says every survivor is "pinned". Three are not.

---

## Part 2 — new defects in the fix

### N1. MEDIUM (test gap) — The ancestor walk and the race fix are entirely unpinned — CHECKED

`loadPolicy` evaluates `trustProblem(fstat) ?? ancestorProblem(path)`. Every
file the suite creates is owned by the test user, so `trustProblem` always
returns first. **`ancestorProblem` never runs in any test.** One-line
sabotages, each run against the unmodified 26 tests:

| sabotage | result |
|---|---|
| `ancestorProblem` returns `null` immediately | **survived** |
| delete the `?? ancestorProblem(path)` call | **survived** |
| drop the ancestor symlink, uid, mode or isDirectory check (four mutants) | **survived ×4** |
| start the walk at the grandparent | **survived** |
| stop the walk below `/` | **survived** |
| ancestor `lstat` error → `null` | **survived** |
| read `readFileSync(path)` instead of the fd (the race, restored) | **survived** |
| `fstatSync(fd)` → `lstatSync(path)` | **survived** |
| drop `O_NONBLOCK` (the FIFO hang, restored) | **survived** |
| EACCES → UNSCOPED | **survived** |
| outer `catch` → UNSCOPED | **survived** |
| drop `O_NOFOLLOW` | killed |
| drop the `nlink` check | killed |

So the headline of the commit, "THE FILE IS JUDGED THROUGH ONE FD … and an
ANCESTOR WALK", has no test coverage at all. Each part is reachable without
root:

- Export `ancestorProblem` and table-test it with an injected `lstat`, as was
  done for `trustProblem`.
- For the walk's wiring, inject a `stat` function into `loadPolicy`. Or assert
  that a root-owned file such as `/usr/share/misc/syscalls.json` reaches the
  parse stage. That file exists on every macOS install, so guard it by
  platform.
- Test the FIFO with `mkfifo` plus a timeout. Test EACCES with `chmod 0` on the
  parent, which is what my probe did.

### N2. MEDIUM — A trusted empty file is UNSCOPED — CHECKED

See #2. Listed again here because the fix introduced a split between
`parsePolicy` (null means "not a policy") and `readPolicy`, and `''` landed on
the wrong side of it. `parsePolicy` maps `''` to `UNSCOPED` before its own
null path, so `trustedBytes('')` fails open.

### N3. LOW — The hardlink check is a one-command seal for any agent, and its reason is wrong — CHECKED

As `ohadpr` I hardlinked a root-owned 0644 file (`/private/etc/hosts`) into a
directory I own. macOS allowed it. Its `nlink` went to 2. `/Library` and
`/var/folders`, `/Users` are all on the Data volume.

So once `/Library/muxpad/connectors.json` exists, any agent on the mini can run
`ln /Library/muxpad/connectors.json ~/x`. That raises the file's `nlink` to 2,
the policy seals, and every connector is refused for every chat — including
Slack for the VM's chats, since the mini's server makes that check. Before
this fix, no unprivileged action could do that.

The comment's reason (`scope.ts:211-212`, "a second link reaches the same
inode through ancestors we never walked") does not hold up:

- Another path to the same inode grants no write access. The file's own uid
  and mode govern that, and both are checked.
- Getting a foreign hardlink *into* the policy path needs write access on the
  policy directory, which the walk now catches.

So the check defends nothing the other checks miss. What it adds is a denial
of service.

It is LOW because sealing is the module's chosen failure, and a same-uid agent
can also just kill the server. The broker does the same `nlink` check
(`protected-path.mjs:71`), so this is house style. Either keep it and give the
real reason (consistency with the broker), or drop it.

### N4. LOW — The unknown-pane refusal breaks two invariants of `ScopeDecision` — CHECKED

`return { ok:false, origin:'', enforced: policy.enforce, … }`:

- **`enforced:false` on a refusal.** With enforcement off, as shipped, an
  unknown pane gets `ok:false, enforced:false` (CHECKED). Review 1 verified
  "`enforced:false` … never accompanies a refusal". That held then and does not
  now. The module docblock still says `enforced:false` "travels with the
  allow". A consumer that treats `enforced:false` as "unscoped, therefore
  allowed" would invert this refusal.
- **`origin:''`** violates "The machine the asking pane lives on". No caller
  exists yet (grep finds none outside the test), so nothing leaks into an audit
  or prompt today. But the first audit writer will record `''` as a machine,
  and a prompt template such as `this chat runs on ${origin}` will print
  nothing.

**Fix:** a distinct shape, for example `origin: null` and a
`kind: 'unknown-pane'`. Neither mutation (`enforced` forced to true, `origin`
set to `'local'`) is caught by the suite (CHECKED).

### N5. LOW (test gap) — The null-prototype defence passes regardless — CHECKED

The test comment says "Two defences, and each needs its own case". Replacing
`Object.create(null)` with `{}`, in either `parsePolicy` or `sealed`,
**survives**, because `Object.hasOwn` in `mayUse` masks it. The first loop of
that test therefore pins nothing beyond what the literal-policy loop already
pins.

If the null prototype matters, perhaps for some future direct
`policy.allow[x]` reader, assert it directly:
`expect(Object.getPrototypeOf(p.allow)).toBeNull()`.

### N6. LOW — The existence query: correct, but its semantics are unpinned, and a non-string id throws — CHECKED

The SQL itself (`SELECT node_id AS n FROM panes WHERE id = ?`) is correct.
It is the same query as `NodeStore.nodeForPane`, with the same column names,
and it is parameterised. Results:

- `"' OR 1=1 --"` → no row, refused.
- A 50 MB string → no row, refused.
- `5`, `null`, `undefined` and `['x']` → refused.
- **`{}` throws** `Too few parameter values were provided`. That is the same
  throw-instead-of-refuse class as review 1's #4. The route schema makes it
  unlikely, but `paneId: string` is a type, not a check. Add
  `if (typeof paneId !== 'string') refuse`.

Changing `=` to `LIKE` survives the suite, as does adding `COLLATE NOCASE`
(both CHECKED). `LIKE` would make `_` and `%` wildcards and fold case, so
`p_vm` would match `pXvm`. No test asks whether a differently-cased or
wildcard id resolves.

The query is also the seventh copy of "SELECT node_id FROM panes WHERE id = ?"
in the tree, each with its own default. That duplication is how `''` was
misread here. A `NodeStore.paneNode(id): string | undefined` that returns
`undefined` for no row would give every caller one answer.

### N7. LOW — Stale and contradictory comments introduced or kept by the fix — CHECKED

- **`mayPaneUse`'s docblock (`:285-291`)** still says it "Resolves the origin
  … via `nodeForPane`, which answers `local` … the correct reading … for a
  pane whose row is gone". The function no longer calls `nodeForPane`. The
  second claim is the bug this commit fixed, and its block comment twelve
  lines below says the opposite.
- **`readPolicy`'s "corrupt pref" rationale** is unchanged (see #2).
- **`NodeStore` is still imported but unused** (`:5`). Biome does not flag it.
- **The BOM test (`scope.test.ts:231`) depends on an invisible literal U+FEFF**
  (bytes `ef bb bf`) in the source. It kills the strip-removal mutant today.
  But if a formatter or editor normalises the character away, the test passes
  with or without the strip. Write it as `'﻿{…}'`.
- **Commit-message oversell.** It says "Everything an adversarial code review
  … found". In fact `''` was kept, node-id normalisation (#8) and the bare
  `mayUse` reason (#7b) were skipped, and three of the ten survivors still
  survive.

### N8. INFO — `closeSync` in `finally`

If `closeSync` threw, it would replace the return value. Because `loadPolicy()`
is `mayPaneUse`'s default parameter, `mayPaneUse` would then throw rather than
refuse. EBADF cannot happen here, since the fd is ours and is closed once. EIO
on a local APFS volume is not realistic. Wrapping it in its own `try` costs one
line.

### N9. INFO — Exporting `trustedBytes` / `trustProblem`

Neither export lets a caller forge trust they did not already have. Any caller
can hand `mayPaneUse` a literal policy as its fourth argument, which is a far
larger hole than either export. That parameter is the real misuse surface:

- A future route that passes `readPolicy(someString)` bypasses the file.
- A route that passes `trustedBytes(req.body)` would obey an attacker's
  `enforce:false`. The name `trustedBytes` makes that easier to write.

There are now three parse entry points with opposite failure behaviour, and
the names do not say which one is lenient. Recommendations:

- Make `policy` non-optional and internal, through a separate
  `mayPaneUseWith` that only tests import.
- Rename `trustedBytes` to `policyFromRootFile`.
- Narrow `readPolicy` to the one call site that genuinely wants lenience, or
  delete it. Nothing in the tree calls it.

---

## Advisory framing — where the code could be mistaken for the boundary

The module header is honest that the broker is the boundary. Three places still
read as if this code were it:

1. **`:31-36`, "The ORIGIN is never taken from a request body …".** Any
   api-secret holder chooses `node_id` at pane creation, so the origin is
   whatever the pane's creator said. The header's own threat model already
   concedes that a hostile local agent beats this. This sentence then claims
   something stronger. Say "resolved from the pane row, which records what
   its creator asked for".
2. **`:66-69`, "out of an agent's ordinary reach … The ancestors matter and are
   checked".** That is true only for an absolute path to an existing file. An
   ENOENT short-circuits the walk, and a relative path walks only `.`. It
   should state those limits, or the code should close them.
3. **`ScopeDecision.enforced`.** Its name and doc invite an audit record to
   say "scoped check passed". With an unknown pane under enforcement off, it
   is `false` on a refusal (N4). Anything the broker or audit consumes from
   this struct should be treated as a hint.

## What I verified and found sound

- An invented pane id and a deleted pane's id are refused (CHECKED).
- Every non-ENOENT open failure seals with the errno named (CHECKED for
  EACCES, ENOTDIR and ELOOP).
- A FIFO, a directory and device nodes seal without blocking (CHECKED).
- The ancestor walk terminates on `/` and is correct for absolute paths,
  including ones containing `..` (CHECKED or traced).
- The TOCTOU window between the fd and the walk is not exploitable without
  root or ACLs (REASONED).
- Prototype-named connectors refuse, they do not throw, through every path
  (CHECKED).
- `enforce` is still exactly `=== true`. Arrays, `null` and scalars return
  `null` from `parsePolicy` (killed mutants).
