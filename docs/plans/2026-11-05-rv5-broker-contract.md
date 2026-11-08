# RV5 — the broker contract: what muxpad's connector code assumes, and what must be deployed

Reviewed 2026-11-05 against main @ 3b2337f, the repo's `broker/`, and the broker
actually running under `/Library/muxpad-broker`. Read-only. I ran the broker test suite,
one in-memory probe against the repo's `Broker` class with fake Slack, `--help` on
msgvault, and `GET /health` on the live broker. I printed no secrets. I made no Slack
or Google call, issued no token and changed nothing on disk.

**CHECKED** means I ran it, traced it in code, or read it off the filesystem.
**REASONED** means I inferred it and did not exercise it.

This doc covers only the broker contract. The six earlier reviews are not restated. I
cite them where a step depends on one of their findings ("plan-review #2" and so on).

---

## 0. A premise correction that changes the whole spec

**The broker is not on a separate machine.** `100.90.23.126` is `muxpad-secure.west-hydra.ts.net`.
That is a tsnet node: a second tailnet identity hosted by `/Library/muxpad-broker/muxpad-tsnet`,
running **on the same Mac mini** as `_muxbroker` under LaunchDaemon `org.muxpad.broker`. The
mini's own name, `dt-mac-mini`, resolves to `100.118.83.18`. CHECKED: `dscacheutil` for both
names, `ps` (pids 1658 and 2118 owned by `_muxbroker`), and `launchctl print system`.
Plan-review #2 noticed this in passing. The brief for this round still says "separate machine",
so it is restated here because every answer below depends on it.

What follows from it:

