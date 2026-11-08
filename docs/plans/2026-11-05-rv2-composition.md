# rv2 — composition review: scope × registry × passthrough

Lane: put the three modules together, plus the routes that feed them, and look
for a capability the owner never approved. Prior reviews' findings are not
restated. Where one is still open, or has come back by a new route, it gets one
line.

Code: `server/src/connectors/{scope,registry,passthrough}.ts` at 3b2337f, plus
`routes/agent-sessions.ts` (`recordInbound`), `routes/panes.ts` (create,
move), `routes/nodes.ts`, and `store/migrations.ts` v35.

Method: CHECKED means I ran it. I used a throwaway vitest file, deleted
afterwards, against a real migrated `openDb(':memory:')` and the REAL Hono
routes (`agentSessionsRoutes` `/send` and `panesScopedRoutes` `/move`) with
stubbed ptyd/bridge. CHECKED also covers `msgvault <cmd> --help` on 0.22.0.
REASONED means traced through code but not executed, usually because executing
it would mutate state. The connector suite passes: 4 files, 92 tests.

## Context that frames everything below

- **There are still ZERO call sites** for `mayPaneUse`, `directingOrigin`,
  `classify`, `judgeArgv` or `verbForCommand` outside `connectors/`. I grepped
  `server`, `web` and `broker` (CHECKED). Every finding here is about the
  contract a future caller inherits. None of them is a live bypass of live
  code.
- **`/Library/muxpad/` does not exist** (CHECKED). So `loadPolicy()` is
  `UNSCOPED` and `mayUse` returns `ok` for everything. Today the composite check
  is `classify` + `judgeArgv` alone. Scope and laundering contribute nothing
  until the file is installed.

---

## Findings, most severe first

### 1. HIGH — A personal chat directs a work chat in the SAME TAB and leaves no trace — CHECKED

