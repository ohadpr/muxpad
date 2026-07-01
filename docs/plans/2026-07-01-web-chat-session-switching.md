# Web chat for Claude sessions, switchable with the terminal

Date: 2026-07-01
Status: Design — validated by a 10-agent review of real implementations (Happy, CloudCLI/claudecodeui, opcode, claude-code-webui, Sculptor, omnara, VibeTunnel camp) and the official Agent SDK/CLI primitives.

## Goal

Let a Claude Code session be viewed and driven from **either** the real terminal TUI (great on desktop) **or** a native chat web UI (great on mobile), switching back and forth — without scraping the terminal to understand what the agent is doing. muxpad already owns the pty bridge and web face; this adds a structured **chat** face over the same session and an explicit **handoff** between the two.

### Scope & assumptions (this cut)

- **Claude Code only.** Codex/Cursor are later adapters; the interface is designed for them but not built.
- **Every session is launched via `muxpad claude`.** This is the hard contract: switchable sessions are started **only** by `muxpad claude [any claude args...]` (the `yolo` alias becomes `muxpad claude --dangerously-skip-permissions`; the CLI-launched-by-another-Claude path routes through the same wrapper). Sessions started by bare `claude` outside muxpad are **not supported** — muxpad owns every launch, and the whole design exploits that. This collapses discovery, lineage, and single-writer enforcement from core machinery to near-free.
- **Sticky live runner.** Moving between desktop/mobile only changes which *view* attaches. It does **not** auto-swap the runner. Switching runner (TUI↔chat) is an explicit toggle, gated on a turn boundary. Mid-turn device change stays on the current variant (user's call).
- Access boundary stays Tailscale, as today. No new auth. Conscious note: a `bypassPermissions` headless driver reachable over the tailnet means anyone on the tailnet can drive a full-permission agent on this machine — same posture as terminal access today, but the chat face makes it easier to reach. The `SessionStart`-hook endpoint must be bound local-only.
- **Out of scope for now (manual workaround exists):** starting a brand-new session *from* mobile with no desktop terminal. If wanted, just open a pane and type `muxpad claude --dangerously-skip-permissions` as usual; a headless-from-scratch entry flow is a later add.

## The three corrections that shape everything

The review killed three assumptions in the first-draft spec. They are non-negotiable constraints now:

1. **Session-id is not a stable baton.** `--resume` (CLI and SDK) can return a *new* `session_id` and write a *new* `<uuid>.jsonl`; official docs say "append same id" but multiple real issues (#8069, #10806, #12235, SDK #555) and real implementations (claude-code-webui's `grouping.ts` dedupe) show it drifts in practice. **Design for drift.** muxpad maintains its own **AgentSession** identity and a **lineage** = ordered list of Claude session-ids/files. The live id is always (re)read from the `system:init` event, never assumed.
   > **S0 RESULT (Claude 2.1.198, headless `-p --resume`): appends to the SAME file, session-id STABLE — no fork.** A single `.jsonl` held both turns with one distinct `sessionId`. So for the headless write path the pessimistic fork case did not occur, and the lineage collapses to (usually) a single id. Keep the `AgentSession`/lineage abstraction anyway as **insurance** — driven by the `SessionStart` hook as source of truth — because (a) the interactive-TUI resume path and (b) `/compact`/`--fork-session` are not yet verified and are the cases most likely to mint a new id. Don't build heavy dedupe until a hook actually reports a new id.

2. **`muxpad claude` owns the launch — no fs-watch discovery.** Because muxpad launches every session, discovery is deterministic, not inferred. The `.jsonl` is created only on the *first prompt* and is ambiguous when two sessions share a cwd, so fs-watch would race — we don't use it. Instead the wrapper (see Launch contract below):
   - **Mints** a UUID and passes `--session-id <uuid>` (honored for `-p`/headless; best-effort for the TUI, which may still mint its own — reconciled via the hook).
   - **Installs a `SessionStart` hook** via `--settings` (Happy's mechanism) that makes Claude POST its real `session_id` to a muxpad endpoint. Fires on fresh / `--continue` / `--resume` / `/compact` / fork — so it is *also* how we grow the lineage. The hook is the source of truth for the id; `--session-id` is best-effort.
   - **Registers the `AgentSession` before launch** (pane id from `MUXPAD_PANE_ID`, minted id, cwd), so the tracker has the row before any file exists. 1:1 pane→session mapping by construction, no race.
   - Never derive cwd from the encoded dir name (lossy: every non-alphanumeric char → `-`). Read the real `cwd` from inside the JSONL.

3. **Enforce single-writer mutual exclusion.** There is no platform lock; two live drivers on one session corrupt/fork the transcript. muxpad is the sole arbiter: exactly one of {TUI, headless runner} owns a session at a time. Handoff = **stop the old writer, verify it is dead, then resume in the new mode.** Detect a rogue second `yolo` terminal on the same session and surface a conflict rather than double-drive.

## Launch contract: `muxpad claude`

A new subcommand of the existing in-pane muxpad CLI. **Passthrough that augments** — runs `claude` with the user's exact args, injecting only what muxpad needs, then `exec`s so the process replaces the wrapper (signals, Ctrl-C, and the TUI are byte-identical to running `claude` directly).

```
muxpad claude                                         # interactive
muxpad claude --dangerously-skip-permissions          # the `yolo` alias expands to this
muxpad claude --dangerously-skip-permissions "first prompt"
```

Steps, in order:
1. Read `MUXPAD_PANE_ID`/cwd from env (already present in every pane).
2. Mint a session UUID — **unless the user passed `--session-id`, then adopt theirs** as the lineage root.
3. Build a `--settings` file containing the `SessionStart` hook (POST id → muxpad). **If the user passed their own `--settings`, merge into it, don't overwrite** (Claude takes one settings source).
4. Register the `AgentSession` with the tracker (pane, minted id, cwd).
5. `exec claude <user args> --session-id <uuid> --settings <merged>` — **preserving any positional first-prompt arg** verbatim.

Non-goals: adopting a bare `claude` started outside muxpad. Unsupported by design.

## Core model

```
AgentSession (muxpad-owned, persisted)
  id                muxpad's own stable id (survives all hops)
  pane_id           the pane this session belongs to
  assistant_kind    'claude' (adapter key)
  cwd               real cwd (read from JSONL, not the dir name)
  lineage           [ claude_session_id... ]  ordered, grows on every resume/fork/compact
  current_sid       last id seen from a system:init  (the live tail target)
  validated_sid     last id we confirmed has real user+assistant lines on disk
  transcript_paths  resolved <cwd-hash>/<sid>.jsonl per lineage entry
  view_mode         'terminal' | 'chat'
  writer            'tui' | 'headless' | 'none'   (the single-writer token)
  status            idle | turn-active | resuming | conflict | dead
```

muxpad's session identity is **decoupled** from Claude's (omnara's `agent_instance_id` lesson). Claude's ids are lineage members; `AgentSession.id` is the durable handle used by the UI, the toggle, and PaneStore.

## Architecture: where each piece lives

muxpad = main server (Hono; router, PaneStore, ws bridge) + **ptyd** (daemon; owns processes, survives server restarts) + web (React/xterm).

- **Session tracker** — **on the main server** (not ptyd — see Restart safety). Exposes the `SessionStart` hook endpoint, maintains lineage/`current_sid`/`validated_sid`, resolves transcript paths, persists to PaneStore.
- **Transcript tailer + normalizer** — reads the lineage's `.jsonl` files (byte-offset tail, truncation/rewrite-aware), normalizes to canonical chat events, streams over a new **`/ws/chat/:paneId`** (JSON frames, parallel to the binary `/ws/pane/:id`). Works while the TUI is the live writer (read-only mirror). **This is the novel part — spike it first (S1).**
- **Headless runner** — **on the main server** (not ptyd); **spawns one `claude` per turn** with `--resume <current_sid> --output-format stream-json --input-format stream-json`, `permissionMode: bypassPermissions`. Not a long-lived per-session process (Sculptor/CloudCLI/opcode all confirm per-turn+resume is the restart-safe, scalable shape). Durability is the JSONL, **not** the process — so it does **not** need to live in ptyd for survival; a server restart at worst drops one in-flight chat turn, recovered by resume (S0). Interrupt = kill the process.
- **Switch orchestrator** — main server. Owns the single-writer token and the turn-boundary gate. Executes the TUI↔headless handoff state machine.
- **Web chat pane** — new renderer beside `XtermPane`: bubbles / thinking / tool cards / diffs (from `toolUseResult.structuredPatch`) / composer. Per-pane terminal↔chat toggle.

## Restart safety (build this without killing running Claudes)

**Hard constraint: this feature touches only the main server, web, and the `muxpad claude` CLI script — never ptyd.** Verified against `scripts/muxpad`: ptyd and the server are separate processes; `muxpad restart` (default) bounces the *server only* and reuses the already-running ptyd, so every pane and its live `claude` survive (browser ws drops <1s, ring-buffer replay on reconnect). Only `muxpad restart --all` SIGTERMs ptyd and kills panes — this work must never require it.

Consequences that lock the design in place:
- The headless runner and session tracker live on the **main server**, not ptyd (durability is the JSONL, per S0), specifically so iterating on them is a server-only restart.
- The `muxpad claude` wrapper is a change to the CLI script — picked up on next launch, **no daemon restart at all**; existing panes keep running.
- Deploy loop while building: `muxpad restart` (server-only) + web rebuild. Panes/Claudes untouched.

This also aligns with the standing rule that tunable logic belongs on the server, not ptyd.

## Read path (tail → chat)

Canonical event model, normalized from JSONL lines. Rendering hygiene the reviews proved necessary:

- Skip `isMeta` lines without `leafUuid`/`summary`; skip `<command-name>`/`<local-command-stdout>` wrappers and the injected `"Caveat: ..."` first message.
- Pair `tool_use`↔`tool_result` by id; render diffs from `toolUseResult.structuredPatch`.
- **Skip `subagents/agent-*.jsonl`** — they reuse the parent `sessionId` and will clobber the mapping.
- Per-line `try/catch`; tolerate partial/malformed lines (concurrent writes are normal).
- **Byte-offset tail with truncation/rewrite detection**, not size-delta — compaction rewrites the file in place and can shrink it (opcode's size-only watcher misses this).
- Dedupe across lineage files: adopt claude-code-webui's subset-grouping (drop a file whose assistant-`message.id` set is a subset of a larger one) or follow `parentUuid` chains.

Turn-complete signal for the read side: last `assistant` line has `stop_reason: "end_turn"` (not `"tool_use"`) **and** PTY idle. No explicit "turn done" record exists; disambiguate subagents / mid-`Bash` / compaction with the PTY-idle cross-check.

## Write path (compose → headless)

Per turn: composer text → spawn `claude -p --resume <current_sid> --input-format stream-json --output-format stream-json` under `permissionMode: bypassPermissions` (**not** the `--dangerously-skip-permissions` *flag* — it shows a one-time interactive confirm dialog that hangs with no TTY, #52506). Stream events to `/ws/chat`; new messages append to the transcript, which the tailer already renders. Capture the (possibly new) `session_id` from `init`; extend lineage. Gate turn-complete on the `result`/`ResultMessage` event — **reliable**, but do **not** wait for process exit (stream-json result-then-hang / worker leak: #25629, #68626 open at 2.1.170). Reap the process on a timer after `result`.

`bypassPermissions` auto-approves everything; since sessions are YOLO this is the intended posture. Keep an SDK `canUseTool` → `/ws/chat` permission-request hook stubbed for a future non-YOLO mode (CloudCLI/Happy/omnara-MCP patterns), but it is dead code under bypass. Note: `bypassPermissions` refuses to run as root — check the daemon uid.

## Switch state machine (single-writer, turn-gated)

```
terminal (writer=tui)  --toggle chat-->  await turn boundary
    -> stop TUI process (SIGTERM; verify dead)   [writer=none]
    -> resume headless with current_sid          [writer=headless, view=chat]

chat (writer=headless)  --toggle terminal-->  await result event
    -> kill headless (idempotent; verify dead)   [writer=none]
    -> spawn TUI: claude --resume <current_sid> in a pty   [writer=tui, view=terminal]
```

Invariants:
- Never two writers. Transition through `writer=none`; verify the old process is dead before the new one resumes.
- Gate on a turn boundary (`result` for headless; `end_turn`+PTY-idle for TUI). Forced mid-turn switch = warn, drop the partial (completed messages are already on disk).
- **Rogue-writer detection:** while headless owns the session, a new same-lineage session file growing = a user hand-launched a second `yolo`. Surface `status=conflict`; do not silently double-drive.
- Handoff back to a live TUI hits the stdin/pty drain bug class (Happy's #301 family: O_NONBLOCK, duplicated cursors, leaked keystrokes) — budget a drain/`setBlocking` step.

## Stop / interrupt from mobile

A **Stop** button in the chat view, available regardless of who owns the session. Semantics = Claude's Esc (**graceful interrupt**), not a process kill:

- **Writer = TUI:** write a single `Esc` byte to the pty (muxpad already forwards input — this is the write side, not the read-side scraping we rejected). Claude stops generating and returns to an idle prompt. That idle state **is a clean turn boundary**, so the follow-on TUI→headless handoff is the normal gated switch with **no mid-tool truncation risk** (avoids #18880). Then: stop the TUI process (verify dead) → resume headless → you're driving in chat.
- **Writer = headless:** interrupt the in-flight turn via the SDK interrupt / control-request (graceful), not a raw kill, to keep the transcript clean. Stay in chat.

Net UX: one button → generation stops cleanly → you're now driving from the web chat.

## Failure modes to build for (all evidenced in the review)

- **Resume crashes** on a transcript killed mid-tool-use (#18880) and on very large / subagent-heavy sessions (#30302) — *exactly* the long YOLO workload. Build a "resume failed → start fresh session seeded with a summary of the lineage" fallback. Keep `validated_sid` (Sculptor's rollback): before each turn confirm the id's file has real user+assistant lines; if not, roll back and warn "your last message may be missing from context."
- **Leaked headless workers** (#68626) — reap on a timer, never wait for EOF.
- **SDK/CLI version drift** — the JSONL schema is internal/undocumented, and Claude Code ships constantly (this is what killed omnara's wrapper). Couple to the stream-json/flag surface and pin CLI+SDK together; prefer the SDK's `list_sessions()`/`get_session_messages()` readers over hand-parsing where practical. **Ship a version-drift canary**: a test that runs on every `claude` upgrade and asserts — `muxpad claude` launches, the `SessionStart` hook fires, `--session-id` behaves, the stream-json shape is intact, and resume identity matches what S0 established. Without it, breakage surfaces on your phone in production.
- **Compaction UX** — long YOLO sessions compact, rewriting the transcript in place (the tailer's byte-offset/truncation handling copes with the bytes). Register a `PreCompact` hook so the chat view can show a "compacting…"/"compacted" state and, ideally, context-fullness — otherwise a mid-session rewrite looks like a glitch on mobile.
- **Phantom sessions** — an `init` id whose `.jsonl` never lands; reap with a bounded `awaitFileExist`.

## De-risk first: spikes before the build

- **S0 — resume identity truth. ✅ DONE (2026-07-01, Claude 2.1.198).** Headless `-p --resume` **appends to the same file, id stable, no fork**. Also confirmed: pre-minted `--session-id` is honored for the `-p` path, and `--permission-mode bypassPermissions` runs tools headless with no hang. Lineage machinery downgraded to insurance (above). *Still unverified (cheap follow-ups): interactive-TUI resume identity, and `/compact`/`--fork-session` behavior — both covered by the hook regardless.*
- **S1 — read-while-live. ✅ DONE (core question answered).** Live-tailed a transcript during a ~10s multi-tool turn: the file grew incrementally (6→9→…→18 lines, tracking each Bash tool call as it happened) and **every line at every sample parsed cleanly — zero partial/torn-line reads**. Newline-delimited atomic appends, live-tailable mid-turn. The riskiest read-side bet holds. *Caveat: proven against the `-p` writer, not the interactive TUI writer specifically — the persistence code is shared so behavior should match, but do one faithful TUI-writer confirmation before shipping the read path.*
- **S2 — hook-based discovery + lineage.** Launch via a muxpad-controlled `yolo` alias with `--session-id` + a `SessionStart` hook POSTing to muxpad; confirm 1:1 pane→session and that the hook re-fires (growing the lineage) on `--resume`/`/compact`/fork. (~half day)
- **S3 — round-trip handoff.** TUI→(stop, verify dead)→headless resume→drive a turn→back to TUI, twice, same AgentSession. Watch for transcript fork, context loss, pty drain glitches. (~1 day)

Only after S0–S3 look good does the full build below make sense.

## Phased build

1. **`muxpad claude` wrapper + session tracker + PaneStore schema** (`AgentSession`, lineage, `writer`, `view_mode`). The wrapper (Launch contract above) + the hook endpoint it POSTs to. Re-point the `yolo` alias to `muxpad claude --dangerously-skip-permissions`. *(depends on S2)*
2. **Transcript tailer + normalizer + `/ws/chat/:paneId`** — read-only chat mirror. Ship this alone first: it already makes mobile dramatically better with zero driving. *(depends on S1)*
3. **Web chat pane** — renderer + composer + terminal↔chat toggle beside `XtermPane`.
4. **Headless runner** — per-turn `--resume` + `bypassPermissions`; drives new turns; `validated_sid` rollback; worker reaping.
5. **Switch orchestrator** — single-writer token, turn-boundary gate, rogue-writer conflict surface, pty drain on hand-back.
6. **Hardening** — resume-failure fallback, large-session guards, version pinning.

Build 1–2 first: read-only mirror is low-risk, immediately useful, and proves session tracking before any driving.

## Adapter seam (for Codex/Cursor later)

```
AgentAdapter {
  launchTui(opts)            // command + hook/settings injection for the pty
  launchHeadlessTurn(opts)   // per-turn structured spawn
  captureSessionId(evt|hook) // where the id comes from
  transcriptPath(sid, cwd)   // or null if stream-only (Cursor)
  normalizeStream(events)    // -> canonical chat events
  resumeArgs(sid, mode)      // tui vs headless resume invocation
  permissionModel            // interactive-callback | policy-upfront
}
```

Claude is adapter #1. Codex (tier 1: readable `~/.codex/sessions/**/rollout-*.jsonl`, `codex exec --json`, `codex resume`) slots in later; Cursor is tier 2 (structured stream but opaque on-disk history → back the chat from muxpad's own recorded stream). Tiers degrade to today's xterm pane for terminal-only agents.

## Open questions to settle empirically (not from docs)

- S0's resume-identity behavior on the pinned Claude version (drives lineage vs. simple-append).
- Does `--session-id` actually control the *interactive TUI's* local file, or only the API/telemetry id? (Reconcile via the hook regardless.)
- Read-while-TUI-live lag and correctness (S1) — the make-or-break for the read path.
