# Adversarial review: host-held connector + broker-signed tickets

Reviewed 2026-11-04 against main @ 1524070. Design not implemented. "VERIFIED" means
read in code; "REASONED" means inferred and not exercised.

## Bottom line

The design does not deliver "the mini cannot use Slack". It cannot, because the mini
is the VM's control plane. The mini holds the VM's node token, creates panes on the
VM with any startup command, and can message the VM's chats. So "the mini has no
token" only covers the one path nobody would take. Worse, step 6 makes things
weaker than they are today. Today a mini process can only ASK, and the token sits on
a separate root-owned node. After step 6, a mini process is two hops from the raw
token, with no approval at all: spawn a VM pane, then passwordless sudo. Fix that
before tickets or signatures matter.

## Findings, most severe first

### 1. CRITICAL: the mini reaches the raw token, no approval needed
VERIFIED:
- The mini server dials the VM with `x-muxpad-node-token`. The token is read from the
  mini's data dir (`HostLinks.sync`, `readNodeTokenFor`), so it is readable by the
  account every personal chat runs as.
- `POST /api/panes` on the mini accepts `node_id` plus `startup_cmd` and spawns there
  (`routes/panes.ts:233,354`). `POST /api/tabs` takes `node_id` (`routes/tabs.ts:110`).
  Pane keys are explicitly "not a security boundary" (`routes/slack.ts`).
- Per the brief, VM user `ohad` has passwordless sudo and docker.

Sequence: a mini chat runs `muxpad agent new` (or calls `/api/panes`) aimed at
`ohad-dev`. That pane runs `sudo cat ~muxconn/token`, then `curl chat.postMessage`.
Cost: two commands. It needs no exploit, only the features muxpad itself teaches
agents.

This is also the accident path, not just the malicious one. A personal chat whose
`slack post` fails is the "eager debug" case. muxpad's own instructions tell it to
"route it to whoever owns it" and to spawn sub-agents. The owner accepted "a rogue
work agent gets the token". This finding is a mini agent that becomes a VM process,
and the design has no way to tell the two apart.

