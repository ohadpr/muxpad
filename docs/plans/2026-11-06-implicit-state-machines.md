# The implicit state machines in muxpad

A survey, asked for directly. An *implicit* state machine is one whose states
exist but are never named: a handful of booleans, refs or columns that are
only valid in certain combinations, with the transitions written by hand at
each site that happens to need one. They are not bad code by definition — the
smallest ones are fine — but they share a failure mode, and it is the one that
has produced most of the bugs found in this repo recently:

> **A transition is added in one place and not the others.** Nothing fails, the
> combination is simply unreachable from that path, and the bug is "it works
> except when…".

MEASURED means I counted or read it; INFERRED means I am reasoning from shape
and naming without having traced every path.

Ranked by the cost of getting it wrong, not by how many flags are involved.

---

## Status, re-measured 2026-11-08

Two of the three recommendations at the foot of this document are done, and
the measurements below are from today, not from when it was written.

| | then | now | |
|---|---|---|---|
| **#3 ChatPane's foreground** | four flags re-derived in six places | **FIXED** — `lib/pane-foreground`, five named states, all 32 combinations under test | `b7771a6` |
| **#2 pane status** | `getStatus` plus a `busy` alias on every row | **FIXED** — the alias is gone from the wire, the CLI, the shared type and the instructions; `getBusy` is `isWorking` | `0b3d1c5` |
| **#1 the agent turn** | 13 booleans in one closure, three backends | **OPEN** — now **14** in claude.ts (9 in codex, 8 in cursor) | — |

The turn has gained a flag since the survey, which is the thing a survey is
for: the count moves on its own. It remains the one worth doing and the one
least suited to being rushed — it is the live runner, and a mistake there ends
every chat on the machine rather than mis-drawing a row.

ChatPane still has 16 boolean `useState`s and 5 boolean refs. That number did
not fall because the foreground group was never four of those sixteen — it was
`drawerOpen` plus two modal objects plus a prop. What changed is that nothing
re-derives the question any more. The remaining clusters (socket, pager,
composer) are listed below and are not urgent.

### Found since: the broker's request lifecycle

Not in the original survey because the broker was not in scope then. One
request moves through **pending → verifying → executing → complete**, with
**rejected**, **failed** and **expired** as exits, and the transitions are
written at eleven separate sites. Alongside it a grant carries `expires`,
`elapsedExpires`, `owner`, `grantEpoch` and a scope string that must all agree
for a dispatch to be legal — sixty lines mention one of those four.

This one is DIFFERENT from the others, and the difference is worth stating: its
states are named, `state` is a single field rather than a set of booleans, and
the comments explain each transition. It is an explicit state machine written
without a state-machine type. The risk is not confusion about what the states
are; it is that a new exit added at a twelfth site will not know about the
other eleven. Leave it alone unless it grows again.

---

## 1. The agent turn — `server/src/agent-runner/backends/claude.ts` · MEASURED

**Thirteen booleans in one 2,883-line closure:** `quotaPaused`,
`recoveryInFlight`, `uncertainToolResult`, `inTurn`, `interruptRequested`,
`clearRequested`, `shuttingDown`, `streamedTextThisTurn`,
`saidSomethingThisTurn`, `titleGenerated`, `answeredThisTurn`, `turnHuman`,
`turnCron`.

The states are real and nameable — *idle*, *in a turn*, *interrupting*,
*clearing*, *quota-paused*, *recovering a credential*, *shutting down* — and
one transition is written out longhand at `claude.ts:1406`: a block of sixteen
assignments that means **enter turn**. A hand-written entry block is the
signature: every field reset there is part of the state, and anything added
later that is *not* reset there is a leak from the previous turn into the next.

**And there are three copies.** `codex.ts` has fourteen such assignments,
`cursor.ts` twelve. The same machine, implemented three times, which is where
backends drift from each other — exactly the class of difference that produces
"works on claude, not on codex".

**What it invites:** a turn that ends while `interruptRequested` is still set; a
`quotaPaused` that outlives the recovery that cleared it; a flag added for one
backend and missed in the other two.

---

## 2. A pane's status — assembled, never stored · MEASURED

The five-state vocabulary is documented (`blocked` / `working` / `ready` /
`dead` / `idle`) but no single place owns it. It is assembled from
`agent_sessions.status`, the `agent_queue`, `retired_at`, the runner registry
and — for panes with no runner — a PTY-output heuristic, across
`PaneStore.listAgentPanes`, `listParkCandidates`, `ws.ts` and the rail.

