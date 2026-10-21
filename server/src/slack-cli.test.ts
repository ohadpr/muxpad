import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MUXPAD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');
/** Code only. Half of this file's job is proving an absence, and a comment
 *  explaining why something is absent names the thing — which is how an
 *  earlier version of these assertions failed against a correct script. */
const CODE = SRC.split('\n')
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

/**
 * THE CLI HOLDS NO CREDENTIAL, AND MAKES NO CLAIM ABOUT WHO IT IS.
 *
 * It used to do both, and both were the same mistake — trusting the caller:
 *
 *   · it SOURCED ~/.claude/secrets/slack.env. A chat that was refused could
 *     read the token out of that file and curl Slack directly, so the
 *     workspace check only ever stopped an agent that wanted to be stopped;
 *   · it identified itself with $MUXPAD_PANE_ID, which the caller sets.
 *     `MUXPAD_PANE_ID=<a work pane> muxpad slack post …` from a personal chat
 *     went straight through. The test suite at the time asserted that
 *     $MUXPAD_WORKSPACE_ID could not be spoofed — the variable that was no
 *     longer being read — and said nothing about the one that was.
 *
 * These assertions are about ABSENCE for that reason. A behavioural test
 * passes just as happily with a token-reading fallback sitting unused beside
 * the new path, and an unused fallback is one bug away from being used.
 */
