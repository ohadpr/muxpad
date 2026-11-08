# rv1 — every route across the machine boundary, and whether the laundering check survives it

Lane: how work, or a connector request, gets from a chat on machine A into a chat
on machine B, and whether `directingOrigin` + `mayPaneUse(…, directedBy)` sees it.

Scope rule: this doesn't repeat model-code-review #4 (rows a–g). Where a route
below overlaps one of those rows, it says so and covers only the new part.

## Bottom line

`inbound_messages` has **one writer**: `POST /api/agent-sessions/:id/send`, and
only when the caller volunteers `from_pane` (`agent-sessions.ts:104`). Every
other way to get text into a runner goes through `ws.ts submitSend(paneId,
text)`, which takes **no origin argument**. That covers the chat socket, cron
fires, sub-chat report delivery and queue drains. So provenance exists for one
door, and only on the honour system. Everything else is invisible by
construction, not through individual oversights.

Two further facts set the ceiling:

1. **The mini can run arbitrary code on trayo.** It can call `POST
   /api/tabs/:id/panes {node_id:"trayo", startup_cmd}` or type into trayo shells
   (`/api/panes/:id/input`). Trayo's agent account has passwordless root, so it
   can also read every trayo pane's env, including pane keys. A request
   "originating on trayo" therefore proves nothing about who wrote it. No muxpad
   change fixes this (see "Closable where").
2. **`mayPaneUse` still has no caller** (CHECKED, `rg` over `server/src`). Every
   "caught" below means "would be caught once wired".

Live state (read-only `sqlite3` on `~/.muxpad/db.sqlite`): 858 local panes,
2 trayo panes, 0 panes with null `node_id`, 0 mixed-machine tabs, 0
cross-machine parent/child pairs, 6 cross-machine `inbound_messages` rows.
Workspace "Trayo" defaults to node `trayo`.

## The definitive list

Columns: **Rec** means the route writes a provenance row. **Proof** says whether
that row is proven or self-asserted. **Caught** says whether the check refuses
the laundered request once wired.

### Mini → trayo (personal chat directs a work chat, e.g. to post to Slack)

| # | Route | Rec | Proof | Caught | Note |
|---|---|---|---|---|---|
| M1 | `muxpad agent send W` with `from_pane` (CLI default) | yes | self-asserted env var | yes | row a in the prior review (omit or forge it) |
| M2 | same, sender **in the same tab as W** | **no** | — | **no** | **NEW, F1** |
| M3 | same, then W's pane moved or its tab merged | row orphaned | — | **no** | **NEW, F2** |
| M4 | same, **queued** behind a long turn | yes, stamped at accept | — | **no** if the turn lasts more than 15 min | **NEW, F5** |
| M5 | `muxpad agent new` from a local chat | brief via M1 | self-asserted | yes | child inherits `local` (string), so it lands on the mini, not trayo |
| M6 | `POST /api/tabs {node_id:"trayo"}`, or a root tab in workspace Trayo, then brief | brief via M1 | self-asserted | as M1 | CLI has no `--node`; curl does |
| M7 | `POST /api/tabs/:id/panes {node_id:"trayo", startup_cmd, env}` | no | — | no | row g in the prior review; ceiling fact 1 |
| M8 | `POST /api/panes/:id/input` into a trayo terminal or TUI | no | — | no | row g in the prior review |
| M9 | cron `--pane=<trayo pane>`, or `PATCH /api/crons/:ref {prompt}` on an **existing** cron | no | — | no | row f covered new crons; **NEW, F6:** PATCH-ing the owner's own cron, which repeats with no window |
| M10 | cron `--new-tab` in workspace Trayo | no | — | no | lands on trayo via `defaultNodeFor` |
| M11 | `/ws/chat/:paneId` `send` frame, or HTTP send without `from_pane` | no (reads as "human") | api-secret only | no | **NEW angle, F7**: any process holding the secret *is* the human |
| M12 | **local child of a trayo parent**: `POST /api/tabs {spawned_by:<trayo tab>, node_id:"local"}`; the child's report lands in the trayo chat | no | — | no | **NEW, F3** |
| M13 | `muxpad card set` on a trayo tab; the trayo agent reads it with `card get` | no | — | no | F8, low |
| M14 | Out of band: published URL, git remote, Slack itself, email | — | — | no | F10, no muxpad fix |

### Trayo → mini (work chat directs a personal chat, e.g. into msgvault)

