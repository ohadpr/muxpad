# Code review — cb36215 (verbs + laundering) and 6770682 (msgvault pass-through filter)

Scope: `server/src/connectors/{registry,passthrough,scope}.ts` and their tests,
as of `6770682`. Reviews 1 and 2 of `scope.ts` are not restated; where the new
code re-opens one of their findings, that is called out.

**CHECKED** = ran it. Three harnesses, all in `/tmp/mvt`:
`probe.ts` (the real `judgeArgv` / `verbForCommand` / `classify` on attack
argv), `launder.ts` (the real `directingOrigin` + `mayPaneUse` on an in-memory
SQLite with the real query), and `mutate.mjs` (39 single-line sabotages of a
scratch copy, each run against the full 78-test suite). msgvault 0.22.0's
parser was probed only with `version` and `--help`: nothing synced, nothing
issued, no Google traffic. **REASONED** = argued, not run.

## Verdict

The verb table and the "no write on a timed grant" rule are sound. The two
enforcement pieces built on top of them are not. `judgeArgv` can be walked past
in one token. `verbForCommand` labels whole command trees with their parent's
privilege, so `calendar create --send-updates all` comes back as a **timed
read**. The laundering check can be dodged at least six ways, one of which is
unsetting an environment variable. One framing problem outranks all of these:
on the mini the msgvault archive is plain files the agents' own OS account can
read. The pass-through currently mediates nothing an agent can't get by going
around it.

---

## Findings, most severe first

### 1. CRITICAL (framing) — On the mini, msgvault has no boundary to mediate — CHECKED

`ls -l ~/.msgvault` (metadata only):

```
drwx------ ohadpr  ~/.msgvault
-rw-r--r-- ohadpr  msgvault.db, msgvault.db-wal      (world-readable)
-rw------- ohadpr  config.toml, client_secret.json
drwxr-xr-x ohadpr  analytics/                        (the Parquet cache `query` reads)
lrwxr-xr-x ohadpr  /opt/homebrew/bin/msgvault
```

Every agent on the mini runs as `ohadpr`. Any one of them can run
`/opt/homebrew/bin/msgvault query "SELECT …"` or `sqlite3
~/.msgvault/msgvault.db` and never go through `muxpad msgvault`. It can also
read the OAuth client secret and config. With the archive in this state, these
are suggestions to a cooperative agent: `FORBIDDEN_FLAGS`, `REFUSED_COMMANDS`,
the read/write split and the per-verb grant. None of them is a control. Host
scoping does do real work in the other direction: trayo can't reach the mini
(one-way tailnet). But a *personal* chat on the mini needs no grant at all to
read every message.

The comments assume a mediator: "the CLI … with a credential injected",
"escape the mediator rather than use it". That is only true once the archive
and its credentials live under an account the agents are not, with the daemon
reachable only by agent token. Until then, the docstrings should say that this
is the future boundary, not the current one. **Fix:** move msgvault's home to a
separate OS user (or at least chmod `msgvault.db*` to 0600 and accept that
`ohadpr` still reads it). Treat everything below as "correct once that is true".

### 2. HIGH — `judgeArgv`'s "first bare token is the subcommand" is false under cobra — CHECKED

msgvault is cobra/pflag. When cobra looks for the subcommand, it strips any
value-taking flag *together with its value*. `--log-file` and `--log-level`
take values and are not forbidden:

```
judgeArgv(['--log-file','search','query','SELECT * FROM messages'])
  → ok:true, command:'search' → msgvault.search.read → {ok, read, timed:true}

$ msgvault --log-file search version          # runs `version`
$ msgvault --log-file search query --help     # "Run arbitrary SQL against the Parquet analytics cache."
$ msgvault --log-level search version         # also runs `version`
```

Any refused command rides this. That includes `query`, `export-messages`,
`create-subset`, and `agent-token issue --permissions calendar.invite`, all
approved as a timed `search.read` (or whatever the decoy maps to).

**Fix:** stop guessing grammar from the outside. Either (a) require the
subcommand to be `argv[0]`, with no flags allowed before it, and refuse
otherwise; or (b) forbid every value-taking global flag (`--log-file`,
`--log-level`, `--log-sql-slow-ms`, plus the six already listed) and treat any
other leading `-` token before the subcommand as a refusal. (a) is simpler and
costs agents nothing.

### 3. HIGH — `verbForCommand` gives a parent's privilege to its write subcommands — CHECKED (classification); daemon enforcement REASONED

`calendar`, `person` and `meetings` are command trees (from `--help`):

