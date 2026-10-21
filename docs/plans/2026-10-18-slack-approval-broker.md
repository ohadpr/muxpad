# Slack approval broker

Status: implemented in `feat/slack-approval-broker`; not installed or activated.

## Requested experience

Use muxpad normally. When an agent requests a protected Slack operation, a modal
opens automatically showing the exact action and payload. Click Send, Allow read,
or Reject once. No passkey or additional confirmation is needed for each action.
There is one initial pairing step in the person's own browser on a device outside
the agent's control. Never pair a remote agent browser or a shared cookie profile.

## Trust boundary

The adversary runs as the muxpad agent account and can edit muxpad, read its files, spoof pane IDs,
forge HTTP headers, call APIs, and automate its browser. The current muxpad server
has no human login. Its Origin checks, workspace flags, pane keys, browser wheel
state and any `isTrusted` click test cannot prove a human approved a transaction.
A regular modal backed only by these controls fails the requested threat model.

A root-installed broker runs under a separate unprivileged OS account. Root owns
its code, Node runtime/dependency chain, protected configuration and TLS transport.
The token and human-session state belong to the broker account, not the agent account.

For one-click approvals, the broker serves a small protected top-level muxpad shell.
The existing muxpad UI runs inside a cross-origin sandboxed iframe. The modal is
owned by the outer shell, outside the mutable application. Its HTML, scripts and
styles come only from the root-installed broker; no untrusted API is proxied into
its origin. The iframe cannot navigate the top-level window, manipulate its DOM,
set its cookies, cover its top-layer dialog or send it approval instructions.
No postMessage approval bridge exists. The shell polls the broker's own queue.

A different HOSTNAME from the mutable muxpad application is mandatory. Different
ports alone do not isolate cookies. Pairing sets a random host-only `__Host-`
Secure/HttpOnly/SameSite=Strict cookie. The broker checks that session on every
human endpoint, and checks its CSRF token and exact Origin for each decision.
An agent can forge the latter headers but cannot produce the private session.
Neither cookies nor CSRF tokens are forwarded to the application in the iframe.

## Request lifecycle

The broker policy binds one Slack team and optional conversation-ID allowlist.
Claimed workspace IDs are not an adversarial boundary. Reads require approval by
default; root may explicitly set `autoRead: true`. Writes require exact human approval or an applicable time-limited human grant. Conversation names are refused in favor of fixed IDs. The exact robot
prefix is added before the payload is displayed.

A request has a random ID/nonce, immutable validated payload, fingerprint and
five-minute expiry. The modal renders it with textContent. The authenticated
human decision must match that fingerprint, and pending state is consumed before
any asynchronous external call. Replay, races, altered content, expiry and failed
persistence do not execute Slack. A failed or uncertain send is never retried.
On restart, pending requests disappear. The modal never swaps the payload while
open, disables buttons while submitting, and pauses between queued requests to
avoid approving another action with a double tap.

Pairing requires the root-configured random bootstrap secret entered directly by
the person. Pairing is rate-limited, single-use and persisted before issuing a
cookie. Logout revokes the server-side session. Sessions expire after at most
30 days. Recovery/re-pairing requires a protected administrator reset. A legacy
passkey mode remains available when explicitly chosen; it is not the default UX.

## Limits and rollout

The paired device/session must be outside the agent's reach. A desktop browser
whose files or debugging endpoint an agent can read/control does NOT meet this
requirement. The person's normal phone browser is the intended initial device.
Anyone holding its session can approve: this mode deliberately relies on session
possession rather than per-action biometric proof. Agent root/sudo access, a
compromised human device, or agent control of broker DNS/TLS/proxy/code defeats
the assumptions. There is no claim to resist those situations.

Agents may spam bounded requests, cause denial of service, or lie in the mutable
inner app. Only the protected modal at the trusted address authorizes anything.
Legacy Slack tokens, authenticated Slack browser sessions and other connectors
can bypass the broker and must be revoked/removed during rollout.

Independently approve the exact release archive through a trusted external channel,
freeze and verify it in a root-controlled stage, then install protected TLS/forwarding and the separate
account manually, rotate the token, pair the private human device, and then point
muxpad at the broker. The installer refuses user-writable Homebrew runtimes.
Never restart ptyd for this change. No cron is needed. Source and automated tests
alone cannot verify the deployed OS/network/browser boundary; see the security
review note for the remaining acceptance checks.


The setup must not execute any installer directly from an agent-writable checkout.
Root ownership after copying is insufficient: the exact archive needs independent
approval before execution, and source/runtime/ancestor ACLs must be checked too.
Forwarding must authenticate the broker, not just connect to a local port: require
end-to-end TLS or upstream certificate/hostname validation. See the independent
Astra findings and remediation in the security review note.

## Timed approval extension

The user subsequently requested approval once, for 10 minutes, for a day and other
finite choices. The modal now offers once (default), 10 minutes, 1 hour and 1 day.
This is a new authorization feature and must receive an additional Astra review;
previous code acceptance does not cover it automatically.

A human can approve the exact initial action and delegate future matching requests
for the chosen period. Scope is fixed to the configured Slack team, exact action
and exact conversation ID. Sending different text in that channel is intentionally
covered, and the modal explicitly says ALL agents can use the permission; forgeable
pane/workspace IDs cannot provide trustworthy per-agent isolation. Reads, sending
and deletion are separate scopes. Search is limited to the exact query and result
limit; channel listing has its own fixed action scope. Root policy/allowlists and
validation still run on every request. Agent-provided approval/duration fields are
ignored, and only the human-session/CSRF/Origin-protected decision creates a grant.

Reusable grants live only in the dedicated broker's memory and activate only
following confirmed initial Slack success. Their expiry is measured from the
approval time using the broker clock and is capped by owner-session expiry. Initial
failure, logout or a permission revocation during in-flight creation prevents late
activation. Restart, logout, expiry or an explicit Revoke/Revoke all ends them.
Already queued actions are not automatically sent when a new grant appears.
Existing in-flight actions may complete after revocation; new dispatches may not.

Every automatically allowed request records a bounded protected authorization audit
entry before dispatch and checks the grant again after persistence. No reusable
grant is saved to disk. Expiry/revocation returns future requests to normal human
approval. The protected shell exposes a Permissions list with scopes and expiry,
and one-click individual/all revocation. Choosing once creates no new timed grant;
it does not silently revoke an existing independent grant.
