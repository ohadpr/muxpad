# Adversarial review: msgvault behind human approval

Reviewed 2026-11-05 against main @ 1524070 and msgvault 0.22.0 (Homebrew, darwin/arm64).
The design is not implemented. **VERIFIED** means I read it in the CLI, the OpenAPI
schema, the binary's strings, the filesystem or muxpad's code. **REASONED** means I
inferred it and did not exercise it. I ran nothing that mutates msgvault or touches
Google. One flag test sent a dummy token to closed loopback ports.

## Bottom line

The design does not deliver "agents reach the mail only through an approval". Three
separate problems each defeat it:

1. Step 1 moves the data to `_msgvault` but leaves the code that `_msgvault` runs
   writable by every agent.
2. Step 3 puts the authority to mint grants inside muxpad, which runs as the same UID
   as the agents.
3. Even an honest grant leaks to every chat, because whatever a chat reads lands in
   muxpad's shared transcript archive.

The taint rule (step 5) covers two of the many ways data can leave the machine, and it
keys on a pane identity that muxpad's own code says is forgeable.

Separately, and more urgent than any of the design: **today** any agent can send email
as the owner. The Google refresh token readable at `~/.msgvault/tokens/` carries
`gmail.modify`.

## Findings, most severe first

### 0. CRITICAL, current state: every agent can send mail as the owner today
VERIFIED: `~/.msgvault/tokens/me@ohad.com.json` is owned by `ohadpr`, mode 0600. It
holds a `refresh_token`, and its `scopes` include `gmail.modify` and
`calendar.events`. I read only the key names and the scope list. The brief names
`client_secret.json` as the credential at risk. That file is the less important one.
The refresh token is the real credential.

VERIFIED: the running daemon (`daemon.68781.json`) reports `auth_fingerprint: none`
on `127.0.0.1:57206`. The binary's strings include auth modes `loopback` and
`anonymous loopback`. So any local process can call the API with no key today.

