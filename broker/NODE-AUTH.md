# Remote member approval mode — candidate, not deployed

This candidate follows the authoritative parent contract in
`/private/tmp/muxpad-slack-current-contract.txt`. Earlier per-device allowlist
proposals are superseded. No device is added individually and no browser PIN or
key enrollment is needed. Access requires the administrator-issued
`muxpad.org/cap/approve-member-v1` application capability, verified by the isolated
Go helper. Explicit protected approval is still required for each exact request
or selected full-team timed scope; network identity never approves automatically.

## Trust prerequisite

Every eligible remote member device, including newly admitted devices, can obtain
approval authority under the application grant below. Software controlling one
can submit decisions; Tailscale identity is not proof of physical human presence.
Protection against a rogue hosting UID501 requires that it cannot enroll/control
an eligible remote node, use a proxy on one, or change the protected policy or
tailnet grant. These prerequisites have NOT been established on the live machine.
In particular, no conclusion has been established about reusable auth keys, OAuth
credentials, CLI/browser login sessions, delegated enrollment rights or control of
remote peers. An attacker able to enroll an eligible node can approve without a
physical human. That actor can supply Origin and CSRF from its own authorized
session; these checks protect browser request boundaries, not human presence.
No secret audit was performed. Do not silently replace this model with device
allowlisting or describe these assumptions as verified.

The ordinary hosting OS node and the independent broker node are always denied
for human authority, even if they have the member capability. Tagged, shared,
jailed, expired, unsigned-peer-only, WireGuard-only and indirect/subnet sources
are unsupported and denied. Other eligible remote members are authorized through
the admin grant, not owner/email/hostname/IP-only inference or TOFU.

## Administrator draft — no live identities chosen

No command here installs or activates anything. A trusted administrator must
independently identify the actual hosting OS stable node ID, broker stable node
ID and broker tailnet stable ID. Public inventory is candidate information for
that review; no live inventory, credential or installed private state was read.
The root policy is `/Library/muxpad-broker/node-policy.json`, regular single-link
0644, root-owned non-writable ancestors, no symlinks/ACLs. Example placeholders:

```json
{
  "version": 1,
  "revision": "REPLACE_WITH_FRESH_POLICY_REVISION",
  "hostNodeID": "REPLACE_WITH_ACTUAL_HOST_OS_STABLE_ID",
  "brokerNodeID": "REPLACE_WITH_INDEPENDENT_BROKER_STABLE_ID",
  "tailnetID": "REPLACE_WITH_BROKER_TAILNET_STABLE_ID",
  "controlURL": "https://controlplane.tailscale.com",
  "capability": "muxpad.org/cap/approve-member-v1"
}
```

The administrator merges this application grant into the existing tailnet policy,
using the broker's exact Tailscale destination IP(s), not the hosting Mac's IP:

```json
{
  "grants": [{
    "src": ["autogroup:member"],
    "dst": ["REPLACE_WITH_BROKER_TAILSCALE_IP"],
    "app": { "muxpad.org/cap/approve-member-v1": [{}] }
  }]
}
```

Application authority and TCP443 reachability are separate. Preserve or explicitly
configure the needed network permission; do not replace existing policy wholesale.
A narrowly administered destination tag is possible only if its assignment rights
are outside agent control. The capability must not be assigned by another broader
rule, shared-node grant or agent-editable attribute. Its payload is exactly `[{}]`;
missing/malformed/multiple/unknown-version parameters fail closed.

Membership is established by this narrowly administered application grant, not
by `Sharer == 0`. In pinned Tailscale v1.104.1, Sharer is populated only when the
sharer differs from the owner, so zero alone is not proof of non-sharing.
Tailscale documents `autogroup:member` as direct tailnet members, excluding shared
users: https://tailscale.com/docs/reference/syntax/policy-file . The helper requires
that grant's capability from its own LocalClient WhoIs and additionally rejects
nonzero Sharer. WhoIs does not independently attest which source selector produced
the capability: deploying a broader/shared-user grant with the same capability
would violate this prerequisite and could broaden authority. Validate the effective
grant and shared-peer negative path before activation; do not claim generic
WhoIs-visible peers or Shared==0 peers are automatically members.

Explicit `authMode: "tailnet-peer"` requires `transport: "tsnet"` and
`approvalMode: "session"`. Default/`authMode: "paired"` preserves current behavior.
Legacy pairing/key records remain stored, unused in peer mode. Legacy pair,
passkey, device register/challenge/renew paths cannot bypass peer authentication.
Neither mode accepts the other's session bearers; no automatic migration/fallback.

## Identity and authority boundary

The helper uses its OWN tsnet LocalClient and original incoming RemoteAddr for
bounded WhoIs before every human route. It checks canonical stable node+owner,
direct node IP, capability, self/tailnet/control context and host/self exclusion.
Peer StableTailnetID is not used: the pinned API leaves it empty for peers. Missing
or expired pinned host identity in the helper's netmap fails closed and requires
trusted reconciliation; no automatic learning of replacement host identities.

