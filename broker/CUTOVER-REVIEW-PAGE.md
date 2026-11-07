# Cutover: approvals move to the broker's own page

Everything below is a change to the LIVE approval path. Read it before running
any of it, and do it when you have ten quiet minutes — not while an agent is
mid-send.

## What changes, in one line

The approval dialog stops being drawn by muxpad's web code — which any agent on
this machine can edit — and is served by the broker at `/review`, on its own
origin, from code agents cannot write.

## Why it is worth a cutover

Today's install runs `approvalMode: 'passkey-inline'`. The ceremony is real: the
broker issues an intent envelope, its SHA-256 is the challenge, and the request
is reserved before the signature is verified, so a decision cannot be replayed
or silently re-scoped. What it does NOT prove is that the text you read is the
text that was signed, and the broker's own notes say so: *"This does not prove
the visible transaction text."* The page doing the describing is muxpad's, and
muxpad is the thing being restrained.

`/review` closes that. It is already built, it already stands alone — the
muxpad iframe is hidden there, so nothing wraps your workspace — and it now
shows which machine asked and what the grant actually covers.

## The order

1. **Pair a browser you trust.** Your phone, or a profile no agent can reach.
   Not an agent browser, not a shared profile, not one with remote debugging on.
   You will paste a one-use secret, once.

2. **Switch the mode** in the protected config (root-owned, on the broker host):

   ```
   approvalMode: "session"
   ```

   and, if you want the narrower grants that came with this release:

   ```
   timedGrants: "read"
   ```

   `timedGrants` defaults to the old behaviour on purpose. With it set to
   `read`, a timed approval covers the five read verbs only and a write is
   `once` or it does not happen.

3. **Restart the broker.** Grants are volatile by design — a restart ends every
   timed permission, which is the correct behaviour and worth knowing before
   you wonder why.

4. **Open `https://<broker-host>/review` and pair.** Keep the tab, or install it
   as a PWA on the phone. An idle page says "No request is waiting"; a pending
   one raises the dialog.

5. **Check it end to end** with something harmless — `muxpad slack channels`
   from a chat. The prompt must show the action, the team, and **asked by
   <machine>**. Approve once. If the origin line says `unknown`, muxpad did not
   send one: that is fail-closed, not broken — it simply cannot ride a timed
   grant.

## What you lose, and it is real

- **Approvals no longer appear inside muxpad.** They appear on the broker's
  page. That is the entire point — a prompt inside muxpad is a prompt an agent
  can draw — but it does mean a second surface to look at.
- **Every device that approves must be paired**, and pairing is per browser.
- **The passkey enrolled for inline mode is not reused.** Inline mode binds the
  credential to muxpad's own origin and rpID; the session path uses the paired
  browser instead. Nothing is lost, but it is not the same credential.

## What you keep

Per-request approval still shows the exact payload. The challenge is still the
hash of the displayed intent. A timed grant is still bound to the machine that
asked, and still dies on expiry, sign-out, revocation or restart.

## If it goes wrong

Set `approvalMode` back to `passkey-inline` and restart. The inline path is
untouched by this release and the two do not share state beyond the grants,
which a restart clears anyway. Nothing has to be migrated in either direction.