| # | Route | Rec | Proof | Caught | Note |
|---|---|---|---|---|---|
| V1 | host-api `agent send` to a mini pane | — | — | **blocked** | `paneIsOn` 404s it. Sound |
| V2 | host-api `POST /api/tabs` producing a mini pane | — | — | **blocked** | parent must be a trayo pane; `node_id` forced to `ctx.nodeId`. Sound |
| V3 | **trayo child's report to a local parent** (parent created on the mini with explicit `node_id:"trayo"` child) | no | — | **no** | **NEW, F3** |
| V4 | **trayo child of a trayo pane that sits in a mixed tab**; `agentPaneOf` delivers to the tab's *oldest* `muxpad agent` pane, which can be local | no | — | **no** | **NEW, F3** |
| V5 | host-api card PUT into a mixed tab (`tabIsOn` accepts any pane on the host) | no | — | no | F8, low |
| V6 | Mini pulls trayo transcripts: `agent transcript`, `pane summarize`, `@mention`, headline generation | — | — | not modelled | F9: information flow, not instruction |
| V7 | `muxpad say` / `reply` from trayo | — | — | n/a | renders in trayo's own chat only; host-api exposes just `GET /api/say/key`. Not a route |

### Trayo → trayo with forged provenance

| # | Route | Rec | Proof | Caught | Note |
|---|---|---|---|---|---|
| T1 | host-api `agent send` with `from_pane` naming **any** pane, including a local one | yes, as named | **host-asserted, unchecked** | can wash, or falsely taint | **NEW, F4** |

### Connector requests originating on B

- **From trayo today: no route through muxpad exists.** host-api allows no
  `/api/slack/*` or msgvault shape. When one is added, it has to go through
  host-api, where `ctx.nodeId` is the strongest origin proof in the system
  (the link object, not a header). The directing check has to run there too.
- **If trayo can reach the broker (100.90.23.126) directly, muxpad isn't on the
  path at all**, and none of this applies. REASONED: I did not inspect the
  tailnet ACL. The broker needs its own answer.

## Findings, by severity

### F1 HIGH — Sends inside one tab are never recorded, even across machines (CHECKED)

`recordInbound` returns early when `from.tab_id === to.tab_id`
(`agent-sessions.ts:146`). The rule exists so a chat doesn't brief itself.
But a tab can hold panes on two machines, while the origin check works per
pane.

Sequence, run against the real routes:

1. Create a trayo agent pane inside personal chat P's own tab:
   `POST /api/tabs/<P tab>/panes {node_id:"trayo", startup_cmd:"muxpad agent --mode chat"}`.
   `POST /api/tabs/:id/merge` produces the same layout, and so does pane `move`.
2. P sends to it with `from_pane`. Result: `inbound_messages` has 0 rows,
   `directingOrigin` returns null, and `mayPaneUse(slack)` returns ok.

**Fix:** skip only when the two panes share the same tab **and** the same
node. Better: store the sender's node in the row at send time, which the prior
review also wanted for other reasons. **Breaks:** nothing. Same-machine,
same-tab sends stay unrecorded.

### F2 HIGH — Moving or merging the receiving chat wipes its taint (CHECKED)

Rows are keyed by the receiving **tab**, and `directingOrigin` joins
`panes.tab_id = inbound.tab_id`. Move W's pane and its history stays behind.

Sequence:

1. P directs W. The check refuses.
2. Either `POST /api/tabs/<W tab>/merge {into_tab_id:<fresh trayo tab>}` or
   `POST /api/panes/W/move {new_tab:true}`. Both return 200.
3. The check now returns ok for both.

The prior review's row d is the **sender** side. This is the receiver side.

**Fix:** add `to_pane_id` to `inbound_messages` and query by pane. Or, more
simply, have move and merge carry rows from the source tab to the
destination. **Breaks:** nothing. The UI's per-tab cards can keep `tab_id`.

### F3 HIGH — Sub-chat report delivery is an unattributed injection, and both cross-machine shapes can be built (CHECKED by route and trace)

`ReportDelivery` calls `submitSend(parentPane, renderSpawnDelivery(...))` and
writes no inbound row (`report-delivery.ts:292`). Yet `spawn_rounds` already
records exactly which child tab the text came from. Three shapes:

- **M12, mini → trayo.** `POST /api/tabs {spawned_by:<trayo tab>,
  node_id:"local", bootstrap:"agent"}` returns 201 with `spawned_by` set
  (CHECKED). The tabs route accepts any `spawned_by`, and an explicit `node_id`
  overrides inheritance. The local worker's report, which the worker writes
  itself through the `report` tool, lands in the trayo chat as a plain message.