It strips inbound identity/forwarding headers, including duplicates, and injects
one canonical assertion only over the protected private Unix transport. Node
rejects peer auth over TCP and missing/duplicate/malformed proofs. Strict bounded
schemas reject duplicate, case-aliased and unknown fields in both runtimes.

A cookie binds node+owner+policy digest+helper generation. Stolen cookies from
another node/host and retired generations fail. GET reports session status only;
it allocates neither sessions nor resume challenges. The protected client uses
exact-Origin JSON POST to bootstrap automatically, without PIN or key enrollment,
never approval. Sessions are capped at128 and reused on polling without rotation
or writes. Browser jars coexist. Human mutations retain exact Origin and CSRF,
Secure/HttpOnly/host-only/SameSiteStrict cookie, no CORS/embedding/opener bridge,
immutable request fingerprint and explicit timed-scope checks. No secrets enter
mutable app state, URLs or logs. No uncertain Slack write is replayed.

## Expiry, reload and revocation

Root policy is revalidated on human and delegated owner checks. Policy-byte changes
retire old digests in a bounded persisted journal, invalidate sessions/grants and
prevent rollback revival. Observed identity/capability loss retires previously
authorized transport generations, including concurrent stale WhoIs results;
restoring capability cannot reactivate old assertions/grants. Owner changes also
retire authority. Transport tracking is bounded to256 peer IDs; excess fails
closed. Peer bearers and all grants are invalidated at broker restart.

Immediately before a delegated agent dispatch, and after initial Slack completion
before granting, Node revalidates the granting owner through a separate protected
helper Unix socket. Agents need not originate at the human node. Wall/elapsed,
session expiry and revocation checks remain, with no queued-request sweep.
Automatic requests are consumed before awaiting identity and dispatch is one-shot.
Only successful initial actions can activate permission. Calls already dispatched
may finish; they are never retried automatically.

Sign out this browser revokes that session and its grants while preserving sibling
jars. Its existing cookie is retained as a long-lived NON-AUTHORITY logout marker,
with only its hash persisted. Reload/restart will not silently bootstrap that
marker. Explicit protected Resume uses a one-use browser-cookie/node/policy/helper
challenge, wall+elapsed deadlines and logout epoch, and atomically replaces the
marker with a new session. Browser data deletion/expiry creates a new jar eligible
under member trust; use stronger device revocation to disable node authority.

Revoke this tailnet device is separate: a persisted node+owner deny blocks all its
browser sessions, bootstrap, resume and delegated grants across policy revisions
and restart. Only trusted administration may reconcile that deny. Grant-only
Revoke ends a permission, not browser or device trust. Failed authority-state saves
deny memory first and disable in-process peer authority with reconciliation
guidance. Durability cannot be promised when storage fails: trusted administration
must reconcile persisted state before restart, rather than loading older state.

External membership/capability changes are observed through the helper's local
netmap. Control-plane propagation is not instantaneous; no immediate external
revocation guarantee is claimed. A successful WhoIs is local knowledge, not proof
of current control-plane connectivity. An offline device is not necessarily
removed; grants do not require that device to remain online. Protected device
revocation immediately invalidates local sessions/grants; root-policy replacement
requires the documented restart and reconciliation path.

The private authority RPC admits at most16 concurrent checks, with bounded request,
response and lookup time. It returns the exact verified node/owner/IP/policy
revision/generation tuple; Node rejects any mismatch or unavailable helper without
retrying. This does not create a control-plane freshness lease.

## Remaining deployment gates

This is source for independent Astra review, not activation approval. A later
coherent human-authorized update must include compiled Go helper + JS + approved
configuration together. The old16-file JS-only updater is insufficient. No new
installer, production/root operation, policy mutation, restart or live Slack call
was performed. Existing installation and pairing remain untouched.

Portable UX is Review gesture → protected approval → best-effort close/manual
return. Ordinary Safari/Chrome may block asynchronous popup opening or closing;
that requirement is not solved, and approval is not embedded in mutable muxpad.
Mock tests do not demonstrate real remote-path or browser acceptance. Verify real
remote phone/laptop positives, actual host/self/proxy/forged-header/stolen-cookie
negatives, identity outages, revocation races and Safari/Chrome geometry/open/close
before activation. Review the exact future compiled package and human command.

References:
https://tailscale.com/docs/reference/tsnet-server-api
https://tailscale.com/docs/features/access-control/grants/grants-app-capabilities
https://tailscale.com/docs/reference/syntax/policy-file
https://developer.mozilla.org/en-US/docs/Web/API/Window/open
https://developer.mozilla.org/en-US/docs/Web/API/Window/close