- **The boundary is a separate OS account plus a root-owned tree.** It is not a network
  boundary. It holds only while nobody acting as `ohadpr` reaches root. On this machine that
  means the sudo password is never typed anywhere an agent can see (plan-review #9).
- **The broker can reach the mini's loopback** (Q4). It is the same kernel.
- **The live broker matches the repo in behaviour.** `diff` of the installed `code/` against
  `broker/` shows only import reordering, reformatting, and the uncommitted-to-install Linux
  port (`broker-paths.mjs`, `protected-path.mjs` inspectors). Grant logic, `TEAM_ACTIONS`,
  `DURATIONS` and `grantScope` are the same in both (CHECKED). `/health` returns
  `inchat-slack-capabilities-v2-2026-10-20` (CHECKED). Live config:
  `approvalMode: passkey-inline`, `authMode: paired`, `transport: tsnet`,
  `passkeyOrigin` = the muxpad origin (CHECKED, non-secret fields only).

## Baseline, CHECKED by probe

A probe used the repo's `Broker` class in session mode, with fake Slack and a live owner
session:

1. `create({action:'slack.read', payload:{ref:'C1'}, origin:'trayo', requester:'paneA'})`
   - `origin` and `requester` are **silently dropped**.
   - The returned view has no such keys.
2. Approve that **read** for `10m`. The resulting grant has `actions.length === 11` and scope
   `{"teamID":"T1","permissionScope":"slack-team-all-v2"}`.
3. `create({action:'slack.post', payload:{ref:'C2', text:'hi'}, origin:'local'})`
   - The post **auto-dispatches**: state `complete`, and fake Slack receives `slack.post`.
   - It went to a different channel, from a different claimed origin.
4. The audit entry for that post is `{id, hash, decision, at, mode:'timed-grant', grantID}`.
   It has no action, no channel, no text and no origin.

So approving a *read* for ten minutes authorizes *posting*. The inline mode reaches the same
`#decideAuthorized` and the same matcher at `core.mjs:290-295`, so this holds there too.

---

## Findings in this lane, most severe first

### R1. HIGH — Today's broker accepts and discards any field muxpad adds — CHECKED

`Broker.create` (`core.mjs:155-334`) reads only `input.action` and `input.payload`. Any other
top-level key is ignored, with no error.

Failure sequence:

1. muxpad is wired to send `origin` (from `mayPaneUse`).
2. The broker is not yet upgraded.
3. Requests succeed. Timed grants stay team-wide and match every origin.
4. Meanwhile muxpad's prompt and audit can say "scoped to trayo".

A silent no-op on the security field is the worst kind of version skew.

**Required:**
- The broker refuses unknown top-level keys, using `exact(input, ['action','payload'], [...])`,
  the helper `passkey-approval.mjs` already has.
- `/health` gets a new version string.
- muxpad states scoping in its UI or audit only after `/health` reports the new version.

### R2. HIGH — No deploy step can make the broker *verify* origin; it can only *carry* it — CHECKED (paths) / REASONED (WhoIs result)

Three facts, each CHECKED:

- The tsnet frontend (`tsnet/main.go` `proxyHandler`) strips identity headers on every path.
  It injects a verified peer only for `/human/` and `/device/`, and only in `tailnet-peer`
  mode. The live mode is `paired`.
- The VM cannot reach the mini's tailnet at all (one-way link, project memory). VM chats'
  requests therefore reach the broker through the mini's muxpad server.
- `routes/slack.ts:187` `brokerAction` is the single funnel. It sends `{action, payload}`
  from the mini.

The consequence is REASONED: wiring tsnet `WhoIs` onto `/requests`, which is README's
"what would change the decision", would report `dt-mac-mini` for **every** request,
personal or work. Origin is therefore a label muxpad asserts, permanently, under this
topology. A grant keyed to `origin:"trayo"` can be spent by any mini process that writes
that string.

That is still worth doing. It stops the accident plan-review #8 describes. The spec just has
to call it an **accident guard** in the dialog and in the code comments.

### R3. HIGH — msgvault has no fixed address and no owner key to mint with — CHECKED

The daemon runs today as `ohadpr`, listening on `127.0.0.1:57206` (CHECKED with `lsof`).
`~/.msgvault/config.toml` sets none of `api_key`, `agent_access`, `api_port` or `bind_addr`
(CHECKED: key names only). `msgvault agent-token --help` says it "Requires agent_access =
true and api_key".

So:
- **Minting is impossible today.** There is no key.
- **The port is ephemeral.** It is published in `~/.msgvault/daemon.<pid>.json`, mode 0644
  and owned by `ohadpr`. That file also carries a `shutdown_token` (field name CHECKED,
  value not read).

A broker that learned the port from that file would follow an agent-written pointer. It
would not even need to wait for a restart. And because the shutdown token is readable, an
agent can trigger plan-review #2's squat window on demand rather than wait for one.

**Required:** the port is pinned in the broker's own root-owned config, never discovered.
The daemon's shutdown token and pidfile live where `ohadpr` cannot read them.

### R4. MEDIUM — Broker audit cannot reconstruct an auto-dispatched action — CHECKED

`recordAuthorization` (`core.mjs:302-309` for grants, `:486-495` for decisions) stores only
`id` plus the fingerprint hash. `approvalHistory` keeps 200 entries. Once a day-grant has
run, `state.json` cannot tell you what was read or posted, where, or for which claimed
origin. Plan-review #7 said grants record no requester. This is the wider gap: the audit
records no **action**.

### R5. MEDIUM — Comments that claim a broker check that does not exist — CHECKED

These are new spots, beyond model-review #5's `registry.ts:162` and `passthrough.ts:25-27`:

- `scope.ts:77-79`: "The broker re-checks the origin before it mints anything". The broker
  has no origin concept (R1, R2).
- `registry.ts:35-39`: "the broker enforces its own copy of this table before it mints
  anything". The broker has no read/write distinction. `TEAM_ACTIONS` is the grant's whole
  action set (baseline).
- `scope.ts:27-29`: "the broker-origin approval page". It does not exist (Q2).

All three should be written in the future tense or point at this spec.

### R6. MEDIUM — Broker boot is welded to Slack — CHECKED

`main.mjs:64-69` refuses to start without an `xoxp-` token and a successful
`slack.verify()`. A broker that also mediates msgvault would lose mail mediation whenever
the Slack token is rotated or Slack is unreachable at boot. The only safe failure today is
"no broker", so mail approvals would fail closed. It is an availability coupling, not a hole.

### R7. LOW — The approval link muxpad shows today is dead — CHECKED by trace

- `routes/slack.ts:275,485` return `approval_url: ${broker}/review`.
- `SlackApprovalAlert.tsx:79-83` renders it.
- In inline mode, `inlineHandler` answers every path except `POST /requests` and
  `GET /requests/:id` with 404. That includes `/review` and `/approve/:id`.

Harmless today. But it is exactly the hook the doorbell will use, so the link target has to
exist before muxpad points at it.

### Verified sound

- **The broker session cookie is `__Host-muxpad-human`** (`human-session.mjs:3`). Both hosts
  sit under `west-hydra.ts.net`, which is a registrable domain because `ts.net` is on the
  Public Suffix List. So the `__Host-` prefix is what stops `dt-mac-mini` from
  cookie-tossing into the broker. CHECKED.
- **The passkey verifier pins `expectedOrigin` and `expectedRPID` exactly.** CHECKED at
  `passkey-approval.mjs:377-378, 561-562, 658-659`.
- **`validateHumanConfig` forces `passkeyRPID === hostname(passkeyOrigin)`.** So an RP of
  `west-hydra.ts.net`, which both hosts could use, cannot be configured by accident.
  CHECKED at `human-session.mjs:112-126`.
- **The intent envelope binds the request fingerprint, duration, scope and epochs into the
  challenge** (`passkey-approval.mjs:482-505`). Anything added to `fingerprint()` is
  therefore signed over automatically.
- **The broker suite passes:** 176 tests, 174 pass, 2 skipped, 0 fail. CHECKED.

---

## Q1. The minimal grant change: origin + a narrowed verb set

**Where.** `broker/core.mjs`, plus the duplicated constants in `broker/passkey-approval.mjs`.
Move the shared constants into a new `broker/grant-scope.mjs`. `core.mjs` already imports
`passkey-approval.mjs`, so the second file cannot import from the first.

| Location | Today | Change |
|---|---|---|
| `core.mjs:17-31` | `TEAM_SCOPE='slack-team-all-v2'`; `TEAM_ACTIONS` = 11 verbs, used both as the known list and as the grant's action set | Keep `TEAM_ACTIONS` as the known list. Add `TIMED_ACTIONS = ['slack.read','slack.search','slack.channels','slack.users','slack.thread']` and `GRANT_SCOPE = 'slack-reads-by-origin-v3'`. |
| `core.mjs:155` `create()` start | reads `action` and `payload` | `exact(input, ['action','payload'], ['origin','directedBy','requester'])`. When `config.origins` is set, `origin` is required and must be in it; so must `directedBy` if present. `requester` is a bounded label (`/^[A-Za-z0-9_-]{1,64}$/`). Do this **before** `requests.set` and the grant lookup. |
| `core.mjs:285` | `teamID` defined non-writable on the request | Define `origin`, `directedBy` and `requester` the same way. |
| `core.mjs:371-381` `fingerprint()` | id, action, teamID, payload, expires, nonce | Add `origin`, `directedBy` and `requester`. The passkey challenge then signs over them, with no change to `passkey-approval.mjs`'s envelope. |
| `core.mjs:351-370` `view()` | — | Expose `origin`, `directedBy` and `requester`, so the approval surface can display them. |
| `core.mjs:406-409` `grantScope()` | `{teamID, permissionScope}` | `{teamID, origin, permissionScope: GRANT_SCOPE}`. The matcher at `:290-295` then needs no change: scope equality now includes origin. |
| `core.mjs:453` | refuses unless `scope === TEAM_SCOPE` | Compare to `GRANT_SCOPE`. Add: `if (duration !== 'once' && !TIMED_ACTIONS.includes(r.action)) fail('Writes are approved once')`. |
| `core.mjs:541-551` grant object | `actions: TEAM_ACTIONS`, `action:'slack.all'` | `actions: TIMED_ACTIONS`, `action:'slack.reads'`, `permissionScope: GRANT_SCOPE`, `origin: r.origin`, `approvedFor: r.requester`. `listGrants()` already exposes everything except `owner` and `elapsedExpires`. |
| `core.mjs:302-309`, `:486-495` audit | id + hash | Add `action`, `channel` (`payload.channel`), `payloadDigest` (sha256 of canonical payload), `origin`, `directedBy` and `requester` (R4). |
| `passkey-approval.mjs:9-10, 469` | duplicate `durations` and `scope` | Import from `grant-scope.mjs`. Change the durations to the owner's `once/1m/5m/1d` in the same release (plan-review #7), in **both** places. |
| `http.mjs:58-65` `/health` | one version string | New string, plus `{grantScope, timedActions, origins}`, so muxpad can detect the contract (R1, Q3). |
| `shell.html` permissions text; `web/src/lib/slack-passkey.ts` intent check | "Full Slack access … all agents" | Show the origin and "reads only". The web intent check must compare the new scope string and origin. |

Root config gains `"origins": ["<the VM's muxpad node id>"]`. That is the broker's own copy
of the Slack entry in `connectors.json`. It is root-owned and read at boot, never taken from
muxpad.

**What it buys, honestly.** A grant approved for a trayo-origin read covers trayo-origin
reads only. A personal chat that reaches for Slack through muxpad gets `origin:"local"`,
which is refused at `create()`. A write is never auto-dispatched.

**What it does not buy.** Any mini process can claim `origin:"trayo"` (R2), and grants still
cover all agents claiming that origin. Say so in the dialog: "every chat that claims Trayo,
for 1 hour".

Tests to add to `core.test.mjs`:
- a read grant does not dispatch a post;
- a trayo grant does not dispatch a local-origin read;
- an unknown field is refused;
- a missing origin is refused when `origins` is set;
- a timed approve of a write is refused.

## Q2. A broker-origin approval page muxpad can only ring a doorbell for

**What already exists:**

- **Transport: yes, live.** `https://muxpad-secure.west-hydra.ts.net` answers with a valid
  tsnet TLS certificate (CHECKED by `curl /health`). The Go frontend proxies every path to
  the broker socket. Nothing needs to change there.
- **Ceremony engine: yes.** `PasskeyApproval` already has the intent envelope, durations,
  owner epochs, revocation, enrollment leases and the admin-socket confirmation. It is
  RP-agnostic: it reads `passkeyOrigin` and `passkeyRPID` from config, and config validation
  accepts the broker's own hostname (CHECKED: no rule forbids it). So pointing it at the
  broker origin is a **config change plus a page**, not a new engine.
- **A broker-origin page: only the legacy one.** `page.html` + `client.js` serve
  `/approve/:id` and `/enroll`, but only in `approvalMode: 'passkey'`
  (`http.mjs:187-195`). That page does once-only decisions against `state.credential`, has
  no durations or revocation, uses the old `Broker.options/decide` path, and allows
  `'unsafe-inline'` styles. Reuse its `ceremony()` encoding. Do not reuse the mode.
- **`shell.html` / `shell.js`: the wrong tool.** They are the session-mode wrapper:
  - muxpad sits in an iframe and the broker draws the modal;
  - auth is a 30-day paired cookie, with no passkey per decision;
  - the manifest is blocked by CSP `default-src 'none'`, so it cannot be installed as a PWA.

  That is plan-review #1's option (a). It works, but it replaces the muxpad PWA rather than
  complementing it.

**What is missing** (all agent-writable code, then one reviewed release):

1. **The page itself.** In inline mode, `inlineHandler` must serve these as static,
   `'self'`-only assets:
   - `GET /approve/:id`, `/approve.js` and `/approve.css`;
   - `GET /enroll` for the new RP.

   The page reads `GET /requests/:id`, which already passes through. It shows action,
   payload, origin and requester, and the duration choices that `TIMED_ACTIONS` allows for
   that action. It calls the existing `/inline/options` → WebAuthn → `/inline/decision`,
   same-origin. It needs **no cookie**: authority is a fresh assertion per decision, and
   that is what makes it robust on iOS (see below).
2. **Config.** `passkeyOrigin` and `passkeyRPID` become the broker host. Add a fresh
   `passkeyGeneration`, a fresh enrollment capability in `bootstrapHash`, and
   `passkeyEnrollmentExpires`.
3. **No `/.well-known/webauthn`, ever.** A Related Origins file on the broker would let the
   muxpad origin request the broker RP's passkey, which undoes the whole point.
4. **`/inline/status` exposes `approvalOrigin`**, so muxpad's web code knows to show a link
   instead of running WebAuthn itself.
5. **muxpad web:** when `approvalOrigin !== location.origin`, the pending card becomes a
   button that opens `${approvalOrigin}/approve/${id}`. That fixes R7's dead link too.
   Delete the in-page `navigator.credentials` calls once cut over.
6. **Optional hardening:** in this mode, refuse `/inline/options` and `/inline/decision`
   requests that carry no `Origin` header. That would close muxpad's server-side relay.
   It is not load-bearing: the relay cannot produce an assertion for the broker RP, because
   the browser refuses `rpId` values that are not a suffix of the calling origin, and the
   verifier pins `expectedOrigin`.

**Why this is the right boundary.** An agent that edits muxpad's UI can:
- still enqueue misleading payloads (accepted, README);
- spam the doorbell;
- link to a lookalike page.

It can no longer **sign** a decision. Only a page served from the broker origin can obtain
an assertion for that RP, and the broker draws that page.

**What breaks for the owner during the switchover:**

- **It is a hard cut** (REASONED from `credential()`, which checks
  `generation === config.passkeyGeneration`). The current passkey is bound to the
  `dt-mac-mini` RP and becomes unusable. Restarting the broker drops every pending request
  and every grant. From the restart until the new passkey is confirmed over the admin
  socket, `create()` fails with "Set up the Slack passkey". So there is a window with no
  Slack at all.
- **Rollback is clean only before enrollment is confirmed.** After that, `inlinePasskey` has
  been overwritten, and going back means re-enrolling under the old RP.
- **1Password ends up holding two muxpad passkeys.** Delete the old one after acceptance.
- **Desktop.** Until muxpad web ships item 5, the existing in-page modal requests options
  whose `rpId` is the broker host. `slack-passkey.ts:168` rejects that, or the browser
  throws. **Ship item 5 first.** It is inert while `approvalOrigin` equals muxpad's origin.
- **Installed iPhone PWA** (REASONED; each point must be an acceptance test):
  - The PWA's scope is muxpad's origin (`manifest.webmanifest`: `start_url "/"`,
    `display: standalone`). The broker host is out of scope, so a tap opens an in-app
    Safari sheet over the PWA, with a Done button. It does not navigate the PWA away.
  - **Auto-open is lost.** Today the modal pops up by itself. An out-of-scope
    `window.open` without a user gesture is blocked, so approval becomes one extra tap on
    the card. A push notification's tap opens the PWA, not the broker page.
  - **Storage does not matter if the page is cookieless.** Standalone web apps on iOS have
    storage separate from Safari, and the in-app sheet's cookie jar is not the PWA's. A
    design needing a broker session cookie would make the owner pair repeatedly. One that
    needs only a per-decision passkey does not care.
  - **Passkeys in the in-app sheet.** iCloud Keychain and the 1Password AutoFill provider
    are expected to work there. Not verified: test it before cutover.
  - **The sheet shows the real host in its address bar.** That is the only defence against
    a lookalike link from muxpad's card. Even if the owner misses it, a lookalike page
    cannot obtain the broker RP's assertion.

## Q3. Enforcing `registry.ts` / `passthrough.ts` broker-side, without trusting muxpad's copy

- **Slack verbs** are enforced in `core.mjs`:
  - which verbs exist (`TEAM_ACTIONS` membership check, `:172`);
  - which may ride a grant (`TIMED_ACTIONS` from Q1, used at `:453` and `:545`);
  - the re-check at dispatch in `execute()` (`:637-642`).
- **msgvault permission verbs** need a new action family in `create()`. Allow
  `msgvault.{search,message,attachment,stats,calendar,calendar.event}.read` on grants.
  Allow `draft.*` once only. Mint nothing for `calendar.write` or `calendar.invite`
  (plan-review #5).
- **The argv lists (`FORBIDDEN_FLAGS`, `REFUSED_COMMANDS`, `COMMAND_VERBS`) cannot be
  enforced by a broker that only mints tokens.** It never sees argv (model-review #5). They
  become enforceable broker-side only if the broker's own executor runs msgvault and applies
  the list itself. That is plan-review's `_mvexec` helper, which is feasible here because
  the broker is on the same host. Otherwise the real boundary is the msgvault daemon checking
  the token's permissions, and the argv filter stays a convenience.

**Keeping the copies in step.** The smallest trustworthy direction is broker → muxpad, never
the reverse:

1. **The broker is the author.** The tables live in `broker/grant-scope.mjs` (exported),
   inside the reviewed, hash-pinned release.
2. **Commit-time drift check.** A muxpad unit test imports `broker/grant-scope.mjs` from the
   repo and asserts that `registry.ts`'s Slack and msgvault rules match it: same verbs, and
   `timed === TIMED_ACTIONS.includes(verb)`. This needs no runtime trust. It catches drift
   in a PR.
3. **Runtime check.** `/health` (Q1) publishes the broker's live `timedActions` and
   `grantScope`. On mismatch, muxpad's server treats every verb as "ask once", never shows
   "covered by an existing grant", and logs the skew. A wrong muxpad copy then fails toward
   prompting. A tampered muxpad copy changes nothing, because the broker never reads it.

## Q4. msgvault: can the broker reach the daemon, and what is missing?

**Reachability: yes.** `_muxbroker` and the daemon share a kernel, so `127.0.0.1` is the
same loopback (REASONED; not tested as `_muxbroker`). tsnet does not get in the way: it
fronts only inbound broker traffic. The Node child is an ordinary process.

**Missing, exactly:**

1. **An owner key exists nowhere.** `api_key` and `agent_access = true` are not set (R3).
2. **A protected home for that key**, readable by `_muxbroker` only: for example
   `/Library/muxpad-broker/state/msgvault-api-key`, mode 0600. Add a `msgvaultKeyPath` to
   config and read it with `protectedRead()` in `main.mjs`, alongside `tokenPath`. Only an
   admin can write it.
3. **The daemon must not run as `ohadpr`.** While it does, `config.toml`, the key, the db
   and the shutdown token are all agent-readable, and minting through the broker adds
   nothing (plan-review D, model-review #1). Today the db is 0644 and owned by `ohadpr`,
   and `mediationReady()` correctly refuses.
4. **A pinned port in broker config**, never read from `daemon.<pid>.json`, plus a check that
   whoever is listening on it is the daemon's UID before every keyed call (R3,
   plan-review #2). Upstream Unix-socket support would remove the squat entirely.
5. **Broker code:**
   - a `msgvault.*` action family in `create()`;
   - an `execute()` branch that `POST`s the daemon's agent-token issue with `--expires`,
     `--label` (fixed prefix), `--permissions`, `--source-ids` and pinned `--sender`;
   - revoke-all-by-label at boot (plan-review #9);
   - a `/health` field for the msgvault contract.
6. **Decouple boot from Slack (R6).** Either Slack and msgvault each start only if
   configured, or each is a separate broker unit.
7. **Somewhere to deliver the minted token that is not agent space.** That means the
   executor in Q3. If the token is returned to muxpad, every mini process can use it for its
   lifetime, and the daemon is the only boundary.

## Q5. Order of work — each step leaves the system no worse

**AGENT** = writable in the repo, inert until installed. **ADMIN** = a trusted
administrative session (README step 1), never an agent pane. **DEVICE** = the owner's
private phone or browser.

| # | Step | Who | Why it is no worse |
|---|---|---|---|
| 1 | Fix the R5 comments; add the Q3 drift test | AGENT | Text and tests only. |
| 2 | Broker release A: Q1 in full, the R1 strict fields and `/health` v3, R4 audit, durations `once/1m/5m/1d` | AGENT (code + `prepare-release.mjs`) | Not installed yet. |
| 3 | muxpad: send `origin`, `directedBy` and `requester` **only when `/health` is v3**; prompts say "accident guard" | AGENT; then `muxpad restart` (server only) at the owner's moment | An old broker never sees the fields, and muxpad claims nothing it cannot verify (R1). |
| 4 | Independent review of the release-A archive; out-of-band hash | HUMAN reviewer | README gate. |
| 5 | Install release A with `update-code.sh` from a frozen root-owned copy; add `origins` to `config.json` | ADMIN | The broker restarts: grants and pending requests drop, ptyd and panes are untouched. From here, grants are reads-only and keyed by origin. Strictly narrower than before. |
| 6 | Acceptance: approve a trayo read for 1m; confirm a local read and any post are **not** auto-dispatched; read the audit | DEVICE + ADMIN | Read-only check. |
| 7 | Broker release B: the broker-origin `/approve/:id` and `/enroll` pages, `approvalOrigin` in status, optional Origin-required relay | AGENT | Not installed yet. |
| 8 | muxpad web: doorbell button when `approvalOrigin` differs from the page origin; fix R7 | AGENT; server restart at the owner's moment | Inert until step 10. |
| 9 | iPhone dry-run on a **test** RP if possible, or at least: open the broker origin from the installed PWA, confirm the in-app sheet appears and 1Password offers a passkey there | DEVICE | Nothing changes yet. |
| 10 | Review and install release B, then switch `passkeyOrigin`/`passkeyRPID` to the broker host with a fresh generation and enrollment capability | HUMAN reviewer + ADMIN | **Slack is unavailable from this restart until step 11 completes.** Pick the moment. Reverting config before step 11 is clean. |
| 11 | Enroll at `https://<broker>/enroll` on the private device; confirm all six candidate fields over `passkey-admin.sock` | DEVICE + ADMIN | Approval is now drawn by the broker. |
| 12 | Delete the in-page WebAuthn path and the `/api/slack/passkey/{options,decision}` relay from muxpad; delete the old passkey from 1Password | AGENT / DEVICE | Removes the dead parallel door. |
| 13 | msgvault prerequisites: `_msgvault` daemon, `api_key` + `agent_access`, pinned port, protected key file, private shutdown token | ADMIN | Until done, `mediationReady()` refuses, which is no worse than today. Done by itself, it closes the 0644 db exposure. |
| 14 | Broker release C: the Q4 item-5 code, decoupled boot (R6), and the Q3 executor if argv enforcement is wanted | AGENT, then reviewer + ADMIN | Mail mediation appears only once there is a boundary to mediate. |

**Steps 1–3 and 7–8 an agent can do today.** Every install, config edit, enrollment
confirmation and msgvault re-homing needs the owner in an admin session. Never do these
from a muxpad terminal pane, where a cached sudo ticket can be ridden (plan-review #9).