describe('the Slack CLI reads no credential', () => {
  it('names no Slack token variable at all', () => {
    expect(CODE).not.toMatch(/SLACK_USER_TOKEN|SLACK_BOT_TOKEN/);
  });

  it('names no secrets file', () => {
    expect(CODE).not.toMatch(/SLACK_SECRETS|secrets\/slack\.env/);
  });

  it('never sources anything', () => {
    // `set -a; . "$FILE"` was the mechanism. Nothing in this script should
    // dot-source a file now, Slack or otherwise.
    expect(CODE).not.toMatch(/^\s*\.\s+["$]/m);
  });

  it('never talks to slack.com', () => {
    expect(CODE).not.toContain('slack.com/api');
  });
});

describe('the Slack CLI cannot simply assert which pane it is', () => {
  it('presents the key beside the id, never the id alone', () => {
    // The id is a value any caller can set — that was the hole. The key is
    // one the server minted for THIS pane and put in its spawn environment.
    for (const verb of ['read', 'search', 'post', 'unpost', 'channels']) {
      const body = CODE.slice(CODE.indexOf(`cmd_slack_${verb}() {`));
      const fn = body.slice(0, body.indexOf('\n}\n'));
      expect(fn, verb).toContain('MUXPAD_PANE_KEY');
    }
  });

  it('fails closed, with instructions, when the pane has no key', () => {
    // Panes older than the feature have none and cannot be given one while
    // running. "Restart this pane" is the only useful thing to say.
    const body = CODE.slice(CODE.indexOf('slack_ident() {'));
    const fn = body.slice(0, body.indexOf('\n}\n'));
    expect(fn).toContain('MUXPAD_PANE_KEY');
    expect(fn).toMatch(/exit 1/);
    expect(SRC).toMatch(/Restart this pane, or open a new/);
  });

  it('uses the server-issued alias when the shell filters KEY names, still failing closed without proof', () => {
    const start = SRC.indexOf('slack_ident() {');
    const fn = SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
    const run = (proof: string) =>
      spawnSync(
        'bash',
        [
          '-c',
          `${fn}\nunset MUXPAD_PANE_KEY\nMUXPAD_PANE_ID=pane\nMUXPAD_PANE_PROOF="$1"\nslack_ident\n[ "$MUXPAD_PANE_KEY" = "$1" ]`,
          'test',
          proof,
        ],
        { encoding: 'utf8' },
      );
    expect(run('fake-pane-proof').status).toBe(0);
    expect(run('').status).toBe(1);
  });

  it('never sends the workspace id — that is the caller grading its own paper', () => {
    const section = CODE.slice(CODE.indexOf('slack_ident()'), CODE.indexOf('cmd_slack() {'));
    expect(section).not.toContain('MUXPAD_WORKSPACE_ID');
  });
});

describe('one identity, and the disclosure is not ours to forget', () => {
  it('offers no way to ask for a bot', () => {
    expect(SRC).not.toContain('--as-bot');
  });

  it('does not add the robot prefix here', () => {
    // The server does it. This script is no longer the only thing that can
    // post, so a prefix applied by each caller is a prefix that will be
    // missing from whichever caller is written next.
    const post = CODE.slice(CODE.indexOf('cmd_slack_post() {'));
    expect(post.slice(0, post.indexOf('\n}\n'))).not.toContain('🤖');
  });

  it('keeps the ts, because it is the only undo handle', () => {
    const post = CODE.slice(CODE.indexOf('cmd_slack_post() {'));
    expect(post).toContain('muxpad slack unpost');
  });
});

describe('broker CLI outcomes', () => {
  const start = SRC.indexOf('slack_call() {');
  const end = SRC.indexOf('\n}\n', start) + 3;
  const fn = SRC.slice(start, end);
  const invoke = (outcome: string) =>
    spawnSync(
      'bash',
      [
        '-c',
        `
    require_jq() { :; }
    sleep() { :; }
    curl() {
      local target='' item previous=''
      for item in "$@"; do
        [ "$previous" = '-o' ] && target="$item"
        previous="$item"
      done
      if [[ "$*" == *'/api/slack/requests/'* ]]; then
        printf '%s' '{"id":"request","state":"${outcome}","result":{"channel":"C123","ts":"123.45"}}' > "$target"
        printf 200
      else
        printf '%s' '{"id":"request","state":"pending","approval_url":"https://broker.test/approve/request"}' > "$target"
        printf 202
      fi
    }
    MUXPAD_API_URL=http://example.invalid MUXPAD_PANE_ID=pane MUXPAD_PANE_KEY=test
    ${fn}
    slack_call POST /api/slack/post '{}'
  `,
      ],
      { encoding: 'utf8' },
    );

  it('waits silently for approval and returns only the completed result', () => {
    const result = invoke('complete');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stderr).not.toContain('https://broker.test/approve/request');
    expect(JSON.parse(result.stdout)).toEqual({ channel: 'C123', ts: '123.45' });
  });

  for (const outcome of ['rejected', 'expired', 'failed']) {
    it(`does not report success for ${outcome}`, () => {
      const result = invoke(outcome);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain(outcome);
    });
  }
});

describe('approval-controlled exact channel-name resolution', () => {
  const extract = (name: string) => {
    const start = SRC.indexOf(`${name}() {`);
    return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  };
  const invokeName = (ref: string, listing: string, lookupExit = 0) =>
    spawnSync('/bin/bash', ['-s', '--', ref], {
      input: `set -euo pipefail
MUXPAD_PANE_ID=pane-test
MUXPAD_PANE_KEY=key-test
slack_require_pane() { :; }
reset_flags() { :; }
parse_flags() { :; }
slack_call() {
 if [[ "$2" == /api/slack/channels* ]]; then
  printf 'LOOKUP %s\\n' "$2" >&2
  printf '%s' "$LISTING"
  return "$LOOKUP_EXIT"
 fi
 printf 'POST %s\\n' "$3" >&2
 printf '%s' '{"channel":"C123","ts":"1.2"}'
}
${extract('slack_resolve_ref')}
${extract('cmd_slack_post')}
cmd_slack_post "$1" 'literal message $() <script>'
`,
      env: { ...process.env, LISTING: listing, LOOKUP_EXIT: String(lookupExit) },
      encoding: 'utf8',
    });
  it('resolves one exact name through authenticated broker listing before posting the canonical ID', () => {
    const r = invokeName(
      '#test-ohad',
      JSON.stringify({
        channels: [
          { id: 'C123', name: 'test-ohad' },
          { id: 'C999', name: 'test-ohad-other' },
        ],
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain('LOOKUP /api/slack/channels?pane=pane-test&key=key-test');
    const body = JSON.parse(r.stderr.split('POST ')[1]!.trim());
    expect(body).toEqual({
      pane: 'pane-test',
      key: 'key-test',
      ref: 'C123',
      text: 'literal message $() <script>',
    });
    expect(r.stderr.match(/LOOKUP /g)).toHaveLength(1);
    expect(r.stderr.match(/POST /g)).toHaveLength(1);
  });
  it('accepts a bare exact channel name using the same approved lookup', () => {
    const r = invokeName('test-ohad', '{"channels":[{"id":"C123","name":"test-ohad"}]}');
    expect(r.status).toBe(0);
    expect(r.stderr.match(/LOOKUP /g)).toHaveLength(1);
    expect(JSON.parse(r.stderr.split('POST ')[1]!.trim()).ref).toBe('C123');
  });
  it('keeps direct IDs on the existing no-lookup path', () => {
    const r = invokeName('C123', 'invalid');
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('LOOKUP');
    expect(r.stderr).toContain('POST');
  });
  it.each([
    ['missing', '#test-ohad', '{"channels":[]}'],
    [
      'ambiguous',
      '#test-ohad',
      '{"channels":[{"id":"C123","name":"test-ohad"},{"id":"C456","name":"test-ohad"}]}',
    ],
    ['invalid canonical ID', '#test-ohad', '{"channels":[{"id":"#other","name":"test-ohad"}]}'],
    ['malformed listing', '#test-ohad', '{"channels":null}'],
    ['unsupported user', '@ohad', '{"channels":[]}'],
  ])('submits no post for %s', (_label, ref, listing) => {
    const r = invokeName(ref, listing);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('POST ');
    expect((r.stderr.match(/LOOKUP /g) ?? []).length).toBeLessThanOrEqual(1);
  });
  it.each(['#TEST-ohad', '#test-OHAD'])(
    'rejects noncanonical name case %s before lookup or action',
    (ref) => {
      const r = invokeName(ref, '{"channels":[{"id":"C123","name":"test-ohad"}]}');
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toContain('LOOKUP ');
      expect(r.stderr).not.toContain('POST ');
    },
  );
  it('does not case-fold a returned name into an exact-match destination', () => {
    const r = invokeName('#test-ohad', '{"channels":[{"id":"C123","name":"TEST-OHAD"}]}');
    expect(r.status).not.toBe(0);
    expect(r.stderr.match(/LOOKUP /g)).toHaveLength(1);
    expect(r.stderr).not.toContain('POST ');
  });
  it('does not use a plausible response or retry after failed/uncertain lookup', () => {
    const r = invokeName('#test-ohad', '{"channels":[{"id":"C123","name":"test-ohad"}]}', 1);
    expect(r.status).not.toBe(0);
    expect(r.stderr).not.toContain('POST ');
    expect(r.stderr.match(/LOOKUP /g)).toHaveLength(1);
  });
});

describe('composed approved listing then canonical action', () => {
  const extract = (name: string) => {
    const start = SRC.indexOf(`${name}() {`);
    return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  };
  const run = (verb: 'post' | 'read', decision: 'complete' | 'rejected') =>
    spawnSync('/bin/bash', ['-s', '--', verb], {
      input: `set -euo pipefail
MUXPAD_API_URL=http://mock.invalid
MUXPAD_PANE_ID=pane-test
MUXPAD_PANE_KEY=key-test
require_jq() { :; }
slack_require_pane() { :; }
reset_flags() { :; }
parse_flags() { :; }
sleep() { :; }
curl() {
 local out='' url=''
 while [[ $# -gt 0 ]]; do
  case "$1" in
   -o) out="$2"; shift 2 ;;
   -w|-X|-H|--data) shift 2 ;;
   http*) url="$1"; shift ;;
   *) shift ;;
  esac
 done
 printf 'CALL %s\\n' "$url" >&2
 case "$url" in
  */channels?*) printf '%s' '{"id":"11111111-1111-4111-8111-111111111111","state":"pending","approval_url":"https://broker.test/review"}' > "$out"; printf 202 ;;
  */requests/*)
   if [[ "$DECISION" == complete ]]; then printf '%s' '{"state":"complete","result":{"channels":[{"id":"C123","name":"test-ohad"}]}}' > "$out"
   else printf '%s' '{"state":"rejected"}' > "$out"; fi
   printf 200 ;;
  */post) printf '%s' '{"id":"22222222-2222-4222-8222-222222222222","state":"complete","result":{"channel":"C123","ts":"1.2"}}' > "$out"; printf 202 ;;
  */read?*) printf '%s' '{"id":"22222222-2222-4222-8222-222222222222","state":"complete","result":{"messages":[]}}' > "$out"; printf 202 ;;
  *) return 9 ;;
 esac
}
${extract('slack_call')}
${extract('slack_resolve_ref')}
${extract('cmd_slack_post')}
${extract('cmd_slack_read')}
if [[ "$1" == post ]]; then cmd_slack_post '#test-ohad' 'literal message'; else cmd_slack_read '#test-ohad'; fi
`,
      env: { ...process.env, DECISION: decision },
      encoding: 'utf8',
    });
  it.each(['post', 'read'] as const)(
    'waits for successful listing approval before %s and uses canonical ID',
    (verb) => {
      const r = run(verb, 'complete');
      expect(r.status).toBe(0);
      const calls = r.stderr.split('\n').filter((l) => l.startsWith('CALL '));
      expect(calls).toHaveLength(3);
      expect(calls[0]).toContain('/channels?pane=pane-test&key=key-test');
      expect(calls[1]).toContain('/requests/11111111-1111-4111-8111-111111111111');
      expect(calls[2]).toContain(`/api/slack/${verb}`);
      if (verb === 'read') expect(calls[2]).toContain('ref=C123');
    },
  );
  it.each(['post', 'read'] as const)(
    'never submits %s after rejected listing and does not retry',
    (verb) => {
      const r = run(verb, 'rejected');
      expect(r.status).not.toBe(0);
      const calls = r.stderr.split('\n').filter((l) => l.startsWith('CALL '));
      expect(calls).toHaveLength(2);
      expect(calls.some((l) => l.includes(`/api/slack/${verb}`))).toBe(false);
    },
  );
});

describe('expanded Slack commands use protected requests', () => {
  const extract = (name: string) => {
    const start = SRC.indexOf(`${name}() {`);
    return SRC.slice(start, SRC.indexOf('\n}\n', start) + 3);
  };
  it('resolves @username then opens only the returned DM ID, with no post after lookup rejection', () => {
    const run = (reject: boolean) =>
      spawnSync('/bin/bash', ['-s'], {
        encoding: 'utf8',
        input: `set -euo pipefail
MUXPAD_PANE_ID=pane
MUXPAD_PANE_KEY=proof
slack_call() {
 printf 'CALL %s\\n' "$2" >&2
 case "$2" in
 /api/slack/users*) ${reject ? 'return 1' : `printf '%s' '{"user":{"id":"U123"}}'`} ;;
 /api/slack/dm) printf '%s' '{"channel":"D123"}'; printf '%s\\n' "$3" >&2 ;;
 *) return 9 ;;
 esac
}
${extract('slack_resolve_ref')}
slack_resolve_ref '@alona'
`,
      });
    const good = run(false);
    expect(good.status).toBe(0);
    expect(good.stdout.trim()).toBe('D123');
    expect(good.stderr).toContain('"user":"U123"');
    const bad = run(true);
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).not.toContain('/api/slack/dm');
  });
  it.each([
    ['cmd_slack_thread', ['C123', '1.2'], '/api/slack/thread?', undefined],
    [
      'cmd_slack_react',
      ['C123', '1.2', ':eyes:', '--remove'],
      '/api/slack/react',
      { name: 'eyes', operation: 'remove', ts: '1.2', ref: 'C123' },
    ],
    [
      'cmd_slack_edit',
      ['C123', '1.2', 'literal $() & "hello"'],
      '/api/slack/edit',
      { text: 'literal $() & "hello"', ts: '1.2', ref: 'C123' },
    ],
    [
      'cmd_slack_post',
      ['C123', 'reply', '--thread=1.2'],
      '/api/slack/post',
      { text: 'reply', thread_ts: '1.2', ref: 'C123' },
    ],
  ] as const)('%s sends exact arguments', (name, args, path, fields) => {
    const result = spawnSync('/bin/bash', ['-s', '--', ...args], {
      encoding: 'utf8',
      input: `set -euo pipefail
MUXPAD_PANE_ID=pane
MUXPAD_PANE_KEY=proof
slack_require_pane() { :; }
reset_flags() { :; }
parse_flags() { for arg in "$@"; do case "$arg" in --thread=*) FLAG_thread="\${arg#--thread=}";; esac; done; }
slack_resolve_ref() { printf '%s' "$1"; }
slack_call() { printf '%s\\n' "$2" >&2; printf '%s\\n' "\${3:-}" >&2; printf '%s' '{"channel":"C123","ts":"1.2"}'; }
${extract(name)}
${name} "$@"
`,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain(path);
    if (fields)
      expect(JSON.parse(result.stderr.split('\n')[1]!)).toMatchObject({
        pane: 'pane',
        key: 'proof',
        ...fields,
      });
  });
});
