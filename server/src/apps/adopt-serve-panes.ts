// One-shot adoption of the PRE-REGISTRY app servers.
//
// Before the app registry, the only way to keep a local web server alive was to
// run `muxpad serve` in a shell pane and leave that pane's TAB open forever.
// Two apps live like that on the real install — Notes
// (01KXAYH4EX12XDXJHB736XEFWQ) and Reader (01KXQGRMDY8XEQNPH6T1ZBFBP3) — each
// burning a permanent slot in the tab tree for something that is not a
// conversation and that the user only ever looks at through its web face.
//
// This hands them to the registry. It is deliberately the gentlest possible
// change:
//
//   · THE PANE IS NOT TOUCHED. Its id, its pty, its scrollback and its running
//     server all survive; only the tab's PARENT WORKSPACE changes, from the
//     user's visible one to the hidden apps container. The app never goes down,
//     which also means adoption is safe to run on a live machine.
//   · NOTHING IS DELETED. Not the pane, not the tab, not the workspace the tab
//     came out of (an emptied workspace is the user's to keep or remove — we do
//     not decide that for them).
//   · ANYTHING AMBIGUOUS IS LEFT ALONE, and says so in the log. A serve pane
//     sharing a tab with other panes, or one whose command we cannot parse, is
//     skipped rather than guessed at.
//   · RUNS ONCE, behind a `globals` marker. Without it, a user who deliberately
//     dragged an app's tab back into view would have it taken away again on
//     every boot.
import type Database from 'better-sqlite3';
import type { EventBus } from '../events.js';
import type { PtydCache } from '../ptyd-cache.js';
import { AppStore } from '../store/AppStore.js';
import { GlobalsStore } from '../store/GlobalsStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { APPS_WORKSPACE_KEY, APPS_WORKSPACE_NAME } from './AppRegistry.js';

/** One-shot marker. */
export const KEY_ADOPTED = 'serve_panes_adopted';

export interface AdoptResult {
  /** Slugs of the apps created. */
  adopted: string[];
  /** Human-readable trace — every decision, including every skip. */
  log: string[];
}

/**
 * Pull `--url`, `--label` and the wrapped command out of a `muxpad serve`
 * startup command.
 *
 * Hand-rolled rather than shell-parsed on purpose: this reads a string the
 * server itself wrote, and the only quoting it can contain is the single quotes
 * `appStartupCmd` adds. Anything it does not recognise returns null, which the
 * caller turns into "skipped, left alone" — never a guess.
 */
