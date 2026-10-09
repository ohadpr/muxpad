import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const MUXPAD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');

/**
 * SLACK IS A WORKSPACE CAPABILITY, AND IT FAILS CLOSED.
 *
 * "Never allow a project that is using personal files/data to send slack
 *  messages, never ever ever ever. It should fail."
 *
 * ── THE DIRECTORY WAS THE WRONG THING TO ASK ────────────────────────────────
 * The first version gated on `pwd`, and it was wrong for how the tool is used:
 * "not all my trayo chats run in that directory — I just tell the agent what
 * directory stuff is in, so the agent can be running in ~". That check would
 * have refused real work chats and allowed a personal one that happened to
 * start somewhere permitted. It measured the wrong thing confidently, which is
 * the worst way for a guard to be wrong.
 *
 * Workspaces are how the chats are actually organised, so that is the boundary.
 * The switch is a column on the workspace row, edited in the UI — not a file on
 * disk, so there is one place to look and nothing can disagree with itself.
 *
 * ── AND READING IS GATED TOO ────────────────────────────────────────────────
 * The first cut gated only `post`, reasoning that the risk is data going OUT.
 * But a personal chat could run `slack channels` and list every private channel
 * in the company. Slack is a work surface: a workspace either touches it or it
 * does not.
 *
 * ── AND THE WORKSPACE COMES FROM THE SERVER ─────────────────────────────────
 * `MUXPAD_WORKSPACE_ID` is in every pane's environment and would have been one
 * line. It is also a value the caller can set, and a guard that asks the thing
 * it is guarding to state its own identity is a guard in name only. The pane id
 * is resolved pane → tab → workspace over the API; the pane cannot edit that
 * answer. The spoof case below is the point of the whole design.
 *
 * These need a running server, so they are skipped without one rather than
 * reported as passes.
 */
const API = `http://127.0.0.1:${process.env.MUXPAD_PORT ?? 7777}`;

/**
 * THE FIXTURE READS THE CAPABILITY, it does not assume which workspace has it.
 *
 * The first version took "not named Personal" to mean "allowed", which was the
 * file-based allowlist's semantics. The capability defaults OFF for every
 * existing workspace — migration 43 adds the column with `DEFAULT 0` — so the
 * through-the-gate case has nothing to run against until somebody throws the
 * switch in the UI, and it skips rather than asserting the old meaning. That
 * failure is how this was found: the real work workspace was refused, correctly.
 */
let offPane = '';
let offName = '';
let onPane = '';
let onName = '';
let up = false;

beforeAll(async () => {
  try {
    const panes = (await fetch(`${API}/api/panes`).then((r) => r.json())) as Array<{
      id: string;
      tab_id: string;
    }>;
    const wss = (await fetch(`${API}/api/workspaces?all=1`).then((r) => r.json())) as Array<{
      id: string;
      name: string;
      slack?: boolean;
    }>;
    for (const p of panes) {
      const tab = (await fetch(`${API}/api/tabs/${p.tab_id}`).then((r) => r.json())) as {
        workspace_id?: string;
      };
      const ws = wss.find((w) => w.id === tab.workspace_id);
      if (!ws) continue;
      if (ws.slack) {
        if (!onPane) {
          onPane = p.id;
          onName = ws.name;
        }
      } else if (!offPane) {
        offPane = p.id;
        offName = ws.name;
      }
    }
    up = !!offPane;
  } catch {
    up = false;
  }
});

const post = (env: Record<string, string>) =>
  execFileAsync(MUXPAD, ['slack', 'post', '#definitely-not-a-channel', 'hi'], {
    env: { ...process.env, SLACK_SECRETS: '/dev/null', ...env },
  }).then(
    (r) => ({ code: 0, out: r.stdout + r.stderr }),
    (e: { code?: number; stdout?: string; stderr?: string }) => ({
      code: e.code ?? 1,
      out: (e.stdout ?? '') + (e.stderr ?? ''),
    }),
  );