REASONED (Google's documented scope semantics; not exercised): `gmail.modify` permits
`users.messages.send` and `users.drafts.send`.

Sequence: `cat` the token file, refresh it against Google's token endpoint with the
client ID from the same file, then call `messages.send`. Cost: about three HTTP
calls.

The design-level consequence matters more. **"msgvault never sends" is a property
of msgvault's code, not of the credential.** No Google scope allows drafts without
also allowing send: `gmail.compose` sends too. So anything that executes as the
daemon's user, or reads its token, can send. That is what makes #1 critical.

### 1. CRITICAL: `_msgvault` would run agent-writable code
VERIFIED:
- `/opt/homebrew/Cellar/msgvault/0.22.0/bin/msgvault` is owned by `ohadpr`, and so
  are its parent directories. `/opt/homebrew` and `Cellar` are `ohadpr:admin`, and
  `Cellar` is group-writable.
- The binary is ad-hoc signed (`flags=0x2(adhoc)`, no team ID), so there is no
  hardened runtime and no library validation.
- `otool -L` shows it loads `/opt/homebrew/opt/duckdb/lib/libduckdb.dylib`. That is a
  symlink owned by `ohadpr` into an `ohadpr`-owned Cellar directory.

Sequence: an agent repoints `/opt/homebrew/opt/duckdb` at a directory holding a
patched `libduckdb.dylib`, or `chmod u+w`s and replaces the msgvault binary. Then it
waits for the next daemon start: `brew upgrade`, `msgvault update`, a reboot or a
crash. The patched code runs as `_msgvault`. It can read the 20 GB db and the
refresh token, and it can send mail (#0). Cost: two commands and patience. The
owner's next routine `brew upgrade` closes the loop for the attacker.

REASONED: the same applies to any helper the daemon runs through `PATH`. The binary
contains `executable file not found in $PATH` and has Codex-login and
embedding-provider integrations. If `/opt/homebrew/bin` is on `_msgvault`'s `PATH`,
every one of those helpers is agent-replaceable.

The Slack broker solved exactly this. Its installer refuses user-owned Homebrew
runtimes and requires root-owned code (`broker/README.md`, step 2: "Do not weaken
that check"). The msgvault plan copies the separate user but not the root-owned
code. Without that, step 1 changes who owns the files and nothing else.

### 2. CRITICAL: muxpad holding the grants means agents hold the owner key
VERIFIED: the binary says "Agent token management requires the owner API key" and
"server agent_access requires an effective API key". So to mint per-approval grants,
muxpad's server must hold msgvault's owner `api_key`.

VERIFIED: muxpad's server runs as `ohadpr`. Same-UID environments are readable:
`ps -E -p 68781` returned 2,214 characters against 33 without `-E`. muxpad's data
dir holds `api-secret` and `pane-key-secret` as plain `ohadpr` files. muxpad's
source sits in an agent-editable Dropbox checkout.

The owner key is not "a grant". It reaches every route in the OpenAPI schema,
including:
- `POST /api/v1/cli/run`: "Run an allowlisted CLI command". The body carries `args`,
  `cwd` and `env`.
- `POST /api/v1/query/archive`: SQL.
- `POST /api/v1/auth/token/{email}`: upload an OAuth token.
- `PATCH /api/v1/settings`.
- The `people-inference` and provider-credential routes. These send archive
  excerpts to a configurable HTTPS endpoint.
- The Kata issue routes: an outbound write.

Sequence: read the key from the server's environment or config, then
`curl -H 'X-Api-Key: …' 127.0.0.1:<port>/api/v1/agent-tokens` to mint any grant, or
skip grants entirely. Cost: one `ps -E` plus one `curl`.

Grant secrets cached in muxpad for "this pane" leak the same way. This is the
mistake that #1 of the 2026-11-04 Slack review caught. The secret moved to a place
the distrusted party controls. `server/src/slack-broker.ts` states the rule this
breaks: "The muxpad process holds no broker credential or approval key."

### 3. HIGH: the pass-through can be told to send the token elsewhere
VERIFIED with a dummy token and closed ports:
```
msgvault --agent-url http://127.0.0.1:1 --agent-token-file … --agent-allow-insecure stats --agent-url http://127.0.0.1:2
→ dial tcp 127.0.0.1:2
```
A later `--agent-url` wins, even when it comes after the subcommand.

Sequence: `muxpad mail stats --agent-url http://127.0.0.1:4444`, plus a 20-line
listener that answers `/api/v1/health` and records the next request's headers. That
captures the grant secret. If the grant is a 5-minute or 1-day grant, it now works
from anywhere.

REASONED variant: `--agent-token-file /path/to/the-runner's-private-file` with the
same URL. The CLI reads that file as a "token" and puts its contents in a request
header to the agent's listener. If the pass-through runs the CLI as a privileged
user, such as a broker UID, it exfiltrates that user's private files.

Other flags that write as the runner's UID: `-o` on `export-eml`, the
export-attachments output paths, and `--log-file`. My `--log-file` test failed
before it logged anything, so it is inconclusive.

VERIFIED as holding: agent mode rejects `--local`. The strings say it also rejects
`--home` and `--config`. Any pass-through has to parse argv against an allowlist per
verb and refuse every global flag. "Inject our flags and append theirs" is
exploitable as written.

### 4. HIGH: "approved for this pane" cannot be enforced, and reads spread to every chat
VERIFIED, from `server/src/pane-key.ts` and `routes/slack.ts`:
- A pane key is `HMAC(install secret, pane id)`.
- The install secret is `~/.muxpad/pane-key-secret`, readable by every agent.
- The code says outright: "not a security boundary against agents sharing the server
  OS account".
- The Slack README draws the conclusion the msgvault plan skips: timed permissions
  are presented as usable by **all agents**, because "a forgeable pane ID cannot
  safely restrict it to one agent".

So a 1-day grant "for this chat" is a 1-day grant for every chat. Approving it
creates exactly what the owner fears: chats with access nobody granted.

Even a perfectly scoped "once" read spreads.
- VERIFIED that these exist: `~/.muxpad/agent-transcripts`, `archive.sqlite`, and
  muxpad's `search` across every session.
- REASONED: tool output is what those stores hold. Whatever `muxpad mail
  show-message` printed into chat A is readable from chat B through
  `muxpad search "invoice"` or `muxpad agent transcript <A>`. That needs no grant and
  never expires.
- The harness's own JSONL under `~/.claude/projects` is a second copy.

The design never says where approved results go after they are printed.

### 5. HIGH: the taint rule is neither enforceable nor wide enough
REASONED, on verified premises:
- **Identity.** Taint has to key on the calling pane. That identity is forgeable (#4),
  and the taint record lives in muxpad's SQLite, which agents can write.
- **Where it can be checked.** The broker only ever learns what muxpad tells it. This
  is the 2026-11-04 review's finding #3 again.
- **Channels.** Slack and publish are two egress channels out of many. Agents also
  have `curl`, WebFetch, `gh` and `git push`, the Playwright browser navigating to
  `https://evil/?d=…`, and `muxpad agent send <untainted chat>`. A tainted chat can
  also spawn a fresh sub-agent with no taint, or write to `/tmp` for another chat to
  read.
- **Prompt injection.** The motivating case is mail-borne injection. Injected
  instructions do not need Slack, so a rule that guards only Slack does not address
  it.
- **Publish.** Publish is not brokered at all. A "per-payload approval" for publish
  would render in muxpad's own UI, which is forgeable. The brief concedes this in
  step 4.

The rule would stop an honest chat from absent-mindedly pasting mail into Slack. It
promises more than that and cannot deliver it.

### 6. HIGH: calendar writes are email sends, and Beeper drafts are one keypress from one
VERIFIED, from `msgvault calendar --help`:
- `--send-updates none|all|externalOnly`.
- "Guest changes also require invite_calendars".

With `all`, Google emails an agent-chosen title, description and location from the
owner's calendar identity to any address the agent picks. That is outbound mail under
the owner's name.

REASONED:
- Even with `none`, Google usually adds the event straight to guests' calendars.
- `calendar respond` notifies the organizer.

`calendar.invite` and `calendar.write` with guests belong in the "send" class, not
"calendar". The brief already prompts on them with the payload shown. The
requirement "never send" is still false for them as stated.

VERIFIED: `draft-compose` makes "native Beeper" drafts. Those land in a live chat
composer (WhatsApp, Signal and so on), where one Enter from the owner sends them.

REASONED: Gmail drafts sync to the phone, and a `draft-reply` sits inside a real
thread looking self-authored. "Draft, not send" leaves the send decision to a
distracted human on a phone. That is an accepted cost only if it is stated.

VERIFIED: Gmail tag edits are limited to user label IDs, so no `SENT` or `DRAFT`
trick works. The binary contains no `drafts/send` or `messages/send` path string. That
is weak evidence, but it agrees with "Msgvault never sends" in `mcp --help`.

### 7. MEDIUM: "once" does not exist in msgvault, and the prompt shows less than the grant allows
VERIFIED: a grant is permissions × source IDs × optional expiry. It is not tied to a
single call.

So `search from:x` shown in the dialog actually authorizes:
- any search over the whole source, across every year, and
- with `message.read`, any message in it.

For 1-minute, 5-minute and 1-day grants, the dialog must say "all mail in source N",
not the query. "Once" only exists if the token never leaves the process that makes
the call and revokes the grant afterwards.

REASONED: if the CLI runs as `ohadpr` with a token file or an environment variable,
then for that interval the token is readable by any agent (`ps -E` is verified
above), so "once" really means "until revoke".

### 8. MEDIUM: plain-HTTP loopback has no daemon identity, so restarts are a squatting window
REASONED:
- `daemon.<pid>.json`, which holds the port and the identity proof, lives in the
  daemon's private home. muxpad, or a broker, would therefore need a fixed
  `api_port`.
- When the daemon is down (upgrade, crash or reboot), any agent can bind that port.
  Grants die on restart, so this is exactly when the issuer re-sends the owner key to
  re-mint them.
- Agent mode needs `--agent-allow-insecure` for plain `http://`. VERIFIED: "HTTPS
  required for agent token connections".
- That leaves nothing to tell a squatter from the daemon.

The Slack README names the same attack ("an agent could occupy the unprivileged
loopback port while the broker is down").

VERIFIED that passive sniffing is out: `/dev/bpf*` is `root:wheel 0600`, and no
`access_bpf` group exists.

### 9. MEDIUM: the approval surface it depends on is not installed
VERIFIED, from `broker/README.md`: "Prepared and tested code; not installed or
activated."

Until it is installed, every approval dialog renders in muxpad's own UI, which is
agent-mutable and forgeable. Adding msgvault to the broker also changes the broker's
code. The README requires a fresh exact-archive review and a reinstall for that.

### 10. MEDIUM: copies and side doors the move leaves behind
VERIFIED:
- **Old data dir.** `msgvault.db` (20 GB), its `-wal` and `-shm` files, and
  `sync-full.log` are mode 0644 today. `analytics/` and its subdirectories are 0755.
  Only the 0700 parent directory protects them. A migration that copies instead of
  moving leaves a fully readable 20 GB copy behind. Analytics written under a new
  home whose parent is not 0700 are world-readable.
- **Live sync.** `msgvault sync-full me@ohad.com` is running now as `ohadpr` (pid
  97945) and writing into the old home.
- **Time Machine.** No destinations are configured, so no backup copy exists.
- **Muxpad browser profiles.** None of the 23 holds a Google session cookie. I found
  only `NID`, `AEC`, `__Secure-STRP` and `_GRECAPTCHA`, so no profile is logged in
  to Gmail.
- **Claude connectors.** This session lists claude.ai **Gmail, Google Calendar and
  Google Drive** connectors, waiting for the owner to authorize them. Authorizing
  them gives every Claude agent direct Gmail access with no muxpad gate. That bypass
  sits entirely outside this design.
- **Skills.** msgvault skills are not installed under `~/.claude/skills`. `msgvault
  skills install` would teach agents to call the CLI directly.

NOT CHECKED, deliberately, because each would raise a TCC prompt or touch another
app's data:
- the macOS Keychain (where `msgvault credentials set` stores provider keys);
- Beeper's and Muesli's own local databases, which hold the chat and meeting originals
  in `ohadpr` space regardless of msgvault;
- Apple Mail, if this terminal has Full Disk Access;
- Docbank's mirror target and any `backup` repository (both live in the unreadable
  `config.toml`).

Spotlight indexing is on, but `~/.msgvault` is a hidden directory (low risk; reasoned).

### 11. LOW–MEDIUM: what the owner loses
Mostly REASONED.
- **The owner's own CLI and TUI.** As `ohadpr`, `msgvault tui` and `search` now need
  the owner key in `ohadpr` space, which reopens #2. Interactive use becomes
  `sudo -u _msgvault msgvault …`.
- **Silent wrong answers.** VERIFIED string: "Allow local commands to start or replace
  the daemon". An agent running plain `msgvault search` silently starts a fresh empty
  daemon under `~/.msgvault` and gets zero results instead of an error. If the old
  data dir was left behind, it gets the old full archive.
- **OAuth re-auth.** It needs a browser as `_msgvault`. Use `add-account --headless`,
  the device-code flow.
- **Grants die on every daemon restart.** Expect re-prompts after each `brew upgrade`
  or reboot. Re-issuing them automatically would be a standing grant in disguise.
- **MCP.** Its tools work only in delegated mode against the daemon, so they need
  the same token handling as the CLI.
- **Status card.** `~/.msgvault/card.sh` greps the old `sync-full.log` and runs `du`
  on the old home.
- **Latency.** Each approved call costs an issue, the call, and a revoke, plus the
  human approval.

### 12. LOW: mixing personal and work content
VERIFIED: one Gmail token exists (`me@ohad.com`), plus CardDAV. Source-ID scoping
cannot separate personal from work mail that shares a source.

`draft-forward --account` and `--from` can draft one identity's mail into another
account. VERIFIED that `--sender SOURCE_ID=ADDRESS` exists on `issue` to pin that,
but only if the issuer uses it.

## What holds up

- Read grants exclude SQL, export, sync, deletion and administration. VERIFIED in
  the documentation text ("Read grants do not authorize sync, deletion, SQL, export,
  or administration"). Not exercised against a daemon. So `query` under
  `search.read` should fail.
- Agent mode refuses `--local` (VERIFIED by running it), and the strings say it
  refuses `--home` and `--config`.
- Agent connections need HTTPS unless you opt out. Keyless loopback checks Host and
  Origin ("rejects requests for unrecognized hosts", "mutations must be
  same-origin"), which blocks browser CSRF and DNS rebinding. VERIFIED from strings
  only.
- Draft edit and delete touch only msgvault-managed drafts (help text). Gmail tag
  edits take only user labels.
- A separate OS user for the data is the right primitive. It fails here only
  because of #1 and #2.

## Disclosure

While listing the keys of `daemon.68781.json`, I printed one nested field unredacted
into this transcript: the daemon's `shutdown_token`. It lets a same-UID process stop
the current daemon. Every agent can already read it from that file, and it should
rotate on the next daemon restart, which is the owner's call. I read no other secret
values. Of the token file I read only its key names and its `scopes` array.
