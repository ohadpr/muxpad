# Tailscale setup (new installer under review)

No logout, custom domain or manual certificate files are required by the new
transport. The prepared Apple Silicon release bundles a pinned Node runtime and
compiled Go/tsnet frontend. It creates a separate `muxpad-secure` tailnet identity;
your Mac's existing Tailscale connection and ordinary muxpad URL remain intact.
The protected shell embeds ordinary muxpad cross-origin.

The human sequence is: run an independently trusted installer from a trusted
administrative session; authorize the new Tailscale device using its enrollment
URL on a private device; enter the Slack token privately; open the new protected
muxpad URL and pair once with the generated secret. Team ID is discovered from
Slack automatically. Tailnet HTTPS/MagicDNS or device approval may be required
by your policy. Do not run this unreleased installer yet.

`install-tsnet.sh` installs the isolated account, root-owned code/runtime and
LaunchDaemon, then the frontend terminates HTTPS through tsnet and forwards ONLY
to `/Library/muxpad-broker/state/broker.sock`. No browser-facing TCP proxy to an
agent-replaceable listener; no custom DNS, existing Tailscale daemon changes,
Funnel, SSH listener or exposed LocalAPI. Both state and socket parent are private
to the broker UID. Enrollment does not create a human approval session.

Full reproducible build inputs are in [tsnet/BUILD.md](tsnet/BUILD.md). Existing
external artifact trust and actual installation/isolation/browser acceptance
checks still apply. The simpler installer has not been executed.

The legacy certificate-based deployment is documented below for reference.

# One-click muxpad Slack approvals

Prepared and tested code; not installed or activated. No live token has been copied
or rotated. The new default is one-time private-device pairing, followed by an
automatic modal and one Send/Allow read/Reject click. No per-action passkey prompt.

The broker serves a protected top-level muxpad shell. Your regular muxpad UI runs
inside it; the approval dialog belongs to the protected shell. The agent can edit
muxpad but cannot edit that dialog or obtain its separate human-browser credential.
Use your own browser on a device agents cannot access, initially your phone. Do
not pair an agent browser, shared profile, or a browser whose files/debugging
endpoint are available to the agent.

Read the [design](../docs/plans/2026-10-18-slack-approval-broker.md) and
[security review and open deployment gates](../docs/plans/2026-10-18-slack-approval-security-review.md).
Application-level security checks pass. This is not independent audit approval;
OS, HTTPS and real-browser isolation still need verification before activation.

## Administrator setup (trusted administrative session)

1. Use a trusted administrative shell/session whose startup files, command
   resolution and execution cannot be changed by agents. Prefer a separate
   administrator account they cannot modify. A private phone browser does not
   make an agent-controlled workstation shell trustworthy. Absolute command
   paths and a clean child environment do not authenticate a compromised parent
   shell. Do not bootstrap from an agent pane. Review the broker and installer. Installation needs administrator access and is
   intentionally a human step. This agent session cannot create the OS account or
   install the root daemon.
2. Prepare a root-owned Node runtime with libuv 1.52+ (for example official Node 24.22.0) and all linked libraries. The installer
   refuses user-owned Homebrew runtime paths. Do not weaken that check.
3. Choose a dedicated HTTPS hostname for the protected shell. It MUST differ from
   the mutable muxpad application's hostname: a different port is insufficient,
   because cookies cross ports. Prepare root-controlled TLS certificate/key files
   and protected forwarding to `127.0.0.1:9443`. Keep DNS, TLS and proxy configuration
   outside the agent's control. Use end-to-end TLS passthrough or authenticated
   upstream TLS; a TLS-terminating proxy must validate the broker's certificate
   and hostname. Never disable upstream certificate validation: an agent could
   occupy the unprivileged loopback port while the broker is down and steal
   cookies from a proxy that trusts only the port. No arbitrary muxpad content may be served through
   this protected origin. The daemon itself never binds a public/tailnet interface.
4. Rotate the Slack user OAuth token in Slack. Keep the fresh token out of agent
   chats/files. Identify Trayo's Slack team ID (`T…`) and your normal HTTPS muxpad URL.