- **V3, trayo → mini.** A local parent with an explicit `node_id:"trayo"`
  child. The child's report lands in the personal chat. For a mini-scoped
  connector (msgvault), this is the mirror-image laundering.
- **V4, mixed tab.** `agentPaneOf` returns the **oldest** `muxpad agent` pane
  in the parent tab (`report-delivery.ts:338`). A trayo child spawned from a
  trayo pane that shares a tab with an older local agent reports to the
  **local** one. Trayo can trigger this itself through host-api once a mixed
  tab exists.

**Fix:**

1. ReportDelivery records `from_tab_id = child tab` for each delivered round.
   It's a one-line `InboundMessageStore.record`, and the check then catches all
   three shapes.
2. `agentPaneOf` should pick the parent **pane** that spawned the child
   (`spawned_by_pane` is known at spawn time), not the tab's oldest.

**Breaks:** nothing for the feature the owner uses. Trayo sub-chats are spawned
through host-api with `node_id` forced to trayo, so parent and child are on the
same machine and the check passes. Optionally refuse cross-machine
`spawned_by` in `POST /api/tabs`. The live DB has 0 such pairs, so that would
break nothing today. It would remove the "mini chat spawns a trayo worker"
ability, which nothing currently exposes in the CLI.

### F4 MEDIUM — host-api forwards `from_pane` verbatim (CHECKED)

The `agent send` shape has no `rebuildBody` (`host-api.ts:133`). The body is
passed through unchanged. Sent as trayo with `from_pane:<local pane id>`, it
arrived as `{"text":"x","from_pane":"<local pane>"}`.

Effects:

- Trayo can taint any trayo chat as "directed by local" (a denial of service on
  its Slack).
- It can make the UI card attribute a message to a personal chat that never
  sent it.
- It can wash a taint by naming another trayo pane.

All of these are VM-internal: the VM has root, so it could do the same by other
means, but the misattribution is shown to the owner.

**Fix:** add a `rebuildBody` that keeps `text` and keeps `from_pane` only if
`ctx.paneIsOurs(from_pane)`. Better still, have the host-api stamp
`from_node = ctx.nodeId` itself. **Breaks:** nothing.

### F5 MEDIUM — A queued instruction's window starts before it is delivered (REASONED from code)

The row is written at acceptance with `Date.now()` (`agent-sessions.ts:104`,
`InboundMessageStore.record`). A `queued` send is accepted while W is mid-turn
and drains when that turn ends. If the current turn runs longer than
`DIRECTED_WINDOW_MS`, the instruction arrives with its window already spent,
and W acts on it untainted. This is distinct from row f in the prior review: no
sleep or delay by the directing chat is needed, only a busy target.

**Fix:** persist the origin on the queue entry and stamp the inbound row when
the queue drains. That requires `submitSend` to carry an origin; see "the one
structural change". **Breaks:** nothing.

### F6 MEDIUM — `PATCH /api/crons/:ref {prompt}` launders through the owner's own schedule (CHECKED by trace)

Cron rows have no creator column. PATCH accepts `prompt` on **any** cron,
including one the owner made in the UI that targets a trayo pane. Every fire
then injects through `submitSend` with no origin, indefinitely, outside any
window. A `--new-tab` cron in workspace Trayo lands on trayo
(`defaultNodeFor`).

**Fix:** add `crons.author_node` and `author_tab`, set on create **and on every
PATCH** from the verified caller (pane key; null means the UI). Each fire
records an inbound row from that author. **Breaks:** nothing. Owner-made crons
read as the human.

### F7 MEDIUM — "No provenance" means "the human", and every same-uid process can be the human (CHECKED by trace)

The web composer's `/ws/chat/:paneId` `send` frame (`ws.ts:3289`) and a bare
HTTP send both produce no row, which the check reads as "nobody directed this,
so allowed". Opening that socket takes only the api-secret, which every mini
agent holds. The prior review's row a covered omitting `from_pane` on the CLI.
The new point is that there's no field to forge here at all: the human's own
door is the bypass.

**Fix in muxpad:** none that holds against a same-uid agent. The server can
stop treating absence as trust, and treat "unattributed into a cross-machine
chat" as unknown, refused for timed grants. **Breaks:** the owner typing into a
trayo chat from the web UI would then need a per-request approval for Slack,
unless the human's session carries a proof the agent can't mint. That proof
can only come from the broker (a passkey-bound session).

### F8 LOW — Cards are an unrecorded instruction channel in both directions (REASONED)

