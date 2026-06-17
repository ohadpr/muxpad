import { EventEmitter } from 'node:events';
import type { AppUrl } from '@muxpad/shared';
import type { PtydClient } from './ptyd-client/PtydClient.js';
import { AppUrlDetector } from './runtime/app-url-detector.js';
import type { AppUrlMarker } from './runtime/pty-scanner.js';

/**
 * Per-pane decoration state cached on the main server from ptyd push events.
 *
 * Fields:
 *  - `cwd` / `fg` are read synchronously by HTTP handlers (workspace lists,
 *    cwd-inherit-from-sibling) — round-tripping to ptyd for every list call
 *    would add latency to a hot path.
 *  - `title` / `attention` are read synchronously by the tab GET handler
 *    (which decorates each pane row with title/foreground_cmd) and by the
 *    workspace list (which folds attention across every pane in every tab).
 *
 * The shape mirrors the legacy in-process `PaneManager.emitDecorations`
 * snapshot: cache the same fields the main server used to read directly
 * off the runtime, but now sourced from ptyd's `paneCwd` / `paneFg` /
 * `paneTitle` / `paneAttention` events plus the initial `flushCwds()` seed
 * on (re)connect.
 *
 * Cold start: `cwd` is seeded synchronously from `PaneStore.listCwds()`
 * (see `seedCwds` and the main entry's startup wiring). `title`,
 * `foreground_cmd`, and `attention` are NOT seeded — they live only in
 * ptyd's memory. During the window between HTTP start and the first
 * ptyd-event for a given pane those fields read as null. Acceptable
 * trade — the web side renders nulls gracefully. Future-me should not
 * "fix" this by seeding from SQLite, because those values aren't
 * persisted there.
 */
export interface PaneState {
  cwd?: string;
  fg?: string | null;
  title?: string | null;
  attention?: boolean;
  // True while the pane is actively producing output (foreground app
  // working). Sourced from ptyd's `paneBusy` events; read synchronously by
  // the tab/workspace list handlers to roll a "busy" flag up to each tab.
  busy?: boolean;
  appUrls?: AppUrl[];
}

/**
 * Listens to PtydClient events and maintains a per-pane snapshot. Emits a
 * single 'paneChange' event after any field mutates so consumers (the main
 * server's `emitPaneUpdated` helper) can rebuild the decorated pane row in
 * one place.
 *
 * Lifecycle:
 *  - `paneCwd` / `paneFg` / `paneTitle` / `paneAttention` → upsert field,
 *    fire 'paneChange'.
 *  - `paneExit` → drop the entry entirely (no event — consumer will get a
 *    matching `pane.removed` from the route layer or react to `paneExit`
 *    on the client directly).
 *  - `connected` → seed `cwd` for every live runtime via `flushCwds()`.
 *    Other fields will populate as their respective events arrive.
 */
export class PtydCache extends EventEmitter {
  private state = new Map<string, PaneState>();
  // Non-null only while a `connected`-driven `flushCwds()` is inflight.
  // The paneCwd handler appends to it during that window; the connected
  // handler reads it after the snapshot resolves to skip ids that got a
  // fresher event mid-flight. Outside the window the field is null and
  // the paneCwd handler's `?.add` is a no-op — so the set never grows
  // beyond a single inflight flushCwds.
  private cwdEventRacers: Set<string> | null = null;
  // Server-side app-url detection. ptyd ships raw URL sightings
  // (`paneUrlsSeen`); the detector classifies hosts + probes for a listener
  // and writes the confirmed list back into the cache. It lives here so this
  // logic is a server-only restart away — never a ptyd bounce.
  private readonly detector = new AppUrlDetector((paneId, urls) => {
    this.update(paneId, { appUrls: urls });
  });