5. **Do not sudo the installer in this checkout.** Prepare an unsigned review bundle
   as the ordinary user:

   ```sh
   npm ci --ignore-scripts --prefix broker
   node broker/prepare-release.mjs /PATH/muxpad-broker-review.tar
   ```

   Have an independent trusted reviewer approve the exact archive, including the
   installer and dependency bytes, and obtain its SHA-256 or signature through a
   trusted channel outside the agent-controlled checkout/app. The packager's
   printed hash, an agent-written checksum file, or this mutable muxpad chat is
   not an independent trust anchor. Without that external approval, STOP here.

   In your own terminal, use system tools to freeze the candidate before checking
   it; agents must not be able to change bytes between verification and execution:

   ```sh
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/install -d -o root -g wheel -m 700 /private/var/root/muxpad-broker-review
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/chmod -N /private/var/root/muxpad-broker-review
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/install -o root -g wheel -m 600 /PATH/muxpad-broker-review.tar /private/var/root/muxpad-broker-review/release.tar
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/shasum -a 256 /private/var/root/muxpad-broker-review/release.tar
   ```

   Compare this frozen archive's digest with the independently approved value.
   **Only after an exact match**, extract the verified artifact and run its installer:

   ```sh
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/bin/tar -xf /private/var/root/muxpad-broker-review/release.tar -C /private/var/root/muxpad-broker-review
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /usr/sbin/chown -R root:wheel /private/var/root/muxpad-broker-review/broker
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/chmod -RN /private/var/root/muxpad-broker-review/broker
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin /bin/chmod -R go-w /private/var/root/muxpad-broker-review/broker
   /usr/bin/sudo /usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin SUDO_USER=YOUR_AGENT_ACCOUNT /bin/bash --noprofile --norc /private/var/root/muxpad-broker-review/broker/install.sh /usr/local/bin/node https://APPROVAL_HOST:9443 T_TEAM_ID /PROTECTED/cert.pem /PROTECTED/key.pem https://MUXPAD_HOST/
   ```

   Substitute protected paths, different hostnames, and the team ID. Use the clean-environment invocation above; inherited BASH_ENV can run
   before a script starts, and NODE_OPTIONS/loader variables must never reach
   privileged Node. The installer also uses absolute system paths and runs every
   privileged Node invocation through env -i. Invoke sudo
   with SUDO_USER set explicitly to the actual agent OS account (the account muxpad runs as, on
   this machine), even when your trusted administrative account has a different
   name, so effective access is checked as the agent UID. The installer rejects writable source/ancestors, symlinks,
   hardlinks and unexpected ACLs before trusting staged inputs; it cannot
   authenticate itself if you execute an unverified mutable copy. Runtime and
   library ACLs are rejected too. Newly installed ACLs are removed, and effective
   agent read/write permissions are checked before daemon activation. Installed
   code/dependency directories are normalized to 0755 and files to 0644; a
   dependency import under the dedicated broker UID must succeed before any
   token prompt or activation. Private state remains 0700/0600.

   It creates `_muxbroker`, installs root-controlled code and the LaunchDaemon,
   and prompts without echoing for the token and a random one-use pairing secret
   of at least 32 characters. Generate the secret with your password manager.
6. Open `https://APPROVAL_HOST:9443/` directly in your own private device browser,
   enter the pairing secret once, and bookmark that protected muxpad URL. It shows
   your normal muxpad screen, with automatic approval modals above it. Do not use
   the browser handoff/remote viewer to pair: that would sign in the agent browser.
7. Optionally edit root-owned `/Library/muxpad-broker/config.json` to restrict
   `channels: ["C…"]`. Search is disabled with a channel allowlist. Conversation IDs
   are mandatory; names/user handles are refused. `autoRead: false` requires approval
   for each read; root may explicitly allow reads automatically with `true`. Sends and deletions need individual approval or an applicable human-granted
   timed permission. Protected configuration changes need a
   broker restart. An optional legacy `approvalMode: "passkey"` remains available;
   the installer chooses `"session"` for the one-click UX.
