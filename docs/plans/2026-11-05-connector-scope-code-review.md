# Code review — ce7cd40 `feat(connectors): host scoping, the rule by itself`

Scope: `server/src/connectors/scope.ts` and `scope.test.ts` only, as written.
This review judges the module in its stated role: an ADVISORY check that fails
fast and explains, with the approval broker as the boundary. Design findings
already in the 11-04 and 11-05 reviews are not repeated.

**CHECKED** means I ran it, either in a scratch copy at `/tmp/sab-scope` with
a stub `NodeStore` reproducing `nodeForPane` verbatim and an in-memory SQLite,
or by tracing it in the code. **REASONED** means I argued it but did not run it.

## Verdict

The rule itself (`mayUse` plus `readPolicy`) is sound: nothing I tried widens an
allow or turns enforcement on or off against the file. There are three real
problems:

1. `mayPaneUse` turns an unknown pane into `local`, which is an allow for
   `msgvault`.
2. `loadPolicy` fails OPEN on a root-owned file that does not parse, and on
   every stat error other than ENOENT. The commit message says it fails closed.
3. The claim that the file is "genuinely out of an agent's reach" depends on
   directories the code never checks.

`mayPaneUse` has no tests at all.

---

## Findings, most severe first

### 1. HIGH — No pane row means `local`, and `local` owns msgvault — CHECKED

`mayPaneUse` resolves the origin with `nodeForPane(paneId) || LOCAL_NODE_ID`.
`nodeForPane` returns `local` for a pane with no row. The function's own comment
calls that "the correct reading … for a pane whose row is gone". It is the wrong
reading. The repo already says why, in `server/src/chat/transcript-access.ts:53`:
mapping "never heard of this pane" to local is "precisely the sid-swap the
chokepoint exists to stop". `transcriptForPane` returns `elsewhere` for a
missing row. This function needed the same treatment and did not get it.

With policy `{"enforce":true,"allow":{"slack":["trayo"],"msgvault":["local"]}}`:

| input | result |
|---|---|
| `mayPaneUse(db,'msgvault','p-trayo')` (row `node_id='trayo'`) | `ok:false` ✔ |
| `mayPaneUse(db,'msgvault','does-not-exist')` | **`ok:true, origin:'local', enforced:true`** |
| same trayo pane id after its row is deleted | **`ok:true, origin:'local'`** |
| row with `node_id=''` | **`ok:true, origin:'local'`** (the `\|\|` maps `''` to local) |

How each case happens in practice:

- **Unvalidated caller.** Any future route that takes `paneId` from a request
  and calls this before proving the pane exists hands msgvault to any string.
- **Node removal.** `routes/nodes.ts:194` deletes every pane row on a removed
  node. An agent still running on the VM keeps its pane id, and that id now
  reads as `local`. This is exactly the work-to-personal crossing the module
  exists to stop.
- **Empty node id.** `POST /api/panes` accepts `node_id: ""`
  (`z.string().optional()`, then `??` keeps `''`). I did not trace where
  PaneRouter spawns a pane whose node is `''` (REASONED). Either way the scope
  check calls it local without knowing.

The result is `enforced:true`, so an audit record would say a scoped check
passed. The broker re-check bounds the damage only if the broker learns the
origin independently. If it ever asks muxpad "which node is this pane on", this
finding is the boundary.

**Fix:** read the row directly. No row, or an empty or non-string `node_id`,
means refuse with "unknown pane". Drop the `|| LOCAL_NODE_ID`.

### 2. MEDIUM — A trusted file that does not parse fails open, silently — CHECKED

`loadPolicy` checks the file's owner and mode, then calls `readPolicy`. Any
parse failure there returns UNSCOPED with no `problem` attached. Each of these
was a root-written policy that intended `enforce:true`, and each came back as
`{"enforce":false,"allow":{}}`:

- a trailing comma: `{"enforce":true,"allow":{"slack":["trayo"],}}`
- a UTF-8 BOM, as some editors write it. `readFileSync(…,'utf8')` does not
  strip it.
- a miscased key: `{"Enforce":true,…}` gives `enforce:false`.

The commit says "A TAMPERED POLICY FAILS CLOSED". That holds only for tampered
metadata. A file the owner wrote and got wrong turns scoping off, and the
decisions say `enforced:false` without saying why.

