# rv4 — msgvault's real surface vs. muxpad's model of it

Lane: do `registry.ts` and `passthrough.ts` believe true things about msgvault
0.22.0's CLI? The binary is the authority. I used `--help` on all 148 top-level
commands, 135 second-level and 78 third-level subcommands, plus `msgvault
openapi`, `msgvault quickstart` and the binary's strings. I ran the real
`judgeArgv`/`verbForCommand`/`classify` on the attack inputs.

**How I tested what msgvault would run, without running it.** cobra checks a
command's positional arguments *before* any `PersistentPreRunE`. msgvault
validates `--log-level` in that pre-run. So `msgvault --log-level=bogus <argv>`
gives one of two answers. Either cobra rejects the arguments ("unknown
command…", "accepts 1 arg(s)…"), or it accepts them and then stops on
`invalid log level "bogus"` before the command body runs. I calibrated this on
`stats`, `schema-version extra` and `show-message a b`. Every "accepted" below
means I got the second answer and nothing executed.

Connector suite: 4 files, 92 tests, green.

---

## 1. HIGH — a bare `--json` before the subcommand brings back the bypass 3b2337f closed — CHECKED

3b2337f fixed `--log-file search query …` by allowing a bare flag only if it is
in `VALUELESS_FLAGS`. The flaw is that this set is keyed to the wrong command.
When cobra **resolves** the subcommand, it strips flags using the flag set of the
command it is standing on. A long flag that command does not know, given without
`=`, is assumed to take a value, so cobra deletes the next word.

`--json` is **not a root flag**. The root has `-v/--verbose`, `-h/--help`,
`--no-log-file` and `--log-sql`, all bool; `--json` is not among them. So at the
root, `--json` swallows the next token:

```
$ msgvault --json search query --help        → Usage: msgvault query [sql]
$ msgvault --json search export-eml --help   → Usage: msgvault export-eml <id>
$ msgvault person --json list delete --help  → Usage: msgvault person delete <person-id>
```

The filter, meanwhile, treats `--json` as valueless and takes `search` (or
`person list`) as the command:

```
judgeArgv(['--json','search','organization','create'])
  → {ok:true, command:'search'} → msgvault.search.read → {read, timed:true}
judgeArgv(['person','--json','list','delete','5'])
  → {ok:true, command:'person list'} → msgvault.message.read → {read, timed:true}
```

**What limits it.** The swallowed decoy is not removed. It becomes the real
command's first positional argument, and the real command must also accept
`--json`. Together those block most targets:

- `query`, `export-messages` and `export-eml` reject `--json`.
- `agent-token issue`, `merge-account`, `draft-compose`, `kata *`,
  `credentials list` and `setup status` reject the stray word.
- `person delete`, `message-tags` and `export-attachment` get the wrong
  argument count.

**What gets through** is any command with `--json` whose first positional is an
optional free-text, name or slug argument, so the decoy word (`search`, `stats`,
`list` …) is a valid value. All of the following were accepted by msgvault's own
argument validation, and all are classified by muxpad as a **timed
`search.read`**:

| argv | what msgvault would run |
|---|---|
| `--json search person provider add --endpoint=https://x --custom=true --allow-sensitive=true --yes=true` | adds a people-inference provider profile named `search`. It points at an arbitrary endpoint and is allowed to receive sensitive text. |
| `--json search person provider use` | makes `search` the active inference provider |
| `--json search organization create` | creates an organization named `search` |
| `--json search relationship-type create a b` | creates a relationship type |
| `--json search identity discover` / `identity show` / `person get` / `person search` / `documents search` / `multimodal search` / `media search` / `draft-get` | reads outside `search.read`'s meaning |

(The `--custom=true` spelling matters. A bare `--custom` is refused by the
filter, but every bool accepts `=true`.)

The provider pair is the one to care about. It configures where msgvault sends
"provider packets" of archive content for person briefs, enrichment, scoring
and sweeps. `--credential-env=NAME` on the same command reads an environment
variable of the msgvault process and uses it as the provider credential
(REASONED: I did not run it). The runs that would actually ship packets
(`person brief generate`, `enrichment run`, `sweep run`, `scoring run`) all
reject the stray word, so I found no single-call exfiltration.

**Bound (REASONED).** In agent-delegated mode the daemon checks the token.
quickstart says "read grants do not authorize sync, deletion, SQL, export, or
administration". So a read token should not be able to add a provider. But
muxpad's half still fails in the way that matters to muxpad: it labels a write
as a timed read, and a timed read is what runs on an earlier grant **without a
new prompt**. It is the same class of bug as prior #2, through a flag the fix
whitelisted.

**Why the suite misses it.** `passthrough.test.ts:65` places `--json` only
*after* the head. `:136` places it before a *refused* head. `:102`
(`calendar --json freebusy`) is correct only because `calendar` happens to
declare `--json` as a persistent flag (CHECKED: `calendar --json freebusy create
--help` resolves `freebusy`). The same test with `person`, `identity` or
`organization` would be wrong.

**Fix.** Positional reasoning about flags before the command path cannot be made
right from outside, because "valueless" depends on which command cobra is
standing on. Require the command path to be the leading tokens:

- top-level: `argv[0]`;
- nested: `argv[0..1]`, and `argv[0..2]` for 3-level parents (see #4);
- refuse any `-` token before the path ends.

This costs agents nothing; msgvault's own examples all put flags last. Add the
four inputs above as tests.

## 2. MEDIUM — the environment re-points or unlocks msgvault, and the list is longer than prior #10 said — CHECKED (names), REASONED (exposure)

Prior #10 named `MSGVAULT_HOME`, `HOME` and `XDG_*`. The binary reads these
too (`strings`):

| variable | effect |
|---|---|
| `MSGVAULT_ENABLE_REMOTE_DELETE=1` | quickstart: one-shot opt-in to **deleting at Gmail** (`delete-staged`; `--permanent` is unrecoverable) |
| `MSGVAULT_REMOTE_URL`, `MSGVAULT_REMOTE_API_KEY`, `MSGVAULT_REMOTE_ALLOW_INSECURE`, `MSGVAULT_ALLOW_INSECURE` | re-point at another daemon and allow plain HTTP. These are the env twins of the banned `--agent-url` / `--agent-allow-insecure`. |
| `MSGVAULT_API_KEY`, `MSGVAULT_API_PORT`, `MSGVAULT_BIND_ADDR`, `MSGVAULT_TRUSTED_PROXIES`, `MSGVAULT_CORS_*` | daemon identity and exposure, if the call starts a daemon |
| `MSGVAULT_ACCOUNT`, `MSGVAULT_TOKEN_NAMESPACE`, `MSGVAULT_BACKUP_REPO` | change which account, token set or repository is used |
| `MSGVAULT_IMAP_PASSWORD`, `MSGVAULT_SLACK_TOKEN`, `MSGVAULT_BEEPER_TOKEN`, `MSGVAULT_DISCORD_TOKEN`, `MSGVAULT_CHATWOOT_TOKEN`, `MSGVAULT_MATRIX_LOGIN_SECRET` | credentials. Any that are present are readable through `--credential-env` (#1). |

msgvault itself refuses `--home` and `--config` in agent-delegated mode (strings:
"--home is not allowed in agent-delegated mode"). I found no equivalent string
for `MSGVAULT_HOME`, so I cannot say the env var is refused there.

**Can an agent set these on the call?** Today, no code path exists to do it.
There is no `muxpad msgvault` CLI verb and no spawner: `judgeArgv` has no caller
(rg). It becomes possible the moment either one forwards `process.env`, or the
spawner inherits the muxpad server's launchd environment. **Fix:** the spawner
should build the environment from an allowlist (`env -i`, then a fixed
`PATH`/`HOME`/`TZ`), not a denylist. Each release has added variables;
`ENABLE_REMOTE_DELETE` arrived in v0.20.0. The broker's copy needs the same
rule.

## 3. MEDIUM (latent) — commands whose name hides what they do, so they must never be mapped by name — CHECKED from `--help`

Today these are all unmapped, so they are refused once a caller enforces
`verbForCommand === null` (prior #7). I list them because a "read" label would
be wrong for each, and some look harmless.

| command | why it is not what it looks like |
|---|---|
| `message-tags <id>` | One command does both read and write. It reads tags, and with `--add`/`--remove` it **edits Gmail labels / IMAP keywords / Graph categories at the provider**. It cannot be mapped by name at all. |
| `build-cache` (alias `build-parquet`) | Exports the archive's normalized tables to Parquet: a second full copy, the same reason `create-subset` is refused. |
| `embeddings build`, `multimodal build/probe/search`, `documents build/probe-mistral/vectors *`, `person brief generate`, `person enrichment run`, `person scoring run`, `person sweep run` | Send archive content (bodies, attachment pixels, documents, evidence packets) to configured **external** providers. They look like index maintenance but are reads that leave the machine. |
| `person provider add/use/set`, `… consent` | Choose where those packets go (#1) |
| `muesli-hook --install <dir>` | Writes launcher files to a directory of the caller's choosing |
| `docbank attachments backfill` | Uploads stored attachments to the Docbank mirror |
| `logs` | With `[remote].url` it reads the **remote daemon's** logs. Logs carry argv and, with `--log-sql`, SQL. |
| `verify`, `backfill-*-media`, `sync*`, `muesli-hook` | Network calls with the owner's provider credentials |
| `deduplicate` (aliases `dedup`, `dedupe`), `delete-deduped`, `stage-delete`, `delete-staged`, `cancel-deletion`, `repair-*`, `import-*`, `identity add/import/remove/matches accept`, `activity build`, `rebuild-fts`, `purge-excluded-media`, `pack/unpack/repack-attachments` | Local mutation. `import-*` also reads arbitrary local paths into the archive. |
| `list-deletions`, `show-deletion`, `cache-stats` (alias `parquet-stats`), `completion`, `schema-version`, `quickstart` | Plain reads or static output. They would be safe to map, but are unmapped. |

## 4. LOW — `NESTED` is wrong in three ways — CHECKED

- It lists **`claude-account`**, which msgvault 0.22.0 does not have. It is
  harmless and unexplained, probably a copy-paste.
- `meetings` and `media` are missing. rv2 covers this; still open.
- **The rule stops at depth 2, but msgvault goes to depth 3.** Third-level
  parents (CHECKED):
  - `person` has `agenda`, `attributes`, `brief`, `enrichment`, `facts`,
    `notes`, `provider`, `relationship`, `scoring` and `sweep`;
  - `identity` has `matches`;
  - `organization` has `attribute`;
  - `carddav` has `books` and `conflicts`;
  - `documents` has `vectors`;
  - `docbank` has `attachments`;
  - `kata` has `evidence`.

  Every one mixes reads and writes. Today none of these pairs is mapped, so they
  fail closed. The first time someone maps a "read" pair, though, every leaf
  under it inherits the read: `person notes` → `notes set`, `person facts` →
  `facts pin`, `person brief` → `brief generate`, `identity matches` →
  `matches accept`. **Fix:** derive the tree from `--help` in a version-pinned
  test, and key the map on the full path to a leaf.

## 5. INFO — the `COMMAND_VERBS` → permission mapping

The OpenAPI schema has one security scheme (`X-Api-Key`) and no per-endpoint
permission annotations. msgvault does not document which grant each read path
needs, so most of the mapping cannot be confirmed without issuing a token,
which was out of bounds.

What the binary does say:

- **CHECKED.** "calendar.read permits availability only; … event details only
  with calendar.event.read" and "guest changes require calendar.invite". So
  `calendar freebusy`/`conflicts` → `calendar.read` is right, and writes without
  guests need only `calendar.write`.
- **CHECKED.** "Agent grant requires search.read, message.read,
  attachment.read, or stats.read on the requested sources". Some path, likely
  account listing, accepts any of the four. `list-* → stats.read` is plausible
  (REASONED).
- **CHECKED.** No mapped command asks for `attachment.read`, so that
  permission is unreachable. That is fine.
- **REASONED, unverifiable here.** I could not confirm:
  - whether `person list` is permitted in agent mode, or under `message.read`;
  - whether `draft-forward` (which copies an arbitrary archived message into a
    draft) needs `message.read` as well as `draft.create`;
  - whether `search --mode=vector|hybrid` sends the query text to an external
    embedding provider.

  Plan-review #7 already covered source scoping (`--source-ids`).

## Verified sound

- **No cobra prefix abbreviation.** `stat`, `sta`, `list-acc`, `show-mess`,
  `quer` and `qu` all give "unknown command" (CHECKED, via `--help` so nothing
  ran). `REFUSED_COMMANDS` cannot be dodged by abbreviation.
- **Aliases** (CHECKED, all levels): `show`→`show-message`,
  `org`→`organization`, `build-parquet`→`build-cache`,
  `parquet-stats`→`cache-stats`, `dedup`/`dedupe`→`deduplicate`,
  `sync-incremental`→`sync`,
  `sync-calendar-incremental`→`sync-calendar`. None reaches a refused command,
  no subcommand has an alias, and every alias is unmapped, so it fails closed.
  `org create x` → command `org`, unmapped.
- **`VALUELESS_FLAGS` arity** (CHECKED): each one is a bool wherever it is
  defined. `--json` appears about 136 times across commands and is a bool every
  time. The only value-taking short flags in the whole tree are `-n` (`--limit`,
  `--lines`) and `-o` (`--output`); both are refused when bare. The defect in #1
  is *where* `--json` is known, not its arity.
- **Forbidden flags.** None has a shorthand. msgvault also refuses
  `--home`/`--config` itself in agent mode, and `--local` with `--agent-url`.
- **Mapped pairs that exist and are reads:** `calendar freebusy`,
  `calendar conflicts`, `person list`, `media`→`search` only.
  (`calendar list`/`show` and `person find`/`show` don't exist; rv2 covers this.)
