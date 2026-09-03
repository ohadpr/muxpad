# `muxpad cron` — a server-owned scheduler that writes into the agent send queue

**Date:** 2026-08-14
**Status:** **Built** (2026-08-30, phases 1–3). See §7 for as-built deltas —
the design below is the intent; where the implementation diverged, §7 wins.
**Goal:** replace reliance on the Agent SDK's session-scoped `CronCreate` with a
muxpad-owned scheduling primitive that is durable, visible, editable, testable,
catches up after downtime, and works for every backend.

---

## 1. Why SDK crons fail

`CronCreate` schedules a turn **inside the session that created it**. Every
property that makes it unreliable follows from that one fact.

1. **Fires into a drifted context.** A daily cron on a week-old session talks to
   a compacted, polluted conversation. Output quality degrades over time and the
   degradation is invisible.
2. **No catch-up.** Laptop asleep, ptyd bounced, pane closed → the fire is simply
   lost, with no record it was due. This is the single biggest source of "it just
   didn't run."
3. **7-day auto-expiry.** Silent. Set-and-forget fails on day 8.
4. **Invisible.** `CronList` only works from inside the owning session. There is
   no cross-pane view, no next-due, no last-run, no run history.
5. **Not editable or portable.** You can't move a cron to another pane or change
   its prompt except by asking the agent to do it, correctly, in prose.
6. **Claude-only.** Codex/Cursor panes are spawn-per-turn — autonomous turns are
   structurally impossible there (`2026-07-24-multi-backend-agent-chat.md` §2).
7. **Silent failure.** A cron turn that errors, or wedges on a dead runner,
   reports nothing.
8. **The scheduler operator is an LLM.** You're trusting a model to translate
   "every weekday at 9" into the right expression in the right timezone, and to
   not duplicate or drop it three days later.

The deep problem is (1): a cron bound to a conversation is a **context**
dependency wearing a **schedule** costume. Nearly every recurring job we actually
want — sweep PRs, summarize the day, check the inbox — wants a *fresh* context
and a *stable* prompt, not a chat that has been drifting for a week.

## 2. Why this is cheap to build

muxpad already owns the hard half. Injection into a running agent is a solved,
shipped, restart-safe path:

- **`agent_queue`** (migration v18) + `store/AgentQueueStore.ts` — durable,
  per-pane, ordered by a monotonic `seq`, in SQLite.
- **`submitSend(paneId, text)`** (`ws.ts:326-364`) — the single choke point,
  returning `{status: 'sent' | 'queued' | 'rejected', reason?}`. Runs now if the
  runner is connected and idle; otherwise persists. Drains **one message per
  turn**, refed on `turn-done` (`ws.ts:604`), on runner reconnect (`ws.ts:554`),
  and on enqueue. Works with **zero browsers open**. Bounded at
  `MAX_QUEUED_SENDS = 200`. Already rejects (rather than silently piling up) when
  the pane isn't runner-owned or its respawns are exhausted.
- **`POST /api/agent-sessions/:paneId/send`** (`routes/agent-sessions.ts:66`) →
  `agent-bridge.ts` → `submitSend`. External HTTP already routes through the
  queue (`ws.ts:174-183`), so nothing is dropped.
- **`muxpad agent new "message"`** (`scripts/muxpad:1176`) — creates a
  `bootstrap:agent` tab, polls `/send` until 202, prints the URL. That is "spawn
  a fresh agent on a job," already built.
- **`pane-reaper.ts`** — the precedent to copy verbatim: a durable pending-work
  table (`pending_pane_kills`) + reconcile-on-reconnect + an unref'd
  `setInterval(sweep, 60_000)` fallback. muxpad already knows how to do
  "persisted intent + periodic sweeper"; the cron tick is the same shape.
- **`notice` chat event** with `variant: 'task' | 'reminder'`
  (`shared/src/chat-events.ts:56-62`), already rendered as a chip in
  `ChatPane.tsx:2829-2835` — the render surface for a cron-fire marker exists.
- SQLite + migration ladder (at v18), the `/ws/events` bus,
  `push_subscriptions` + web push (incl. `POST /api/push/test`), launchd
  `KeepAlive` on the main server.

