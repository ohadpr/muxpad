// SELF-HEAL AFTER A DEAD CREDENTIAL, and the respawn that must not lose a
// conversation. The 2026-09-20 incident, end to end.
//
// WHAT WENT WRONG. muxpad runs one persistent `query()` session per pane — one
// long-lived `claude` child. The CLI reads its OAuth credential once at process
// start and cannot re-read it, so when ~25 children raced one token refresh the
// winner rotated the refresh token and every other child was left holding an
// invalid one. Each then failed every turn in ~0.05 s. The trap was what came
// next: `/login` written a fresh credential to disk, and no running child ever
// read it. Twenty-four panes stayed dead until they were respawned by hand.
//
// Everything here runs through the FAKE SDK HARNESS into the REAL Claude
// backend, over a real socket, into the real ws.ts handler — because the shapes
// are the whole problem. Transcribed from the pane log of the incident:
//
//   17:13:09.262Z ready · claude-opus-5 · 117 tools
//   17:13:09.316Z claude Not logged in · Please run /login
//   17:13:09.318Z ✓ turn done · 0.0s · $165.05
//
// The turn result says SUCCESS. There is no error subtype, no `errors` array
// and nothing thrown — the auth failure is ordinary assistant prose. A
// hand-written "fatal frame" test would have proved a path that does not exist.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Must precede the fakeRunner import: constructing the Claude backend calls
// query(), which would otherwise spawn a real Agent SDK session.
vi.mock('@anthropic-ai/claude-agent-sdk', () => import('../test-helpers/fakeAgentSdk.js'));

import { EventBus } from '../events.js';
import { PtydCache } from '../ptyd-cache.js';
import { AgentSessionStore } from '../store/AgentSessionStore.js';
import { PaneStore } from '../store/PaneStore.js';
import { TabStore } from '../store/TabStore.js';
import { WorkspaceStore } from '../store/WorkspaceStore.js';
import { openDb } from '../store/db.js';
import { type FakeSession, fakeSession, resetFakeAgentSdk } from '../test-helpers/fakeAgentSdk.js';
import { type FakeRunner, startFakeRunner } from '../test-helpers/fakeRunner.js';
import { sdk } from '../test-helpers/sdkScript.js';
import { spawnPtyd } from '../test-helpers/spawnPtyd.js';
import { attachWsServer } from '../ws.js';
import { markSessionTurned } from './session-marks.js';

/** The two strings the incident actually produced, verbatim. */
const OAUTH_EXPIRED = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const NOT_LOGGED_IN = 'Not logged in · Please run /login';

const SID = '11111111-2222-3333-4444-555555555555';

let dataDir: string;
let claudeDir: string;
beforeAll(() => {
  // Never touch the real ~/.muxpad or ~/.claude: the backend reads its
  // instructions from one and scans the other for transcripts.
  dataDir = mkdtempSync(join(tmpdir(), 'muxpad-auth-test-'));
  claudeDir = mkdtempSync(join(tmpdir(), 'claude-auth-test-'));
  process.env.MUXPAD_DATA_DIR = dataDir;
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  return () => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(claudeDir, { recursive: true, force: true });
  };
});

let cleanup: (() => Promise<void>) | null = null;
afterEach(async () => {
  if (cleanup) await cleanup();
  cleanup = null;
  resetFakeAgentSdk();
  // Each test owns its own transcripts and marks.
  rmSync(join(claudeDir, 'projects'), { recursive: true, force: true });
  rmSync(join(dataDir, 'agent-sessions'), { recursive: true, force: true });
});

/** Put a `<sid>.jsonl` where `findTranscript` will find it. */
function writeTranscript(sid: string): void {
  const dir = join(claudeDir, 'projects', '-tmp-project');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), '{"type":"user"}\n');
}

interface Fixture {
  runner: FakeRunner;
  /** Every (paneId, body) the server handed the push notifier, in order. */
  pushes: Array<[string, string]>;
  /**
   * Just the GIVE-UP pushes. A pane pushes for ordinary reasons too — a turn
   * that ends while nobody is looking notifies on its own — so "did we give
   * up" has to be asked of the bodies, not of the count.
   */
  giveUps: () => string[];
}

