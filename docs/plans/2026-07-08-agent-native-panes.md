# Agent-native panes: `muxpad agent`

Date: 2026-07-08
Status: Shipped (v1). Full live e2e passed: attach → chat turn → interrupt → server-restart reconnect → kill → resume with context.

## What this is

A pane whose primary face is **web chat over a persistent Claude session**, with the terminal as its observability log — the chat-first primitive, replacing the fragile live TUI⇄chat toggle for panes that opt in.

```
muxpad agent                    # in any pane: start a chat-native session
muxpad agent --resume <sid>     # resume one (what the self-heal writes)
```

## Architecture

**The runner lives IN the pane's pty, not in the server.** `muxpad agent` execs
`node server/dist/agent-runner/index.js`, which hosts one long-lived Claude
session via the Agent SDK (`query()` with streaming input) and connects to the
main server over `/ws/agent-runner/:paneId`.

Why in-pane:
- **ptyd owns it** → it survives `muxpad restart` (server-only) like every
  terminal; the runner just reconnects its ws (2s retry, e2e-verified).
- **Self-healing**: on hello the server rewrites the pane's `startup_cmd` to
  `muxpad agent --resume <sid>`. A ptyd restart or reboot re-runs it and the
  pane springs back into the same session from disk. Pane = session.
- **Pane lifecycle = agent lifecycle.** No new supervision machinery; closing
  the pane ends the runner; Ctrl-C in the terminal face ends it too (the
  session stays on disk, resumable).

**Read path unchanged**: the SDK writes the normal `~/.claude/projects` JSONL
(spike-verified), so the existing TranscriptTail renders history and live
messages. The runner adds only what the tail can't see: turn lifecycle frames
(`turn-start`/`stream`/`turn-done`) and the live-typing preview.

**Write path**: chat `send`/`stop` relay server→runner. The runner serializes
turns (one in flight; later sends queue). `stop` = SDK `interrupt()` — the
turn ends cleanly and the session accepts the next turn.

**Single writer by construction**: the runner IS the pane's foreground
process; `writer='sdk'` in agent_sessions. The TUI takeover/relaunch machinery
is bypassed for these panes (takeoverPane no-ops; the view toggle is a pure
view flip).

## What this fixes vs the switchable TUI primitive

- **Scheduled wakeups / background tasks / warm context** live in the one
  persistent process — per-turn `claude -p` spawns structurally couldn't host
  them, and the TUI⇄chat switch killed them on every toggle.
- **Permissions**: `bypassPermissions` + `allowDangerouslySkipPermissions` —
  the SDK auto-approves every tool call before `canUseTool` is consulted
  (verified; the SDK even warns the callback is shadowed). No hidden prompt
  can wedge a turn.
- No SIGTERM handoffs, no foreground sniffing, no typing resume commands into
  live shells.

## Server pieces

- `/ws/agent-runner/:paneId` (ws.ts): registry keyed by pane; newest runner
  wins on respawn; disconnect mid-turn fails the turn visibly and releases the
  writer; hello → `AgentSessionStore.attachRunner` (writer sdk, view chat, sid
  into lineage) + `PaneStore.setStartupCmd` + `agent_session.updated` event.
- `agent_session.updated` on the event bus → `/ws/events` → ShellPaneBody
  re-checks immediately: the face flips to chat the moment the runner
  registers, across every device; the busy dot follows turn start/end live.
- Chat relay: sends/stops route to a connected runner before the legacy
  headless per-turn path (which remains the fallback for `muxpad claude`
  panes).
- Startup reconcile clears stale `sdk` writers; live runners re-hello within
  seconds.

## The old toggle

`muxpad claude` panes keep the existing terminal⇄chat switching unchanged.
Direction: new chat-first work targets agent panes; the toggle stays as the
mobile mirror for TUI sessions.

## Round 2 (same day): tabs-first + faces + questions + progress

- **"+ Agent" / atomic tab bootstrap**: `POST /api/tabs {bootstrap: 'shell'|
  'agent'}` creates tab + single full-size pane in one request (layout set,
  pty eagerly spawned). An agent tab's runner attaches with zero clients —
  chat-native sessions can be born from a phone. CLI: `muxpad tab new
  --bootstrap=agent`. All web creation flows are tabs-first; splitting stays
  an explicit in-tab action.
- **Server-persisted faces**: `panes.face`/`face_url` (+ PATCH + pane.updated
  events); `pane-face.ts` is now an optimistic overlay over the server value
  (tab-view-mode pattern) with one-time localStorage migration. Every face —
  including web + URL — survives reloads and follows across devices. The
  agent_sessions.view_mode channel is legacy (still written, no longer read
  by the client).
- **ask_user question chips**: Claude Code's AskUserQuestion is NOT offered
  to SDK sessions (spike-verified), so the runner exposes `ask_user` via the
  SDK in-process MCP server. Chat renders tappable option cards (single-tap /
  multi-select / free-text "Other…"); the blocked tool call resolves on
  answer; Stop and turn-end dismiss it; server restarts re-deliver it (the
  runner re-sends pending questions after every hello).
- **Subagent live progress (stage 1)**: the runner counts subagent stream
  messages per Task tool-use id → throttled `{steps, lastTool}` frames → the
  chat Task row shows "N steps · Bash: …" with a spinner while running.
- **Chat heartbeat**: app-level ping/pong (20s, visible tabs) detects zombie
  idle sockets; complements the send-time ack watchdog.

## Known gaps (v2)

- Nested subagent transcript (drill-in) — deliberately deferred; the
  progress line covers the "is it alive" need. `forwardSubagentText` is the
  SDK hook when wanted.
- Non-yolo permission prompts in chat (`PreToolUse` hook is the gate that
  works under bypass; `canUseTool` is shadowed).
- "Who drives this pane" is still branched client-side in a few places
  (guarded server-side); a server-owned driver concept would clean it up.