| mapped as | subcommands that are not that |
|---|---|
| `calendar → calendar.read` (timed) | `create`, `update` (`--attendees`, `--send-updates all`), `delete`, `move`, `respond` (an RSVP mails the organiser) |
| `person → message.read` (timed) | `delete` ("permanently"), `merge`, `split`, `promote`, `notes` (update), `set-display-name`, `track`, `publish` / `unpublish` (to CardDAV, which leaves the machine), `enrichment` (external lookups), `sweep` |
| `meetings → message.read` | `context -o FILE` writes transcripts to disk in bulk, which is the reason `export-*` is refused |

```
['calendar','create','primary','--account','me@x','--send-updates','all']
  → ok:true, msgvault.calendar.read, {kind:'read', timed:true}
```

That is the `calendar.invite` refusal, walked around under a timed *read*. It
also makes the registry's "a write never rides a timed grant" false end to end.
The belt-and-braces check in `classify` can't catch it, because the mislabel is
in a different table. If the broker mints a token holding only the mapped
permission, msgvault's daemon should refuse `create` (REASONED: I couldn't test
it without issuing a token). Then the damage is a wrong approval prompt rather
than an event. But nothing here pins that the token's permission set is exactly
the mapped verb.

`draft-get → message.read` is a privilege *mismatch* the other way. Drafts are
gated by `draft.*`, so a `message.read` token probably can't read them
(REASONED). That is functional, not security. `media` (only `search`) is
correct.

**Fix:** key the map on `command subcommand` for tree commands, with an
explicit list per tree:
- `calendar freebusy|conflicts` → read.
- `create|update|delete|move` → `calendar.write`, untimed.
- Any `--attendees`, or `--send-updates` other than `none`, → `calendar.invite`
  (refused).
- `respond` → refused or invite.
- `person get|list|identities|files|directory|merge-history|merge-show|search`
  → read; everything else unmapped.
- `meetings` → read only without `-o`/`--output`.

An unknown second word should return null.

### 4. HIGH — The laundering check can be bypassed by six routes — CHECKED unless marked

Run against the real query (`launder.ts`). Policy is `{slack:[trayo],
msgvault:[local]}`. P is a personal chat on local and W is a work chat on
trayo; every row ends with W allowed to post to Slack.

| # | sequence | directedBy | ok |
|---|---|---|---|
| a | `MUXPAD_PANE_ID= muxpad agent send W "post X"`. `from_pane` is optional and caller-asserted (`agent-sessions.ts:91,104`; CLI `inbound_from_field`), so nothing is recorded. Passing a *work* pane's id as `from_pane` instead records the work tab. (CHECKED by trace.) | null | true |
| b | P directs W, then any work chat W2 sends W anything. **Pinned as intended** by the test "takes the MOST RECENT instruction". | trayo | true |
| c | Two hops: P → W2 → W. Only the last hop is checked. | trayo | true |
| d | P directs W, then P's pane is moved to another tab (the old tab is deleted on empty; `routes/panes.ts` move) or P's tab is closed. `from_tab_id` deliberately has no FK, so it dangles, and `!sender → null`. | null | true |
| e | P's tab also holds an older trayo terminal pane. Sender = the tab's *oldest* pane, so it reads as trayo. | trayo | true |
| f | P tells W to post in 16 minutes, sleep, or `muxpad cron new --pane=W` (a cron fire carries no `from_tab_id`). The window elapses. | null | true |
| g | Channels that don't write `inbound_messages` at all: `muxpad pane send` keystrokes, `POST /api/panes` with a briefed startup command on trayo, a file or card W is told to read. (REASONED.) | null | true |

Things I tried that **don't** wash, and are sound:
- **A chat messaging itself.** `recordInbound` drops same-tab sends.
- **A later message with no sending tab.** It is filtered by `IS NOT NULL`, and
  the test pins it.
- **An `at` in the future.** The chat stays tainted (refuses), and `at` is
  server-stamped anyway.

**Underlying problems.**
- *Provenance comes from the asker.* The CLI sends `from_pane` from the agent's
  own environment, so the record is self-reported. It needs a server-side proof
  of the sending pane, like the per-pane key the Slack routes use.
- *The sender's machine is worked out at decision time, from the tab.* It
  should be captured when the message is sent, from the sending pane, and
  stored in the row.
- *Taint expires.* "Most recent within 15 minutes" lets taint lapse or be
  overwritten. A cleaner rule is the union of every directing origin in the
  window: any foreign origin taints.
- *Taint doesn't carry through hops.* It should inherit (W2 directed by a
  tainted W is tainted).

Even with all of that, (g) means this can only ever catch accidents. Say so.

### 5. MEDIUM — Comments that claim more than the code does — CHECKED

