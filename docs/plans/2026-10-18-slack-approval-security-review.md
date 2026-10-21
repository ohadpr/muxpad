# One-click muxpad approval security review

Scope: code review and automated regression checks performed by the implementing
agent. This is not an independent audit or a production security certification.
Status: application-level checks pass; deployment approval remains BLOCKED until
the protected installation and real-browser isolation checks below are verified.
The service has not been installed and no live Slack action was executed.

## Findings and fixes

| Finding | Resolution and evidence |
| --- | --- |
| A plain muxpad approval endpoint cannot authenticate a human: the server is reachable by agents and has no login. | It has no authority to approve. Protected `/human/decision` needs the paired cookie, per-session CSRF token and exact origin. Tests try forged headers/cookies and legacy endpoint mode spoofing. |
| An agent can edit the muxpad UI to display different content, steal a session, or click its own button. | Root-owned outer shell renders and submits broker-owned immutable payloads. Existing mutable UI stays in a cross-origin sandboxed iframe. No credential-bearing backend proxy and no postMessage approval listener exist. |
| Cookies cross ports, and a same-host application could receive the human cookie. | Startup refuses same-host session configuration. `__Host-` Secure/HttpOnly/SameSite=Strict cookie has no Domain attribute. Configuration and response tests verify these properties. |
| An iframe could try to overlay, navigate, or impersonate the approval UI. | Protected native dialog lives in the outer document's top layer. iframe has no top-navigation permission. Frame-ancestors none and X-Frame-Options DENY stop embedding the protected shell, and COOP severs cross-origin openers. DOM tests verify message content is escaped and iframe messages cannot authorize requests. |
| An authenticated decision could execute different content or run twice. | Immutable copied payload, random nonce and content fingerprint; synchronous pending-state consumption before any await. Tests cover mismatched fingerprints, concurrent decisions and replay. |
| A queued action could appear beneath a double tap on the previous action. | Buttons are disabled initially and during submission. Requests never replace an open modal; a cooldown separates queued dialogs. DOM tests click twice and verify a single decision. |
| Expiry, network failure or disk failure could cause a retry or false success. | Expired/stale requests fail closed; a failed/uncertain action cannot be retried in the modal or CLI. Persistence must succeed before execution. Automated tests cover failure and UI retry behavior. |
| Pairing could be repeated or a revoked/expired session reused. | Random one-time administrator secret, rate limit, persisted pairing, server-side session expiry/revocation and no raw bearer in saved state. Tests cover wrong secrets, repeated pairing, failed saves, logout and expiry. |

## Deployment acceptance gates

These cannot be proved by unit tests and are still open. Until verified, do not
label the system deployed, independently reviewed or safe for real Slack sends.

1. Confirm code/config/runtime and all linked libraries are root-controlled, the
   daemon UID differs from agent UIDs, and agents cannot read token/session files.
2. Confirm the protected HTTPS hostname differs from muxpad's hostname; certificate,
   DNS and forwarding controls cannot be changed by agents; never proxy arbitrary
   muxpad content through the protected origin. Confirm TLS validation is enabled.
3. Pair directly on the person's private device, never through browser handoff or
   an agent browser/profile. Confirm no human cookie or CSRF token appears in the
   agent cookie jar, application logs/API, iframe DOM or agent browser storage.
4. In a real browser, verify the modal opens automatically above the muxpad frame,
   exact content remains visible, frame navigation/postMessage/overlay attempts
   cannot approve or cover it, and double tapping cannot approve the next request.
   No Playwright MCP was available in this session, so this is NOT browser-verified.
5. Verify broker isolation from an agent shell, reject a test action, and explicitly
   approve one deliberate test-channel message once. Verify token team/channel
   policy and revocation of old tokens and alternate Slack access paths.
6. Check usability of embedding the existing muxpad app (navigation, popouts,
   mobile layout and any microphone/clipboard features). The protected shell is
   new; DOM checks are not a full browser compatibility test.

A shared or agent-controlled browser session fails this review regardless of
whether its clicks have `isTrusted=true`. Session mode is suitable only when the
human browser credential is outside the agent's control. Otherwise use a stronger
independent authenticator or move the agent to a genuinely isolated account/device.

## References

