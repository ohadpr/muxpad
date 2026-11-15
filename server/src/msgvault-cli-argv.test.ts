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

/**
 * THE READS USED TO DROP WHAT THEY DID NOT RECOGNISE, WITHOUT A WORD.
 *
 * `search x --offset=50` answered page one again; `show-thread <id>
 * --offset=100` answered the same hundred messages. Nothing said the flag
 * was never sent. The typed shape still takes the typed route (it can ride a
 * read approval and needs nothing new from the broker); anything else goes
 * through the argv path, where msgvault's own `--help` accepts or refuses it
 * by name.
 */
describe('a read verb never silently drops a flag', () => {
  it('the plain typed shapes stay on their typed routes', () => {
    expect(sent('msgvault', 'search', 'from:a', '--limit=5').path).toMatch(
      /^GET \/api\/msgvault\/search\?.*q=from%3Aa&limit=5$/,
    );
    expect(sent('msgvault', 'search', '--limit=5', 'from:a').path).toMatch(/q=from%3Aa&limit=5$/);
    expect(sent('msgvault', 'show-message', '42').path).toMatch(/^GET \/api\/msgvault\/message\?/);
    expect(sent('msgvault', 'show-thread', '42').path).toMatch(/^GET \/api\/msgvault\/thread\?/);
    expect(sent('msgvault', 'draft-get', 'draft-abc').path).toBe('POST /api/msgvault/draft-get');
  });

  it('search with any other flag is sent as argv, query last', () => {
    const { path, body } = sent('msgvault', 'search', 'dinner plans', '--offset=50', '--limit=10');
    expect(path).toBe('POST /api/msgvault/run');
    expect(body.args).toEqual([
      'search',
      '--json',
      '--offset=50',
      '--limit=10',
      '--',
      'dinner plans',
    ]);
  });

  it('show-thread / show-message paging and options are sent, not dropped', () => {
    expect(sent('msgvault', 'show-thread', '42', '--offset=100').body.args).toEqual([
      'show-thread',
      '--json',
      '--offset=100',
      '--',
      '42',
    ]);
    expect(sent('msgvault', 'show-message', '42', '--strip-quoted').body.args).toEqual([
      'show-message',
      '--json',
      '--strip-quoted',
      '--',
      '42',
    ]);
  });

  it('draft-get --conversation=N reaches msgvault', () => {
    expect(sent('msgvault', 'draft-get', '--conversation=7').body.args).toEqual([
      'draft-get',
      '--json',
      '--conversation=7',
    ]);
  });

  it('stats refuses an option out loud instead of answering for everything', () => {
    expect(() => sent('msgvault', 'stats', '--collection=work')).toThrow(/stats takes no options/);
  });
});

/**
 * ── EVERY PATH THE CLI CAN CALL MUST MAP TO AN ACTION THE BROKER ACCEPTS ──
 *
 * The failure this exists for: a new verb is added to `cmd_msgvault`, it
 * calls `/api/msgvault/<something>`, and nobody adds the line to the
 * path→action `case` next to it. The CLI then asks the broker for an action
 * whose name is derived by the fallthrough rule, the broker answers
 * "Unsupported action", and the verb has never worked — exactly the shape of
 * the `--revision` and the owner-only-attachment-route bugs, both of which
 * shipped green.
 *
 * Source text rather than execution, deliberately: the point is to cover the
 * verbs whose happy path writes FILES and so cannot be driven by the stub
 * above. It is a weaker test than `sent()` and it catches the one thing
 * `sent()` structurally cannot.
 */
