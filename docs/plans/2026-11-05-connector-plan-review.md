# Adversarial review: one mediator for every connector

Reviewed 2026-11-05 against main @ 1524070, the installed broker under
`/Library/muxpad-broker`, and msgvault 0.22.0. Nothing is implemented yet. I ran nothing
that mutates state, started no daemon and printed no secret values.

**CHECKED** means I verified it in code, configuration, the CLI or the filesystem.
**REASONED** means I inferred it and did not exercise it.

## Bottom line

The plan's trust anchor is not the system that is deployed. Section A says approval
happens in the broker's protected shell, outside the iframe. The live broker runs in
`passkey-inline` mode. In that mode the approval dialog is drawn by muxpad's own,
agent-editable web code, and the passkey's relying party is muxpad's origin. So the
human approves whatever muxpad's UI shows them, and that UI can bind the signature to a
different request or duration.

That leaves the plan with two threat models. D and E spend real operational effort
(three new principals, a root-owned install, a release ceremony per upgrade) to stop a
*malicious* mini agent. A, as deployed, concedes to that same agent. Pick one model.

Two further problems hold whichever model is picked:

1. The broker would send msgvault's owner `api_key` over plain HTTP to a TCP port that
   any agent can occupy while the daemon is down. This is the squatting attack that
   `broker/README.md` already rejects for the broker itself.
2. F's pass-through is a three-item denylist in an agent-editable layer. Review 2
   finding #3 required the opposite: an allowlist, enforced by something agents cannot
   edit.

**Verdict: do not implement as written. Implement with the named changes at the end.**
Most of the architecture is right: the token stays in the broker, nothing secret lives
on the VM, a separate daemon user, root-owned code, and a separate exec user. The
defects are in the joints between those pieces, not in their placement.

## Does it answer the two prior reviews?

**2026-11-04 review (killed: secrets on the VM)**

- #1 and #4, the token on the VM: **answered.** Nothing secret goes to the VM.
- #2, timed grants spendable via the VM: **partly answered.** Grants keyed by origin
  and narrowed verbs are adopted. But the review's own fix item 4 (refuse local→remote
  `agent send` and `agent new`) was dropped. The accident path it described is
  untouched; see finding 6.
- #3, host identity asserted by the distrusted party: **conceded, not answered.** C
  still stamps origin in muxpad. That is fine only if the plan says the stamp is an
  accident guard. Finding 8 covers what it buys.

**2026-11-05 review (killed: daemon-as-user, grants in muxpad)**

- #0, send capability today: **H answers send only.** Reads stay open; see finding 10.
- #1, agent-writable code: **answered by D**, at an operational price (finding 9).
- #2, the owner key inside muxpad: **answered in placement, re-introduced in
  transport** (finding 2).
- #3, pass-through redirect: **re-introduced** (finding 4).
- #4, pane scoping and transcript spread: **E answers token handling.** Timed grants
  are still all-agents, and the plan does not say so. Transcript spread is acceptable
  under the owner's stated requirements (finding 13).
- #5, taint: dropped. That is the right call.
- #6, calendar sends: **not answered** (finding 5). No Beeper source is configured
  today (CHECKED: no `BeeperTexts` directory and no beeper section in `config.toml`).
- #11, operations: **mostly unanswered** (finding 9).
- One correction to review 2: it suggested `add-account --headless` as a device-code
  flow. msgvault's help says "Google does not support Gmail in device flow" (CHECKED).

## Findings, most severe first

### 1. CRITICAL: A's premise is false; approval is drawn by agent-editable code

CHECKED:
- `/Library/muxpad-broker/config.json` (0644, read for non-secret fields only) has
  `approvalMode: "passkey-inline"`, `authMode: "paired"` and `transport: "tsnet"`.
- `broker/http.mjs` serves `shell.html` only when `approvalMode === 'session'`.
  `PASSKEY-INLINE.md` says: "No external approval HTML, iframe, popup … is used". It
  also says the design "trusts the mutable muxpad UI to display the exact scope
  honestly … does not prove the visible transaction text".
- The WebAuthn call is in `web/src/lib/slack-passkey.ts:180`, in the Dropbox checkout,
  which every agent can edit. `userVerification` is `discouraged`, so a single
  presence tap suffices.