`mayPaneUse` decides per PANE, but provenance is recorded per TAB. `recordInbound`
drops any send whose sender and receiver share a tab ("a chat does not brief
itself", `agent-sessions.ts:146`). A tab can hold panes on two machines:

- `POST /api/tabs/:id/panes` takes an explicit `node_id` that "still wins" over
  the sibling's;
- `POST /api/panes/:id/move {to_tab_id}` moves any pane into any tab.

Sequence (honest, no forged `from_pane`, nothing injected):

1. Tab T holds L, a personal chat on `local`, and V, a work chat with
   `node_id:'trayo'`. V was created with an explicit node, or moved in.
2. L runs `muxpad agent send V "post X to #eng"` with its true
   `MUXPAD_PANE_ID`. The route returns 202.
3. `inbound_messages` has **0 rows**. `directingOrigin(V)` returns `null`.
4. `mayPaneUse(db,'slack',V, {slack:[trayo], msgvault:[local]}, null)` returns
   `{ok:true, origin:'trayo', enforced:true}`.

This differs from prior #4a, which needs a lying caller, and from #4e, which is
the sender side resolving to the tab's oldest pane. This one is the honest path.

**Which module should have stopped it:** `recordInbound`. It encodes "same
chat" as "same tab", while scope encodes "same principal" as "same node". The
drop should apply only when sender and receiver are on the same node. Better,
record `from_pane` and `from_node` in the row at send time, which prior #4
already asked for. The same-tab exemption is what makes this case new.

### 2. HIGH — Moving the DIRECTED pane erases its taint, while the agent keeps the instruction — CHECKED

Provenance hangs on `inbound_messages.tab_id` with `ON DELETE CASCADE`.
`directingOrigin` joins through the pane's CURRENT tab.

1. P is a personal chat on `local`, in tab Tp. W is a work chat on `trayo`, in
   tab Tw.
2. P sends to W. `directingOrigin(W)` returns `local`, and Slack is refused.
   Correct so far.
3. W is moved to another tab: `POST /api/panes/W/move {to_tab_id: T3}`. P can
   do this with the api-secret, or the owner can do it while tidying the rail.
   Tw is now empty, so the move deletes it, and the cascade deletes its inbound
   rows.
4. `directingOrigin(W)` returns `null`, `mayPaneUse` returns `ok:true`, and
   **inbound rows left: 0**.

The runner and the conversation survive the move. Its `node_id` is preserved
(CHECKED in the move response), so W still holds P's instruction in context. If
the source tab is not emptied the rows survive, but on the wrong tab, and the
result is the same.

Prior #4d moves the SENDER. This moves the RECEIVER, and it needs no
deliberate act: an ordinary drag does it.

**Which module:** `directingOrigin`. Taint belongs to the agent session or pane
that received the instruction, not to whichever tab it sits in now. At the very
least, a move must carry the rows with the pane. The reverse case, moving a
clean pane INTO a tainted tab, taints it, which is the safe direction.

### 3. HIGH (boundary framing) — The root-owned policy names node IDs, and what a node ID *means* is an agent-editable row — REASONED

`connectors.json` is root-owned so that agents cannot change "slack → trayo".
But `trayo` is resolved through the `nodes` table, and these are reachable with
the api-secret every agent holds:

- `PATCH /api/nodes/trayo {endpoint}` re-points it (`nodes.ts:125`, which only
  refuses `local`);
- `DELETE` then `POST /api/nodes {id:'trayo', endpoint}` re-creates it. The ID
  is caller-chosen, and the token is written to dataDir, readable by the same
  account.

A sequence that ends in mixing:

1. Re-point `trayo` at a `muxpad-node` started on the mini, on a loopback
   port, using a token read from dataDir.
2. Create a pane with `node_id:'trayo'`. It runs on the mini as `ohadpr`.
3. `mayPaneUse` returns origin `trayo`, which is allowed Slack. The same
   process can `sqlite3 ~/.msgvault/msgvault.db`.

This is the owner's exact fear: a chat with personal mail that can also post to
work Slack. I did not run it, because it mutates nodes.

Prior reviews established that origin is asserted by the distrusted party, as
far as the broker is concerned. What is new here is *inside* muxpad: the
`scope.ts` docblock argues that root ownership puts the policy "out of an
agent's ordinary reach". That holds for the file's bytes and not for its
meaning.

**Which module:** `scope.ts`'s trust argument. Either bind each policy entry to
something an agent cannot re-point (the node's pinned pubkey, or its Tailscale
stable node ID) and have `mayPaneUse` check the row against it, or say plainly
in the docblock that the file's guarantee stops at the node table. Because the
VM cannot reach the broker (one-way tailnet), the broker cannot tell either.

### 4. MEDIUM — Nothing binds connector, verb and grant together, so the three answers are independent and a caller recombines them — CHECKED (independence), REASONED (misuse)

- `mayPaneUse` takes the connector as a free argument.
- `classify` returns `{ok, kind, timed}` with **no connector field**.
- `judgeArgv`'s `command` is msgvault-only by construction, but nothing ties
  `verbForCommand`'s output back to the connector that `mayPaneUse` was asked
  about.

CHECKED: on a local pane, `mayPaneUse(db,'msgvault',L)` returns ok and
`classify('slack.read')` returns `{ok:true, timed:true}`. Both are true at
once, and neither knows about the other.

A route that composes them naively reads the connector from its own path and
the verb from the request body. It writes `mayPaneUse(route connector) &&
classify(body.verb).timed && hasGrant(route connector)` and dispatches a Slack
read on a msgvault day-grant, or the reverse. The same shape spends a grant
approved for one *account* on another (#6). A caller that checks only
`judgeArgv().ok` is worse: `draft-compose` is `ok:true` (CHECKED), so it rides
a read grant as a write. That is prior #7 seen from the grant side.

**Which module:** none of them owns it, and that is the defect. Add one entry
point, `decide({paneId, verb, argv?})`, that:

- derives `connector = verb.split('.')[0]`;
- calls `directingOrigin` itself;
- returns one record: `{connector, verb, kind, timed, origin, directedBy,
  enforced, policyRevision, registryRevision}`.

The grant lookup should take that record, never loose booleans.

### 5. MEDIUM — The default is the wrong way round, and the result cannot reveal that it was taken — CHECKED

On `directedBy = null`, I concur with prior #6 and will not restate it. The
composition point is that **the `ok` decision drops `directedBy` entirely**
(`return d` at the end of `mayPaneUse`). An audit row or approval prompt built
from a `ScopeDecision` cannot tell "nobody directed this chat" from "the caller
never asked", so a forgetful caller is undetectable after the fact as well as
before.

Implied call sites that must each remember the argument (there are none today):

- the Slack routes;
- the `muxpad msgvault` runner;
- the approval-prompt builder;
- any grant-reuse fast path;
- a cron fire into a pane;
- a future host-api relay for VM requests.

The cron fire is the worst of these. It carries no `from_tab_id`, so even a
correct caller gets `null` (prior #4f).

**Fix:** as prior #6 says, plus put `directedBy` (or `'unchecked'`) in the
returned decision.

### 6. MEDIUM — The personal/work line runs through ACCOUNTS, and no module can name one — REASONED

The policy, the registry and the verdict all stop at the connector. But
msgvault takes `--account`, `--collection` and `--source-id` on search and stats,
and `--account`/`--from` on every `draft-*` command (CHECKED in `--help`). Slack
grants are per `teamID`.

Suppose the archive holds a work mailbox next to the personal one. I did not
look, to avoid reading it. Then scoping `msgvault → local` hands work mail to
every mini chat. Likewise, one `slack → trayo` entry covers every workspace the
token reaches. A timed read "for msgvault" has no account in it to check.

**Gap or broker's job:** a gap in the model both copies share. The broker can
put source IDs on a msgvault grant, but nothing upstream decides which sources
a host may use, so the broker's copy has nothing to apply. The policy needs
`allow: {"msgvault:<source>": [...]}` or an equivalent. `judgeArgv` would then
have to refuse an argv with no explicit `--account=`/`--source-id=`, rather
than let msgvault default to "all accounts".

### 7. MEDIUM — Two command trees are still mapped as leaves, and the table names subcommands that do not exist — CHECKED

On 0.22.0:

- **`meetings` has `actions`, `context` and `metrics`.** `media` has
  `search`. Neither is in `NESTED`. As a result,
  `meetings context --id=42 --include-transcript=true -o=/tmp/x.md` comes back
  `ok:true`, command `meetings`, verb `msgvault.message.read`, `{read,
  timed:true}`. That is a bulk transcript write to an arbitrary path under a
  timed read. Prior #3 named `meetings`, and 3b2337f added `NESTED` but left
  these two out, so it is still open.
- **`calendar list`, `calendar show`, `person find` and `person show` are
  mapped, but 0.22.0 has none of them.** Calendar's children are `conflicts`,
  `create`, `delete`, `freebusy`, `move`, `respond` and `update`. Person has
  `get` and `list`, not `find` or `show`. This is harmless today, because cobra
  errors on an unknown child. But it means the table was not checked against
  the binary.

  This is also the version-drift trap. A later msgvault that adds `calendar
  show` or `person find`, with whatever semantics, inherits a **timed read**
  with no muxpad change and no review. The same goes for any leaf that grows
  children, as `meetings` already did.

**Which module:** `passthrough.ts`. Add a test that walks `msgvault --help`
recursively and fails if any command with children is absent from `NESTED`, or
if any mapped pair does not exist. Pin it to a msgvault version.

### 8. MEDIUM — A timed grant outlives the classification it was approved under — REASONED

A day-long read grant is minted against msgvault permission names. Two mappings
can change during its life, and nothing records either:

- muxpad's command→verb table (`COMMAND_VERBS`, `NESTED`);
- msgvault's permission→capability semantics (a `brew upgrade`).

Suppose build N+1 maps `meetings context` to `message.read`, or msgvault 0.23
lets `message.read` do something new. The grant approved under build N then
covers it, and a prompt that read "read mail for a day" now means something it
did not say.

**Which module:** `registry.ts` should export a revision: a hash of
`VERBS + COMMAND_VERBS + NESTED + REFUSED_COMMANDS`, plus the msgvault version.
The grant should store it, and dispatch (muxpad and broker) should refuse on
mismatch. This is broker territory for enforcement, but the revision has to
come from here.

### 9. LOW–MEDIUM — The check order is not structural, and only one order means anything — REASONED

The modules are pure apart from `loadPolicy`'s disk read, so no check's side
effect undoes another. The one side effect in the system that matters is
`recordInbound`, and #1/#2 cover that.

What the modules cannot do is force the order. A natural implementation adds a
fast path, "grant exists, so dispatch", and puts it ahead of scope. Then
`mayPaneUse` and the laundering check run once, at mint, on whichever request
happened to be clean. Every later tainted request spends the grant. The broker
cannot re-run laundering, because it has no `inbound_messages`. So laundering
is muxpad-only by construction and must run on **every** dispatch, including
grant reuse. The `decide()` entry point in #4 should be the only path to the
grant lookup.

---

## What an approval needs that is not represented anywhere

| Missing | Gap here, or the broker's job? |
|---|---|
| Account / source / team the approval covers | **Gap in the model** (#6). The broker can carry it but has nothing to apply. |
| Which connector a verb belongs to, carried in the result | **Gap here** (#4). |
| Whether laundering was checked, and against what | **Gap here** (#5). |
| Registry and msgvault revision at approval | **Produced here, enforced by the broker** (#8). |
| A node's identity, as opposed to its row | **Gap here** (#3). Only the policy can pin it. |
| Who asked, unforgeably (pane proof) | Prior review. Not solvable while panes share an OS account. |
| Payload hash for writes | Prior review. The broker's job. |

## Checked and sound

- **A caller that ignores `ok` and uses `command` fails closed.** No
  `REFUSED_COMMANDS` entry is a `COMMAND_VERBS` key, and a bare `calendar`
  yields command `calendar`, which `verbForCommand` maps to `null` (CHECKED).
- **A caller that reads only `classify().timed` fails safe.** Every refusal is
  `timed:false` (CHECKED; also prior).
- **A pane cannot be recreated with the same ID through the API.**
  `PaneStore.create` mints a ULID, `node_id` is never updated after create, and
  move preserves it (CHECKED by trace, and in the move response). A deleted
  pane is refused by `mayPaneUse`. A grant keyed to a pane ID therefore cannot
  be inherited by a new pane. It is only forgeable, which prior reviews cover.
- **Moving a clean pane into a tainted tab taints it**, and a mixed tab where
  the *local* pane was directed from elsewhere taints the trayo pane too. Both
  err toward refusing.
- **No check's side effect disables another.** The three functions write
  nothing, and `loadPolicy` re-reads on every call, so a stale policy cannot be
  cached across a decision.
