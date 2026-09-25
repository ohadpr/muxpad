# CI coverage

Every push and pull request runs five independent checks with the locked pnpm
dependencies and the Node version in `.nvmrc`:

- `typecheck`: `tsc -b shared server web --force`, including test source files.
  Vitest transpilation alone does not detect type errors.
- `lint`: the existing recursive Biome checks, including formatting.
- `shared tests`: the full shared Vitest suite.
- `web tests (jsdom)`: the full web Vitest suite, with freshly compiled shared exports.
- `server tests (serial)`: the full server Vitest suite with file parallelism disabled.
  Parallel execution has a known load-dependent integration timeout flake; serial
  execution avoids that contention without raising test timeouts.

These checks fail on errors; no `continue-on-error`, empty-suite success, or lint
baseline suppression is configured. Independent jobs keep one failing check from
hiding the results of the others. Repository branch protection must separately
require these checks before they can block merges.

This is **not a required browser regression suite**. CI does not build `web/dist`
or install Playwright browsers. Existing server browser tests therefore report
skips. jsdom and helper/source-text assertions do not establish real scrolling,
layout, WebSocket-to-render wiring, cross-window storage delivery, or mobile
keyboard behavior. The workflow also does not validate a production Vite bundle.

A future browser gate needs a freshly built bundle, required browser prerequisites
and executed-test counts (missing prerequisites must fail, not skip), and isolated
loopback instances with their own data directories and PTY sockets. Chromium and
WebKit should exercise parked history plus late growth, hide/show and cold return,
prepends during restoration, fold expansion and later thumbnail/composer growth.
Mobile keyboard behavior needs an appropriate mobile-browser/device harness.
Adding CI does not itself fill these component and browser coverage gaps.
