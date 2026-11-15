# Connectors: the broker, Slack, and the mail archive

muxpad works with none of this. Panes, chats, apps, publishing and crons need
no broker and no connector. Read this only when you want a chat to **reach
something outside the machine on your behalf** — post to Slack as you, or read
your own mail and calendar.

If you are an agent reading this to set it up for someone: every command below
is copy-pasteable, every verification step prints something you can check, and
the **Failures** section at the end lists the ones that have actually happened
with their exact error text. Start at *Do you need this?* and stop as soon as
the answer is no.

---

## Do you need this?

| You want | Broker | Connector |
|---|---|---|
| Terminals, chats, sub-chats, crons, cards, apps, `publish` | no | no |
| An agent that posts to Slack under your name | **yes** | Slack token |
| An agent that reads your mail or calendar | **yes** | msgvault |
| An agent that drafts a reply in your mailbox | **yes** | msgvault |

Nothing here is required to try muxpad, and nothing here degrades if you skip
it: a chat asked to reach Slack on a machine with no broker says so and stops.

---

## What the broker is, and why it exists

The broker is a **separate root-owned daemon** running as its own account
(`_muxbroker`), with its own code at `/Library/muxpad-broker` and its own
state. It holds the credentials. muxpad — and therefore every agent — holds
none.

That split is the whole design:

- An agent asks the broker for an **action**, not for a token. It never sees
  the Slack token or the mail grant.
- The broker **describes** the action to you and waits for a passkey approval
  (or an active timed grant) before doing it.
- The broker's code lives where an agent cannot write. An agent that could
  edit it could hand itself the credential, so the installer refuses any path
  that is not root-owned, has group/world write, or carries an ACL.

The practical consequence, and the one that surprises people: **updating the
broker is a root copy plus a root script.** There is no `pnpm` path to it.

---

## Installing the broker

The broker is installed from a **root-owned staging directory**, never from
your git checkout. An agent can write to your checkout; that is exactly the
thing the isolation exists to prevent.

```bash
# 1. Stage the broker's files where only root can edit them.
sudo mkdir -p /Library/muxpad-broker-release
sudo cp -- broker/*(.) /Library/muxpad-broker-release/      # zsh; see note
sudo chown -R root:wheel /Library/muxpad-broker-release

# 2. First install, from that staged copy.
sudo /Library/muxpad-broker-release/install.sh \
  <node-runtime> <origin> <team> <cert> <key> <muxpad-url>

# 3. Every update afterwards.
sudo cp -- broker/*(.) /Library/muxpad-broker-release/ \
  && sudo /Library/muxpad-broker-release/update-code.sh \
  && muxpad restart
```

**`broker/*(.)` is zsh**, and the `(.)` matters: it selects regular files
only. A plain `broker/*` includes `setup/`, `tsnet/` and a `node_modules`
**symlink**, and `cp` without `-r` fails on them. In bash use
`find broker -maxdepth 1 -type f -exec sudo cp -- {} /Library/muxpad-broker-release/ \;`.

`install.sh` refuses to overwrite an existing install. `update-code.sh`
swaps the code directory atomically and keeps the previous one as
`code.previous`.

### Verifying the install took

```bash
ls -l /Library/muxpad-broker/code/        # the live code
sudo /usr/bin/stat -f '%Su %Sp' /Library/muxpad-broker   # expect root, no group/world write
```

Compare a file you just changed against the live copy — this is the check that
catches "I edited the repo and nothing happened", which is the single most
common broker mistake:

```bash
cmp broker/msgvault.mjs /Library/muxpad-broker/code/msgvault.mjs && echo live
```

---

## Slack

One token, held by the broker, and every message goes out **as you** with a 🤖
prefix the server adds. There is no bot identity and no flag to request one.

```bash
muxpad slack channels                 # proves the token and the approval path
muxpad slack post '#general' 'hello'  # raises an approval; sends under your name
```

If `muxpad slack …` answers that Slack belongs to another machine, that is
deliberate: connectors are **host-scoped**, so a chat on a personal machine
cannot post to a work Slack. The refusal names the machine that may.

---

## The mail archive (msgvault)

