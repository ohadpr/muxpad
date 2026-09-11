// THE VERB LIST, pinned.
//
// Two halves, and the second matters more than the first. Anyone can write
// tests that a gate fires; the failure mode that kills a gate is firing on
// things nobody wants to be asked about, until people tap through it without
// reading. So the "stays out of the way" block below is deliberately the
// longer one, and every line of it is a command that shows up in ordinary work
// in this very repo.

import { describe, expect, it } from 'vitest';
import {
  GATE_NO,
  GATE_YES,
  classifyAction,
  denialNote,
  gateEnabled,
  gateQuestion,
  isApproval,
} from './reversibility.js';

const bash = (command: string) => classifyAction('Bash', { command });
const verb = (command: string) => bash(command)?.verb ?? null;

describe('gated: send — speaks as the user', () => {
  it('muxpad pane send is arbitrary shell in someone else’s terminal', () => {
    // The exact hazard web/src/lib/dictation-cleanup.ts makes a human read the
    // composer for. Voice has no composer; this is what replaces it.
    expect(verb('muxpad pane send 3 "pnpm test"')).toBe('send');
    expect(verb('muxpad pane keys 3 --key=ctrl-c')).toBe('send');
  });

  it('muxpad agent send speaks to another agent as the user', () => {
    expect(verb('muxpad agent send pane-7 "ship it"')).toBe('send');
  });

  it('gh comments post publicly under the user’s account', () => {
    expect(verb('gh pr comment 14 --body "lgtm"')).toBe('send');
    expect(verb('gh issue comment 9 --body hi')).toBe('send');
    expect(verb('gh pr review 14 --approve')).toBe('send');
  });
});

describe('gated: publish — bytes that cannot be taken back', () => {
  it('git push, however it is spelled', () => {
    expect(verb('git push')).toBe('publish');
    expect(verb('git push origin main')).toBe('publish');
    expect(verb('git push --force-with-lease')).toBe('publish');
    // Global flags that swallow their value must not hide the subcommand.
    expect(verb('git -C /some/repo push')).toBe('publish');
  });

  it('catches a push hidden behind a chain — chaining is how agents write shell', () => {
    expect(verb('cd /tmp/repo && git push origin main')).toBe('publish');
    expect(verb('pnpm test; git push')).toBe('publish');
  });

  it('muxpad publish puts files on a public URL and turns the funnel on itself', () => {
    expect(verb('muxpad publish ./report --name=teardown')).toBe('publish');
    // …but its read-only modes are not publishing anything.
    expect(bash('muxpad publish --list')).toBeNull();
    expect(bash('muxpad publish --base')).toBeNull();
  });

  it('gh pr create / merge, gh release, npm publish', () => {
    expect(verb('gh pr create --fill')).toBe('publish');
    expect(verb('gh pr merge 14 --squash')).toBe('publish');
    expect(verb('gh release create v1.2.0')).toBe('publish');
    expect(verb('npm publish')).toBe('publish');
    expect(verb('pnpm publish --access public')).toBe('publish');
  });
});

describe('gated: delete — no undo', () => {
  it('a recursive forced delete of real files', () => {
    expect(verb('rm -rf ~/Documents/Invoices')).toBe('delete');
    expect(verb('rm -r -f /Users/me/project/src')).toBe('delete');
  });

  it('git clean --force destroys files that were never committed', () => {
    expect(verb('git clean -fd')).toBe('delete');
  });

  it('dropping a database', () => {
    expect(verb('dropdb production')).toBe('delete');
  });
});

