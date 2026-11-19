import type { AppWithStatus, Artifact } from '@muxpad/shared';
import { describe, expect, it } from 'vitest';
import {
  MAX_OUTPUT_RESULTS,
  type SearchableOutput,
  rankOutputs,
  toSearchableOutputs,
} from './output-search';

/**
 * Ranking the things you MADE. The cases that matter here are not synthetic:
 * they come from the registry on this machine and from the three requests that
 * prompted the feature.
 */
const app = (over: Partial<AppWithStatus> & { slug: string }): AppWithStatus =>
  ({
    id: `app-${over.slug}`,
    name: over.slug,
    cwd: '/tmp',
    command: './start',
    url: 'http://127.0.0.1:1234',
    autostart: false,
    enabled: true,
    pane_id: null,
    created_at: 1,
    updated_at: 1,
    state: 'running',
    pty: true,
    health: null,
    ...over,
  }) as AppWithStatus;

const artifact = (over: Partial<Artifact> & { slug: string; name: string }): Artifact =>
  ({
    files: 1,
    bytes: 10,
    created: 1,
    expires: null,
    expired: false,
    url: `https://pub.example/${over.slug}/`,
    versions: [],
    ...over,
  }) as Artifact;

const titles = (rows: ReturnType<typeof rankOutputs>) => rows.map((r) => r.output.title);