msgvault is a third-party local archive
([kenn-io/msgvault](https://github.com/kenn-io/msgvault)) that muxpad talks to
through the broker. muxpad never reads the archive directly and cannot: it runs
as its own service account with its own home.

Three pieces have to line up:

1. **The daemon**, running as the service account with its own
   `MSGVAULT_HOME`, declared to muxpad in `/Library/muxpad/integrations.json`
   (`binary`, `agentUrl`, `tokenFile`).
2. **An agent grant** — a token issued by msgvault with an explicit permission
   list, written to the file named by `tokenFile`, owned by the broker's
   account at mode `0600`.
3. **Per-call approval**, which muxpad handles.

### Issuing and installing a grant

Run as the service account; the owner key lives in its home, not yours.
This pipes the secret straight into the token file so it never reaches a
terminal, a transcript, or an agent:

```bash
cd /tmp && sudo -u <service-account> MSGVAULT_HOME=<home> HOME=<home> \
  <msgvault-binary> agent-token issue --json \
  --label 'muxpad agents' \
  --permissions search.read,message.read,attachment.read,stats.read,\
draft.create,draft.edit,draft.delete,calendar.read,calendar.event.read \
  --source-ids 1,2,3 \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["secret"])' \
  | sudo tee <tokenFile> >/dev/null
sudo chown <broker-account> <tokenFile> && sudo chmod 600 <tokenFile>
```

Then verify through muxpad rather than by hand — the point is the brokered
path, not the binary:

```bash
muxpad msgvault stats          # counts only, no content: the cheapest proof
muxpad msgvault search 'newer_than:2d'
```

### Calendar is two separate things

Syncing calendar events **into** the archive and **controlling live events**
are different features with different configuration, and the error when you
have only the first is not obvious.

```bash
<msgvault-binary> add-calendar you@example.com --write --headless
<msgvault-binary> sync-calendar you@example.com
```

That gets you **reads** — events in the archive, searchable like mail. Live
control (freebusy, conflicts, create/move/delete) additionally needs a
**top-level `[[gcal]]` block** in msgvault's `config.toml`, which
`add-calendar` does not create:

```toml
[[gcal]]
email = "you@example.com"             # the OAuth account, not a source id
enabled = true
write_calendars = ["you@example.com"] # exact calendar IDs
# invite_calendars = [...]            # only if agents may touch guests
```

`[[accounts]]` entries are the **sync** sources, one per calendar, keyed
`account/calendar-id`. `[[gcal]]` is the **control** source, keyed by account.
Without it every control call answers
`403 calendar operation denied: enabled calendar source is required`.

Leaving `invite_calendars` unset is the safer default: guests, RSVPs and
invitations all require it, and an invitation is mail sent under your name.
muxpad refuses `--attendees` for the same reason.

---

## Failures that have actually happened

Each of these cost real time. The error text is what you will see.

**`Invalid or missing API key` on every attachment, while search works.**
The grant was being sent as `X-Api-Key`. msgvault has two header names:
`X-Api-Key` for the OWNER key and `X-Msgvault-Agent-Token` for a grant. The
message is literally true — there was no api key — and reads like a
permissions decision. If you are probing msgvault's HTTP API by hand, use the
agent header or you will prove nothing.

**Every connector call fails after a reboot or a config change.**
msgvault grants live in memory: *"valid until revoked or until its optional
expiry, or until the daemon restarts."* Any config edit needs a daemon
restart, and the restart kills the grant. Reissue it. Budget this as a
two-command ritual, not a bug.

**"I approved it 'until I revoke' and it keeps asking."**
A failed operation deliberately mints no reusable grant — a standing
permission created from an operation nobody has seen work is a permission to
do something unknown. The approval card now says so explicitly. If it keeps
asking, the *action* is failing; read its error, not the dialog. Note also
that grants are in memory on muxpad's side too, so a broker restart (including
every `update-code.sh`) clears them.

**"I edited the broker and nothing changed."**
The live broker runs from `/Library/muxpad-broker/code`, not your checkout.
Stage and run `update-code.sh`. `cmp` the file.

**`chdir: permission denied` running a msgvault command.**
`sudo -u <service-account>` keeps your current directory, and the service
account cannot read it. `cd /tmp` first.

**A command that opens a browser on a headless or remote session.**
`add-calendar` wants `--headless` over ssh, which prints instructions instead
of launching a browser.

---

## Where to look when something is wrong

```bash
muxpad slack channels                      # does the broker answer at all
cmp broker/<file> /Library/muxpad-broker/code/<file>   # is the live code yours
sudo tail -40 <msgvault-log>               # the daemon's own reason, verbatim
ls -l <tokenFile>                          # broker-owned, 0600, non-empty
```

The daemon's log is the authority and is usually ignored for too long. It
printed the exact cause of a calendar failure that four rounds of inference
got wrong.

And when a third-party tool's behaviour does not match this page: **read its
documentation before inferring from its binary.** The `[[gcal]]` block above
is documented plainly in msgvault's own `docs/usage/calendar.md`; it was
reverse-engineered the hard way first, and the hard way was wrong.
