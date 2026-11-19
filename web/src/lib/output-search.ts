import type { AppWithStatus, Artifact } from '@muxpad/shared';
import { isBrowserAppSlug } from '@muxpad/shared';
import { SCORE, findBest, nameScore } from './nav-search';

/**
 * THE THINGS YOU MADE, in the one search box.
 *
 * ⌘K finds chats and what was said in them. It did not find the OUTPUT of a
 * chat, so "where is the thing I made" had no answer but asking an agent to go
 * and look — and it got asked. The same family games portal was asked for
 * three times in five days, in two different chats: "Link to tom Romy game
 * portal", "link to home apps u know tom and romy and tom's creativity
 * studio", "Link to Tim and Romy games". Also "Link to radio web interface",
 * "Direct link to the Notes application", "link to portal".
 *
 * ── WHAT IS SEARCHED, AND WHY THE CWD IS IN THERE ───────────────────────────
 * Measured against the real registry, which is the only reason this is right:
 * that games portal is an app called `rail-rush-internal`, and its sibling is
 * `creativity-studio`. The words "tom" and "romy" appear in NEITHER the name
 * nor the slug. The one place they appear is the working directory —
 * `/Users/…/MyDev/2026/tom-romy-surfers`. A search over names alone would
 * answer the exact query that prompted this with nothing at all.
 *
 * So an app is searched by name, slug AND cwd, and the cwd is scored below the
 * other two: it is where the thing lives rather than what it is called, and a
 * path match should never outrank a name match. An artifact is searched by its
 * readable name and its slug — `Artifact.name` is the half of the slug a
 * person chose, the random suffix being there because the public host has no
 * index and no login.
 *
 * ── SEPARATORS DO NOT COUNT ─────────────────────────────────────────────────
 * Every field here is an IDENTIFIER — a slug, a path, an app name somebody
 * typed into `--name` — and the query is what a person says out loud. "Tom
 * Romy" has to find `tom-romy-surfers`, which is the literal request this
 * feature came from, so spaces, hyphens, underscores and slashes are
 * interchangeable (see `findBest`'s `loose`). Chat names keep the strict rule:
 * those are prose.
 *
 * ── WHERE IT CAME FROM ──────────────────────────────────────────────────────
 * Carried as a tab ID and resolved to a chat NAME by the caller, which
 * already holds the corpus to do it with. An artifact's origin was already on
 * record — the `publish:<slug>` chat action, i.e. the card in the conversation
 * that published it — so nothing new is stored for it. An app's needed one
 * column, because `muxpad app add` wrote no card.
 *
 * Nothing is backfilled, and the label is absent far more often than not. An
 * origin inferred from a timestamp would be a wrong chat stated confidently.
 *
 * ── MUXPAD'S OWN PLUMBING IS NOT A THING YOU MADE ───────────────────────────
 * 13 of the 36 apps on this machine are browser hosts muxpad registered for
 * itself — `browser · default`, `browser · shots`,
 * `browser · perf-chat-open`, one per profile ever used. They are real apps
 * and they belong on the Apps PAGE, which is an inventory. They do not belong
 * in a search for something you made, and measured against the real registry
 * they dominate it: "browser" returns 13 results and nothing else, and
 * "chat", "test", "default", "shots" and "perf" each return one of these and
 * nothing of the user's.
 *
 * Worse than noise, pressing Enter on one navigates into an internal CDP
 * host. Recognised by the slug prefix the server mints them with
 * (`BROWSER_APP_SLUG_PREFIX`), which is the one rule that defines them.
 *
 * ── WHAT IS NOT HERE ────────────────────────────────────────────────────────
 * Filters by workspace and type. The tier is capped at five rows under the
 * chats; a filter UI belongs on the Artifacts and Apps pages, which have the
 * room for it.
 */
export type OutputKind = 'app' | 'artifact';