The rationale in the `readPolicy` docblock ("a corrupt **pref** must not
silently turn off a working Slack connector") is left over from the
`app_prefs` draft the commit says it replaced. For a root-owned file, "present,
trusted, unparseable" should seal with a `problem`, the same as "present,
untrusted".

The same fail-open applies to every `lstat` error other than ENOENT. Each of
these returned UNSCOPED:

- EACCES: the parent directory is `chmod 0`, for example after
  `sudo mkdir -m 700 /Library/muxpad`, which the server cannot traverse.
- ENOTDIR.
- ELOOP (REASONED, same `catch`).

Only ENOENT means "absent". Everything else should seal.

### 3. MEDIUM — "Out of an agent's reach" assumes the directories — CHECKED

The code inspects only the final path component. Nothing checks who owns or
can write `/Library/muxpad` or anything above it. I hardlinked `/etc/hosts`
(root, 0644) into a directory I own. `loadPolicy` accepted it: root-owned, not
a symlink, not group- or world-writable. It parsed as UNSCOPED. macOS has no
protection against hardlinking someone else's files.

So if any ancestor directory is writable by `ohadpr`, the "cheapest attack" the
comment says it prevents is still available, three ways:

- **Delete the file.** ENOENT is UNSCOPED. Absence is not sealed.
- **Hardlink any root-owned file there.** Non-JSON or `{"enforce":false}`
  reads as UNSCOPED; I ran this.
- **Swap the file between `lstat` and `readFileSync`.** `readFileSync` follows
  symlinks, so a symlink dropped in after the check is read (REASONED).

As deployed it is fine: `/Library` is `root:wheel 0755` (CHECKED), so
`/Library/muxpad` created with `sudo mkdir` (0755) is genuinely out of reach.
But `loadPolicy(path)` accepts any path and states the guarantee without
checking it. In its advisory role this is a comment oversell, not a hole.

**Fix (cheap):**

- `openSync(path, O_RDONLY|O_NOFOLLOW|O_NONBLOCK)`, then `fstatSync(fd)`, and
  read from the fd. That closes the race.
- Require `isFile()` and `nlink === 1`.
- Walk the ancestors, requiring each to be uid 0 and not writable by group or
  everyone (or sticky).

### 4. LOW–MEDIUM — Prototype names throw instead of refusing — CHECKED

`policy.allow[connector]` is a plain-object lookup. With enforcement on:

- `constructor`, `__proto__`, `hasOwnProperty` and `isPrototypeOf` **throw**
  `allowed.includes is not a function`.
- `toString` and `valueOf` are refused with "no machine is allowed".

It also throws against a sealed policy, so `mayPaneUse` never reaches its
`problem` substitution. No grant is possible, because nothing inherited has a
working `includes`. But a decision function that throws where it should refuse
leaves the outcome to whatever the caller's catch does, and the connector id
comes from an action kind an agent can write.

`readPolicy` itself is safe. The key regex rejects `__proto__` because of the
leading `_`. A literal `"constructor"` key is stored as an own property and
behaves correctly (CHECKED).

**Fix:** `Object.hasOwn(policy.allow, connector)`, or build `allow` as a
`Map` or null-prototype object.

### 5. LOW — Never checks that it is a regular file — REASONED (directory CHECKED)

- **Directory.** Root-owned, 0755: EISDIR, sealed "could not be read". Correct
  (CHECKED with `/usr`).
- **FIFO.** A root-owned FIFO with 0644 passes every check. `readFileSync` then
  blocks *synchronously*. `loadPolicy()` is a default parameter of
  `mayPaneUse`, so it runs on every call. One open with no writer freezes the
  server's event loop. Getting a root-owned FIFO there needs root, or finding
  #3's writable directory plus a hardlink to one.
- **Very large file.** Over 2 GiB it throws and seals. Hundreds of MB is read
  into memory and stalls the loop before the string-length error seals it.

The `O_NONBLOCK` + `fstat().isFile()` change in finding #3 covers all three.

### 6. LOW — ACLs are invisible to the mode check — REASONED

A macOS ACL (`chmod +a "ohadpr allow write"`) on a root-owned 0644 file makes
it agent-writable while `st.mode & 0o022` stays 0. Only root can set one, so
this is misconfiguration, not an attack. It is worth one sentence in the
comment that claims parity with `node-policy.json`.

Setuid and setgid bits are irrelevant for a data file.

### 7. LOW — The refusal text sends people somewhere that cannot exist — CHECKED

`no machine is allowed to use X — set one in Settings → Connectors`:

- There is no such UI. `grep` over `web/src` finds nothing.
- By the commit's own argument there must never be one. A web UI holding the
  api-secret cannot be allowed to write a root-owned policy.

The agent will tell the user to visit a page that does not exist. The text
should name `/Library/muxpad/connectors.json` and `sudo`.

There is a second problem with refusal reasons. A sealed policy evaluated
through bare `mayUse`, as the test at `scope.test.ts:97` does, refuses with
this same misleading text instead of the `problem`. Only `mayPaneUse` swaps in
the real reason. A future route that calls `mayUse(…, loadPolicy())` loses it.

### 8. LOW — No normalisation; mismatches fail closed, confusingly — CHECKED

Node ids are compared by exact `includes` with no normalisation.

- A Cyrillic `о` in the file denies, which is correct. The reason then reads
  `slack is scoped to trayо; this chat runs on trayo`, two strings that look
  identical.
- Case mismatches deny.
- Connector ids are constrained to ASCII lowercase by the regex. Node ids in
  the file are not constrained at all.

Nothing here widens a grant. Consider applying the same id regex to node ids
so a bad entry is rejected at load time rather than silently never matching.

### 9. Comments that oversell — CHECKED by trace

- **"THE ORIGIN IS RESOLVED, NEVER ASSERTED."** It is resolved at check time
  from a value that was asserted at creation time. `routes/panes.ts:354` takes
  `body.node_id` from any api-secret holder, unvalidated against the `nodes`
  table. The design consequence is in the earlier reviews. The comment should
  say "resolved from the pane row, which the creator chose".
- **"a connector this build has never heard of is refused"** implies a known
  set. There is no registry. It is the same "no entry" branch as an unlisted
  connector, and the test of that name duplicates the one above it.
- **"`enforced:false` travels with the allow, so the approval prompt and the
  audit record can both state…"** No caller exists yet, so nothing consumes it.
  The commit message is honest about that ("No route is wired"); the docblock
  reads as if it already happens.
- **"checked on every read, exactly like the broker's own node-policy.json"** I
  did not verify the broker's checks. If they include ancestry or `fstat`,
  this is not "exactly like".

### Information leak in the reason text — not worth caring about

The reason names every allowed node and the asking node. Every agent holding
the api-secret can already list nodes (`/api/nodes`, `muxpad node list`).
Nothing new is disclosed.

---

## The tests — mutation results (all CHECKED)

These are one-line mutations of `scope.ts` in the scratch copy, each run
against the unmodified `scope.test.ts`. "Survived" means the change was made
and all 12 tests still passed.

| mutation | result |
|---|---|
| enforcement off reports `enforced:true` / denies | killed |
| delete the no-entry deny branch | killed |
| `includes` always true | killed |
| ok path returns the wrong `origin` | killed |
| drop the key regex | killed |
| drop the `typeof n === 'string'` filter | killed |
| keep empty lists | killed |
| `enforce: !!o.enforce` | killed |
| parse failure seals instead of UNSCOPED | killed |
| drop the symlink check / drop the uid check | killed |
| `lstat` failure seals / sealed policy has `enforce:false` | killed |
| **drop `\|\| allowed.length === 0`** | **survived**: no test passes a hand-built empty list |
| **case-insensitive match** | **survived** |
| **prefix match (`origin.startsWith(a)`)** | **survived**: `trayo2` would be allowed by `trayo` and no test notices |
| **make the key regex `/i`** | **survived** |
| **drop the `n.length > 0` filter** | **survived** |
| **drop the `!v \|\| typeof v !== 'object'` guard** | **survived**: `'7'` and `'[]'` still equal UNSCOPED; `'null'` would throw, and it is not in the list |
| **drop the mode (`0o022`) check** | **survived**: entirely untested |
| **read failure returns UNSCOPED instead of sealing** | **survived**: untested |
| **`mayPaneUse` stops substituting `problem`** | **survived**: `mayPaneUse` has zero tests |
| **`mayPaneUse` origin hard-wired to `trayo`** | **survived** |

Notes on the tests:

- **No test is fully vacuous,** but the suite pins `mayUse` and leaves
  `mayPaneUse` (the only function that resolves an origin) completely
  unexercised. Finding #1 lives in exactly that function.
- **Exact-match semantics are not pinned.** Add `trayo2`, `Trayo` and
  `trayo ` cases.
- **The mode and read-failure branches can be tested without root.** Factor
  the stat result into a pure `trustProblem(st)` function and table-test it.
- **The "not root-owned" test is environment-dependent** (REASONED). Run as
  root, as in many CI containers, the temp file *is* root-owned, so the policy
  loads and the test fails. Skip it when `process.getuid() === 0`.
- **The temp directories are never removed.**

## What I verified and found sound

- **`readPolicy` cannot produce `enforce:true` from anything but a literal
  `true`.** Checked with `"yes"`, `1`, a miscased key, a missing key, and a
  mutation test.
- **It cannot widen an allow.** Non-arrays, non-strings and empty strings are
  dropped. Keys must match the regex, `__proto__` cannot get in, and
  top-level `null`, `[]` and `7` all give UNSCOPED.
- **A sealed policy never returns `ok:true`.** `allow:{}` can only deny or
  throw (finding #4).
- **Through `mayPaneUse`, every refusal from a sealed policy carries
  `problem`.**
- **`enforced:false` comes back only from the enforcement-off branch.** It
  never accompanies a refusal.
- **The metadata checks are correct.** The final-component symlink check runs
  on `lstat` (the link's own uid, so the order does not matter), the uid-0
  check is right, the `0o022` bitmask is right, ENOENT gives UNSCOPED as
  designed, and a root-owned directory seals.
- **The default path is safe as deployed.** `/Library` is `root:wheel 0755`.