describe('gated: credentials — who can act as the user', () => {
  it('auth and identity commands', () => {
    expect(verb('gh auth login')).toBe('credentials');
    expect(verb('npm login')).toBe('credentials');
    expect(verb('security add-generic-password -a me -s svc -w hunter2')).toBe('credentials');
    expect(verb('aws configure')).toBe('credentials');
    expect(verb('git config --global user.email me@example.com')).toBe('credentials');
  });

  it('writing a file that IS an identity', () => {
    expect(classifyAction('Write', { file_path: '/Users/me/.ssh/authorized_keys' })?.verb).toBe(
      'credentials',
    );
    expect(classifyAction('Edit', { file_path: '/Users/me/.aws/credentials' })?.verb).toBe(
      'credentials',
    );
    expect(classifyAction('Write', { file_path: '/Users/me/.npmrc' })?.verb).toBe('credentials');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The half that decides whether anyone keeps the gate switched on.
// ───────────────────────────────────────────────────────────────────────────

describe('NOT gated — the whole promise of Chat mode is not being asked', () => {
  it('reading, searching, building, testing', () => {
    for (const cmd of [
      'ls -la',
      'cat README.md',
      'rg "reply" server/src',
      'pnpm -C server exec tsc --noEmit',
      'pnpm -C server test',
      'biome check .',
      'node scripts/thing.mjs',
      'curl -s https://example.com',
    ])
      expect(bash(cmd)).toBeNull();
  });

  it('the whole local git loop, up to but not including the push', () => {
    for (const cmd of [
      'git status --short',
      'git diff',
      'git add server/src/agent-runner/reply-stream.ts',
      'git commit -m "feat: the thing"',
      'git checkout -b voice-prereqs',
      'git stash',
      // Recoverable from the reflog, so it fails the criterion.
      'git reset --hard HEAD~1',
      'git log --oneline -20',
      'gh pr view 14',
      'gh auth status',
    ])
      expect(bash(cmd)).toBeNull();
  });

  it('a commit MESSAGE containing a gated word is not that action', () => {
    // Quoted tokens are excluded from matching on purpose. Without that, every
    // commit about the push path would stop and ask.
    expect(bash('git commit -m "push the reply frame through ws"')).toBeNull();
    expect(bash("git commit -m 'rm -rf the old roster'")).toBeNull();
    expect(bash('echo "git push" >> notes.txt')).toBeNull();
  });

  it('deleting build output is Tuesday, not a data loss event', () => {
    // A gate that fires several times a day is a gate people tap through
    // blind — the specific way approval cards stop working.
    for (const cmd of [
      'rm -rf node_modules',
      'rm -rf web/dist server/dist',
      'rm -rf /tmp/voice-prereqs',
      'rm -rf .next .turbo coverage',
      'rm -rf server/tsconfig.tsbuildinfo',
      'rm -rf /var/folders/xy/T/muxpad-test-123',
    ])
      expect(bash(cmd)).toBeNull();
  });

  it('a MIXED delete still asks — one real path is enough', () => {
    expect(verb('rm -rf node_modules ~/Documents')).toBe('delete');
  });

  it('a non-recursive or non-forced rm is not the gated verb', () => {
    expect(bash('rm /tmp/x')).toBeNull();
    expect(bash('rm -r stale-dir')).toBeNull();
  });

  it('editing ordinary files, including a project .env', () => {
    // .env is deliberately absent from the credential list: it is edited
    // constantly and editing it back costs nothing, so it fails the "destroys
    // the only copy" criterion. Including it would be the false gate on every
    // file write that would ruin Chat mode.
    for (const p of [
      '/Users/me/project/src/index.ts',
      '/Users/me/project/.env',
      '/Users/me/project/package.json',
      '/Users/me/.zshrc',
    ])
      expect(classifyAction('Write', { file_path: p })).toBeNull();
  });

  it('read-only stripe and gh subcommands', () => {
    expect(bash('stripe logs tail')).toBeNull();
    expect(bash('stripe list charges')).toBeNull();
  });

  it('a binary that merely CONTAINS a verb name', () => {
    expect(bash('pushd /tmp')).toBeNull();
    expect(bash('git-push-helper --check')).toBeNull();
  });

  it('malformed or empty input never throws and never gates', () => {
    expect(classifyAction('Bash', {})).toBeNull();
    expect(classifyAction('Bash', { command: '   ' })).toBeNull();
    expect(classifyAction('Bash', null)).toBeNull();
    expect(classifyAction('Read', { file_path: '/Users/me/.ssh/id_rsa' })).toBeNull();
    expect(classifyAction('Write', { file_path: 42 })).toBeNull();
  });
});

describe('paths through an absolute binary or a sudo/env prefix', () => {
  it('resolve to the same verb', () => {
    expect(verb('/usr/bin/git push')).toBe('publish');
    expect(verb('sudo rm -rf /Users/me/thing')).toBe('delete');
    expect(verb('GIT_SSH_COMMAND="ssh -i k" git push')).toBe('publish');
  });
});

describe('the question a gate renders as', () => {
  const action = classifyAction('Bash', { command: 'git push origin main' });

  it('fits the existing ask_user chip contract', () => {
    const q = gateQuestion(action as NonNullable<typeof action>);
    expect(q.header.length).toBeLessThanOrEqual(16);
    expect(q.question.length).toBeLessThanOrEqual(500);
    expect(q.options).toHaveLength(2);
    expect(q.multiSelect).toBe(false);
    // The command itself is shown verbatim — the user is approving a specific
    // thing, not a category.
    expect(q.options[0]?.description).toBe('git push origin main');
  });
});

describe('answers — fail closed, always', () => {
  const yes = (a: string[]) => [{ question: 'q', answers: a }];

  it('only the exact affirmative label approves', () => {
    expect(isApproval(yes([GATE_YES]))).toBe(true);
    expect(isApproval(yes([GATE_NO]))).toBe(false);
    expect(isApproval(yes([]))).toBe(false);
    expect(isApproval(yes(['do it']))).toBe(false);
    expect(isApproval(yes([GATE_YES, GATE_NO]))).toBe(false);
    expect(isApproval([])).toBe(false);
  });

  it('a DISMISSED question is a no — this is what Stop and shutdown resolve to', () => {
    expect(isApproval(null)).toBe(false);
  });

  it('a typed correction becomes the denial reason, not a discarded tap', () => {
    expect(denialNote(yes(['not to main — use a branch']))).toBe('not to main — use a branch');
    expect(denialNote(yes([GATE_NO]))).toBeNull();
    expect(denialNote(yes([GATE_YES]))).toBeNull();
    expect(denialNote(null)).toBeNull();
  });
});

describe('scope — narrow on purpose', () => {
  it('is on in Chat mode', () => {
    expect(gateEnabled('chat', {})).toBe(true);
  });

  it('is OFF in Agent mode, which is documented as the raw face', () => {
    expect(gateEnabled('agent', {})).toBe(false);
  });

  it('MUXPAD_GATE=off turns it off outright', () => {
    expect(gateEnabled('chat', { MUXPAD_GATE: 'off' })).toBe(false);
  });

  it('there is no environment switch that turns it ON for Agent mode', () => {
    expect(gateEnabled('agent', { MUXPAD_GATE: 'on' })).toBe(false);
    expect(gateEnabled('agent', { MUXPAD_GATE: 'all' })).toBe(false);
  });
});