async function boot(
  opts: { sid?: string | null; authHealDelaysMs?: readonly number[] } = {},
): Promise<Fixture> {
  const db = openDb(':memory:');
  const ptyd = await spawnPtyd();
  const workspaces = new WorkspaceStore(db);
  const tabs = new TabStore(db);
  const panes = new PaneStore(db);
  new AgentSessionStore(db);
  const events = new EventBus();
  const wsRow = workspaces.create({ name: 'W' });
  const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: wsRow.id });
  const pane = panes.create({ tab_id: tab.id, shell: '/bin/cat', cwd: '/tmp' });
  const http = createServer();
  const pushes: Array<[string, string]> = [];
  attachWsServer({
    http,
    db,
    ptyd: ptyd.client,
    cache: new PtydCache(),
    events,
    notifyPane: (paneId: string, body: string) => {
      pushes.push([paneId, body]);
      return 'sent';
    },
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as AddressInfo).port;
  const runner = await startFakeRunner({
    port,
    paneId: pane.id,
    sid: opts.sid === undefined ? SID : opts.sid,
    mode: 'chat',
    // Every rung instant: the LADDER is unit-tested on its own clock
    // (auth-heal.test.ts); what this file has to prove is what the backend
    // does at each rung, and a test that waited out 85 seconds of real
    // back-off is a test nobody runs.
    ...(opts.authHealDelaysMs ? { authHealDelaysMs: opts.authHealDelaysMs } : {}),
  });
  cleanup = async () => {
    await runner.kill().catch(() => {});
    await ptyd.cleanup();
    await new Promise<void>((r) => http.close(() => r()));
  };
  return {
    runner,
    pushes,
    giveUps: () => pushes.map(([, b]) => b).filter((b) => b.includes('/login')),
  };
}

/** Spin until `pred` holds, or fail loudly rather than hanging the suite. */
async function until(pred: () => boolean, what: string, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Deliver a user turn and wait for the live session to consume it. */
async function send(fx: Fixture, text: string): Promise<FakeSession> {
  const before = fakeSession();
  fx.runner.backend.send(text);
  await until(() => before.promptTexts.some((t) => t.includes(text)), `session to take "${text}"`);
  return before;
}

/** One turn that dies of a dead credential, exactly as the incident's did. */
function authFailedTurn(message: string): unknown[] {
  // `init` really does precede each of these in the capture — the harness
  // re-inits, reports 117 tools, and only then says it cannot authenticate.
  return [sdk.init(), sdk.text(message), sdk.result('success')];
}

describe('a dead credential re-execs the session instead of ending the turn', () => {
  it.each([
    ['OAuth session expired', OAUTH_EXPIRED],
    ['Not logged in', NOT_LOGGED_IN],
  ])('%s: the child is replaced and the user keeps their answer', async (_name, message) => {
    const fx = await boot();
    const first = await send(fx, 'what is the plan?');

    await fx.runner.feed(authFailedTurn(message));
    await until(() => fakeSession() !== first, 'the session to be re-execed');
    const second = fakeSession();

    // A NEW `claude` process — the only thing that can re-read the credential
    // a `/login` elsewhere just wrote — and the old one is closed, not leaked.
    expect(second).not.toBe(first);
    expect(first.closed).toBe(true);

    // THE USER'S TURN IS NOT SWALLOWED. It never reached a model (the failed
    // turn cost $0 and 0.05 s), so it is re-sent to the new session rather
    // than reported as a failure the user has to notice and retype.
    await until(
      () => second.promptTexts.some((t) => t.includes('what is the plan?')),
      'the message to be retried against the new session',
    );

    // …and the turn stays OPEN across the re-exec: no turn-done, so the chat
    // keeps its working indicator and the answer lands in the turn the user
    // started. (The only turn-start is the one the retry emits.)
    expect(fx.runner.sent.filter((f) => f.t === 'turn-done')).toEqual([]);

    // The new session answers, and that is the end of it.
    await fx.runner.feed([sdk.text('The plan is to ship it.'), sdk.result('success')]);
    expect(fx.runner.sent.filter((f) => f.t === 'turn-done')).toEqual([
      { t: 'turn-done', ok: true, summary: 'The plan is to ship it.' },
    ]);
  });

  it('re-execs EXACTLY once for one failure', async () => {
    const fx = await boot();
    const first = await send(fx, 'hello?');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fakeSession() !== first, 'the re-exec');
    const second = fakeSession();
    // Settle well past anything the heal path could still be doing.
    await new Promise((r) => setTimeout(r, 150));
    expect(fakeSession()).toBe(second);
  });

  it('re-anchors the new session on the transcript, so the conversation survives', async () => {
    writeTranscript(SID);
    const fx = await boot();
    const first = await send(fx, 'continue please');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fakeSession() !== first, 'the re-exec');
    // `--resume <sid>` is what makes this a recovery rather than a reset.
    expect(fakeSession().options.resume).toBe(SID);
    expect(fakeSession().options.sessionId).toBeUndefined();
  });

  it('starts the replacement UNDER the same id when there is no transcript to resume', async () => {
    const fx = await boot();
    const first = await send(fx, 'continue please');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fakeSession() !== first, 'the re-exec');
    // `resume` on a transcript-less sid kills the session outright; the pane
    // keeps its identity the other way.
    expect(fakeSession().options.resume).toBeUndefined();
    expect(fakeSession().options.sessionId).toBe(SID);
  });

  // THE BACK-OFF WINDOW. Rungs two and beyond wait up to a minute before the
  // replacement exists, and the user keeps typing during it. The dead child
  // must be retired at the moment of the DECISION rather than at the moment of
  // the re-exec, or the generator feeding it is still the one a fresh send
  // wakes — and a message handed to a process that cannot authenticate dies
  // with it, silently.
  it('a message typed DURING the back-off waits for the new session, not the dead one', async () => {
    const fx = await boot({ authHealDelaysMs: [250] });
    const first = await send(fx, 'first');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    // Still inside the back-off: the replacement does not exist yet.
    await until(() => first.closed, 'the broken child to be retired');
    expect(fakeSession()).toBe(first);

    fx.runner.backend.send('second');
    await until(() => fakeSession() !== first, 'the re-exec');
    const second = fakeSession();

    // The retried turn goes first; the queued one follows it, exactly as the
    // turn queue serialises any two sends.
    await until(
      () => second.promptTexts.some((t) => t.includes('first')),
      'the retried message to reach the NEW session',
    );
    await fx.runner.feed([sdk.text('done'), sdk.result('success')]);
    await until(
      () => second.promptTexts.some((t) => t.includes('second')),
      'the typed-during-back-off message to reach the NEW session',
    );
    // Nothing was handed to the process we had already given up on.
    expect(first.promptTexts.join('|')).not.toContain('second');
  });

  it('an AUTONOMOUS turn has nothing to retry, so its turn-done is reported', async () => {
    const fx = await boot();
    // A cron/wakeup turn: no user send, the turn opens on the SDK's own traffic.
    const first = fakeSession();
    await fx.runner.feed([sdk.textStream('…'), sdk.text(NOT_LOGGED_IN), sdk.result('success')]);
    await until(() => fakeSession() !== first, 'the re-exec');
    // The turn is closed rather than held open — nobody is waiting on it, and
    // a turn nothing will ever finish leaves the pane reading "working".
    expect(fx.runner.sent.filter((f) => f.t === 'turn-done')).toEqual([
      { t: 'turn-done', ok: false, error: NOT_LOGGED_IN },
    ]);
  });
});