- [OWASP transaction authorization](https://cheatsheetseries.owasp.org/cheatsheets/Transaction_Authorization_Cheat_Sheet.html): bind authorization to the actual transaction, enforce decisions server-side and address malicious-client substitution.
- [OWASP authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): enforce authorization independently of client assertions.
- [MDN cookie prefixes](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Set-Cookie#cookie_prefixes): host-only Secure cookie requirements.
- [HTML modal dialogs](https://developer.mozilla.org/en-US/docs/Web/API/HTMLDialogElement/showModal): top-layer behavior and blocking of the outer document.

## Independent Astra review and remediation

Astra independently reviewed commit `0bbd83e` and did not approve installation or
activation. It found two high-priority installation issues, a medium-priority
modal recovery bug and a low-priority state persistence recovery issue:

- **Mutable installation inputs:** direct sudo execution from the agent-writable
  checkout is removed from the setup procedure. The installer now refuses a
  writable/ACL-bearing stage and its ancestors, and validates all staged entries.
  A review bundle must first be independently approved outside the mutable app,
  copied into a private root-owned stage with system tools, and verified there
  before extraction/execution. Self-printed checksums are not approval. No release
  has received that external trust approval yet; this remains a rollout gate.
- **macOS ACLs:** installer runtime/source/ancestor checks reject ACLs; installed
  ACLs are removed. Startup checks config, secret/TLS/state paths and ancestors
  for ownership, Unix permissions, symlinks/hardlinks and ACLs. Installation checks
  effective secret read denial and installation write denial as the actual agent
  UID before activation. A macOS regression test installs an ACL on its own
  temporary test file and verifies rejection; it does not inspect user secrets.
- **Stale Close/Reject handler and uncertain retries:** Reject now has one permanent
  state-driven handler, and each new modal resets its label. Attempted IDs are
  recorded in protected-origin localStorage before submission, suppressing
  redisplay after uncertain results, Close, reloads and sibling tabs. DOM tests
  cover failure → polling closure → next Reject and failure → Close → pending.
- **Crash temp files:** state saves use unique exclusive temp files, file/directory
  synchronization, atomic rename and best-effort temp cleanup. Tests verify old
  crash remnants do not block saving and serialization failure preserves state.

Astra additionally identified unauthenticated loopback forwarding as a deployment
risk. Use end-to-end TLS passthrough or upstream TLS certificate/hostname validation.
A root-owned proxy configuration that skips upstream authentication is insufficient:
an agent can claim port 9443 while the broker is down. Test that failure before
pairing any real device. Existing browser, credential-revocation and root/runtime
isolation gates remain open. A follow-up Astra review is required for these fixes.

## Second Astra review and additional remediation

Astra accepted the original ACL, stale-handler and crash-temp fixes, and the
verified-staging procedure conditionally. It still blocked installation on:

- **Inherited command/environment resolution:** the installer now sets a minimal
  PATH and uses absolute system paths for external commands. Privileged Node
  runs through `/usr/bin/env -i`. All documented privileged staging commands use
  env -i too, and shell entry is `/bin/bash --noprofile --norc` from a clean
  environment. This matters because BASH_ENV can execute before a script has any
  opportunity to sanitize itself. Raw sudo execution with an inherited shell
  environment is not the documented installation path.
- **Unreadable dependency directories:** packaging now creates traversable code
  directories. More importantly, installation explicitly normalizes all live
  code/dependency directories to 0755 and regular files to 0644 while keeping
  them root-owned. Before asking for any token, it imports `core.mjs` (including
  its dependency tree) as the dedicated broker account in a clean environment.
  Private state modes are not relaxed. Actual installation is still untested.
- **Cross-tab uncertain retry:** an origin-scoped exclusive Web Lock now wraps
  check-and-record of each attempted ID. Existing entries are refused just before
  submission, and read-modify-write of the shared history is serialized. Polls,
  storage events and the initial button delay also check claims from other tabs.
  Without Web Locks, submission fails closed. Tests cover simultaneous same-ID
  clicks, an already-open sibling modal after an uncertain Reject, concurrent
  different IDs with no lost history and missing-lock fallback. Retention uses
  the client clock so skew against the broker's clock does not erase claims.

The third Astra review must assess these changes. No previous archive digest
approves a new bundle: packaging must be repeated, and the exact new artifact
still requires approval through an independent trusted channel.

## Third Astra review

Astra independently reran 26 broker tests and 10 modal tests, inspected the third
archive, and accepted the installer environment, dependency permissions and
cross-tab claim fixes. It found no new broker authorization defect in that focused
review. It identified one remaining conditional bootstrap-procedure issue: bare
`sudo` is resolved by the parent shell before env -i starts.

The setup examples now use `/usr/bin/sudo` and explicitly require a trusted
administrative shell/session that agents cannot change. The selected SUDO_USER
is explicitly the actual agent account, even when installation is performed from
a different protected administrator account. A clean child environment cannot
repair a compromised parent shell. This documentation correction does not change
any archive bytes; the reviewed third archive retains its existing digest.

Code/design acceptance remains conditional on the stated isolation assumptions.
External release approval and actual OS/runtime/TLS/browser/credential-revocation
acceptance gates remain open. Nothing has been installed or activated.

## Final Astra confirmation

Astra confirmed that `f2f1dcb` closes the final bootstrap-procedure finding.
All findings from its code/design reviews are addressed. Its verdict is
conditionally acceptable under the stated isolation assumptions, not deployment
approval. The existing third archive is unchanged by that documentation commit.
Installation and activation still require independently trusted archive approval,
actual OS/runtime permission checks, authenticated TLS forwarding with takeover
rejection, private-device/browser checks and alternate-credential revocation.

## Timed permissions: new review required

The user requested once/10-minute/day approval choices after the prior review.
New code offers once (default), 10 minutes, 1 hour and 1 day, with explicitly
all-agent team/action/channel scope. Sending grants permit different text to that
same channel; delete/read/search/listing are distinct actions, and search is bound
to the exact query and result limit. Agent-supplied approval/duration fields do not
create grants. Only authenticated human decisions do so.

Grants are volatile, session-bound, broker-clock limited, and capped at 24 hours.
They activate only after confirmed success of the initial action. Revocation and
logout during initial in-flight execution prevent late activation. Already queued
requests stay pending. New matching requests are validated against root policy,
audited before dispatch and rechecked after persistence. Restart loses all grants;
expiry/logout/revocation stops future dispatch but not already in-flight actions.
The human-only Permissions panel lists scope/expiry and supports individual/all
revocation. Once creates no new grant; existing grants require explicit revocation.

39 broker tests, 13 modal DOM tests and 40 Slack server/CLI tests pass, as does the
shared/server/web typecheck. Tests cover scope isolation, forged durations, expiry,
session clamping/restart/logout, queued-action behavior, failure/persistence paths,
in-flight revocation/logout, search query/limit boundaries, protected HTTP routes,
clock-boundary rechecks, Unicode scopes, duration UI and revocation. This is not
security approval for the extension. Additional independent Astra review, a newly
reviewed archive and all existing protected-deployment gates remain required.


Timed-grant review follow-up: Astra found persistence-time expiry gaps, wall-clock rollback extension, misleading offline status, and inaccessible revocation behind the approval modal. The revision rechecks request/session before initial dispatch and request/grant before automatic dispatch, invalidates volatile grants and in-flight grant epochs on observed backward clock movement, explicitly warns that offline grants may remain active, and exposes Permissions inside the approval dialog (including during an in-flight action). Real-browser nested-dialog interaction remains a deployment acceptance check; DOM tests do not prove native inertness behavior. No live activation performed.


Final timed-approval review: Astra independently reviewed commit a4a25fc and accepted code/design within the reviewed scope and isolation assumptions. No outstanding code findings remain in this review series. All 46 broker tests passed independently. Session-capped elapsed deadlines apply both before activation and to active grants. Exact archive /private/tmp/muxpad-broker-session-cap-review.tar has SHA-256 efe43f87241d0215a4bc3c0495b0f687e7517d5e22bf9ab97126770d29da0e6e; reviewer verified checkout byte consistency and 1,438 entries without detected links/traversal. This is not external artifact trust approval. Activation still requires independent approval of the frozen archive through a trusted channel, protected OS account/runtime, authenticated TLS forwarding and takeover rejection, private-browser native modal/revocation testing, actual sleep/resume expiry, and revocation/removal of alternate Slack access. Nothing installed or activated.


Claude subscription failover compatibility: Astra found no Slack token/approval-boundary regression. Recovery fixes in the main working tree persist history requirements across restart, force resume, wait explicitly if history disappears during backoff, reject history-less retry, and release the wait on Stop/shutdown without replaying cancelled continuation. Astra accepted the final focused source review with no outstanding failover findings; it did not independently rerun that suite. These changes do not provide exactly-once Slack delivery: a duplicate command is a new request, and a matching active timed permission may authorize it. Broker archive bytes remain unchanged. Combined integration is validated separately in an isolated temporary copy; nothing installed or activated.
