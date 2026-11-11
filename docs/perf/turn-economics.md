# Where an agent's turn time goes (measured 2026-11-11)

## Why does this take minutes?

Not because the commands are slow. The median command took 0.15 s and 69% took
under a second. A turn is slow because it is a long chain of single calls, and
each call waits for the model before the next one can go out. That wait has a
median of 5.4 s. About 2 s of it is fixed. Most of the rest is the model
writing its next step at ~7 ms a token, and it grows by ~0.3 s for every 100k
tokens of context. A 23-call turn is therefore 5–20 minutes. Agents almost never
ask for two things at once: 0.8% of steps made more than one call. About 15% of
steps were read-only follow-ups that did not use the previous result. They hand-poll
background jobs, write a new Playwright script with a fixed sleep for every UI
question, and rarely split independent investigations into sub-chats (15 of
207 long read-only streaks). The commands that did take long were test runs.
Many of those were the broken filter, now fixed, plus 290 hand-written polling
loops.

## Data and method

There were 10 Claude Code sessions in `~/.claude/projects/`, the largest and most
recent, chosen across muxpad, home chats, investing, general and find-the-cat.
They were deduplicated by entry `uuid` and `tool_use.id`, because resumes
re-write history: 3,342 of 22,294 tool calls in the 600 MB muxpad session
appeared more than once. Sidechains and `isMeta` entries were dropped.

- **step** = one model response (`message.id`) carrying ≥1 tool call.
- **gap** (model time) = step's first entry timestamp − previous step's last
  tool_result timestamp, within a turn, 0–900 s.
- **command** = tool_result timestamp − tool_use timestamp.
- **turn** = from a real user/injected message to the next one.

Reproduce: `docs/perf/turn-economics/run.sh` (extract, ~10 s for all 10),
then `agg.py` and `more.py` in the same directory, and
`subchat_latency.py <session.jsonl>...` for the sub-chat number.

Totals: 4,540 turns, 37,941 calls, 37,410 measured gaps.

## 1. Shape: calls per turn, seconds per call  (`agg.py`)

| calls in turn | turns | calls |
|---|---:|---:|
| 0 | 595 | 0 |
| 1–2 | 1,546 | 2,147 |
| 3–5 | 789 | 3,053 |
| 6–10 | 609 | 4,717 |
| 11–20 | 527 | 7,807 |
| 21–50 | 370 | 11,384 |
| 51–100 | 76 | 5,107 |
| 101+ | 28 | 3,726 |

Turns with more than 20 calls are 10% of turns. They hold 53% of the calls.

| | p10 | p25 | p50 | p75 | p90 | p99 | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| gap (model), s | 2.3 | 3.2 | 5.4 | 9.7 | 15.9 | 43.9 | 8.3 |
| command, s | n/a | n/a | 0.15 | 1.8 | 9.1 | 132 | 10.2 |

Turn wall time: p50 60 s, p90 421 s, p99 2,322 s. The split by turn length is
in `more.py`:

| turn length | turns | model gaps | commands | median calls |
|---|---:|---:|---:|---:|
| < 1 min | 2,264 | 34% | 6% | 1 |
| 1–5 min | 1,617 | 49% | 21% | 7 |
| 5–20 min | 551 | 42% | 42% | 23 |
| > 20 min | 108 | **64%** | 12% | 47 |

The remainder is first-response latency (p50 9 s), final text, and gaps over 900 s.

Per session, gap p50 ranges 4.7–8.6 s and command p50 0.02–0.58 s. The full
table is printed by `agg.py`.

**What the model time is made of** (`more.py`, OLS on 37,372 gaps < 120 s):
`gap ≈ 1.92 s + 7.0 ms × output tokens + 0.30 s × context/100k`. Over the 86 h
of gaps that splits into 20 h fixed, 48 h writing tokens, and 15 h context.

## 2. What the calls are  (`agg.py`, `more.py`)