describe('rankOutputs', () => {
  it('finds an app by the words in its FOLDER — the query that prompted this', () => {
    // The real row: the family games portal is `rail-rush-internal`, and
    // "tom" and "romy" appear in neither its name nor its slug. The one place
    // they appear is the working directory. Asked for three times in five
    // days ("Link to tom Romy game portal"), and a search over names alone
    // answers it with nothing.
    const outputs = toSearchableOutputs(
      [
        app({
          slug: 'rail-rush-internal',
          name: 'rail-rush-internal',
          cwd: '/Users/me/MyDev/2026/tom-romy-surfers/dist-internal',
        }),
        app({ slug: 'notes', name: 'Notes', cwd: '/Users/me/notes' }),
      ],
      [],
    );
    expect(titles(rankOutputs(outputs, 'tom romy'))).toEqual(['rail-rush-internal']);
    expect(rankOutputs(outputs, 'tom romy')[0]?.field).toBe('cwd');
  });

  it('never lets a folder match outrank a name match', () => {
    // The path is where a thing lives, not what it is called. A row that
    // matched only its directory must sit under one that matched its name,
    // or searching "notes" hands you whatever happens to live in ~/notes.
    const outputs = toSearchableOutputs(
      [
        app({ slug: 'other', name: 'Other', cwd: '/Users/me/notes/scratch' }),
        app({ slug: 'notes', name: 'Notes', cwd: '/srv/app' }),
      ],
      [],
    );
    expect(titles(rankOutputs(outputs, 'notes'))).toEqual(['Notes', 'Other']);
  });

  it('ranks a name match over a slug match', () => {
    const outputs = toSearchableOutputs(
      [
        app({ slug: 'reader-archive', name: 'Archive box', cwd: '/a' }),
        app({ slug: 'x1', name: 'Reader', cwd: '/b' }),
      ],
      [],
    );
    expect(titles(rankOutputs(outputs, 'reader'))).toEqual(['Reader', 'Archive box']);
  });

  it('finds an artifact by the half of the slug a person chose', () => {
    // Every slug carries eight random characters because the public host has
    // no index and no login. Nobody remembers them, so the readable half is
    // what has to match.
    const outputs = toSearchableOutputs(
      [],
      [artifact({ slug: 'muxpad-sidebar-evidence-gwdgbm8a', name: 'muxpad-sidebar-evidence' })],
    );
    expect(titles(rankOutputs(outputs, 'sidebar'))).toEqual(['muxpad-sidebar-evidence']);
  });

  it('returns nothing for an empty or whitespace query', () => {
    const outputs = toSearchableOutputs([app({ slug: 'notes' })], []);
    expect(rankOutputs(outputs, '')).toEqual([]);
    expect(rankOutputs(outputs, '   ')).toEqual([]);
  });

  it('returns nothing for a query that is ONLY separators', () => {
    // " - " loosens to "one or more separators", which would otherwise match
    // every path on the machine.
    const outputs = toSearchableOutputs([app({ slug: 'notes', cwd: '/srv/a-b' })], []);
    expect(rankOutputs(outputs, ' - ')).toEqual([]);
    expect(rankOutputs(outputs, '/')).toEqual([]);
  });

  it('treats a space, a hyphen and an underscore as the same separator', () => {
    // Both directions: typed loose against a hyphenated slug, and typed
    // hyphenated against a spaced name.
    const outputs = toSearchableOutputs(
      [app({ slug: 'creativity-studio', name: 'creativity-studio', cwd: '/a' })],
      [artifact({ slug: 'home-apps-aaaaaaaa', name: 'home apps' })],
    );
    expect(titles(rankOutputs(outputs, 'creativity studio'))).toEqual(['creativity-studio']);
    expect(titles(rankOutputs(outputs, 'creativity_studio'))).toEqual(['creativity-studio']);
    expect(titles(rankOutputs(outputs, 'home-apps'))).toEqual(['home apps']);
  });

  it('does not let the loosening turn a query into a wildcard', () => {
    // The WORDS stay literal; only the gaps between them are flexible.
    const outputs = toSearchableOutputs([app({ slug: 'notes', name: 'Notes', cwd: '/a' })], []);
    expect(rankOutputs(outputs, 'no.es')).toEqual([]);
    expect(rankOutputs(outputs, 'n.*s')).toEqual([]);
  });

  it('puts what you can open NOW above what you cannot, at equal match', () => {
    // Between two equally good matches, the one that will actually show you
    // the thing is the one you meant.
    const outputs = toSearchableOutputs(
      [
        app({ slug: 'radio-old', name: 'radio', state: 'stopped', cwd: '/a' }),
        app({ slug: 'radio-new', name: 'radio', state: 'running', cwd: '/b' }),
      ],
      [],
    );
    expect(rankOutputs(outputs, 'radio').map((r) => r.output.slug)).toEqual([
      'radio-new',
      'radio-old',
    ]);
  });

  it('counts a STARTING app as reachable — it is on its way up', () => {
    // Demoting it would reorder the list under the cursor as it settles.
    const outputs = toSearchableOutputs(
      [
        app({ slug: 'a-run', name: 'radio', state: 'running', cwd: '/a' }),
        app({ slug: 'b-start', name: 'radio', state: 'starting', cwd: '/b' }),
      ],
      [],
    );
    // Equal on reachability, so the total tiebreak (title, then slug) decides.
    expect(rankOutputs(outputs, 'radio').map((r) => r.output.slug)).toEqual(['a-run', 'b-start']);
  });

  it('keeps an EXPIRED artifact in the list, below a live one', () => {
    // The bytes are still there and `muxpad publish --extend` revives the
    // link, so hiding the row would tell somebody their artifact is gone when
    // it is not.
    const outputs = toSearchableOutputs(
      [],
      [
        artifact({ slug: 'report-aaaaaaaa', name: 'report', expired: true }),
        artifact({ slug: 'report-bbbbbbbb', name: 'report', expired: false }),
      ],
    );
    const rows = rankOutputs(outputs, 'report');
    expect(rows.map((r) => r.output.slug)).toEqual(['report-bbbbbbbb', 'report-aaaaaaaa']);
    expect(rows[1]?.output.expired).toBe(true);
  });

  it('carries NO highlight range for a folder match', () => {
    // The path is never rendered, so an offset into it would be painted onto
    // whichever string occupied that slot.
    const outputs = toSearchableOutputs([app({ slug: 'x', name: 'X', cwd: '/srv/tom-romy' })], []);
    expect(rankOutputs(outputs, 'romy')[0]?.range).toBeUndefined();
  });

  it('caps the tier so it cannot push the chats off the top', () => {
    const many = Array.from({ length: MAX_OUTPUT_RESULTS + 4 }, (_, i) =>
      app({ slug: `site-${i}`, name: `site ${i}`, cwd: '/a' }),
    );
    expect(rankOutputs(toSearchableOutputs(many, []), 'site')).toHaveLength(MAX_OUTPUT_RESULTS);
  });

  it('is a total order, so two renders of the same data agree', () => {
    const rows: SearchableOutput[] = [
      { kind: 'app', slug: 'b', title: 'same', url: null, isPublic: false, state: 'running' },
      { kind: 'app', slug: 'a', title: 'same', url: null, isPublic: false, state: 'running' },
    ];
    expect(rankOutputs(rows, 'same').map((r) => r.output.slug)).toEqual(['a', 'b']);
    expect(rankOutputs([...rows].reverse(), 'same').map((r) => r.output.slug)).toEqual(['a', 'b']);
  });
});

describe('toSearchableOutputs', () => {
  it('marks an artifact public and an app tailnet-only — the label a title cannot imply', () => {
    const rows = toSearchableOutputs(
      [app({ slug: 'notes' })],
      [artifact({ slug: 'r-aaaaaaaa', name: 'r' })],
    );
    expect(rows.find((r) => r.kind === 'app')?.isPublic).toBe(false);
    expect(rows.find((r) => r.kind === 'artifact')?.isPublic).toBe(true);
  });

  it('does not expose an app’s folder as something to display', () => {
    // It is matched and never rendered; it is on the row only for `rankOutputs`.
    const rows = toSearchableOutputs([app({ slug: 'notes', cwd: '/srv/secret-place' })], []);
    expect(rows[0]?.cwd).toBe('/srv/secret-place');
    expect(rows[0]?.title).toBe('notes');
  });
});