describe('msgvault CLI paths and broker actions agree', () => {
  const cmd = fn('cmd_msgvault');
  /** `/api/msgvault/<x>` literals the CLI builds, deduped. */
  const called = [
    ...new Set([...cmd.matchAll(/\/api\/msgvault\/([a-z-]+)/g)].map((m) => m[1])),
  ].sort();
  /** The path→action `case` arms, wherever they live in the script. */
  const mapped = new Map(
    [...SRC.matchAll(/\/api\/msgvault\/([a-z-]+)\) printf '(msgvault\.[a-z-]+)'/g)].map((m) => [
      m[1],
      m[2],
    ]),
  );

  it('maps every path it calls, or falls through to a real action name', () => {
    // Read as TEXT, not imported: broker/*.mjs ships no types, and the point
    // here is the names the two files agree on, which the text carries.
    const caps = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'broker', 'capabilities.mjs'),
      'utf8',
    );
    const actions = [...caps.matchAll(/'(msgvault\.[a-z-]+)'/g)].map((m) => m[1]);
    expect(called.length).toBeGreaterThan(5);
    for (const path of called) {
      // Unmapped is legal — the script's fallthrough is `msgvault.<last
      // path segment>` — but the NAME it produces still has to be real.
      const action = mapped.get(path) ?? `msgvault.${path}`;
      expect(actions, `${path} → ${action}`).toContain(action);
    }
  });

  it('calls the whole-message attachment action, not the per-file one', () => {
    expect(called).toContain('attachments');
    expect(mapped.get('attachments')).toBe('msgvault.export-attachments');
    expect(mapped.get('attachment')).toBe('msgvault.export-attachment');
  });
});

/**
 * ── THE ATTACHMENT WRITER, RUN FOR REAL ───────────────────────────────────
 *
 * Extracted and sourced rather than driven through the whole CLI, because the
 * happy path WRITES FILES and the stub above cannot. Three bugs an adversarial
 * review found here, all reproduced before they were fixed.
 */
describe('msgvault_save_attachment', () => {
  const script = (body: string) => {
    const fn = SRC.slice(SRC.indexOf('\nmsgvault_save_attachment() {') + 1);
    return spawnSync('bash', ['-c', `${fn.slice(0, fn.indexOf('\n}\n') + 3)}\n${body}`], {
      encoding: 'utf8',
    });
  };
  const seed = (dir: string) =>
    `mkdir -p ${dir}; printf x > ${dir}/src; H=$(shasum -a 256 ${dir}/src | cut -d' ' -f1); base64 -i ${dir}/src > ${dir}/b64;`;

  it('treats a bare relative --out as a FILE, not a missing directory', () => {
    // `${dest%/*}` on a path with no slash returns the path itself, so
    // `--out=report.pdf` was refused as "no such directory: report.pdf".
    const d = '/tmp/muxpad-save-rel';
    const r = script(
      `rm -rf ${d}; ${seed(d)} cd ${d} && msgvault_save_attachment b64 a.pdf report.pdf "$H"`,
    );
    expect(r.stderr).not.toMatch(/no such directory/);
    expect(r.stdout.trim()).toBe('report.pdf');
  });

  it('keeps BOTH of two attachments called image.png', () => {
    // One message can list several files with the same sender-chosen name.
    // The second was refused, so `attachments` reported failed:1 with nothing
    // to retry by hand.
    const d = '/tmp/muxpad-save-dup';
    const r = script(
      `rm -rf ${d}; ${seed(d)} msgvault_save_attachment ${d}/b64 image.png ${d}/ "$H"; msgvault_save_attachment ${d}/b64 image.png ${d}/ "$H"`,
    );
    expect(r.stdout.trim().split('\n')).toEqual([`${d}/image.png`, `${d}/image-2.png`]);
  });

  it('still refuses to overwrite a file the CALLER named', () => {
    // Renaming is right when WE chose the name from a directory. When the
    // caller spelled the path, writing somewhere else would be worse.
    const d = '/tmp/muxpad-save-exact';
    const r = script(
      `rm -rf ${d}; ${seed(d)} touch ${d}/exact.pdf; msgvault_save_attachment ${d}/b64 a.pdf ${d}/exact.pdf "$H"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/already exists/);
  });

  it('still refuses a directory that does not exist', () => {
    const d = '/tmp/muxpad-save-missing';
    const r = script(
      `rm -rf ${d}; ${seed(d)} msgvault_save_attachment ${d}/b64 a.pdf /tmp/nope/deeper/ "$H"`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/no such directory/);
  });

  it('still refuses bytes that do not match the hash', () => {
    const d = '/tmp/muxpad-save-hash';
    const r = script(
      `rm -rf ${d}; ${seed(d)} msgvault_save_attachment ${d}/b64 a.pdf ${d}/ ${'0'.repeat(64)}`,
    );
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/did not come back intact/);
  });
});