**The write half is done. Only the scheduler half is missing.** That is the whole
feature: one table, one tick loop, one CLI verb, one list view.

## 3. Design

### 3.1 Data model (migration v19)

```sql
CREATE TABLE crons (
  id            TEXT PRIMARY KEY,              -- ulid
  name          TEXT NOT NULL,
  schedule      TEXT NOT NULL,                 -- cron expr, or compiled from a friendly grammar
  tz            TEXT NOT NULL,                 -- IANA, e.g. 'America/Los_Angeles'
  prompt        TEXT NOT NULL,
  target_kind   TEXT NOT NULL,                 -- 'pane' | 'new-tab'
  target_pane   TEXT,                          -- when target_kind='pane'
  workspace_id  TEXT,                          -- when target_kind='new-tab'
  cwd           TEXT,
  model         TEXT,
  backend       TEXT,                          -- claude | codex | cursor
  enabled       INTEGER NOT NULL DEFAULT 1,
  catchup       TEXT NOT NULL DEFAULT 'once',  -- 'once' | 'skip' | 'all'
  overlap       TEXT NOT NULL DEFAULT 'skip',  -- 'skip' | 'queue'
  on_context    TEXT NOT NULL DEFAULT 'fire',  -- pane mode: fire | compact-first | rotate | skip
  quiet_mins    INTEGER NOT NULL DEFAULT 0,    -- pane mode: defer if a human sent within N min
  next_due_at   INTEGER NOT NULL,
  last_fire_at  INTEGER,
  last_status   TEXT,                          -- ok | queued | missed | error:<reason>
  fail_streak   INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE cron_runs (                       -- keep last ~50 per cron
  id           TEXT PRIMARY KEY,
  cron_id      TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  fired_at     INTEGER NOT NULL,
  target_pane  TEXT,
  outcome      TEXT NOT NULL,                  -- sent | queued | skipped | missed | error
  detail       TEXT
);
```

`next_due_at` is **persisted, not held in memory**. That single choice is what
makes the scheduler restart-safe and catch-up capable — the two things SDK crons
can't do.

### 3.2 The tick

One `setInterval` in the main server, 30 s. **Not** per-cron timers.

```
every 30s:
  for each cron where enabled=1 and next_due_at <= now:
     decide fires (catch-up policy)
     fire
     next_due_at = nextAfter(schedule, tz, now)
```

30 s granularity is ample for agent work. One tick loop over persisted state is
drift-free across the dev loop's frequent server restarts; N in-memory timers are
not. Mirror `pane-reaper`'s `setInterval(...).unref()` so the tick can't hold
shutdown open.

**Startup grace:** skip the first tick for ~15 s after boot, the same guard
`attachAttentionPush` uses to stop a restart replay re-blasting pushes. Without
it, an HMR restart during the dev loop fires every due cron before runners have
re-registered — and every one of those lands as a `rejected`.

**Catch-up policy** — the fix for "it just didn't run":

- `once` *(default)* — N missed fires collapse into **one** run, with a marker in
  the injected prompt (`[cron: 3 fires missed while offline]`), then re-anchor to
  the next slot.
- `skip` — drop missed fires silently, re-anchor.
- `all` — enqueue every missed fire (for jobs where each tick genuinely matters).

### 3.3 Firing

**`target_kind='pane'`** → `submitSend(target_pane, renderPrompt(cron))`, and
record its returned `status` into `cron_runs.outcome` verbatim.

That's the entire implementation. It inherits queue durability, one-per-turn
drain, restart-safety, and the 200-message bound. No second injection path.
`rejected` (pane not runner-owned, or respawns exhausted) becomes
`last_status='error:<reason>'` + `fail_streak++` — see §6. Full treatment in
§3.3a, because this is the default mode and its failure modes are the
interesting ones.

**`target_kind='new-tab'`** → do what `muxpad agent new` does: `POST /api/tabs
{bootstrap:'agent'}` in the target workspace, then `submitSend` the prompt.

This is the mode that fixes §1's deep problem: **fresh context every fire, stable
prompt, no drift, no compaction, no expiry.** It is also the mode SDK crons
cannot express at all.