export function parseServeCommand(
  cmd: string | null,
): { url: string; label: string | null; command: string } | null {
  if (!cmd || !cmd.startsWith('muxpad serve')) return null;
  const rest = cmd.slice('muxpad serve'.length).trim();
  // Split on the first bare ` -- `, which `muxpad serve` documents as "the
  // command starts here".
  const sepAt = rest.indexOf(' -- ');
  if (sepAt < 0) return null;
  const flagPart = rest.slice(0, sepAt);
  const command = rest.slice(sepAt + 4).trim();
  if (!command) return null;

  const unquote = (v: string) =>
    (v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))
      ? v.slice(1, -1)
      : v;

  const readFlag = (name: string): string | null => {
    // `--name=value` (value may be quoted, and a quoted value may contain
    // spaces) …
    const eq = new RegExp(`--${name}=('[^']*'|"[^"]*"|\\S+)`).exec(flagPart);
    if (eq?.[1]) return unquote(eq[1]);
    // … or `--name value`.
    const sp = new RegExp(`--${name}\\s+('[^']*'|"[^"]*"|\\S+)`).exec(flagPart);
    if (sp?.[1]) return unquote(sp[1]);
    return null;
  };

  const url = readFlag('url');
  if (!url || !/^https?:\/\//.test(url)) return null;
  // The SAME gates routes/apps.ts applies, because adoption writes a registry
  // row without going through it. A url carrying a quote would later be
  // interpolated into `--url '<url>'` and escape its own quoting; a command
  // spanning lines would smuggle a second command past `muxpad serve` and out
  // of its supervision. Neither can happen by accident — the string came from
  // a `muxpad serve` line the user typed — but "we trust this row because of
  // where it came from" is exactly the assumption that stops being true.
  if (/['"\s\0]/.test(url)) return null;
  if (/[\n\r\0]/.test(command)) return null;
  return { url, label: readFlag('label'), command };
}

export function adoptServePanes(deps: {
  db: Database.Database;
  events?: EventBus | undefined;
  /** Unused today; accepted so the call site matches releaseResidentPane's. */
  cache?: PtydCache | undefined;
}): AdoptResult {
  const globals = new GlobalsStore(deps.db);
  const result: AdoptResult = { adopted: [], log: [] };
  if (globals.get(KEY_ADOPTED)) return result;

  const apps = new AppStore(deps.db);
  const panes = new PaneStore(deps.db);
  const tabs = new TabStore(deps.db);
  const workspaces = new WorkspaceStore(deps.db);

  // Resolve (or create) the hidden container the same way the registry does,
  // so adoption and `app add` can never end up with two containers.
  const savedContainer = globals.get(APPS_WORKSPACE_KEY);
  let containerId = savedContainer && workspaces.getById(savedContainer) ? savedContainer : null;

  const candidates = deps.db
    .prepare(
      "SELECT id FROM panes WHERE kind = 'shell' AND startup_cmd LIKE 'muxpad serve%' ORDER BY created_at",
    )
    .all() as Array<{ id: string }>;

  for (const { id } of candidates) {
    const pane = panes.getById(id);
    if (!pane) continue;
    const label = `pane ${id}`;

    if (apps.getByPane(id)) {
      result.log.push(`${label}: already an app — left alone`);
      continue;
    }
    const tab = tabs.getById(pane.tab_id);
    if (!tab) {
      result.log.push(`${label}: no tab row — left alone`);
      continue;
    }
    const fromWorkspaceId = tabs.getWorkspaceId(tab.id);
    const fromWorkspace = fromWorkspaceId ? workspaces.getById(fromWorkspaceId) : null;
    if (fromWorkspace?.hidden) {
      result.log.push(`${label}: already in a hidden container — left alone`);
      continue;
    }
    // A tab with more than this one pane is a MOSAIC the user built. Moving it
    // wholesale into the hidden container would take the other panes with it,
    // out of reach of every navigator. Not our call to make.
    const siblings = panes.listByTab(tab.id);
    if (siblings.length !== 1) {
      result.log.push(`${label}: its tab holds ${siblings.length} panes — ambiguous, left alone`);
      continue;
    }
    const parsed = parseServeCommand(pane.startup_cmd);
    if (!parsed) {
      result.log.push(`${label}: could not parse its serve command — left alone`);
      continue;
    }
    if (!pane.cwd) {
      result.log.push(`${label}: no recorded cwd — left alone`);
      continue;
    }

    const name = parsed.label?.trim() || pane.name?.trim() || tab.name;
    const base = AppStore.slugify(name) || AppStore.slugify(tab.name) || 'app';
    const slug = apps.uniqueSlug(base);

    // Create the container lazily — an install with nothing to adopt should not
    // grow a workspace it will never use.
    if (!containerId) {
      containerId = workspaces.createHidden({ name: APPS_WORKSPACE_NAME }).id;
      globals.set(APPS_WORKSPACE_KEY, containerId);
      result.log.push(`created the hidden apps container (${containerId})`);
    }

    // Row + move, together: an app row pointing at a tab still in the sidebar
    // (or a tab spirited away with no row to explain it) are both worse than
    // either half of the change.
    deps.db.transaction(() => {
      const created = apps.create({
        slug,
        name,
        cwd: pane.cwd as string,
        command: parsed.command,
        url: parsed.url,
        autostart: true,
        enabled: true,
      });
      apps.setPane(created.id, pane.id);
      // The ONE mutation to existing rows: the tab changes parent. The pane,
      // its pty and the running server are untouched — adoption never restarts
      // an app, so it is safe on a live machine.
      tabs.setWorkspace(tab.id, containerId as string);
    })();

    // Tell open clients the tab left their sidebar. There is deliberately no
    // matching `tab.added` for the container: nothing may learn that hidden
    // workspace exists.
    if (fromWorkspaceId) {
      deps.events?.emit({
        type: 'tab.removed',
        workspace_id: fromWorkspaceId,
        tab_id: tab.id,
      });
    }
    result.adopted.push(slug);
    result.log.push(
      `${label}: adopted as app '${slug}' (${parsed.url}) — its tab left ${fromWorkspace?.name ?? 'its workspace'}, still running`,
    );
  }

  globals.set(KEY_ADOPTED, '1');
  if (result.adopted.length === 0 && result.log.length === 0) {
    result.log.push('nothing to adopt');
  }
  return result;
}