The local `PUT /api/tabs/:id/cards/:name` is unscoped: any mini caller can
write to any tab. Trayo can write cards into a mixed tab (`tabIsOn`). This only
matters if the target agent runs `muxpad card get` and acts on what it reads.
**Fix:** none worth the cost. Cards are data, and the instructions file can say
so.

### F9 LOW — Reads aren't modelled, only instructions (REASONED)

The check asks "who told me". Mini chats read trayo transcripts freely (`agent
transcript`, summaries, `@mention` context). The reverse path doesn't exist
(host-api has no transcript shape, so that's sound). A prompt injection in a
work transcript that a personal chat reads is directed work with no row.
**Fix:** if wanted, record a "read from" row on the transcript and summarize
routes when reader and readee are on different machines. Low priority: this
isn't the owner's stated fear.

### F10 INFO — Out-of-band channels

Public `muxpad publish` URLs, a shared git remote, Slack itself, email, any web
service both machines can reach. muxpad can't see these. The check only claims
the accident case; say so in `scope.ts` where it currently says "closed".

### F11 INFO — Watch the untracked `server/src/chat/rebase.ts`

It seeds a fresh session from an old transcript. If the seed is injected
through `submitSend` into a new pane or tab, the taint has to come with it, or
rebasing becomes a wash. Not committed, so not reviewed beyond its header.

## The one structural change

Make `submitSend(paneId, text, origin)` require an origin of type
`{kind:'human'} | {kind:'pane', tab, node, proven} | {kind:'cron', id} |
{kind:'report', childTab} | {kind:'queue', original}`. Have **it** write the
inbound row, with sender node captured at send time and the receiving pane
recorded. Then:

- F1, F2, F3, F5 and F6 close.
- F4 closes once host-api stamps the node.
- New callers can't forget, because the type won't compile without an origin.

This is muxpad-server work only, and it touches nothing on ptyd.

## Closable where

| Gap | muxpad server | Needs the broker or another boundary |
|---|---|---|
| F1 same-tab, F2 re-homing, F3 reports, F5 queue, F6 cron author | yes (structural change above) | — |
| F4 host-api `from_pane` | yes (`rebuildBody` / stamp `ctx.nodeId`) | — |
| Self-asserted `from_pane` on local sends (row a) | partly: require a verified pane key for `from_pane`, as the Slack routes do | against same-uid agents: broker |
| F7 "absence = human" | can stop trusting absence | a human proof: broker passkey session |
| M7/M8 mini authoring code on trayo; trayo root reading every pane key | **no** | Only a boundary that makes trayo pane creation and input from the mini need human approval, or makes the broker treat every trayo-origin request as possibly mini-authored (no timed grants for writes). Shipped muxpad can't do it, since its server runs as the agent's uid |
| Connector requests from trayo reaching the broker directly | no | broker ACL and origin check |
| F9 reads, F10 out of band | F9 optional; F10 no | — |

**Effect on the sub-chats-on-VM feature:** none of the muxpad fixes touch it.
Trayo chats spawning trayo workers is a same-machine relationship (host-api
forces `node_id = ctx.nodeId`, and the parent must be a trayo pane), and the
intersection rule passes when both origins are trayo. The only thing an
optional hardening would remove is a *mini* chat parenting a *trayo* worker,
which no CLI path creates and the live DB has 0 of.

## Verified sound

- host-api: `agent send` and `GET /api/tabs/:id` require the pane or tab to be
  on the calling host. Tab creation requires a host-owned parent and forces
  `node_id`. No shape exists for panes, input, crons, apps, Slack or
  transcripts. Trayo therefore has no **direct** way to put text into a mini
  chat; its only ways in are V3, V4 and V5 (CHECKED: code plus a probe through
  `HostApi.handle`).
- `/ws/agent-runner/:paneId` refuses a runner whose socket speaks for a
  different node than the pane (`nodeOwnershipOk`, `ws.ts:1865`). So a trayo
  runner can't take over a local chat (code read).
- `nodeForBootstrap`: local panes store the string `local` (live DB: 0 nulls),
  so a mini chat's `muxpad agent new` worker stays on the mini even in
  workspace Trayo (CHECKED: live counts and the inheritance test). A
  legacy null-node parent would fall through to the workspace default. That
  path is dead today.
- `recordInbound` records an unresolvable sender as null, and the query skips
  nulls, so a junk `from_pane` can't erase an earlier real row (code read).
  A *real* pane id can, which is row b in the prior review.
- Suite: `src/connectors`, `node-link/host-api.test.ts` and
  `routes/inbound-sender.test.ts` all pass (139 tests). The probes for F1–F4
  ran as a scratch vitest file against the real routes, and I deleted it
  afterwards.
