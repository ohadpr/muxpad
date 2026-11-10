import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MUXPAD = resolve(ROOT, 'scripts', 'muxpad');
const ROUTES = readFileSync(resolve(ROOT, 'server', 'src', 'routes', 'slack.ts'), 'utf8');

/**
 * THE CLI AND THE SERVER MUST NAME THE SAME ACTION.
 *
 * On a remote host the CLI declares what a call is for, and the host refuses
 * to sign an action its own caller did not ask for — which is what stops a
 * control plane that has been taken over from turning a `slack.channels` it
 * is relaying into a `slack.post`.
 *
 * A drift between the two tables would fail NOTHING at runtime. Every proof
 * would simply be refused, every connector call would ask for approval again,
 * and the symptom would be indistinguishable from having no key installed —
 * a feature that silently stops working is worse than one that breaks.
 */
/** The CLI's own function, lifted out and asked directly. A temp file rather
 *  than process substitution: `source <(…)` under `bash -c` defines nothing
 *  on the bash macOS ships, and the symptom is a test that cannot find the
 *  function it just extracted. */
const CLI = readFileSync(MUXPAD, 'utf8');
const fn = /^connector_action\(\) \{$[\s\S]*?^\}$/m.exec(CLI)?.[0] ?? '';
const SOURCED = join(mkdtempSync(join(tmpdir(), 'muxpad-ca-')), 'fn.sh');
writeFileSync(SOURCED, fn);

const ask = (path: string): string => {
  expect(fn, 'connector_action is missing from the CLI').toContain('case');
  return execFileSync('bash', ['-c', `. "$1"; connector_action "$2"`, '_', SOURCED, path], {
    encoding: 'utf8',
  }).trim();
};

describe('what the CLI declares is what the server asks the broker for', () => {
  it('names every Slack verb the way the route does', () => {
    // Each `app.<verb>('/x')` whose handler calls brokerAction('slack.x').
    const paths = [...ROUTES.matchAll(/app\.(get|post)\('\/([a-z-]+)'/g)].map((m) => m[2]);
    const actions = new Set(
      [...ROUTES.matchAll(/brokerAction\(\s*'(slack\.[a-z-]+)'/g)].map((m) => m[1]),
    );
    expect(actions.size, 'no slack actions found — the regex has rotted').toBeGreaterThan(5);
    for (const verb of paths) {
      const action = `slack.${verb}`;
      if (!actions.has(action)) continue; // /approvals, /requests, /token
      expect(ask(`/api/slack/${verb}`), verb).toBe(action);
    }
  });

  it('names every archive verb the way the route table does — including the two that differ', () => {
    // msgvault's PATHS are not its ACTIONS (`/message` → `show-message`),
    // which is exactly the kind of difference a second table gets wrong.
    const table = [...ROUTES.matchAll(/\['(\/[a-z-]+)',\s*'(msgvault\.[a-z-]+)'/g)].map(
      (m) => [m[1] as string, m[2] as string] as const,
    );
    expect(table.length, 'no archive routes found — the regex has rotted').toBeGreaterThan(3);
    for (const [path, action] of table) expect(ask(`/api/msgvault${path}`), path).toBe(action);
    // And the difference is real, not an accident of the test.
    expect(table.some(([p, a]) => `msgvault${p.replace('/', '.')}` !== a)).toBe(true);
  });

  it('names the two write verbs, whose paths are not in the read table', () => {
    // They are POST routes with a body, so they are declared by hand in
    // routes/slack.ts rather than in ARCHIVE_ROUTES — and a hand-written
    // route is exactly the kind that gets forgotten in the CLI's table.
    expect(ROUTES).toMatch(/brokerAction\(\s*'msgvault\.draft'/);
    expect(ROUTES).toMatch(/brokerAction\(\s*'msgvault\.draft-reply'/);
    expect(ask('/api/msgvault/draft')).toBe('msgvault.draft');
    expect(ask('/api/msgvault/draft-reply')).toBe('msgvault.draft-reply');
  });

  it('declares nothing for a path that is not a connector call', () => {
    for (const p of ['/api/tabs', '/api/panes/x', '/api/publish']) expect(ask(p)).toBe('');
  });

  it('ignores a query string rather than signing one', () => {
    expect(ask('/api/slack/channels?pane=P&key=K')).toBe('slack.channels');
  });
});
