# Claude subscription failover

**You do not need this.** Muxpad runs on your ordinary Claude Code login with no
configuration at all — one account, no failover, nothing to set up. Everything
below is for the day one subscription is not enough.

## Adding a second subscription

```
muxpad claude-account add backup
CLAUDE_CONFIG_DIR=~/.muxpad/claude-accounts/backup claude auth login   # a DIFFERENT Anthropic account
muxpad claude-account status
```

`add` does the four things that are easy to get wrong by hand: it creates an
isolated profile directory, symlinks `projects` so both accounts read and write
one transcript history (a failover mid-conversation resumes the same session),
symlinks `skills`, `plugins`, `commands` and `settings.json` so your setup does
not change under you, and writes the accounts file that turns failover on. It
never links `.claude.json` — that file is the account identity, and sharing it
would make the two profiles one login again.

The login itself is Claude Code's. Muxpad stores no credentials; each profile
holds its own and refreshes it on its own.

`status` is the thing to type when you are not sure what is going on:

```
* primary    4% of five_hour
             /Users/me/.claude
  backup     blocked until 21/10/2026, 13:00 (weekly limit)  — NOT SIGNED IN
             /Users/me/.muxpad/claude-accounts/backup
```

With no accounts file it prints the single login you already have and the one
command above. `--json` is the machine-readable form (the quota card reads it).

Only enrol accounts that are allowed to see the same work: sharing `projects`
means sharing every transcript, tool result and project memory between them.

## The accounts file

`add` writes `<MUXPAD_DATA_DIR>/claude-accounts.json`; its existence is what
enables failover. Editing it by hand is supported — use absolute paths:

```json
{
  "version": 1,
  "preferred": "primary",
  "accounts": [
    { "id": "primary", "label": "Primary", "configDir": "/home/me/.claude", "priority": 0 },
    { "id": "backup", "label": "Backup", "configDir": "/home/me/.muxpad/claude-accounts/backup", "priority": 1 }
  ]
}
```

The runner refuses to start a pool whose profiles do not resolve to one shared
`projects` directory. Preserve any existing profile data before linking.

## Operation

- `muxpad claude-account status` shows each account, how full it is, what is
  cooling off, and which one new sessions prefer. `--json` adds assignments and
  pending-request metadata. It never prints credentials or pending prompt text.
- `muxpad claude-account add <id>` enrols another subscription (above).
- `muxpad claude-account remove <id>` drops one from the pool. The profile
  directory is left on disk; delete it yourself if you mean to.
- `muxpad claude-account use backup` prefers the backup for new sessions.
- `muxpad claude-account use auto` restores priority order for new sessions.
- `muxpad claude-account reset primary` clears a recorded cooldown after an
  external fix. It does not log in or purchase credits.
- `/retry` in a Claude pane retries a saved request. Stop cancels that request.

Healthy sessions keep their account. New sessions and requests on an exhausted
account select an eligible account. Per-model limits only exclude that model's
family. Shared SQLite transactions and cooldowns coordinate independent runners
and survive server/runner restarts. The database is owner-only. Preference
changes do not interrupt running work; existing runners need one restart when
this feature is first deployed. Server-only restart activates housekeeping
selection (summaries and titles) without restarting terminals.

## Recovery behavior

The installed SDK's `rate_limit_event` drives detection: only `rejected`, with
no allowed overage, triggers recovery. Warnings do not switch accounts. A narrow
fallback accepts provider-tagged assistant billing/rate-limit errors, never
ordinary model prose. Authentication and server-overload errors retain their
separate handling. Missing reset times receive a five-minute cooldown.

A rejected request asks the CLI to interrupt, then restarts on another account
at the result boundary. A five-second fallback handles CLIs that park instead
of producing a result. Each account is tried at most once per recovery cycle.
Completed tool results lead to a continuation prompt, not replay of the original
action. Unknown/failed tool outcomes and live background work pause recovery for
reconciliation. This is not an exactly-once guarantee for external systems;
ambiguous outcomes require checking before `/retry`.

If all accounts are exhausted, the request is saved locally and the pane reports
why it stopped. No infinite restart loop and no automatic API-key charging.
`/retry` after reset resumes the saved work before later queued input. A pending
checkpoint from a different session is rejected. Stop during recovery cancels
replay; shutdown cannot resurrect a child.

## Validation

`pool.test.ts`, `completion.test.ts` and `quota-recovery.test.ts` exercise shared
cooldowns, model limits, real backend stream handling, safe continuation,
cancellation, queued requests and parked SDK streams. Existing auth-recovery
and CLI-wrapper suites cover compatibility.

`scripts/claude-account-probe.mjs <account-id>` is a tool-free live smoke test:
it sends a random marker, closes the child, resumes the session and checks the
marker. Run it in a visible muxpad shell pane. It spends two small Haiku calls
and exits; it does not open a browser or server.

## Usage defaults

Claude panes use the native `autoCompactWindow: 200000` setting. This bounds
conversation growth independently of a model's 1M-token capacity and lets the
CLI compact during tool use without injecting an extra queued user turn.
Compaction summarizes history; important decisions and task state still belong
in project files. Existing runners pick up the launch setting on their next
normal restart; an existing session can use `/autocompact 200k` immediately.

Tool-free labels, titles and handoffs use low effort with thinking disabled.
Quota probes use the same settings. SDK quota fractions are stored unchanged
and converted to display percentages when read, including historical readings.

`muxpad cron new` defaults to a fresh tab per fire. Use `--pane` explicitly only
when the existing conversation is needed. Watchers should read small saved
state, run deterministic fetch/compare scripts where possible, and write only
current state. Pin cards to their persistent destination using `--tab`; a
worker's own tab is disposable. Do not recover alert history by searching chat.

Healthy running sessions retain their selected account to avoid needless cache
rebuilds. If the backup becomes exhausted after primary's cooldown expires,
normal failover selects primary automatically at a safe request boundary.