8. Add `MUXPAD_SLACK_BROKER_URL=https://APPROVAL_HOST:9443` to muxpad's server
   environment, merge/build this branch and restart only muxpad's server with
   notice. Do not restart ptyd. Enable Slack in Trayo's workspace settings.
9. Complete the security review's deployment acceptance checks. Reject a read and
   deliberately approve a test-channel send once only when you intend it to reach
   Slack. CLI commands enqueue the request; the modal appears automatically in the
   paired muxpad screen and the CLI waits for the result. No cron is required.
10. Revoke old tokens and remove legacy copies only after verifying setup. Remove
    agent access to logged-in Slack sessions, other connectors and alternate OAuth
    credentials if all Slack access must pass through the broker. Those paths are
    separate bypasses; this code does not delete credentials automatically.

Pairing is single-use. The human session lasts at most 30 days; logout revokes it
immediately. Re-pairing or recovery needs an administrator to reset `humanPaired`
and `humanSessions` in broker-owned state and install a newly generated bootstrap
hash in protected configuration, then restart the broker. Never expose a recovery
endpoint to the agent. Do not give an agent the pairing secret or session cookie.

Approvals require Web Locks; unsupported browsers fail closed. Origin-scoped
Web Locks serialize attempt claims across tabs, and existing modals are disabled
when another tab records an attempt.

Requests expire in five minutes. The modal shows immutable exact payloads, blocks
replay/concurrent decisions, never replaces the shown action while open, and does
not retry uncertain sends. Pending actions disappear on restart. The daemon checks
the token's Slack team using `auth.test` at startup. TLS validation stays enabled;
never use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

## Validation

```sh
npm test --prefix broker
pnpm --dir web exec vitest run src/lib/approval-shell.test.ts src/components/WorkspaceSettings.test.tsx
pnpm --dir server exec vitest run --project unit src/slack-route.test.ts src/slack-cli.test.ts
pnpm exec tsc -b shared server web
```

Tests use simulated Slack calls, generated WebAuthn keys, local loopback test
listeners and isolated DOMs. They do not send Slack messages or launch browsers.
The installer has shell syntax checks but has not been run. Atomic state writes
use unique temp files plus file/directory synchronization; stale temp files from
crashes do not prevent later saves. Deployment remains a
manual acceptance gate; test counts alone do not prove OS or browser isolation.

## Approval durations

The modal offers **Approve once** (default), **10 minutes**, **1 hour**, and
**1 day**. A timed permission approves the displayed action and future requests
for the same Slack team, action and exact channel. For sends, different message
text is allowed. The modal explicitly states that **all agents** can use the
permission; a forgeable pane ID cannot safely restrict it to one agent. Deleting
messages is a different permission from sending or reading. Search permissions
retain the exact query and result limit.

Timed permissions activate only after the first action definitely succeeds. They
expire against both wall time and an independent suspend-inclusive elapsed clock, capped by the paired session's remaining
lifetime, and end early on sign-out or broker restart. They are never saved as
reusable permissions on disk. Requests already queued still require individual
approval; only new matching requests automatically run. Each automatic dispatch
has a protected audit entry. The existing protected channel policy remains binding.

Open **Permissions** in the protected muxpad header to view scopes/expiry and
**Revoke** one permission or **Revoke all**. Revocation stops new dispatches; an
operation already in progress can finish. Selecting once creates no new timed
permission and does not cancel existing permissions. This extension needs its own
Astra review and new exact-archive approval before activation; older reviewed
archive digests do not cover changed code.

The macOS daemon refuses libuv older than 1.52. Its hrtime implementation uses
`mach_continuous_time`, which advances across sleep:
https://github.com/libuv/libuv/blob/v1.52.0/src/unix/darwin.c#L56-L59
https://github.com/apple/darwin-xnu/blob/main/osfmk/mach/mach_time.h
Elapsed deadlines prevent a wall-clock adjustment between requests from extending
a grant, even with no browser polling. Observed backward wall/elapsed movement
also invalidates grants. Real sleep/resume remains a deployment acceptance check.
