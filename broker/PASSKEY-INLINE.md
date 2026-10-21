# In-chat passkey approvals (opt-in migration, not activated)

The approved design trusts the mutable muxpad UI to display the exact scope honestly. The app/server relay holds no approval credential. The protected broker verifies a fresh WebAuthn user-verified assertion for every approve/reject and timed-permission revocation. This does not prove the visible transaction text or physical human presence, and does not resist compromise of the approving authenticator/device. Choose the synced 1Password passkey in the browser; provider selection and actual Safari/Chrome behavior require real acceptance tests.

Explicit root configuration selects `approvalMode: "passkey-inline"`, with `authMode: "paired"` retained ONLY for compatibility with the existing tsnet helper. Paired cookies, device keys, legacy WebAuthn and tailnet membership confer ZERO authority in this mode. All prior human/device/enrollment/decision HTTP routes are disabled. `autoRead: true` is refused. Existing paired state is retained for deliberate administrator recovery, never opportunistic fallback. The running paired installation remains unchanged until a separately reviewed human migration.

`passkeyOrigin` is the exact normal HTTPS muxpad origin, and `passkeyRPID` must equal its DNS hostname, not the broker transport hostname or an IP. These public values must be supplied and reviewed, not inferred from forwarded headers. The existing broker transport and helper binary can remain. No external approval HTML, iframe, popup or per-browser enrollment is used. Modal auto-opening is local; a button starts WebAuthn. Browser/1Password mediation still applies.

## One-time enrollment trust step

The reviewed migration must generate a fresh `passkeyGeneration` UUID, random enrollment capability (only its SHA256 hash in `bootstrapHash`), and `passkeyEnrollmentExpires` (at most ten minutes from enrollment start). No agent reads or runs that setup. The human uses the capability in muxpad Settings. Options consume it durably once. A real UV/resident-key registration produces only an immutable pending candidate, never approval authority. It expires after at most two minutes and is bound to the broker process and generation; restart does not reactivate it.

Settings derives the actual browser-created public key fingerprint with native getPublicKey/WebCrypto and checks credential ID, RP and origin against the candidate. Status-only or same-ID/different-key candidates cannot supply a trusted confirmation; missing export/unsupported algorithm fails closed. Settings displays exact candidate ID, credential ID, SHA256 normalized P-256 SPKI public-key fingerprint, RP, origin and generation. The trusted human administration step must confirm ALL six fields, using the protected candidate—not “latest pending.” The dedicated `/Library/muxpad-broker/state/passkey-admin.sock` has protected ancestry/0600 and live/stale/symlink/mode checks. Its separate handler exposes only exact enrollment confirmation and credential revocation. It is never mounted on public HTTP or forwarded by the app relay. This trusts root and the dedicated broker UID; 0600 is not a claim of kernel-authenticated root identity. Do not pair or enroll from agent-controlled browser automation.

Activation updates live broker state through that socket, persists before publishing authority and invalidates old epochs. It does not overwrite the live state file from a shell. Storage uncertainty latches authority off in memory; trusted reconciliation is required before restarting after such a failure. No durability guarantee is claimed when storage itself fails. A failed/expired setup needs a deliberately reviewed recovery; it must not silently reopen enrollment.

## Routine decisions

The immutable request fingerprint, team, decision, exact once/timed duration, versioned full-team scope, credential epoch and grant epoch are encoded into a canonical intent envelope with a fresh random nonce; its SHA256 is the single-use challenge. The trusted UI checks the envelope against every displayed field and local selection and recomputes that hash before starting WebAuthn, so an untrusted relay cannot silently change the duration/payload/purpose. The challenge is with wall and elapsed deadlines. The request is reserved before asynchronous signature verification. Audit/counter persistence and final owner/policy/expiry checks precede Slack dispatch. Decisions are submitted once; uncertain responses never trigger replay. A first action must complete before any reusable timed permission activates.

Once covers only the current request. 10m/1h/1d grants explicitly cover all five existing Slack actions (list channels/read/search/send/delete) across all policy-permitted destinations for the configured team, to all agents, within existing token capabilities. Expiry, elapsed-time/session cap, restart and revocation end grants. Existing queued requests are not swept. Once does not revoke a previously active timed permission; the UI discloses that and Settings offers fresh-passkey revocation. Credential revocation is a separate protected administrator action.

Only the requesting active chat mounts its modal. Exact payload fields render as text; new requests default to once. A matching confirmed result and successful empty pending snapshot permit auto-close; warnings/failures remain visible and can be manually closed without approving. More pending actions keep the dialog open. The old missing-notice incident is not claimed diagnosed by this change.

Source/unit tests do not certify 1Password sync, real browser UX or installed service behavior. Exact migration package/command and public HTTPS origin still need review before any live action. The previous member-capability Phase B is superseded and must not be activated for this design.

Setup recovery stays inside the same forward-only deployment transaction. The
private administrator socket can issue a bounded replacement enrollment lease
only while no credential is active. `begin-enrollment` compares the exact prior
lease ID and candidate ID/fingerprint (including explicit nulls), pins the
configured RP/origin/generation, retires old challenges/candidates and persists
the replacement atomically. It never activates a credential. Once a lease exists,
the original configuration capability cannot be used again. Leases expire on
wall/elapsed deadlines and do not survive a broker boot as usable authority.
A root-generated operation ID and request digest permit lost-response status
reconciliation without extending the lifetime or regenerating a secret. A
replacement requires a deliberate trusted-administrator setup action; it is not
an HTTP relay operation or an automatic browser retry. Final activation still
requires the locally derived exact credential/key receipt. Storage uncertainty
cannot be cleared by this endpoint.

Presence policy: WebAuthn requests userVerification=discouraged; the verifier
does not require UV, but still requires the signed UP flag. Signature, exact
intent/RP/origin/credential/nonce and authority expiry/epoch checks are unchanged.
Existing registered credentials remain valid and require no enrollment. The
client also accepts old required-policy responses during rollout, without
relaxing those responses. 1Password may still ask to unlock; this policy cannot
guarantee that provider/device prompts disappear.