- `scope.ts:335` "the laundering path, **closed**": see #4.
- `scope.ts:353` "a wrong answer here fails toward refusing rather than
  allowing": backwards. Every degraded path returns `null`, which **allows**:
  no row, a deleted sender tab, a tab with no panes, an elapsed window. The
  only refusing degradation is a future `at`.
- `registry.ts:162` "Enforced in the broker as well" and `passthrough.ts:25-27`
  "the broker applies the same list before it mints a grant": `broker/` has no
  msgvault verbs, no `FORBIDDEN_FLAGS`, no `REFUSED_COMMANDS` (grep; only
  Slack's `TEAM_ACTIONS`). Worse, it *can't*: the broker mints a grant for a
  verb and never sees argv. An argv filter can only be the boundary in the
  process that runs msgvault, and that process is on the agents' machine. The
  real future boundary is the msgvault daemon enforcing the token's
  permissions. The comment should name that instead.
- `passthrough.ts:34-35` "the first non-flag token is the subcommand": see #2.
- `passthrough.ts:37-38` "msgvault's own flag parser does not stop there for
  global flags": false. `msgvault version -- --home /x` treats `--home` as a
  positional. Harmless (refusing the extra case is safe) but wrong.
- `REFUSED_COMMANDS` is presented as "the subcommands it refuses". It is a
  denylist, and see #7 for what it leaves out.

### 6. MEDIUM — `mayPaneUse(…, directedBy = null)` makes the check opt-in — CHECKED

There are no callers yet (grep across `server/src`, `broker`, `scripts`). So
nothing skips it *today*. But the signature lets every future route skip it
silently by omitting an argument, and a forgotten argument looks exactly like
"nobody directed this". `mayPaneUse` already has the `db` and the `paneId`.
**Fix:** call `directingOrigin` inside it, and expose an explicit override only
for tests.

### 7. MEDIUM — `judgeArgv` says `ok:true` to destructive or minting commands it doesn't know — CHECKED

`judgeArgv` is a denylist, and its blind spots get `ok:true`:
- `agent-token issue`, which mints delegation tokens;
- `stage-delete`, `delete-staged`, `delete-deduped`, `cancel-deletion`;
- `message-tags` (writes provider tags) and `kata` (creates issues);
- `sync*`, `add-*`, `import-*`, `merge-account`, `update-account`, `verify`;
- `logs` (structured logs, which can include SQL with `--log-sql`).

Failing closed depends on a caller refusing `verbForCommand(...) === null`.
That caller doesn't exist, and a broker that copies "the same list" would ship
the denylist. **Fix:** make `judgeArgv` itself refuse an unmapped command, so
one function gives one answer and the allowlist is the only list.

### 8. LOW–MEDIUM — `directingOrigin` re-opens reviews 1 and 2 by a new route — CHECKED

- `sender.n || LOCAL_NODE_ID` maps a blank `node_id` to `local`. That is the
  exact spelling review 2 found still open and `mayPaneUse` now refuses. A
  `node_id:""` pane directing a local msgvault chat reads as same-machine and
  is allowed (`launder.ts`, row "blank-node sender").
- A sender tab that no longer resolves returns `null`, which allows. That is
  review 1 #1's shape ("absence becomes the permissive answer"), in the
  directing direction.
- A sender node id that has since been removed from `nodes` is returned raw,
  without the `NodeStore` existence check `mayPaneUse` applies to the origin.
  It still refuses unless the policy names that id, so the impact is small.

### 9. LOW — The belt-and-braces check is beaten by an edit to the table it is meant to survive — CHECKED

`timed: rule.kind === 'read' && rule.timed` only stops `{kind:'write',
timed:true}`. Relabelling the kind, as in `'slack.react': {kind:'read',
timed:true}`, passes the suite. And the test called "holds even if the table
itself says otherwise" doesn't edit the table. Removing the belt survives.
**Fix:** pin the expected kind of every verb as a literal table in the test,
and test the belt by injecting a doctored rule.

### 10. LOW — Smaller filter gaps — CHECKED unless marked

- `--log-file=<any path>` makes msgvault write a log to an arbitrary path, and
  `--log-sql` puts query text in the logs. Neither is forbidden. On the mini
  the agent can write as `ohadpr` anyway; on any future separated account this
  is a file-write primitive.
- Environment variables: `MSGVAULT_HOME` (named in `--help`), plus `HOME`,
  `XDG_*`. They re-point the tool exactly like `--home`, and no code yet
  scrubs them. The spawner must start msgvault with a clean environment.
  (REASONED: there is no spawner yet.)
- The first-bare-token rule over-refuses `--log-level warn search x` (it reads
  `warn` as the command). That is the safe direction, but it will train agents
  to retry. Fix #2(a) removes it.
- Probed and fine, because msgvault rejects them itself: `--HOME`, `--hom`
  (no prefix abbreviation), `-home` (a shorthand cluster that errors), and
  `--=x`. Exact-match on `FORBIDDEN_FLAGS` is adequate *for this parser*.
  None of the six forbidden flags has a shorthand.
- `''` as the first bare token becomes the command, which is unmapped and
  refused. Fine.
- `show`, the alias of `show-message`, is unmapped and refused. That is
  usability, not safety.

### 11. LOW — The `directingOrigin` query is under-specified — CHECKED

- `ORDER BY i.at DESC` has no `id` tie-break, so two directions in the same
  millisecond resolve arbitrarily (`listByTab` does tie-break).
- The `>` vs `>=` window boundary is unpinned.
- `DIRECTED_WINDOW_MS` is unpinned too: the tests are relative to the constant,
  so even 1000× its value survived.

### 12. INFO — A stale docblock — CHECKED

`scope.ts:327-333`, "The same question, for a live pane … `nodeForPane`
answers `local` …", now sits detached above the laundering block. It describes
behaviour `mayPaneUse` explicitly stopped having.

---

## Sabotage results (39 mutants, full suite each, CHECKED)

**Survived, and meaningful:**

| mutant | why it matters |
|---|---|
| `timed: rule.timed` (belt removed) | #9 |
| refusal returns `timed: rule.timed` | "timed:false on every refusal" is only true because the table says so |
| `slack.react` → `{read, timed:true}` | no per-verb kind pin |
| `slack.upload` loses `notifiesOthers` | only post and calendar.write are pinned |
| `calendar: → calendar.write`, `draft-get → draft.delete`, `draft-delete → message.read`, `draft-edit → search.read`, `person` removed | `COMMAND_VERBS` is pinned only for `search` and `draft-reply`. Remapping a delete to a read passes. |
| `ORDER BY created_at DESC` | the mixed-machine tab is untested (#4e) |
| `sender.n ?? LOCAL` | blank sender is untested (#8) |
| `!sender → LOCAL_NODE_ID` | the deleted-sender behaviour is unpinned either way (#4d) |
| `>=` window; window ×1000 | #11 |
| `typeof raw !== 'string'` removed | untyped callers are untested |
| `skills` / `openapi` removed from `REFUSED_COMMANDS` | the list is pinned only partly |
| `.sort()` removed from `verbsOf` / `passthroughCommands` | cosmetic |

**Survived but equivalent (no test could kill them):**
- removing `if (raw === '--') continue`, because `--` falls through as a
  harmless flag;
- `if (directedBy)` without `!== origin`;
- `enforced: true` in the directed refusal;
- dropping `withProblem` on the directed path. A sealed policy already refused
  at `d`.

**Tests that pass regardless of behaviour:**
- `registry.test` "covers every Slack action the broker knows":
  `classify(v).ok || classify(v).reason` is truthy for *any* string, including
  an unknown verb, which carries a reason. The list is also hard-coded rather
  than imported from `broker/core.mjs`.
- "blocks the flags…" / "blocks arbitrary SQL…" / "blocks the long-lived
  surfaces…" assert that a constant contains values copied from it. They test
  data against data. The `judgeArgv` tests are the ones that bite.
- "holds even if the table itself says otherwise": #9.
- "takes the MOST RECENT instruction" is not vacuous. It actively pins the wash
  in #4b as correct.

## Verified sound

- `classify`:
  - fails closed on unknown verbs and on `constructor` / `__proto__` /
    `toString` (via `Object.hasOwn`);
  - every refusal returns `timed:false`;
  - a refusal never returns `ok:true`;
  - no write in the *current* table comes back timed.
- The msgvault verb table matches `agent-token issue --permissions` exactly
  (11 names, none of them a send).
- The Slack table matches the broker's `TEAM_ACTIONS` exactly (11).
- `calendar.invite` is refused with a reason.
- `verbForCommand` uses `Object.hasOwn`. `constructor` maps to null, and the
  suite kills a sabotage of this.
- `judgeArgv`:
  - handles `--home X`, `--home=X`, a forbidden flag before the subcommand,
    and one after `--`;
  - allows an operand named `query`;
  - refuses empty argv and flags-only argv;
  - catches `query` behind `--json`.
- `directingOrigin` ignores rows with no sending tab, so a human message
  doesn't wash. Self-sends never create a row. A future `at` errs toward
  refusing.
- `mayPaneUse` with `directedBy` refuses both directions (work→mail,
  personal→Slack). It is a no-op with enforcement off, and the decision says
  `enforced:false`.