describe('what must NOT trigger a re-exec', () => {
  it('an ordinary failed turn is a turn error, not a session condition', async () => {
    const fx = await boot();
    const first = await send(fx, 'do the thing');
    await fx.runner.feed([sdk.text('I hit an error.'), sdk.result('error_during_execution')]);
    await new Promise((r) => setTimeout(r, 150));
    // Same child. A crash is not recoverable by an action taken outside this
    // process, so re-execing would only throw the conversation's warm state
    // away and land in exactly the same place.
    expect(fakeSession()).toBe(first);
    expect(first.closed).toBe(false);
    expect(fx.runner.sent.filter((f) => f.t === 'turn-done')).toEqual([
      { t: 'turn-done', ok: false, error: 'error_during_execution' },
    ]);
  });

  it('an agent WRITING about the failure does not re-exec its own session', async () => {
    const fx = await boot();
    const first = await send(fx, 'what happened this morning?');
    await fx.runner.feed([
      sdk.text(
        'Every pane logged "Not logged in · Please run /login" and stayed dead until they were respawned by hand.',
      ),
      sdk.result('success'),
    ]);
    await new Promise((r) => setTimeout(r, 150));
    expect(fakeSession()).toBe(first);
  });

  it('an agent QUOTING it verbatim, in a turn that did work, does not either', async () => {
    // The text rule cannot save us here: this is the incident's string, alone
    // on its own line — which is exactly how an agent investigating the
    // incident would write it after grepping for it, and exactly what Chat
    // mode's scratchpad looks like (short, single-line, nothing in front).
    //
    // The turn is what tells them apart. A dead credential fails before the
    // child reaches a model at all, so it can never have CALLED anything;
    // this turn ran a tool. Without that corroboration, an agent reading pane
    // logs re-execs its own session — four times, and then tells the user on
    // their phone that auth is broken when it is not.
    const fx = await boot();
    const first = await send(fx, 'what did the panes print?');
    await fx.runner.feed([
      sdk.launchToolUse('toolu_grep1', 'grep the pane logs'),
      sdk.text(NOT_LOGGED_IN),
      sdk.result('success'),
    ]);
    await new Promise((r) => setTimeout(r, 150));
    expect(fakeSession()).toBe(first);
    expect(first.closed).toBe(false);
    // …and it completes as the ordinary turn it was.
    expect(fx.runner.sent.filter((f) => f.t === 'turn-done')).toEqual([
      { t: 'turn-done', ok: true, summary: NOT_LOGGED_IN },
    ]);
  });

  it('a successful turn is enough to forgive the ladder', async () => {
    // Two rungs, then give up — so if the reset did not happen, the second
    // failure below would be the LAST attempt rather than the first.
    const fx = await boot({ authHealDelaysMs: [0, 0] });
    const first = await send(fx, 'one');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fakeSession() !== first, 'the first re-exec');
    await fx.runner.feed([sdk.text('all better'), sdk.result('success')]);

    const second = fakeSession();
    await send(fx, 'two');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fakeSession() !== second, 'the ladder to have been reset');
    expect(fx.giveUps()).toEqual([]); // nowhere near giving up
  });
});