Guardrails, or a nightly cron leaves 30 tabs after a month:
- `max_open` — if the previous run's tab is still open, skip (or reuse) rather
  than spawn another.
- optional `close_when_done` — close the tab on `turn-done` unless the agent
  raised something (a question chip is pending, or it wrote an artifact).

### 3.3a Pane mode in depth — warm context done properly

Pane mode is the default and the one most jobs want: "keep an eye on the deploy
you started," "continue the sweep," anything where the agent needs to remember
what it already did. §1 argues warm context *degrades*; that's an argument for
managing it, not for refusing it.

Firing into a live pane is exactly what an SDK cron does — but with catch-up,
visibility, editability, `cron run` testing, restart durability, and no 7-day
expiry. **Pane mode is not a compromise; it's SDK-cron semantics minus every
failure mode.** And because `submitSend` just enqueues, it works on
**Codex/Cursor panes too** — the queue drains into a spawn-per-turn `resume`,
giving those backends recurring work that the SDK's `autonomous: false` makes
structurally impossible.

Four things must be handled, and the server already has the signals for all four:

**1. Context growth — `on_context`.** A 30-minute cron on one pane will fill the
window and thrash compaction. `conn.status.context.pct` is already live in
`ws.ts:160` (optional per `chat-events.ts:118` — absent for backends without a
window). Policy column:
- `fire` — ignore context (fine for hourly/daily).
- `compact-first` *(default for sub-hourly)* — if `pct > 80`, send the existing
  `{t:'slash', cmd:'compact'}` frame (`protocol.ts:80-81`), then the prompt. Both
  queue as normal turns, so ordering is free.
- `rotate` — over threshold, fall back to a fresh tab for this fire (a per-cron
  escape hatch into new-tab mode) and note it in `cron_runs`.
- `skip` — don't fire; record `skipped:context`.

Treat missing/unknown context as `fire` — `conn.status` is in-memory and null
until the runner's first status frame after a restart.