export interface SearchableOutput {
  kind: OutputKind;
  /** Stable handle: the app's or artifact's slug. Also the row key. */
  slug: string;
  /** What to call it. An app's `name`, an artifact's readable slug half. */
  title: string;
  /** Where it serves or is published, or null for an artifact with no public
   *  base resolved yet. */
  url: string | null;
  /** An artifact is on the open internet; an app answers on the tailnet only.
   *  The one label that must never be guessed from the title. */
  isPublic: boolean;
  /** An app's measured state, for the dot. Absent on artifacts, which have no
   *  process to be up or down. */
  state?: AppWithStatus['state'] | undefined;
  /** The link has lapsed. The bytes are still there — `muxpad publish
   *  --extend` revives it — so this is a label, not a reason to hide the row. */
  expired?: boolean | undefined;
  /** Only for the cwd match below; never shown. */
  cwd?: string | undefined;
  /**
   * The chat that made it, when the record says so — an app's `origin_tab`,
   * an artifact's `publish:<slug>` chat action. A tab ID, resolved to a NAME
   * by the caller against the corpus it already holds, because this module
   * must not need a second one.
   *
   * Null is the common case and not a defect: anything made from an ordinary
   * shell has no origin, and nothing was backfilled for what came before.
   */
  originTab?: string | undefined;
}

/** Which field the query hit. Decides where the highlight is painted, and —
 *  for `cwd` — that it is not painted at all, since the path is not on screen. */
export type OutputField = 'title' | 'slug' | 'cwd';

export interface OutputMatch {
  output: SearchableOutput;
  field: OutputField;
  range?: readonly [number, number] | undefined;
  score: number;
}

/** A tier under the chats, so it can never push one off the top of the list. */
export const MAX_OUTPUT_RESULTS = 5;

/** Below `nameSubstring` (140) so the weakest title match still beats the
 *  strongest slug match, and below THAT for a path. Same 20-wide banding as
 *  nav-search's: a boost can only win a tie inside its own band. */
const SLUG_SCORE = 120;
const CWD_SCORE = 60;

export function toSearchableOutputs(
  apps: readonly AppWithStatus[],
  artifacts: readonly Artifact[],
): SearchableOutput[] {
  const out: SearchableOutput[] = [];
  for (const a of apps) {
    if (isBrowserAppSlug(a.slug)) continue;
    out.push({
      kind: 'app',
      slug: a.slug,
      title: a.name,
      url: a.url,
      isPublic: false,
      state: a.state,
      cwd: a.cwd,
      ...(a.origin_tab ? { originTab: a.origin_tab } : {}),
    });
  }
  for (const a of artifacts) {
    out.push({
      kind: 'artifact',
      slug: a.slug,
      title: a.name,
      url: a.url,
      isPublic: true,
      expired: a.expired,
      ...(a.origin_tab ? { originTab: a.origin_tab } : {}),
    });
  }
  return out;
}

export function rankOutputs(
  outputs: readonly SearchableOutput[],
  query: string,
  opts?: { limit?: number },
): OutputMatch[] {
  const q = query.trim();
  if (!q) return [];
  const limit = opts?.limit ?? MAX_OUTPUT_RESULTS;
  const matches: OutputMatch[] = [];
  for (const output of outputs) {
    const onTitle = findBest(output.title, q, { loose: true });
    if (onTitle) {
      matches.push({
        output,
        field: 'title',
        range: onTitle.range,
        score: nameScore(onTitle.kind),
      });
      continue;
    }
    const onSlug = findBest(output.slug, q, { loose: true });
    if (onSlug) {
      matches.push({ output, field: 'slug', range: onSlug.range, score: SLUG_SCORE });
      continue;
    }
    // NO RANGE for a cwd hit: the path is not rendered, so an offset into it
    // would be painted onto whichever string happened to be in that slot.
    if (output.cwd && findBest(output.cwd, q, { loose: true })) {
      matches.push({ output, field: 'cwd', score: CWD_SCORE });
    }
  }
  matches.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score;
    // A RUNNING app before a stopped one, and a LIVE link before a lapsed one:
    // between two equally good matches, the one you can open now is the one
    // you meant. Beyond that, title then slug, so the order is total and two
    // renders of the same data cannot disagree.
    const reach = Number(unreachable(a.output)) - Number(unreachable(b.output));
    if (reach !== 0) return reach;
    const byTitle = a.output.title.localeCompare(b.output.title);
    if (byTitle !== 0) return byTitle;
    return a.output.slug < b.output.slug ? -1 : a.output.slug > b.output.slug ? 1 : 0;
  });
  return matches.slice(0, limit);
}

/** "Pressing Enter on this will not show me the thing." */
function unreachable(o: SearchableOutput): boolean {
  if (o.kind === 'artifact') return o.expired === true || !o.url;
  // The five app states are stopped / starting / running / unreachable /
  // gave_up. `starting` counts as reachable: it is on its way up, and demoting
  // it would reorder the list under you as it settles.
  return o.state === 'stopped' || o.state === 'unreachable' || o.state === 'gave_up';
}