describe('giving up — loudly, and never in a loop', () => {
  it('stops after the cap and puts it on the user’s phone', async () => {
    const fx = await boot({ authHealDelaysMs: [0, 0] });
    let live = await send(fx, 'are you there?');

    // Two rungs of the ladder, both instant.
    for (const attempt of [1, 2]) {
      const before = live;
      await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
      await until(() => fakeSession() !== before, `re-exec ${attempt}`);
      live = fakeSession();
    }
    expect(fx.giveUps()).toEqual([]);

    // The third failure is one the ladder has no answer for.
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fx.giveUps().length > 0, 'the give-up notification');

    // A push that names the ONE action that fixes it. Anything vaguer and the
    // user is back to reading pane logs.
    const body = fx.giveUps()[0] as string;
    expect(body).toMatch(/retries on its own/);

    // The session is NOT re-execed again…
    const afterGiveUp = fakeSession();
    await new Promise((r) => setTimeout(r, 150));
    expect(fakeSession()).toBe(afterGiveUp);

    // …and the turn is closed with something actionable rather than left open
    // forever, because nothing is coming.
    const done = fx.runner.sent.filter((f) => f.t === 'turn-done');
    expect(done.at(-1)).toMatchObject({ ok: false });
    expect((done.at(-1) as { error: string }).error).toContain('/login');
  });

  it('a further failure inside the re-arm window is quiet — one buzz per burst', async () => {
    const fx = await boot({ authHealDelaysMs: [0] });
    const first = await send(fx, 'hi');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await until(() => fakeSession() !== first, 'the only re-exec');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN)); // → give up, one push
    await until(() => fx.giveUps().length === 1, 'the give-up notification');

    await send(fx, 'hi again');
    await fx.runner.feed(authFailedTurn(NOT_LOGGED_IN));
    await new Promise((r) => setTimeout(r, 150));
    // Still exactly one. A notification per failed turn is how muxpad gets
    // muted, and the rate limit is the server's last line, not the first.
    expect(fx.giveUps()).toHaveLength(1);
  });
});

describe('respawning a session whose transcript is missing', () => {
  it('a never-used session starts fresh under its id, quietly', async () => {
    const fx = await boot();
    expect(fakeSession().options.sessionId).toBe(SID);
    expect(fx.runner.logs.join('\n')).toContain('no transcript yet');
    expect(fx.runner.logs.join('\n')).not.toContain('history lost');
    expect(fx.pushes).toEqual([]);
  });

  it('a session that HAD a transcript and lost it says so, and reaches the user', async () => {
    // The mark is written only once a transcript has been seen on disk — so
    // its presence without one means a conversation went missing, which is the
    // case the old code handled by printing "no transcript YET" and silently
    // starting over.
    markSessionTurned(SID);
    const fx = await boot();
    await until(() => fx.pushes.length > 0, 'the lost-history notification');

    const logs = fx.runner.logs.join('\n');
    expect(logs).toContain('history lost');
    expect(logs).not.toContain('no transcript yet');
    const [, body] = fx.pushes[0] as [string, string];
    expect(body).toContain('lost its conversation');

    // Still BOOTS. Refusing would turn a recoverable pane into a dead one, and
    // the history is already gone by the time we can tell.
    expect(fakeSession().options.sessionId).toBe(SID);
  });

  it('says it once, not on every reconnect', async () => {
    markSessionTurned(SID);
    const fx = await boot();
    await until(() => fx.pushes.length > 0, 'the lost-history notification');
    await fx.runner.disconnect();
    await fx.runner.reconnect();
    await new Promise((r) => setTimeout(r, 100));
    expect(fx.pushes).toHaveLength(1);
  });

  it('a transcript that is there is simply resumed', async () => {
    writeTranscript(SID);
    markSessionTurned(SID);
    const fx = await boot();
    expect(fakeSession().options.resume).toBe(SID);
    expect(fx.runner.logs.join('\n')).not.toContain('history lost');
    expect(fx.pushes).toEqual([]);
  });
});
