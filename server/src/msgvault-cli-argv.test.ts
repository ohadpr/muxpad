import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MUXPAD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');

/** One top-level bash function, verbatim, from `name() {` to its closing `}`. */
function fn(name: string): string {
  const start = SRC.indexOf(`\n${name}() {`);
  if (start < 0) throw new Error(`no ${name} in scripts/muxpad`);
  const end = SRC.indexOf('\n}\n', start);
  return SRC.slice(start + 1, end + 3);
}

/**
 * Run `muxpad msgvault …` for real, with only the network stubbed: the
 * request the CLI would send is printed instead of sent. These assertions are
 * about the ARGV msgvault would receive, which is what broke — the source-text
 * tests in slack-cli.test.ts passed the whole time.
 */
function sent(...argv: string[]): { path: string; body: Record<string, unknown> } {
  const script = [
    'set -euo pipefail',
    'require_jq() { :; }',
    'slack_require_pane() { :; }',
    'msgvault_usage() { echo usage >&2; exit 1; }',
    'slack_call() { printf "%s %s\\n%s" "$1" "$2" "${3:-}"; }',
    'MUXPAD_PANE_ID=p MUXPAD_PANE_KEY=k',
    fn('msgvault_run_argv'),
    fn('cmd_msgvault'),
    'shift; cmd_msgvault "$@"', // drop the `msgvault` word, as main() does
  ].join('\n');
  const r = spawnSync('bash', ['-c', script, 'muxpad', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`exit ${r.status}: ${r.stderr}`);
  const [head, ...rest] = r.stdout.split('\n');
  const body = rest.join('\n');
  return { path: String(head), body: body.trim() ? JSON.parse(body) : {} };
}

/** cobra's rule: after `--`, every token is a positional. */
const positionals = (args: string[]) => {
  const i = args.indexOf('--');
  return i < 0 ? args.slice(1).filter((a) => !a.startsWith('-')) : args.slice(i + 1);
};

describe('muxpad msgvault <draft verb> hands msgvault argv it can parse', () => {
  it('draft-delete <id> --revision=N keeps the flag a FLAG', () => {
    // The shape the usage text documents, and the one a chat typed. It went
    // out as `draft-delete --json -- <id> --revision=1`; msgvault answered
    // "accepts 1 arg(s), received 2".
    const { path, body } = sent('msgvault', 'draft-delete', 'draft-abc', '--revision=1');
    expect(path).toBe('POST /api/msgvault/run');
    const args = body.args as string[];
    expect(positionals(args)).toEqual(['draft-abc']);
    expect(args).toContain('--revision=1');
    expect(args.at(-1)).toBe('draft-abc');
  });

  it('draft-edit <id> --body=… --revision=N: one positional, whatever the body says', () => {
    const { body } = sent(
      'msgvault',
      'draft-edit',
      'draft-abc',
      '--body=two words',
      '--revision=2',
    );
    const args = body.args as string[];
    expect(positionals(args)).toEqual(['draft-abc']);
    expect(args).toEqual([
      'draft-edit',
      '--json',
      '--body=two words',
      '--revision=2',
      '--',
      'draft-abc',
    ]);
  });

  it('flags before the id work too', () => {
    const { body } = sent('msgvault', 'draft-delete', '--revision=3', 'draft-abc');
    expect(body.args).toEqual(['draft-delete', '--json', '--revision=3', '--', 'draft-abc']);
  });

  it('draft-compose has no positional, so no `--` at all', () => {
    const { body } = sent('msgvault', 'draft-compose', '--to=a@b.co', '--subject=Hi', '--body=x');
    expect(body.args).toEqual([
      'draft-compose',
      '--json',
      '--to=a@b.co',
      '--subject=Hi',
      '--body=x',
    ]);
  });

  it('an explicit `--` from the caller still ends the flags', () => {
    const { body } = sent('msgvault', 'draft-delete', '--revision=1', '--', '-odd-id');
    expect(positionals(body.args as string[])).toEqual(['-odd-id']);
  });
});