  attach(client: PtydClient): void {
    client.on('paneCwd', (e: { id: string; cwd: string }) => {
      this.cwdEventRacers?.add(e.id);
      this.update(e.id, { cwd: e.cwd });
    });
    client.on('paneFg', (e: { id: string; cmd: string | null }) => {
      this.update(e.id, { fg: e.cmd });
    });
    client.on('paneTitle', (e: { id: string; title: string | null }) => {
      this.update(e.id, { title: e.title });
    });
    client.on('paneAttention', (e: { id: string; attention: boolean }) => {
      this.update(e.id, { attention: e.attention });
    });
    client.on('paneBusy', (e: { id: string; busy: boolean }) => {
      this.update(e.id, { busy: e.busy });
    });
    client.on('paneUrlsSeen', (e: { id: string; urls: string[]; markers: AppUrlMarker[] }) => {
      // Raw sightings from ptyd's scanner. Hand them to the detector, which
      // probes/classifies and calls back (its onAppUrls) into update() with
      // the confirmed list once it changes.
      this.detector.ingest(e.id, e.urls, e.markers);
    });
    client.on('paneExit', (e: { id: string }) => {
      // Drop the entry on exit so a respawned pane (same id) starts with a
      // clean slate. If the row still exists (delete is a separate
      // operation) the next ensurePane will surface fresh events to
      // repopulate the cache.
      this.detector.forget(e.id);
      if (this.state.delete(e.id)) {
        this.emit('paneRemoved', e.id);
      }
    });
    client.on('connected', async () => {
      // Refresh cwds from the live ptyd snapshot. The cache is NOT cleared
      // on `disconnected` (other consumers still want the last-known cwd
      // while reconnect is in flight), and ptyd's `paneCwd` events only
      // fire on *change*. So on a clean reconnect we can't rely on events
      // alone to wash out stale values — we need to take a full snapshot.
      //
      // Race: between ptyd taking the snapshot and the response arriving
      // here, a `paneCwd` event may have already been broadcast with a
      // fresher value. We track ids that received paneCwd events during
      // the inflight window; for those ids the snapshot is stale and we
      // must NOT clobber the cache. For everyone else we overwrite (this
      // is the path that washes out pre-disconnect stale values).
      //
      // The racer set is scoped to this invocation — assigned to the
      // field for the paneCwd handler to populate, cleared in `finally`
      // so steady-state events don't accumulate ids forever.
      const racers = new Set<string>();
      this.cwdEventRacers = racers;
      try {
        const entries = await client.flushCwds();
        for (const { id, cwd } of entries) {
          if (racers.has(id)) continue;
          this.update(id, { cwd });
        }
      } catch {
        // ignore — cache will fill in via paneCwd events
      } finally {
        if (this.cwdEventRacers === racers) this.cwdEventRacers = null;
      }
    });
  }

  private update(id: string, patch: PaneState): void {
    const prev = this.state.get(id) ?? {};
    const next: PaneState = { ...prev };
    let changed = false;
    for (const k of Object.keys(patch) as (keyof PaneState)[]) {
      const v = patch[k];
      if (prev[k] !== v) {
        // The cast is necessary because each field has its own type; the
        // Object.keys loop loses that fidelity for the compiler.
        (next as Record<string, unknown>)[k] = v;
        changed = true;
      }
    }
    if (!changed) return;
    this.state.set(id, next);
    this.emit('paneChange', id);
  }

  /**
   * Pre-populate cwd for known panes before ptyd's `connected` → `flushCwds()`
   * has had a chance to fire. The main server calls this on startup with
   * the last-known cwd persisted in SQLite so cwd-dependent handlers don't
   * see null during the (small but real) window between HTTP-start and the
   * first ptyd reply. Entries for ids already in the cache are skipped —
   * a real event from ptyd is always more trustworthy than the stale seed.
   */
  seedCwds(entries: Array<{ id: string; cwd: string }>): void {
    for (const { id, cwd } of entries) {
      if (this.state.has(id)) continue;
      this.state.set(id, { cwd });
    }
  }

  /** Synchronous read — returns null when ptyd hasn't reported a cwd yet. */
  getCwd(id: string): string | null {
    return this.state.get(id)?.cwd ?? null;
  }

  /** Synchronous read — null when fg hasn't resolved or pane has no fg. */
  getFg(id: string): string | null {
    const s = this.state.get(id);
    if (!s || s.fg === undefined) return null;
    return s.fg;
  }

  /** Synchronous read — null when ptyd hasn't reported a title yet. */
  getTitle(id: string): string | null {
    const s = this.state.get(id);
    if (!s || s.title === undefined) return null;
    return s.title;
  }

  /** Synchronous read — false when ptyd hasn't reported attention. */
  getAttention(id: string): boolean {
    return this.state.get(id)?.attention ?? false;
  }

  /** Synchronous read — false when ptyd hasn't reported busy state yet. */
  getBusy(id: string): boolean {
    return this.state.get(id)?.busy ?? false;
  }

  /** Synchronous read — empty array when no app urls have been reported. */
  getAppUrls(id: string): AppUrl[] {
    return this.state.get(id)?.appUrls ?? [];
  }

  /** Returns the full snapshot for the given pane, or undefined when unknown. */
  get(id: string): PaneState | undefined {
    return this.state.get(id);
  }

  /** Drop the entry for `id`. Used by route handlers on DELETE /api/panes/:id. */
  forget(id: string): void {
    this.detector.forget(id);
    if (this.state.delete(id)) {
      this.emit('paneRemoved', id);
    }
  }
}