**2. Don't barge into a live conversation — `quiet_mins`.** `conn.lastSendAt`
(`ws.ts:162`) already tracks the last human send; `INTERACTIVE_PUSH_SUPPRESS_MS`
(`ws.ts:41`) is the existing precedent for "the user is right here, back off."
If `now - lastSendAt < quiet_mins`, defer to the next tick rather than dropping
(a cron shouldn't be lost because you happened to be chatting). Default 0 for
daily jobs; set it for chatty panes.

**3. Overlap — `overlap='skip'`.** If the pane's queue already holds an unfired
message from *this* cron, don't stack another. Otherwise an agent busy for three
hours gets six identical "check PRs" messages back to back — a real SDK-cron
failure mode, and the one most likely to burn tokens while you sleep.

**4. Target the pane, not the session.** `pane_id` is the durable handle: the
sid rotates on `/clear` and on resume-drift (`claude.ts:605-615`), and
`startup_cmd` self-heal keeps the pane's agent alive across ptyd restarts and
reboots. So the cron survives everything except pane deletion — which must
`ON DELETE` disable the cron and push, not spin on `error` forever.

**Ergonomics.** Typing a pane id is miserable. `--pane` defaults to
`$MUXPAD_PANE_ID`, so the natural gesture is running `muxpad cron new` *from
inside the pane you mean*; also accept the pane's `name` column. The best path is
§3.9's MCP tool: say "check my PRs every weekday morning" in a chat and the agent
creates a durable muxpad cron **targeting its own pane** — same phrasing as
today, none of the fragility. Model/backend columns are ignored in pane mode; the
fire inherits the pane's live session.

### 3.4 Marking the message

The injected message must be visibly a cron fire, to both human and agent. Reuse
the existing `notice` chat event (`variant: 'reminder'`, already chip-rendered at
`ChatPane.tsx:2829-2835`) rather than inventing a surface — add a `cron` variant
carrying the cron name, rendered `⏱ pr-sweep · 09:00`. Not a hidden system
message: it belongs in the transcript, where you can see what fired and when.

### 3.5 Observability — the actual fix

`cron_runs` turns silence into a record. `muxpad cron list` shows name, schedule,
target, next due, last fire, last status; `muxpad cron show <id>` adds the run
history. A muxpad UI list renders the same rows off the existing event bus.

`fail_streak >= 3` → auto-disable + **web push** via the existing
`push_subscriptions` path. That is the mechanism that stops it failing you
silently.

### 3.6 CLI

```
muxpad cron new  --name=pr-sweep --at='0 9 * * 1-5' [--tz=America/Los_Angeles]
                 (--pane[=<id|name>] | --new-tab [--workspace=<id>] [--cwd=<dir>] [--model=<m>])
                 [--catchup=once|skip|all] [--overlap=skip|queue]
                 [--on-context=fire|compact-first|rotate|skip] [--quiet=<mins>] "prompt"
                 # --pane with no value = this pane ($MUXPAD_PANE_ID)
muxpad cron list [--json]
muxpad cron show <id>
muxpad cron run  <id>          # fire now — test before trusting
muxpad cron pause|resume <id>
muxpad cron rm   <id>
```

`cron run` matters on its own: today an SDK cron can't be tested without waiting
for the wall clock.

### 3.7 Timezone

Store IANA tz per cron; evaluate with `Intl.DateTimeFormat` parts, never UTC
arithmetic. DST is where hand-rolled schedulers break. Use `cron-parser` (small,
tz-aware, well-tested) and accept a friendly grammar (`every 30m`, `daily at
09:00`, `weekdays at 09:00`) that compiles down to a cron expression.

### 3.8 Sleep

A sleeping laptop doesn't tick; `catchup=once` covers the real need ("run it when
I'm back"). No `pmset` wake scheduling in v1.

### 3.9 Let the agent create these

Expose `muxpad_cron_create` from the runner's in-process MCP server — the same
mechanism that already serves `ask_user` and `show_files`
(`agent-runner/index.ts:193-279`). "Remind me every morning to…" then produces a
durable, visible, editable muxpad cron instead of a session-scoped SDK one. ~30
lines, and it's the migration path off `CronCreate`.

## 4. Explicit non-goals

- **No general job runner** — no DAGs, no retry/backoff trees. The agent *is* the
  retry mechanism; the prompt says what to do.
- **Not in ptyd.** Scheduling policy belongs on the main server, which restarts
  freely; putting it in ptyd would make every tweak a terminal-killing bounce.
  `next_due_at` in SQLite is what makes server restarts safe.
- **No second injection path.** Everything goes through `submitSend`.
- **No sub-minute granularity, no distributed locking.** One server, one tick.

## 5. Phasing

1. **Phase 1 (~1 day)** — table + tick + `target_kind='pane'` (§3.3a: `overlap`,
   `quiet_mins`, `on_context`, pane-deleted handling) + CLI
   (`new/list/rm/run/pause`). This is the mode most jobs want, and it is already
   strictly better than SDK crons: visible, editable, testable, restart-safe,
   catches up, and works on Codex/Cursor panes.
2. **Phase 2** — `new-tab` mode + tab lifecycle guardrails, for the jobs that
   want a clean room instead of a warm one. `on_context=rotate` bridges the two.
3. **Phase 3** — UI list + run history, push on repeated failure, and the runner
   MCP tool so agents create muxpad crons.

## 6. The honest risks

**1. A wedged target pane.** Dead runner, respawns exhausted, backend needs auth.
The good news: `submitSend` already handles this — it returns `rejected` (and
`ws.ts:248-256` clears the orphaned queue) rather than piling into a void. So the
cron layer's only job is to *not throw the answer away*: record `error`,
increment `fail_streak`, auto-disable at 3, push. If we ignore the return value
we will have rebuilt silent failure one layer up, which is the entire thing we're
trying to escape.

**2. Uptime is the real dependency.** A muxpad cron fires only while the main
server is running. Today the launchd plists are *documented in `docs/launchd.md`
but not checked in* — a manual `scripts/muxpad start` doesn't survive reboot. So
`muxpad cron` is only as reliable as its host: **shipping this should come with
checked-in plists (or `muxpad install`, punch-list item)**, otherwise we've traded
"the SDK dropped my cron" for "the server wasn't running." Catch-up softens it;
it doesn't remove it.

**3. Some of this wants a trigger, not a schedule.** PR opened, file changed, mail
arrived. A 5-minute poll is a crude trigger. The same table can grow
`trigger_kind = 'schedule' | 'watch'` later — don't build it now.

---

## 7. As-built deltas (2026-08-30)

Phases 1, 2 and 3 shipped. The design above held up; these are the places the
implementation deliberately diverged, and why.

### Schema and plumbing

- **Migration is v22, not v19.** v19–v21 landed between the design and the
  build (globals/hidden workspaces, session_history, agent modes + the living
  sidebar). Versions 2–5 remain burned.
- **Extra columns beyond §3.1:** `mode` (the new-tab fire's agent overlay),
  `max_open`, `close_when_done`, `open_tabs` (JSON list of the tabs a new-tab
  cron currently has open), and `jitter_ms` (below). `cron_runs` gained
  `target_tab` so a new-tab run points at what it created.
- **No FK on `target_pane`.** §3.3a asked for pane deletion to disable the
  cron, not delete it — an `ON DELETE` cascade would do the opposite. The
  scheduler handles it: a fire against a missing pane disables the cron once,
  loudly, with a push.
- **`cron_runs` is trimmed on every insert** (newest 50 per cron), not swept
  later. A bound applied lazily is not a bound.

### Scheduling

- **Deterministic jitter (new).** Every cron carries an id-derived offset,
  capped at `min(30 min, interval/2)`, folded into the persisted
  `next_due_at`. Without it every daily cron fires at exactly :00 and a dozen
  of them stampede the runner fleet and the model API in the same second.
  Derived from the id rather than `Math.random()` so `next_due_at` stays
  reproducible across restarts and testable at any point — the two properties
  this scheduler exists for. Every surface (`cron list`, `cron show`, the
  sidebar ⏱ tooltip) shows the **jittered** time, never the nominal one: the
  displayed time is the truth, not the schedule's aspiration. The nominal slot
  is recovered exactly as `next_due_at - jitter_ms`, so catch-up enumeration is
  unaffected.
- **A "missed" fire needs a grace.** §3.2's catch-up policies say nothing about
  how late is late. A slot older than 3 ticks (90 s) is missed; anything newer
  is simply this tick's fire arriving a beat late. Without it a punctual fire
  could carry a spurious `[N missed]` marker — a lie to the agent.
- **Catch-up enumeration is capped** at 1000 occurrences. A `* * * * *` cron
  across a month of downtime is ~44k slots; under `catchup=all` that would be
  an attempt to enqueue 44k messages.
- **NO 7-day expiry, deliberately** — silent expiry is one of the failure modes
  this replaces (§1.3). The runaway bound is a ceiling on *enabled* crons (100)
  plus the run-log trim, both of which can only ever refuse a *new* thing,
  never silently retire a working one.
- **`quiet_mins` reads a new signal.** §3.3a proposed `conn.lastSendAt`, but
  that is bumped by *any* relay including the cron's own — a 5-minute cron with
  `quiet_mins` set would have deferred itself forever. `ws.ts` now tracks
  `lastHumanSendAt` separately, with provenance read off the message itself (a
  fire carries its marker), so it survives the durable queue and a restart. The
  turn-done push gate moved to the same signal, which is what its comment
  already claimed ("autonomous wakeup/cron turns do push").
- **Fail-fast on `dead` reads the raw bit, not the rolled-up status.**
  `getStatus` ranks `working` above `dead` (right for the nav — a spinner says
  more than a ×), so a corpse still dribbling pty output read as `working` and
  silently disarmed the guard in exactly the case it exists for. Added
  `PtydCache.isDead()`.
- **A manual `cron run` never counts toward the failure streak.** The user is
  watching it fail; one bad hand-test must not retire a working nightly job.
- **Resume and schedule edits re-anchor.** A cron paused for a week must not
  wake up to a week of catch-up it was deliberately not meant to run.

### §3.9 is dropped

The runner MCP tool (`muxpad_cron_create`) is **unnecessary**. Every agent on
every backend already receives `<dataDir>/agent-instructions.md` and has the
`muxpad` CLI on PATH, so the migration path off `CronCreate` is a paragraph of
prose, not 30 lines of MCP. The seed now says, in as many words: **do not use
your harness's built-in scheduler** — session-scoped, drifting, silently
expiring, no catch-up, invisible — use `muxpad cron new` instead, with the
common `--pane` invocation and the list/run/pause/rm verbs. (Seed only; the
user's live copy is user-owned and never overwritten.)

### New-tab mode

- **`close_when_done` defaults ON** for new-tab crons. §3.3 left it optional
  because "tabs pile up" was the guardrail's whole job; since then every
  session is archived and FTS-searchable (`server/src/archive/`), so closing a
  finished cron tab loses nothing — the conversation is still findable with
  `muxpad search`. Two things still hold a tab open, because both mean the
  agent has something *for you* that a search won't surface: a pending question
  (the pane is blocked) and an artifact (an attachment on the pane). A `fatal`
  turn also keeps it — a crashed run is exactly what you want to look at.
- **New-tab fires default to ⚡ Do mode** (`agent-modes.ts`). Terse and
  result-first is exactly what a scheduled job's report should be. Pane mode
  inherits the pane's existing mode; the column is ignored there.
- **`max_open` is enforced against tabs that still exist**, pruned on each
  fire, so a manually-closed tab frees the slot immediately.

### `on_context=rotate` carries context (important)

As designed, `rotate` spawned a **clean-context** agent — which, for a
long-running domain chat, means a confidently amnesiac one whose output is
indistinguishable from a good one. Rotation now takes a **handoff briefing**
from the rotating pane (`chat/summarize.ts`, extracted from the summarize
route) and injects it, delimited as `<muxpad-carryover>`, ahead of the cron
prompt. If a briefing cannot be produced, we **do not rotate** — we record
`skipped: carryover-failed`. Losing a fire is recoverable; silently amnesiac
output is not. The briefing SOURCE is a single injected dependency
(`CronSchedulerDeps.carryover`), so a future per-chat dossier replaces it
without touching the scheduler.

### Visual indication

A cron is a **property** of a chat, not a status, so it deliberately does not
touch the status rail (`StatusMark`: one transient, mutually-exclusive state,
right-aligned in a fixed column meant to be scanned vertically — and it would
lose to `working` at exactly the moment a fire happened). Instead a quiet ⏱
sits on the **name** side of the nav row, in both the sidebar and the sheet
(one `TabRow` component serves both), with the cron name and next-due time in
the tooltip, localized client-side. When a cron fires, the existing `working`
status covers the activity — the mark itself never changes.

The association is folded into the tab row by `decorateTab` (`crons`,
`next_cron`), sourced from **one** query per sidebar list (`cronsByTab`), never
one per row — the tab list is polled every 5 s, so a per-row lookup would have
been the hottest query in the app. A route test asserts the query count.

In-transcript, a fire renders as the existing `notice` chat event with a new
`cron` variant (`⏱ pr-sweep · 09:00`) above the prompt it delivered. The
message is wrapped in a `<muxpad-cron …>` marker that is both the render hook
and a real instruction to the model ("a scheduled job, not a human"); the split
happens on both transcript roads — Claude's raw JSONL and the codex/cursor
normalized log — so all three backends render a fire identically.

### Confirmed, not built

- **Fires land BETWEEN turns, never mid-response.** This is inherited, not
  implemented: `submitSend` queues while a turn is in flight, and the queue
  drains one message per turn on `turn-done`. There is an e2e test asserting it
  so a future "just send it directly" shortcut can't quietly break it.
- **§4's non-goals all stand.** No job runner, nothing in ptyd, no second
  injection path, no sub-minute granularity, no distributed locking.
- **§6 risk 2 (uptime) is unchanged and still real.** muxpad now runs under
  launchd (`KeepAlive`), which is most of the mitigation, but a cron is still
  only as reliable as its host; catch-up softens that, it doesn't remove it.

### Extractions made along the way

`bootstrapTab` / `deleteTabCascade` (`server/src/agent-tab.ts`) and
`summarizePane` (`server/src/chat/summarize.ts`) were lifted out of
`routes/tabs.ts` and `routes/summary.ts` unchanged, so a cron-created tab is
built and torn down by the *same* code as a hand-created one. A second
hand-written copy of "how you make an agent tab" is how the two would have
drifted on the next change to the startup-command shape.
