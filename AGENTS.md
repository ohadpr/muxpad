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