`PaneStore.ts:165` documents a bug of exactly this shape: a pane qualified
"three ways, and the third was missing", so a worker whose runner crashed
between turns scored zero on both of the implemented tests and "stayed live
forever". The fix added a third clause — to that query. Any other reader of the
same concept still has two.

`busy` survives as a deprecated alias for `status === 'working'`, which is a
second name for one state.

---

## 3. ChatPane — several machines in one component · MEASURED

Sixteen boolean `useState`s and five boolean refs. They are not one machine but
at least five, sharing a scope:

| machine | flags |
|---|---|
| socket/liveness | `connected`, `stale`, `staleRunner` |
| the older-pager | `hasMoreOlder`, `loadingOlder` + `hasMoreOlderRef`, `loadingOlderRef` |
| search jump | `jump`, `jumpMissed`, `clearJump` |
| composer | `sending`, `branching`, `startBusy` |
| foreground owner | `drawerOpen`, `drawer.paneId`, `openTool`, `openImage` |

The duplicated state/ref pairs in the pager exist because an effect needs the
value synchronously — a standard workaround, and also a second place for the
truth to live.

**The precedent is in this same file.** The scroll machine *was* an implicit one
— the comment at `ChatPane.tsx:864` lists the thirteen refs that used to
coordinate it and says twelve existed only to answer "was that scroll event us
or the reader?". It is one controller with one writer now. That refactor is the
worked example for the rest.

**Recent evidence it is still live:** the "foreground owner" group produced two
bugs this week — typing captured by the parent while a sub-chat was open, and
the jump-to-latest arrow painting over the drawer. Both were a missing term in
a condition, in a group with no named states.

---

## 4. The approval ceremony — `web/src/components/SlackPasskeyApproval.tsx` · MEASURED

`busy`, `dismissed`, `busyRef`, `alive`, `blocked`, plus a local `active` per
effect run. The states are *idle*, *requesting*, *awaiting the ceremony*,
*deciding*, *blocked*, *dismissed*; `blocked` and `busyRef` are reset together
at `:76`, which is a transition.

Worth naming explicitly because this is the UI that stands between an agent and
your Slack token — and the broker's own notes say a decision must never be
replayed on an uncertain response, which is a statement about legal
transitions.

---

## 5. The voice session — `web/src/lib/voice/use-voice.ts` + `session.ts` · MEASURED

`starting`, `ending`, `muted`, and `starting.current` is cleared in four
separate places. A start/stop race machine written as two booleans: the
unreachable-looking combination (`starting && ending`) is exactly what a
double-tap produces.

---

## 6. The connector/action lifecycle — `chat_actions.state` · MEASURED, small

`pending | sent | failed | declined` on our side, mapped from the broker's
larger set (`pending`, `verifying`, `executing`, …) by one function,
`stateFromBroker`. Contained, and the mapping is in one place — but the two
vocabularies differ in size, so a broker state nobody mapped lands on a
default.

---

## 7. The host link — `server/src/node-link/HostLink.ts` · MEASURED

One `closed` boolean, plus a `pending` map and a `subscribed` map whose
*population* is the rest of the state: connecting, open, draining, subscribed,
replaying after a reconnect. Two known-open defects live here and are both
transition gaps: a pending question lost on reconnect, and a subscription
stranded by a host-agent restart.

---

## 8. Cron runs · INFERRED

`queued` → `running` → `done`/`failed`, plus a failure streak and `max_open`.
The recorded failure mode — a `--new-tab` run that hangs `queued` and wedges the
schedule — is the shape of a machine with no terminal transition for one path.

---

## 9. The sub-chat lifecycle · MEASURED, spread

*spawned* → *working* → *delivered* → *retired* is expressed across
`tabs.done`, `retired_at`, the spawn round, `spawnState()` in `chat-mention`,
and `isChatDone`/`isChatRetired` in `ChatChip`. Five places agreeing by
convention. The predicates are at least centralised; the ROUND is not.

---

## 10. Small and honest · MEASURED

`write-coalescer.ts` (`scheduled`, `holding`), `use-long-press.ts`,
`all-tabs.ts`. Two or three flags each, read in one file. Listed for
completeness; I would leave them alone.

---

## What I would actually change, and in what order

1. **Name the turn's states in one backend** (claude), as a tagged union with
   one `enter(state)` function, and make the other two backends use it. The
   entry block at `claude.ts:1406` already *is* that function, written out.
2. **Give the pane status one owner** — one function every reader calls,
   including the park sweep and the rail — and delete `busy`.
3. **Extract ChatPane's foreground-owner group** (who holds the keyboard, who
   is on top), which has already produced two bugs, following the scroll
   controller's example.

Everything below that is worth knowing about and not worth rewriting.