describe('the Slack workspace capability', () => {
  it('refuses outside a muxpad pane — there is no workspace to check', async () => {
    const { MUXPAD_PANE_ID: _omitted, ...env } = process.env as Record<string, string>;
    const r = await execFileAsync(MUXPAD, ['slack', 'post', '#x', 'hi'], {
      env: { ...env, SLACK_SECRETS: '/dev/null' },
    }).catch((e: { stderr?: string }) => ({ stderr: e.stderr ?? '' }));
    expect(('stderr' in r ? r.stderr : '') as string).toContain('only from inside a muxpad pane');
  });

  it('refuses a pane in a workspace without the capability', async ({ skip }) => {
    if (!up) skip();
    const r = await post({ MUXPAD_PANE_ID: offPane });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`the "${offName}" workspace does not have Slack enabled`);
  });

  it('lets a workspace that HAS the capability through to the API', async ({ skip }) => {
    // Skipped until some workspace is switched on — see the fixture comment.
    if (!onPane) skip();
    // Past the gate — it now fails on the channel, which is the proof.
    const r = await post({ MUXPAD_PANE_ID: onPane });
    expect(r.out, `workspace ${onName}`).not.toContain('does not have Slack enabled');
  });

  it('CANNOT be talked out of it by setting MUXPAD_WORKSPACE_ID', async ({ skip }) => {
    if (!up) skip();
    // The whole reason the workspace is resolved server-side from the pane id.
    const r = await post({
      MUXPAD_PANE_ID: offPane,
      MUXPAD_WORKSPACE_ID: 'whatever-the-agent-likes',
    });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain(`the "${offName}" workspace does not have Slack enabled`);
  });

  it('cannot be switched on from the CLI at all', () => {
    // The CLI is what agents drive. An agent that can grant itself the
    // capability is a guard in name only, so the write lives in the UI and the
    // server refuses a capability PATCH with no browser Origin.
    expect(SRC).not.toMatch(/slack["']?\s*:\s*(true|1)/);
    expect(SRC).toContain('Settings → Capabilities');
  });

  it('gates reading and listing, not just posting', async ({ skip }) => {
    if (!up) skip();
    for (const argv of [
      ['slack', 'channels'],
      ['slack', 'search', 'anything'],
      ['slack', 'read', '#general'],
    ]) {
      const r = await execFileAsync(MUXPAD, argv, {
        env: { ...process.env, SLACK_SECRETS: '/dev/null', MUXPAD_PANE_ID: offPane },
      }).then(
        (x) => x.stdout + x.stderr,
        (e: { stdout?: string; stderr?: string }) => (e.stdout ?? '') + (e.stderr ?? ''),
      );
      expect(r, argv.join(' ')).toContain('does not have Slack enabled');
    }
  });
});

describe('one identity, and it says a machine wrote it', () => {
  it('reads no bot token anywhere in the script', () => {
    // Not "prefers the user token" — does not read the other one at all. A bot
    // DM lands in the recipient's separate conversation with "muxpad", which
    // the sender cannot see; having the option available is what let a DM use
    // it by accident.
    const code = SRC.split('\n').filter((l) => !l.trim().startsWith('#'));
    expect(code.filter((l) => /\$\{?SLACK_BOT_TOKEN/.test(l))).toEqual([]);
  });

  it('offers no way to ask for a bot', () => {
    expect(SRC).not.toContain('--as-bot');
  });

  it('prefixes every post with the robot, and does not double it', () => {
    const body = SRC.slice(SRC.indexOf('cmd_slack_post() {'));
    expect(body).toMatch(/text="🤖 \$text"/);
    // Already-prefixed text is left alone, so a relayed message is not 🤖 🤖.
    expect(body).toMatch(/"🤖"\*\)/);
  });

  it('guards before the credentials are even read', () => {
    // `slack_load` SOURCES the secrets file. A project that may not post has no
    // business holding the token in its environment, so the gate comes first —
    // and a refusal must not depend on getting the usage right either.
    // CODE ONLY. The comment above the call explains the ordering and mentions
    // `slack_load` by name, so matching raw source compares against prose —
    // which is how this assertion first failed on a correctly-ordered script.
    const body = SRC.slice(SRC.indexOf('cmd_slack_post() {'))
      .split('\n')
      .filter((l) => !l.trim().startsWith('#'))
      .join('\n');
    const guard = body.indexOf('slack_guard_workspace');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.indexOf('slack_load'));
    expect(guard).toBeLessThan(body.indexOf('usage: muxpad slack post'));
  });

  it('guards unpost too', () => {
    expect(SRC.slice(SRC.indexOf('cmd_slack_unpost() {'))).toContain('slack_guard_workspace');
  });
});
