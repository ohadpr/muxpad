# Working in this repo: the fast inner loop

The suites are big. To check one change, run one file.

## Run one test file (~1–2 s)

```sh
pnpm --filter web test ChatPane.working          # web    (all 215 files: ~35–60 s)
pnpm --filter server test rebase-run             # server (all: 6+ min, see below)
pnpm --filter @muxpad/shared test chat-events    # shared
```

The argument is a file-name filter. A filter that matches no file fails and
says so, so a typo can't pass green. `-- --run X` works too, but it isn't needed.

If you want vitest with nothing in between, use the narrow form:

```sh
pnpm --dir server exec vitest run src/chat/rebase-run.test.ts
```

## The full server suite takes 6+ minutes

`pnpm --filter server test` runs the `unit` project (~40 s) and then the
`serial` project. The serial project spawns real ptyd/server processes, one
file at a time, and has measured 360–560 s.

- Run it once, **before a commit**, in the background, and read the result
  when it lands.
- Never run it to check one file.
- Never put it under `| head` / `| grep` with a short timeout. The output is
  hidden until the timeout kills it, and you lose the whole run.
- `pnpm --filter server test:fast` is the unit half alone (~40 s).

## Other checks

```sh
pnpm -s typecheck                    # incremental, ~5 s
npx biome check --write <files>      # milliseconds; pass the files you touched
```

## Ask several things per call

The commands are fast; the round trips are not. Measured over 10 sessions on
this machine (37,941 tool calls, `docs/perf/turn-economics.md`): the median
command took 0.15 s, and the median wait before the next call went out was
5.4 s — about 2 s of it fixed, plus ~0.3 s for every 100k tokens of context.
Reads and greps alone were 12,300 calls and 23 hours of that waiting.

- Know you need three ranges of two files? One call:
  `sed -n '40,80p;200,230p' a.ts; echo ===; sed -n '1,30p' b.ts`.
  Several patterns: `grep -n -e foo -e bar server/src/x.ts`.
- Independent tool calls go in the SAME message. Only 0.8% of steps did this;
  14.9% were follow-up reads that did not use the previous result.

## Wait for a job by running it in the background, never by polling

290 `until …; do sleep …; done` loops were measured: 9.4 hours of blocked
calls, 13 of them killed by the 10-minute tool timeout with the answer lost.
Start the job in the background and you are woken when it exits; read its log
then.

## Looking at the UI: one probe, not a script per question

```sh
muxpad browser probe http://127.0.0.1:5173/ --size=390x844 \
  --until="document.querySelector('#root')?.children.length" \
  --eval="document.querySelectorAll('button').length" \
  --eval="getComputedStyle(document.body).fontSize" \
  --shot=/tmp/check.png
```

It uses the pane's warm browser (~2 s warm, measured), waits for a
CONDITION, and answers every `--eval` from the same load. The measured
alternative was 170 hand-written Playwright scripts that each connected or
launched, slept a fixed ~4 s (164 of 170), and took p50 10 s apiece; and 970
runs of back-to-back browser calls (median 3: navigate, evaluate, screenshot).

## Several independent questions: sub-chats, not a long serial turn

207 turns ran 8+ read-only steps in a row; 15 of them delegated anything.
When there are two or more independent investigations of more than a handful
of reads each, start them together in one call (`muxpad agent new
--deliver=batch …` per question) and keep working. A sub-chat starts with a
small context, so each of its calls is cheaper than yours in a long session.
It also takes minutes to report (p50 575 s spawn → report, measured on 109),
so a three-read question is faster done inline, batched.