- The installed `core.mjs` and `http.mjs` differ from the repo's. The files the brief
  asked me to review are not what runs.

Sequence (REASONED, on the checked premises): a mini agent patches the approval
component. The patched component renders "Once: `msgvault search invoice`", but it
fetches options for an agent-queued request with duration `1d` and wide permissions.
The authenticator shows only the RP (muxpad's hostname), never the intent. The human
taps, the broker verifies a valid assertion over the hash it issued, and a day-long
grant activates.

**Why this sinks D/E as justified.** The root-owned daemon, the root-owned helper and
the separate exec user are all there to stop an agent willing to edit code. That agent
does not need to beat them. It edits the dialog. For the plan to be coherent, choose
one of:

- **(a)** Approvals for msgvault, at least, go back to the protected shell
  (`approvalMode: "session"`, a separate origin). This reopens the popup and geometry
  UX problems that presumably drove the inline migration.
- **(b)** Declare the threat model accident-grade: honest agents, eager debugging,
  prompt injection, an agent reading a token off disk. Then D and E are still needed,
  because an eager agent does find `~/.msgvault/tokens/`. But stop presenting approval
  as a boundary against a code-editing agent, and drop the parts of E that only matter
  against one.

### 2. CRITICAL: the owner `api_key` crosses a squattable plaintext TCP hop

CHECKED:
- `msgvault serve` takes only `--bind` and `--port`. The binary has `api_port`,
  `bind_addr` and `allow_insecure`, but no `tls_cert` or `tls_key` setting. There is no
  server-side TLS and no Unix-socket listener.
- Agent-delegated clients therefore need `--agent-allow-insecure` to reach it.
- `README.md` step 3 already rejects this pattern for the broker: "an agent could
  occupy the unprivileged loopback port while the broker is down and steal cookies".

REASONED sequence: the daemon is down because of a restart, a crash, a reboot or a
schema migration. That happens, because grants dying on restart is a stated fact. A
mini agent binds the daemon's fixed port, on loopback or on the mini's tailnet IP, and
answers `/api/ping`. The broker's next grant mint sends `X-Api-Key`.

With the owner key the agent can:
- mint any grant;
- call `/api/v1/cli/run`, whose body takes `args`, `cwd` and `env` (CHECKED in the
  OpenAPI `CLIRunRequest`);
- rewrite `/api/v1/settings` and the people-inference provider endpoints, which send
  archive excerpts to a configurable HTTPS URL;
- go no further than this toward sending mail. I found no route containing `send` in
  the OpenAPI (CHECKED). But if any setting points at an executable, the agent gets
  code as `_msgvault`, and with it the refresh token (REASONED).

The helper's per-exec grant tokens leak the same way. They are lower value: scoped and
expiring.

D makes this worse by binding the tailnet interface. Nothing needs that: the broker
runs on the same Mac (CHECKED: `_muxbroker` and `org.muxpad.broker.plist` are on the
mini). The tailnet binding adds every west-hydra device as a client and an attack
surface.

Fix options:
- Bind loopback only.
- Immediately before every secret-bearing request, have a root-run component confirm
  that the listener on that port belongs to the `_msgvault` UID. A small race remains.
- Or accept the squat risk explicitly, in writing.

There is no clean answer while msgvault lacks TLS or socket support. The cleanest
complete fix is upstream: a Unix-socket listener in a directory only the broker group
can traverse.

### 3. CRITICAL acceptance gate: does `api_key` actually close anonymous loopback?

CHECKED: the binary has auth modes `loopback` and `anonymous loopback`. Today's daemon
reports `auth_fingerprint: none` (review 2). The whole design assumes that once
`api_key` is set, a keyless loopback request from `ohadpr` is refused.

I could not verify that without starting a daemon. If any route stays open to
anonymous loopback, every agent reads the archive and nothing else in the plan matters.
Test this before any other work. Test it on read routes and on `/api/v1/cli/run`.

### 4. HIGH: F is a denylist, enforced in the wrong place, for an unnamed user

CHECKED: the global flags are `--agent-url`, `--agent-token-file`,
`--agent-allow-insecure`, `--config`, `--home`, `--local`, `--log-file`, `--log-level`,
`--log-sql`, `--no-log-file` and `-v`. Review 2 showed that a later `--agent-url` wins
even after the subcommand.

F refuses three flags plus `query`. Problems:

- **Where.** "`muxpad msgvault` … refuses" is a muxpad check. muxpad is agent-editable,
  and the broker's `POST /requests` is unauthenticated by design (README). Validation
  must live in the broker, which decides, and be repeated in the helper, which
  executes.
- **Form.** pflag accepts `--flag=value`, and it accepts flags interspersed after
  positional arguments. A denylist has to track every spelling, and it misses
  `--agent-token-file` (exfiltrates any file the exec user can read, to an
  agent-chosen URL), `--agent-allow-insecure`, `--log-file` (a write as the exec user)
  and `-o` on the export verbs.
- **Which user.** E says "a non-agent user". If that is `_msgvault`, the daemon's user:
  - `export-token` reads the OAuth token and ships it to `MSGVAULT_REMOTE_URL`;
  - `logs` reads daemon logs;
  - `daemon stop` uses the shutdown token in its home;
  - `--log-file` can clobber the database or the token files.

  The exec user must be a third UID, with no readable home and no `config.toml`.
- **Server-side execution** (REASONED from `daemonclient.(*Client).runCLIStream` and
  the `/api/v1/cli/run` schema). The delegated CLI may forward some verbs to the daemon
  for execution with caller-supplied `args`, `cwd` and `env`. If a grant can reach
  that path, argument injection lands in the daemon's UID, not the exec user's.
  Acceptance test: which verbs, if any, reach `cli/run` under an agent grant.
- **Surface beyond the approved intent.** Every one of these needs an explicit
  decision:
  - `tui` and `mcp`: interactive or long-running. They hang the helper.
  - `export-*`: `-o` writes to world-readable `/tmp`.
  - `create-subset`.
  - `docbank`, `documents`, `embeddings`, `multimodal`, `media`, `meetings`, `person`,
    `organization`, `identity`, `collection`, `carddav`: these read beyond mail, and
    `carddav publications approve` writes to a provider.
  - `build-cache` and `cache-stats`.
  - The `*-attachments` pack verbs.
  - `skills`, `setup` and `update`: they write the exec user's home.
  - `credentials`.
  - Every `add-*`, `sync*`, `import-*`, `*delete*` and `backup`.

  Which permission gates `person` or `meetings` under a grant is unverified.

The required shape is an allowlist table: verb → msgvault permissions → permitted flags.
It lives in the broker. It is a policy table, not an invented API, and the owner's "use
msgvault's own CLI" rule survives it. Also mint grants with `--source-ids` (Gmail only)
and `--sender` pinned.

### 5. HIGH: G is false for calendar; "no send endpoint" does not cover invites

CHECKED: `msgvault calendar --help` has `--send-updates none|all|externalOnly`, with a
default of `none`, and "Guest changes also require invite_calendars". The token file
carries `calendar.events` (review 2).

With `all`, Google emails an agent-written title and description to agent-chosen
guests, from the owner's identity. With `none`, guests still get calendar entries.

The plan never mentions calendar, so a pass-through plus a `calendar.write` or
`calendar.invite` grant violates "never sends". The broker must never mint
`calendar.write` or `calendar.invite`. Alternatively, it must force
`--send-updates none`, refuse guest changes, and show the guest list in the dialog.

### 6. HIGH: personal chats still reach Slack, and mail still reaches work chats, via `agent send`

CHECKED:
- `POST /api/agent-sessions/:paneId/send` (`routes/agent-sessions.ts:84`) has no node
  check, so a mini chat can message any VM chat.
- In the reverse direction, `host-api.ts` scopes it with `paneIsOn`. A VM chat cannot
  message a mini chat. Good.
- `POST /api/panes` and `POST /api/tabs` accept `node_id` (review 1, rechecked at
  `routes/panes.ts:233`).

This is not even an accident in muxpad. muxpad's own Chat-mode contract tells a chat
to route work "to whoever owns it". Sequence:

1. A personal chat is asked to "post this to #eng".
2. Its `slack post` is refused because its origin is local.
3. It runs `muxpad agent send <trayo chat> "post X to #eng"`.
4. Under a live trayo grant, the post auto-dispatches.

The same route carries mail content: a personal chat that read mail forwards it to a
work chat, and the mail lands in a transcript on a VM that other people administer.

Both stated requirements fail by the documented happy path. Add review 1's item 4:
refuse local→remote `agent send`, and refuse `agent new` / `node_id` aimed at a
remote node from a local caller. A human-initiated UI action can stay allowed.

### 7. HIGH: what a timed msgvault grant covers is unspecified, and it is wide

CHECKED: grants are permission sets (`search.read`, `message.read`, …) with
`--expires`, not per-query. The broker's `DURATIONS` are `once/10m/1h/1d`, in both
the repo and the installed code. The owner asked for `once/1m/5m/1d`.

REASONED:
- "Approve `search invoice` for 1 day" can only mean `search.read` plus
  `message.read` over the whole archive, auto-dispatched for every mini process,
  with no requester recorded. The Slack grant has the same property today (CHECKED:
  `grantScope` is `{teamID, 'slack-team-all-v2'}`).
- The plan must:
  - state this in the dialog: "every chat on this Mac can read all mail for 1 day";
  - key msgvault grants to `origin=local`;
  - change the durations, which is a broker release;
  - define the permission set a duration grants from the verb, through the finding 4
    table.
- Today the broker refuses anything outside `TEAM_ACTIONS`, requires `teamID` and an
  `xoxp-` token, and names everything Slack. Adding msgvault is a broker rewrite,
  not a plug-in.

### 8. MEDIUM: what C's origin stamp actually buys

CHECKED: today `routes/slack.ts` has no node check, and `host-api.ts` has no Slack
shape. So right now VM chats cannot use Slack at all, and mini chats can: the inverse
of the requirement. C has to add both pieces.

What C does:
- Stops honest and prompt-injected mini chats from calling Slack directly.
- Gives grants a label.
- For **mail**, the real control is structural and good. There is no msgvault shape in
  `host-api.ts`, and the VM cannot reach the broker. A compromised VM cannot even ask.
  Keep it that way: never add a msgvault host-api shape.

What C does not do: stop a mini agent.
- It can POST to the broker directly with `origin: trayo`, since enqueue is
  unauthenticated by README decision.
- It can edit the server.
- It can spawn a VM pane.
- Any "from Trayo" label in the dialog is chosen by whoever enqueued.

Say "accident guard" in the plan, not "scoping".

### 9. MEDIUM: D's durability and running cost

CHECKED:
- `ohadpr` is in `admin`; `sudo` needs a password.
- `/usr/local/bin` and `/Library/muxpad-broker` are `root:wheel` 0755.
- msgvault links `/opt/homebrew/opt/duckdb/lib/libduckdb.dylib` (agent-writable) and
  is ad-hoc signed (review 2).
- The archive is a 27.8 GB `msgvault.db`, owned by `ohadpr`, mode 0644.

REASONED consequences:
- **Relocation.** Copy the binary and libduckdb, rewrite the load path, re-sign ad
  hoc. Ad hoc means `DYLD_*` is honoured, so the helper must exec under `env -i`
  with an absolute path.
- **Every upgrade** (msgvault moves fast and has offline `migrate`) becomes a
  trusted-admin ceremony. That means the separate admin account README step 1
  demands. `ohadpr`'s shell rc files are agent-writable, so a `sudo` typed in an
  `ohadpr` terminal can be wrapped to capture the password. A `sudo` typed in a
  muxpad terminal pane leaves a ticket that any agent can ride by
  `muxpad pane send`-ing into that tty within the timeout.
- **`msgvault update` and `brew upgrade`** stop affecting the real install. That is
  correct, but the owner now upgrades by hand, forever.
- **OAuth re-auth.** It needs a browser for a callback listener running as
  `_msgvault`; there is no device flow for Gmail (CHECKED). It is another
  admin-session ritual. If msgvault's OAuth client is in Google "Testing" status,
  refresh tokens expire every 7 days. Unknown; check.
- **The owner's own CLI and TUI** go through approval or `sudo -u`. `card.sh`,
  `serve.log` and `sync-full.log` paths break.
- **Restart semantics.** A daemon restart kills grants, so the broker must re-prompt
  on 401 and never re-mint silently. A broker restart forgets grants it minted, which
  stay live at the daemon until expiry. Mint with a fixed label prefix and revoke all
  of them at broker boot.
- **Spotlight, Time Machine, Dropbox.** Nothing new: `/Library` is not synced, and
  Spotlight filters results by permission. Mark the tree `.metadata_never_index`
  anyway.
- **What is already lost.** The archive has been readable by every agent for months.
  D protects future mail and removes send. It does not un-read anything.

### 10. MEDIUM: H removes send and nothing else, and costs drafts and calendar

CHECKED from `add-account --help`: `--readonly` requests Gmail read-only, refuses an
account that holds write access, and "revoking applies to the whole grant".

So the interim state:
- keeps the 27.8 GB db and a read-capable refresh token readable by every agent;
- loses draft creation, which `gmail.readonly` cannot do;
- loses the `calendar.events` grant if it shares the Google grant (it does in
  today's token file), and re-adding calendar write brings invite email back.

`tokens/carddav.json` is a second OAuth token that H does not mention.

H is still worth doing, because it closes the worst current exposure. Label it
"removes send; reads remain open".

### 11. MEDIUM: E need not be root, and "clean and simple" is strained

The plan adds `_msgvault`, an exec user, a root-owned helper, a broker rewrite with a
new release and review, and a policy table. That is the heaviest of the three designs.

One simplification costs nothing. The helper does not need to *run* as root. A
LaunchDaemon with `UserName=_mvexec` and socket activation (`Sockets`,
`SockPathMode`, in a directory traversable only by `_muxbroker`'s group) gives:
- root-owned code;
- no root process parsing requests;
- kernel-checked access to the socket;
- a per-connection process.

The helper then checks the peer UID (`LOCAL_PEERCRED`) as defence in depth.

### 12. LOW: E's mechanics, once 4 and 11 are fixed

REASONED:
- **Authentication.** Broker → helper over a root-created socket in a root-owned
  directory, with a peer-UID check. Helper → broker needs nothing more, because the
  path cannot be squatted.
- **Replay.** Moot on that channel. Still include the request ID and argv hash so the
  audit can join.
- **TOCTOU.** Small. `draft-compose` takes `--body` inline and has no body-file flag
  (CHECKED), and argv is held by the broker from approval to exec.
- **Racing panes.** By design, any mini process spends a live timed grant (finding 7).
- **Output.** Cap the size, kill the process on a timeout, and refuse `-o`.

### 13. LOW: approved output spreads across mini transcripts

Review 2 #4 still holds: results land in `agent-transcripts`, `archive.sqlite` and the
harness JSONL. Under the owner's requirement (no personal mail in work chats) that is
acceptable on the mini. It becomes a breach only through finding 6 and `publish`.

## Named changes required before implementing

1. **Settle the approval surface (finding 1).** Either session-mode shell approvals
   for msgvault, or write down "accident-grade" and scale E down to match.
2. **Daemon transport (finding 2).** Bind loopback only and drop the tailnet binding.
   Add a listener-UID check before every secret-bearing call, or put the squat risk
   in writing. Run the finding 3 test first.
3. **Policy table in the broker, mirrored in the helper (finding 4).** An allowlist of
   verbs and flags. A distinct exec UID with no home. `env -i` and an absolute binary
   path. Gmail-only `--source-ids` and a pinned `--sender`.
4. **Calendar (finding 5).** No `calendar.write` or `calendar.invite` grants, or
   forced `--send-updates none` with no guest changes.
5. **Origin rules (findings 6 and 7).** Refuse local→remote `agent send` and
   `agent new` from agents. Key msgvault grants to `origin=local`. Add no msgvault
   shape to `host-api.ts`. The dialog must say "all chats on this Mac".
6. **Durations (finding 7).** Change them to `once/1m/5m/1d` and get the broker
   release re-reviewed.
7. **Grant lifecycle (finding 9).** Labelled grants, revoke-all at broker boot,
   re-prompt on 401.
8. **Helper as a socket-activated `_mvexec` LaunchDaemon (finding 11),** not a root
   process.
9. **H, relabelled (finding 10).** Also decide on `carddav.json`.