### 2. CRITICAL: timed grants are usable from the mini by construction
REASONED (relies on #1, plus the agent-send path; see the note below).
A grant for "the VM, any payload, 1 day" cannot be bound to a payload hash. So one
of two things must hold:
- (a) the broker keeps the grant and auto-signs a ticket per request, or
- (b) the helper holds a reusable capability.

Either way, any process on the VM can spend it, and the mini can make such a process
on demand. Even without spawning anything, `muxpad agent send <work-chat> "post X to
#eng"` from a personal chat asks a work chat to do it. Under a grant, that
auto-dispatches.

The grant's breadth is VERIFIED in `core.mjs`. `grantScope` is
`{teamID, 'slack-team-all-v2'}` across all 11 verbs, including `read`, `search` and
`dm`. So a day's grant also lets a mini-originated VM process read the owner's DMs.

Also VERIFIED: README "Approval durations" says a grant covers the "same Slack team,
action and exact channel". The code is team-wide and covers every verb. The doc is
wrong today.

Note on agent send: I verified that `/api/agent-sessions/:id/send` goes through
`agentBridge.send` with no node check. That remote runners are relayed into that
bridge is REASONED from `HostLink.relays`. I did not exercise it.

### 3. HIGH: host identity is asserted by the party you distrust
VERIFIED: today the server enqueues `{action, payload}` only (`brokerAction` in
`routes/slack.ts`). `POST /requests` has no caller auth (README). In the proposed
design the broker only ever hears from the mini, so a "requesting host" field is
whatever the mini writes.

Signing the ask on the VM (a key held by `muxconn`) prevents forgery, but not
CAUSATION: the mini drives VM processes (#1), so it can make the VM sign anything.

Enrolment is the weakest single step. The broker must learn the VM's public key. If
it learns it over the relay, the mini can substitute its own key. If a fingerprint is
shown for the human to compare, the human sees the VM through muxpad's UI, which is
agent-mutable and served by the mini. Only an SSH session from a trusted device to the
VM closes this loop, and nothing in the design says so. Any "from chat: Trayo work"
label in the modal is likewise mini-supplied. That is social engineering at no cost.

### 4. HIGH: the token lands on a host other people administer
VERIFIED in `host-api.ts`: "A host that is a shared VM administered by other people".
The brief says sudo is passwordless and docker runs the Trayo stack. Putting the
owner's user OAuth token there exposes it to the VM's administrators, cloud project
owners, snapshots and backups, and container escapes from the infra stack.

The owner accepted a rogue work AGENT, not other HUMANS impersonating them in Slack.
The design depends on a risk that was not accepted.

### 5. MEDIUM: the relay makes the mini a reader of work content
VERIFIED: `recordSlackAction` stores the action and payload in the mini's SQLite.
That DB is readable by personal chats under the same UID. Under the new design every
relayed ask (message text, channel, DM target) lands there too. If read results
travel back over the relay for cards, those land there as well. This is the
"personal/work mixing" the owner cares about, in the other direction.

Relay powers beyond withholding:
- Delay: hold a ticket until just before its TTL, so a post sent "at 10:00" lands at
  10:04.
- Lie about outcomes: report "rejected" while delivering the ticket.
- Reorder independent tickets.

Payload substitution FAILS, provided the helper hashes the request it holds itself
and never trusts a hash that came over the wire. Keep it that way.

### 6. MEDIUM: ticket mechanics (fixable, but specify them)
- **Nonce:** make it the helper-generated request ID of a request the helper holds
  PENDING IN MEMORY. A ticket is valid only against a live pending entry. A restart
  drops pending entries and fails closed, with no nonce database to persist or roll
  back.
- **TTL:** VM wall clocks drift (live migration, host suspend). Bound validity on the
  helper's own clock: pending-since plus 5 minutes, measured by the monotonic clock.
  Do not rely on broker wall time alone.
- **Binding:** bind host key ID, request ID, action, a canonical payload hash, and
  the grant ID if a grant was used.
- **Signing key:** it is new root-protected broker state. It needs the same
  exact-archive review and reinstall that README demands for any broker change.

### 7. MEDIUM: the helper sees only a uid
VERIFIED as a property of unix sockets: `SO_PEERCRED` gives uid and pid, not "which
chat". Every agent, every mini-spawned pane, and any container with the socket
bind-mounted is the same `ohad`. The helper's checks also do little against `ohad`:
root-owned code does not matter when `ohad` can `sudo` and edit it (accepted, but say
it). So the "agent cannot patch the helper" claim holds only for an agent that does
not use sudo, which is precisely the eager-debug agent.

### 8. LOW–MEDIUM: operations
- **Broker down:** no Slack, even though the VM holds a token. That is fine, but the
  token on the VM then buys nothing except exposure.
- **Link down:** no approvals. Fails closed.
- **Token rotation:** a manual job on the VM, with no `auth.test` team pinning unless
  the helper reimplements it. The broker can no longer verify the team once its token
  is deleted (`auth.test` at startup is the current check).
- **Audit:** the broker records approvals but never learns what was executed or
  whether it was. The execution log lives on a host where the agent is root.
- **Two hosts, one connector:** the broker needs a key registry and an enrolment
  ceremony (#3).
- **Chat migration:** none (a pane's node is stamped at creation).
- **Complexity:** a root-owned Linux helper under its own user, plus signed tickets,
  is the "Linux port" the owner rejected, in a smaller suit.

## What holds up (checked)

- The mini cannot post DIRECTLY with no token. That is true and trivial, and it is
  defeated by #1.
- Payload-hash binding defeats MITM substitution, if the helper hashes locally.
- The approval dialog must live in the broker's protected shell. That is correct, and
  the reasoning matches README.
- Today, Slack is not in `host-api.ts`'s allowlist (VERIFIED: 13 shapes, none Slack).

## What I would do instead (short)

Leave the token in the broker, where neither host can read it. Make "personal chats
don't use Slack" a server-side rule about origin, which is what stops ACCIDENTS:

1. `routes/slack.ts` refuses any caller pane whose `node_id` is local. Add a Slack
   shape to `host-api.ts` so VM chats enqueue through the link.
2. The server stamps the origin node from the link principal (not from the body)
   onto the enqueue. The broker shows it and scopes grants to
   `{teamID, originNode}`.
3. Narrow grant verbs: a day of "post" should not imply a day of "read DMs" and
   "search".
4. Optionally refuse local→remote `agent send`, and `agent new` aimed at the work node
   from local chats.

This is not malice-proof: a mini agent can edit the server or forge the stamp. But
nothing the owner asked for is malice-proof against the mini, because the mini
controls the VM. It stops the stray grep, the eager debug and the prompt injection
reading a token off disk, since there is no token on disk to read. And it does that
without putting the owner's Slack identity on a VM other people administer.