| class | calls | under 1 s | command h | model h to write it | p50 out-tokens |
|---|---:|---:|---:|---:|---:|
| read (Read, cat, sed -n, head) | 7,532 | 6,948 | 4.9 | 11.0 | 155 |
| search (grep, rg, find, ls, Grep, Glob) | 6,733 | 6,160 | 9.5* | 11.9 | 276 |
| test | 4,083 | 476 | 27.1 | 8.6 | 525 |
| browser | 3,790 | 2,157 | 5.6 | 6.3 | 223 |
| build / typecheck / biome | 3,081 | 726 | 11.4 | 7.6 | 680 |
| edit | 2,846 | 2,469 | 2.1 | 9.6 | 1,030 |
| http (curl) | 1,501 | 903 | 3.2 | 5.2 | 512 |
| muxpad CLI | 1,288 | 884 | 23.2† | 2.2 | 378 |
| git | 1,283 | 961 | 9.5† | 2.5 | 535 |

\* 8.1 h of "search" time is `until grep …; sleep` waits on background test runs.
† These are dominated by a handful of outliers. One "muxpad" call measured
76,299 s, almost certainly a machine sleep. The git total is a few long `node -e`
scripts the classifier tagged git.

**How many could have been one call.** I re-checked each read-only step (read, search,
read-only git, read-only muxpad) that directly follows another read-only step.
It is **independent** when its input contains no token (an identifier or path of
6+ characters, or a 2+ digit number such as a line number) that first appeared
in the previous batch's results. On that test, 5,588 of 37,410 steps (14.9%)
could have gone out with the step before. Saving only the fixed and context part of
each gap, not the token-writing part, that is **4.7 h of 86 h (5.5%)**. This is a
heuristic. A model can decide to read more after seeing a result without copying
a token from it, which makes the count high. Coincidental token matches make it
low. 0.8% of steps actually issued more than one call (318 of 37,486).
Checked directly on the raw 0cdf8641 file: 61 of 22,229 messages carried 2 calls
and 2 carried 3.

## 3. Context size and the gap  (`more.py`)

**Refuted, partly.** The earlier pass saw no effect because the median gap is
dominated by output length. Hold output length fixed and context matters:

| output tokens of the step | <100k ctx | 100–200k | 200–300k | 300–500k | >500k |
|---|---:|---:|---:|---:|---:|
| 0–300 (tiny calls) | 2.3 s | 2.5 | 2.8 | 3.3 | **4.0** |
| 300–1000 | 4.9 | 5.4 | 6.2 | 6.9 | 8.1 |
| 1000–3000 | 14.8 | 14.5 | 14.5 | 14.8 | 15.1 |

A tiny call in a 500k+ context session costs ~1.7× what it costs in a fresh one.
The median step ran at **463k tokens** of context. The position of a step inside
its turn does not matter: p50 is 6.1 s for steps 0–5 and 4.4 s for steps 100+.

## 4. Browser probes  (`more.py`)

- MCP: browser_evaluate 1,188 calls (101 min), navigate 719, screenshot 569,
  run_code 307 (59 min).
- Hand-written scripts that navigate: **170** across 5 sessions, 79 min of
  command time. **164 of 170 used a fixed wait** (median 3.9 s; 16 min total
  of pure sleeping). CDP-connect scripts took p50 10.1 s each.
- 970 runs of ≥2 consecutive browser steps (3,142 steps, median run length 3).
  Collapsing each run into one call saves 3.4 h of gaps if the whole gap goes,
  or **2.0 h** counting only the fixed and context part.
- `muxpad browser probe`, warm, against the live muxpad UI: **2.0 s wall** for
  load + wait-for-condition + 2 evals (measured: `time scripts/muxpad browser
  probe http://127.0.0.1:7777/ --until=… --eval=… --eval=…`). The first call
  of a session took 5.6 s while the browser started cold.

## 5. Sub-chats vs serial self-work  (`more.py`, `subchat_latency.py`)

- Turns that delegated anything (`muxpad agent new` or in-process Agent/Task):
  247. Turns with ≥10 calls and no delegation: 1,045.
