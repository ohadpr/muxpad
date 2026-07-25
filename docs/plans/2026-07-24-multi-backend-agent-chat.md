# Multi-backend agent chat (Claude · Codex · Cursor)

**Status:** Plan v2 — revised after an adversarial code-review pass (findings folded in below).
**Date:** 2026-07-24
**Goal:** let an agent-chat pane be driven by **Codex CLI** or **Cursor CLI** (`cursor-agent`, incl. `composer` models) alongside Claude, behind one adapter interface — teaching `ws.ts` as little about providers as possible (not "nothing" — see §5, the honest seam).

> Research + review were done by four subagents against **live local installs** (`codex 0.144.4`, `cursor-agent 2026.06.04`) and the actual code. Verified facts are marked; the review corrected several optimistic claims from v1 — those corrections are the reason this is v2.

---

## 1. Where we stand (verified)

The live-turn wire protocol (`RunnerFrame` runner→server, `ServerMsg` server→client) is a **mostly** clean normalized seam. `ptyd-cache.ts` is fully backend-agnostic; `ChatPane.tsx` renders capability-gated chrome. But the seam is **not** as clean as v1 claimed — four concrete couplings run through the "untouched" files (§5).

**Claude coupling today:**
1. `server/src/agent-runner/index.ts` — built on `@anthropic-ai/claude-agent-sdk`. The turn loop is *dense*: an async-generator `userMessages()` feeding one long-lived `query()`, a failed-interrupt disambiguation timer (`index.ts:481-507`), autonomous-turn detection for wakeups/crons (`index.ts:707-714`), in-process MCP tools `ask_user`+`show_files` (`index.ts:193-279`), subagent throttling, and self-titling via a second `query({model:'haiku'})`.
2. **History**: server tails Claude's transcript **file** (`TranscriptReader.findTranscript` → `~/.claude/projects/<sid>.jsonl`; `chat-events.normalizeTranscriptLine` decodes Claude JSONL). The runner *also* uses `findTranscript` (`index.ts:68`) to decide whether a `--resume` is real.
3. **Hidden client coupling**: `ChatPane.tsx` hardcodes "Claude" in placeholder/aria/empty-state copy (`:1840,:1691,:1436-1439`), though `SessionMeta.assistant` is already plumbed to it (`:309,:627`) and unused.

`ChatEvent`, `AgentQuestion`, `SubagentProgress` are provider-neutral. `AgentSessionStatus.context` is **not** — it's a required field and `sanitizeAgentStatus` drops the whole status frame if `context.{pct,tokens,max}` are missing (`chat-events.ts:125-133`). That must change (§5, B3).

## 2. What Codex & Cursor give us (verified against local installs)

| | **Codex** `codex exec --json` | **Cursor** `cursor-agent -p --output-format stream-json` |
|---|---|---|
| Headless stream | JSONL `thread.started`/`turn.*`/`item.*` | NDJSON, Claude-shaped `system/init`→`user`→`assistant`→`tool_call`→`result` |
| Text deltas | **No** (message-granularity) | **Yes** w/ `--stream-partial-output` (dedupe final full-text repeat) |
| Session id | `thread_id` UUID, `~/.codex/sessions/…jsonl` | `session_id` UUID, **cloud-backed** (local SQLite is a cache) |
| Resume cross-process | Yes: `codex exec resume <id>` | Yes: `--resume <id>` — **needs network + auth** |
| Autonomous turns (no user send) | **No** (spawn-per-turn) | **No** (spawn-per-turn) |
| Interactive approvals | **No** in exec (policy-only) | **No** answerable event (`--force`/allow-deny) |
| Token usage | `turn.completed.usage` | `result.usage` (end-of-turn only) |
| Context-window size | not in stream | not in stream |
| Auth check | `codex login status` (exit code) | `cursor-agent status` (exit code) |
| Title | none — generate ourselves | none — generate ourselves |
| Richer mode (Phase 3) | `codex app-server` JSON-RPC: deltas + approval round-trip | `cursor-agent acp` JSON-RPC over stdio |

