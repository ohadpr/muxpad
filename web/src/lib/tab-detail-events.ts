import type { PaneSpec } from '@muxpad/shared';

// TabView's projections of the server's pushed rows onto the tab detail it
// holds. They live here, not inline in TabView's event handler, because TabView
// has no render harness and these are exactly the lines where a dropped or
// coalesced field silently diverges from what the server said.

/**
 * Fold a `pane.updated` payload onto the row TabView already holds.
 *
 * Merges rather than overwrites: a version-skewed (or future partial) emitter
 * may OMIT the runtime decorations, and an omitted field must not blank the
 * value we hold. Omitted is `undefined` — and only `undefined`.
 *
 * `title` and `foreground_cmd` are nullable, and `null` is a VALUE: decoratePane
 * sends it when the runtime is gone (pty exit, the ptyd-restart prune), which is
 * the same answer the list endpoint gives. Coalescing it with `??` kept a dead
 * process's title on the pane label until the next resync, so those two
 * distinguish omitted from cleared. The rest are non-nullable, where `??` and
 * "only undefined" are the same test.
 */
export function mergePaneUpdated(p: PaneSpec, incoming: PaneSpec): PaneSpec {
  return {
    ...incoming,
    title: incoming.title !== undefined ? incoming.title : (p.title ?? null),
    foreground_cmd:
      incoming.foreground_cmd !== undefined ? incoming.foreground_cmd : (p.foreground_cmd ?? null),
    // Like title/fg above: PATCH-route events may omit the
    // runtime-only attention flag. Preserve prior so we
    // don't clobber a true value with undefined.
    attention: incoming.attention ?? p.attention,
    // Same for the runtime-only status channel. The server now
    // decorates every pane.updated, but a version-skewed (or
    // future partial) emitter must not be able to blank the
    // status mark mid-turn — coalescing is the cheap invariant.
    // `status`/`agents` are the fields TabView actually
    // RENDERS (the tabbed strip's StatusMark); `busy` is the
    // deprecated alias, coalesced for anything still reading it.
    status: incoming.status ?? p.status,
    agents: incoming.agents ?? p.agents,
    busy: incoming.busy ?? p.busy,
    // Same: a PATCH-route pane.updated carries the raw row
    // without runtime app_urls. Coalesce so a kind/url edit
    // doesn't transiently blank the web-switch dropdown.
    app_urls: incoming.app_urls ?? p.app_urls,
  };
}