- Turns with an 8+ step read-only streak (an investigation): 207. **15** of them delegated.
- Spawn → report latency over 109 matched sub-chats: p25 262 s, **p50 575 s**,
  p75 806 s, p90 1,394 s.

**Why serial is the default.** It is the cheaper path for any one small
question. Three reads inline cost ~15 s. A sub-chat has to be briefed, has to
start, and has to report, and the measured round trip is minutes (these were
mostly large tasks, so a small question would come back faster, but I could not
isolate that). A sub-chat wins when there are ≥2 independent investigations of
more than a handful of reads each. They run at once, and each runs at the cheap
end of the context table (2.3 s vs 4.0 s per tiny call). The instructions said
how to delegate but never said WHEN it pays.

## 6. Polling  (`more.py`)

290 `until/while … sleep` loops, 9.4 h of command time. 13 hit the ~600 s tool
timeout, so the answer they were waiting for was lost.

## What changed on `perf/turn-economics`

1. **`AGENTS.md`**: four rules, each with its number: ask several things per
   call, never poll, one browser probe, sub-chats for parallel investigations.
2. **`server/src/agent-instructions.ts`**: a new section, "Round trips are what
   make a turn slow" (+19 lines), just before "Waiting without burning tokens".
   To pay for it, the `busy`-boolean history line and the 5-line RUNNER-OWNED
   paragraph were cut to 2 lines (−6). Both outgoing seed hashes were added to
   `SHIPPED_INSTRUCTIONS_DEFAULTS`, as the file asks. `pnpm --filter server
   test agent-instructions` gives 41/41, including the truth test that every
   verb and flag exists.
3. **`muxpad browser probe`** (`scripts/browser-probe.mjs`, wired into
   `cmd_browser`): one URL, any number of `--eval`, `--until` (a polled
   condition), `--shot`, `--size`, `--timeout`. It uses this pane's own CDP
   endpoint, which is not a launch. It reports a 409 as "a person has this
   browser". Exit 0/1/3. `node --test scripts/browser-probe.test.mjs` gives 4/4.
   Verified live: a data: URL (until, 3 evals including a throwing one, viewport,
   screenshot), an `--until` timeout (rc 3), and the muxpad UI (2.0 s warm).

## Proposed, not implemented

- **More to remove from the instructions.** "Delegating work" repeats the
  `agent wait` exit-code caveats that "Waiting without burning tokens" also
  states (~12 lines). Keep one copy.
- **Rejected: a batch/exec verb.** Bash already runs `a; echo ===; b`, and the
  harness already accepts several calls per message. The gap is habit, not
  capability, so a verb would be one more thing to forget. The instruction is
  the fix.
- **`muxpad agent ask` (fan-out in one call).** Proposed shape:

  ```sh
  muxpad agent ask --cwd=. \
    "Where is the rail pill's count computed, and what feeds it?" \
    "Which tests cover rebase-run's transcript path?" \
    "What does ptyd do on SIGHUP?"
  ```

  It would spawn N sub-chats with `--deliver=batch`, default names taken from
  each question, and one shared read-only preamble ("answer in ≤10 lines with
  file:line; do not edit"). Today that is N `agent new` lines in one Bash call,
  which works but makes the agent write the brief N times. Worth building only
  if the new instruction does not move the 15/207 number. Re-measure with
  `more.py` in two weeks.
- **Compaction pressure.** Tiny calls at >500k context cost 1.7×. A long-lived
  chat that is mostly doing small reads would be faster rebased onto a fresh
  transcript (the existing rebase feature). I have not measured the cost of a
  rebase, so this stays an observation.

## Could not measure

- Machine load during the historical sessions (there is no load log). It
  probably inflates some command times.
- Thinking vs visible-output split of the 48 h of token time: thinking text is
  redacted in the transcripts, and only `output_tokens` is recorded.
- Sub-chat latency for SMALL questions. Every matched sub-chat was a sizeable
  task.