Both session ids are UUIDs → satisfy the existing `^[A-Za-z0-9._-]{1,128}$` sid gate. No sid-plumbing change.

**Capabilities that DIE for spawn-per-turn backends** (call these out to the user up front, don't bury them):
- **Autonomous wakeups / crons / background tasks** — these depend on Claude's *persistent* session firing turns with no user send. `exec`/print modes are one-shot. Claude-only until/unless we adopt the long-lived app-server/acp modes (Phase 3).
- **Interactive tool approvals** (`ask_user` question chips) — no headless equivalent; run under an explicit sandbox policy instead.
- **Inline artifacts** (`show_files`) — the in-process MCP tool has no exec/print equivalent.
- **Token-level typing** for Codex exec (Cursor has it).

## 3. Architecture

`AgentBackend` interface **inside the runner**; dispatch on a `--backend` arg. The runner process stays long-lived (ws link, turn queue, persistence, self-heal signature). **Two backend shapes coexist behind the interface:**
- **Persistent-session (Claude):** owns its long-lived SDK session, `session.interrupt()` + the failed-interrupt timer, autonomous-turn detection, and its `userMessages()` generator — all move *into* `backends/claude.ts`, not the harness.
- **Spawn-per-turn (Codex/Cursor):** each `send()` spawns a CLI subprocess, parses its stdout stream into frames, `interrupt()` = SIGKILL the child (no timer machinery needed).

The harness owns only what's truly shared: the ws relay, the frame `send`, the turn-queue *dispatch* (kick backend on send / block while a turn runs), the history-log write path, and keeping the `agent-runner` foreground signature.

```ts
interface AgentBackend {
  start(opts: { sessionRef: string | null; cwd: string; model?: string }): Promise<void>;
  send(text: string, attachments?: Attachment[]): void;
  interrupt(): Promise<void>;
  setModel?(model: string): Promise<void>;
  slash?(cmd: 'compact' | 'clear'): void;
  answer?(qid: string, answers: unknown): void;   // optional — only questions-capable backends
  close(): void;
  events(): AsyncIterable<RunnerFrame>;
  liveSessionRef(): string;
  historySource(): { kind: 'vendor-file'; locate(ref): string | null; normalize(line): ChatEvent[] }
                 | { kind: 'muxpad-log'; path: string };   // see §3.1
  readonly caps: {
    textDeltas; models; contextMeter; questions; subagents; compact; clear; autonomous;
  };
}
```

### 3.1 History — per-backend source over the SAME proven tail engine (revised)

v1's "one muxpad-owned log for all three" was wrong: an append-only log never shrinks, so `TranscriptTail`'s "file-shrank ⇒ /compact reset" (`TranscriptReader.ts:129-136`) becomes dead code; the Claude backend would need a *second* SDK-message normalizer that must byte-match the file one (silent dedupe-drift bug factory); and every existing Claude pane loses scrollback until a dual-read backfills — contradicting "unify."

**Revised decision — keep the byte-offset tail / `loadOlder` / compaction / dedupe engine verbatim; inject the per-backend source:**
- **Claude:** `historySource = vendor-file` → `findTranscript` + `normalizeTranscriptLine` become the Claude impl. **Zero migration, byte-for-byte current behavior.**
- **Codex / Cursor:** the runner is already translating the vendor stream into `ChatEvent`s to emit; it **also appends them to a muxpad-owned normalized log** (no extra normalizer — same objects). `historySource = muxpad-log`, normalizer = identity. The runner mints stable, monotonic `ChatEvent.id`s per session; `/clear` rotates the sessionRef → new log file (mirrors Claude's sid-rotation client reset at `ChatPane.tsx:613-620`). Codex's own `~/.codex` rollout files (a *different, messier* schema than the exec stream) are ignored — we never parse them.

Net: the engine is untouched, Claude is untouched, and non-Claude history is a side-effect of the translation we already do. Cursor's cloud-loss risk is *mitigated* here — the muxpad log preserves rendered scrollback even when the cloud session can't rehydrate.

### 3.2 Session persistence & self-heal (corrected — these ARE ws.ts changes)

- `startup_cmd` → `muxpad agent --backend <b> --resume <ref>`. **B1 (blocker):** `ws.ts:431-433` currently rebuilds the self-heal command from scratch, preserving only `--model` — it would **drop `--backend`**, relaunching a Codex pane as Claude on the next ptyd restart, and (via the `isReconnect` mismatch at `:434`) strobe the face every hello. Fix: the rebuild must preserve `--backend` (generalize to "keep all non-`--resume` flags", or carry backend in the hello frame).
- **B2:** populate `AgentSessionStore.assistant` (currently hardcoded `'claude'` at `:147`) — requires the backend in the **hello frame** (`protocol.ts` change) or a `startup_cmd` parse in the hello handler (`ws.ts` change). One of the two is unavoidable.
- **Auth preflight** (new, a net improvement): before a spawn-per-turn backend's first turn, run `codex login status` / `cursor-agent status`; on failure emit a distinct **needs-auth** signal (extend `fatal` with a `reason`, handled in the client) and **suppress the respawn crash-loop** (`ws.ts:239-243`) — today a logged-out backend respawns 3× then dies with a useless "agent exited."
- **M5:** the runner's resume-validity check (`index.ts:68`, `findTranscript(sid) ? resume : fresh`) is Claude-file-specific. For Codex, resumability = a `~/.codex/sessions/<id>` file exists; for Cursor it's a best-effort network call with no reliable local signal. Generalize to `backend.canResume(ref)`.

### 3.3 Capability degradation (needs shared-type + client fixes — NOT free)

**B3 (blocker):** you cannot currently show a model picker while hiding the context meter — `context` is required and gates the whole status frame. Fix: make `AgentSessionStatus.context` **optional** end-to-end (`shared/chat-events.ts` type + `sanitizeAgentStatus`) and gate the meter chip on its presence in `SessionMenu` (`ChatPane.tsx:238-250`, add the gate). Then Codex/Cursor can advertise models with `contextMeter:false`. (Alternatively they fabricate a window from a static per-model map; the optional path is cleaner.)

### 3.4 Safety / approvals

No answerable approval event headlessly → tappable approval chips are Claude-only. Run non-Claude under an explicit, per-pane-visible policy: Codex `-s workspace-write` (or `read-only` default) + `approval_policy=never`; Cursor `--force --sandbox enabled` + workspace allow/deny lists. Denials surface as tool-status, not questions. Phase 3's app-server/acp can restore interactive approvals.

## 4. Phasing (re-sequenced per review — v1's "Phase 0" bundled the two riskiest rewrites)

- **Phase 0a — Extract, Claude-only, behavior byte-for-byte.** Introduce `AgentBackend`; move ALL Claude/SDK machinery (turn loop, interrupt timer, autonomous detection, MCP tools, title-gen) into `backends/claude.ts`. Keep the transcript tail exactly as-is (`historySource: vendor-file`). **Add characterization tests on the Claude turn loop first** (interrupt races, queue kicks, dedupe-by-id, compaction reset) so the extraction can't regress invisibly. Ship — genuinely no user-facing change.
- **Phase 0b — Plumb `--backend` (still Claude at runtime).** `scripts/muxpad` passthrough, `routes/tabs.ts` bootstrap, hello-frame backend field, `ws.ts` self-heal rebuild preserving `--backend` (B1/B2). Prove a flag round-trips through respawn without behavior change. Make `context` optional (B3) + decouple the "Claude" client strings via `SessionMeta.assistant` (M4).
- **Phase 1 — Codex.** `backends/codex.ts`: `codex exec --json [resume]` per turn; events→frames; `historySource: muxpad-log`; context from `usage ÷ static window` (or off); subprocess interrupt; auth preflight; model list from `~/.codex/models_cache.json`. caps: `textDeltas:false, questions:false, subagents:false, autonomous:false`.
- **Phase 2 — Cursor.** `backends/cursor.ts`: `cursor-agent -p --output-format stream-json --stream-partial-output --trust [--resume] --force`; NDJSON→frames (dedupe final assistant repeat; `thinking`→reasoning lane); design for cloud-session loss (best-effort resume; muxpad log keeps scrollback; handle aged-out resume without a crash-loop). caps: `textDeltas:true`, rest false.
- **Phase 3 — Richer modes / parity.** `codex app-server` (token deltas + interactive approvals + possibly autonomous) and `cursor-agent acp`; approval→`question` mapping; per-pane sandbox UX.

## 5. The honest seam — files that CHANGE vs stay

**Change (corrected from v1's false "untouched"):**
- `server/src/agent-runner/index.ts` → harness; **new** `backends/{claude,codex,cursor}.ts` + `backends/index.ts` + interface.
- `server/src/ws.ts` — self-heal rebuild preserves `--backend` (B1); read backend from hello for `assistant` (B2).
- `server/src/agent-runner/protocol.ts` — hello frame gains `backend`; `fatal` gains a `reason` (needs-auth).
- `shared/src/chat-events.ts` — `AgentSessionStatus.context` optional; `sanitizeAgentStatus` accepts its absence (B3).
- `web/src/components/ChatPane.tsx` — gate the meter chip on `context` presence (B3); replace hardcoded "Claude" copy with `SessionMeta.assistant` (M4); **new** backend picker in the "+ new pane" chooser.
- `server/src/store/AgentSessionStore.ts` — populate `assistant` from the backend.
- `server/src/chat/TranscriptReader.ts` — parameterize with a per-backend locator+normalizer (engine unchanged).
- `scripts/muxpad`, `server/src/routes/tabs.ts` — `--backend` plumbing.

**Genuinely untouched:** `ptyd-cache.ts`, `PaneStore.ts`, `routes/panes.ts`, and the *engine* internals of `TranscriptReader` (byte tail, `loadOlder`, compaction, dedupe).

## 6. Risks / open questions

1. **Turn-loop extraction regressing the Claude path** — mitigated by Phase 0a characterization tests before any refactor.
2. **Dead-runner sweep misfire (M3, must verify, not assume):** during a mid-turn ws blip the sweep's foreground probe (`ws.ts:231-235`, `fg.includes('agent-runner')`) could run while a `codex exec` child executes. Since the runner pipes the child's stdout (child not tty-attached), node *should* stay foreground — **verify empirically** that spawning a CLI child doesn't change the pty foreground command and trigger a respawn that kills a live turn.
3. **Cursor cloud sessions:** self-heal respawn tries to resume a possibly aged-out/offline cloud session → design the aged-out path to surface "session ended" instead of crash-looping (`ws.ts:239-243`). The muxpad log keeps rendered history but not continuation.
4. **Attachments/images per backend:** the composer appends absolute image paths to message text (`ChatPane.tsx:993,1013`) assuming the agent reads the path — unverified for `codex exec` / `cursor-agent -p`. May be a no-op there; decide per backend.
5. **Title generation** currently uses a Claude `query({model:'haiku'})` for *all* panes — a hidden Claude-auth dependency for naming Codex/Cursor chats. Either accept (Claude usually present) or title per-backend / from first message.
6. **Schema churn:** both CLIs move fast; add a per-backend stream sanitizer (like `sanitizeAgentStatus`), detect version, fail soft.
7. **Lost capabilities** (autonomous, approvals, show_files, Codex deltas) — accepted + documented for Phase 1–2; Phase 3 evaluates long-lived modes to claw back deltas/approvals/autonomous where it matters.
