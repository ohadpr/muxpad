#!/usr/bin/env node
// A STANDALONE probe of the installed @anthropic-ai/claude-agent-sdk.
//
// The runner's subagent roster is built entirely on assumptions about what the
// SDK emits — that `task_started` carries a `tool_use_id`, that a finish always
// produces a `task_notification`, that `background_tasks_changed` is a complete
// and timely level signal. Every test in the repo asserts those assumptions
// against hand-written messages, so a wrong assumption is invisible. This
// observes them instead.
//
// It drives a REAL session through the fleet shape the bug shows up in:
// background subagents launched across several turns, outliving the turns that
// launched them, plus a nested launch — and dumps every raw message.
//
// Then it REPLAYS the captured stream through the real SubagentRoster with the
// real dispatch rules and prints the roster's final count next to the truth the
// stream itself proves. That last step is the verdict: if the replayed count is
// not zero once every task has notified completion, the leak is runner-side and
// this capture is its reproduction.
//
// Isolated by construction: its own cwd under /tmp, `settingSources: []` (no
// user/project settings, no CLAUDE.md, no MCP), and it never reads or writes
// ~/.muxpad.
//
//   node server/scripts/sdk-task-probe.mjs [--seconds 240] [--model sonnet]
//
// Writes the raw capture to <cwd>/capture.jsonl for offline replay:
//   node server/scripts/sdk-task-probe.mjs --replay /tmp/…/capture.jsonl

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const SDK = join(HERE, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const REPLAY_FILE = flag('replay', null);
const SECONDS = Number(flag('seconds', '300'));
const MODEL = flag('model', 'sonnet');
const WORK = flag('cwd', `/tmp/muxpad-sdk-probe-${Date.now()}`);
// `--stop-after <sec>`: interrupt the FIRST turn this many seconds in, with
// background subagents outstanding. The roster's fourth end-path (retireAll on
// a Stop) rests on the claim that a Stop takes its background tasks down with
// it; this is how that claim gets checked rather than assumed.
const STOP_AFTER = flag('stop-after', null) ? Number(flag('stop-after', '0')) : null;

// ───────────────────────────────────────────────────────────────────────────
// The replay: the runner's dispatch rules and roster, reimplemented in the
// SMALLEST form that is faithful to claude.ts + subagent-roster.ts at HEAD.
// Kept here (rather than importing the TS) so this file runs standalone with
// plain node, and so the rules being tested are visible in one screen.
// ───────────────────────────────────────────────────────────────────────────
const LAUNCH_ACK_RE = /agent launched successfully|async agent launched/i;
const TERMINAL = new Set(['completed', 'failed', 'killed']);

function makeRoster(trace) {
  const entries = new Map(); // toolUseId → { toolUseId, taskId?, background?, steps, label }
  const known = new Map(); // taskId → { toolUseId, steps, label }
  let lastLevel = new Set();
  const say = (...a) => trace.push(a.join(' '));

  const remember = (taskId, p) => {
    known.delete(taskId);
    known.set(taskId, { toolUseId: p.toolUseId, steps: p.steps, label: p.label });
  };
  const done = (toolUseId) => {
    const p = entries.get(toolUseId);
    if (!p) return;
    if (p.taskId) remember(p.taskId, p);
    entries.delete(toolUseId);
    say(`  − retire ${toolUseId} (${p.label ?? ''})`);
  };
  return {
    entries,
    launch(toolUseId, label) {
      if (entries.has(toolUseId)) return;
      entries.set(toolUseId, { toolUseId, label, steps: 0 });
      say(`  + launch ${toolUseId} (${label})`);
    },
    activity(toolUseId) {
      const p = entries.get(toolUseId);
      if (!p) return;
      p.steps++;
    },
    has: (id) => entries.has(id),
    bindTask(toolUseId, taskId) {
      const p = entries.get(toolUseId);
      if (!p) return;
      if (p.taskId !== taskId) p.background = false;
      p.taskId = taskId;
      if (lastLevel.has(taskId)) p.background = true;
      remember(taskId, p);
      say(`  = bind ${toolUseId} ↔ ${taskId}`);
    },
    doneByTaskId(taskId) {
      for (const p of entries.values()) if (p.taskId === taskId) return done(p.toolUseId);
    },
    pauseTask(taskId) {
      for (const p of entries.values()) if (p.taskId === taskId) p.background = false;
    },
    retireUnstarted() {
      for (const p of [...entries.values()]) if (!p.taskId && p.steps === 0) done(p.toolUseId);
    },
    retireAll(reason) {
      if (entries.size) say(`  ⏹ retireAll (${reason})`);
      for (const id of [...entries.keys()]) done(id);
    },
    reconcileBackground(ids) {
      lastLevel = new Set(ids);
      for (const p of [...entries.values()]) {
        if (!p.taskId) continue;
        if (lastLevel.has(p.taskId)) p.background = true;
        else if (p.background) done(p.toolUseId);
      }
      for (const taskId of lastLevel) {
        const k = known.get(taskId);
        if (!k || entries.has(k.toolUseId)) continue;
        entries.set(taskId === k.toolUseId ? taskId : k.toolUseId, {
          toolUseId: k.toolUseId,
          label: k.label,
          steps: k.steps,
          taskId,
          background: true,
        });
        say(`  ↺ resurrect ${k.toolUseId} (${taskId})`);
      }
    },
    done,
  };
}

/** claude.ts's dispatch, message for message. */
function replay(messages) {
  const trace = [];
  const r = makeRoster(trace);
  // The runner sets this in `stop()` and clears it at the turn `result`. The
  // capture's own "[Request interrupted by user]" marker is the same edge, so
  // a --stop-after run replays through the retireAll('stopped') path exactly as
  // the runner would.
  let interruptRequested = false;
  const launched = new Set();
  const notifiedTaskIds = new Set();
  const taskIdsSeen = new Set();

  for (const msg of messages) {
    trace.push(
      `${msg.type}/${msg.subtype ?? ''} ${msg.task_id ?? ''} ${msg.tool_use_id ?? ''} ${
        msg.parent_tool_use_id === null ? 'top' : (msg.parent_tool_use_id ?? '')
      }`.trimEnd(),
    );
    if (msg.type === 'system' && msg.subtype === 'task_started') {
      taskIdsSeen.add(msg.task_id);
      if (msg.tool_use_id && msg.task_id) r.bindTask(msg.tool_use_id, msg.task_id);
    } else if (msg.type === 'system' && msg.subtype === 'task_notification') {
      notifiedTaskIds.add(msg.task_id);
      if (msg.tool_use_id) r.done(msg.tool_use_id);
      if (msg.task_id) r.doneByTaskId(msg.task_id);
    } else if (msg.type === 'system' && msg.subtype === 'task_updated') {
      const st = msg.patch?.status;
      if (st && TERMINAL.has(st)) r.doneByTaskId(msg.task_id);
      else if (st === 'paused') r.pauseTask(msg.task_id);
    } else if (msg.type === 'system' && msg.subtype === 'background_tasks_changed') {
      r.reconcileBackground((msg.tasks ?? []).map((t) => t.task_id));
    } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
      for (const b of msg.message?.content ?? []) {
        if (b.type === 'tool_use' && (b.name === 'Task' || b.name === 'Agent')) {
          launched.add(b.id);
          r.launch(b.id, (b.input?.description ?? 'subagent').slice(0, 80));
        }
      }
    } else if (
      (msg.type === 'assistant' || msg.type === 'user') &&
      typeof msg.parent_tool_use_id === 'string'
    ) {
      r.activity(msg.parent_tool_use_id);
    } else if (msg.type === 'user' && msg.parent_tool_use_id === null) {
      const content = msg.message?.content;
      if (typeof content === 'string' && content.includes('[Request interrupted by user]'))
        interruptRequested = true;
      if (Array.isArray(content)) {
        if (
          content.some(
            (b) => b.type === 'text' && b.text?.includes('[Request interrupted by user]'),
          )
        )
          interruptRequested = true;
      }
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            if (!r.has(b.tool_use_id)) continue;
            const text = Array.isArray(b.content)
              ? b.content.map((x) => (x.type === 'text' ? x.text : '')).join(' ')
              : String(b.content ?? '');
            if (LAUNCH_ACK_RE.test(text)) continue;
            r.done(b.tool_use_id);
          }
        }
      }
    } else if (msg.type === 'result') {
      r.retireUnstarted();
      if (interruptRequested) r.retireAll('stopped');
      else if (msg.subtype !== 'success') r.retireAll('turn failed');
      interruptRequested = false;
    }
  }
  return { roster: r, trace, launched, notifiedTaskIds, taskIdsSeen };
}

function report(messages) {
  const { roster, trace, launched, notifiedTaskIds, taskIdsSeen } = replay(messages);
  console.log('\n═══ REPLAY THROUGH THE ROSTER RULES AT HEAD ═══');
  for (const line of trace) if (line.startsWith('  ')) console.log(line);

  console.log('\n═══ SHAPE FACTS OBSERVED ═══');
  const sys = messages.filter((m) => m.type === 'system');
  const bySubtype = {};
  for (const m of sys) bySubtype[m.subtype] = (bySubtype[m.subtype] ?? 0) + 1;
  console.log('system subtypes:', JSON.stringify(bySubtype));

  const started = sys.filter((m) => m.subtype === 'task_started');
  const agentStarted = started.filter((m) => m.task_type === 'local_agent');
  console.log(
    `task_started: ${started.length} total, ${agentStarted.length} local_agent; ` +
      `WITH tool_use_id: ${started.filter((m) => m.tool_use_id).length}, ` +
      `WITHOUT: ${started.filter((m) => !m.tool_use_id).length}`,
  );
  const notifs = sys.filter((m) => m.subtype === 'task_notification');
  console.log(
    `task_notification: ${notifs.length} total; WITH tool_use_id: ` +
      `${notifs.filter((m) => m.tool_use_id).length}, WITHOUT: ${notifs.filter((m) => !m.tool_use_id).length}`,
  );
  const levels = sys.filter((m) => m.subtype === 'background_tasks_changed');
  console.log(
    `background_tasks_changed: ${levels.length}; last payload: ${JSON.stringify(
      (levels.at(-1)?.tasks ?? []).map((t) => t.task_id),
    )}`,
  );
  const taskTypes = new Set(started.map((m) => m.task_type));
  console.log('task_types seen:', [...taskTypes].join(', '));
  // Does the level signal carry NON-agent background tasks (background Bash)?
  const levelIds = new Set(levels.flatMap((m) => (m.tasks ?? []).map((t) => t.task_id)));
  const bashTaskIds = started.filter((m) => m.task_type === 'local_bash').map((m) => m.task_id);
  console.log(
    `local_bash task ids ever in a level payload: ${bashTaskIds.filter((id) => levelIds.has(id)).length}/${bashTaskIds.length}`,
  );

  console.log('\n═══ VERDICT ═══');
  const live = [...roster.entries.values()];
  const unnotified = [...taskIdsSeen].filter((id) => !notifiedTaskIds.has(id));
  console.log(`top-level launches seen: ${launched.size}`);
  console.log(
    `task ids that never notified a finish: ${unnotified.length} ${JSON.stringify(unnotified)}`,
  );
  console.log(`roster size at end of stream: ${live.length}`);
  for (const p of live)
    console.log(
      `  LEAKED ${p.toolUseId} task=${p.taskId ?? 'UNBOUND'} background=${!!p.background} steps=${p.steps} label=${p.label}`,
    );
  if (live.length === 0) console.log('roster drained to ZERO — no leak in this capture.');
  else console.log(`ROSTER LEAKED ${live.length} ENTRIES.`);
  return live.length;
}

if (REPLAY_FILE) {
  const messages = readFileSync(REPLAY_FILE, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  console.log(`replaying ${messages.length} captured messages from ${REPLAY_FILE}`);
  process.exit(report(messages) === 0 ? 0 : 1);
}

// ───────────────────────────────────────────────────────────────────────────
// The live run.
// ───────────────────────────────────────────────────────────────────────────
mkdirSync(WORK, { recursive: true });
const CAPTURE = join(WORK, 'capture.jsonl');
writeFileSync(CAPTURE, '');
console.log(`probe cwd: ${WORK}`);
console.log(`capture:   ${CAPTURE}\n`);

const { query } = await import(SDK);

// Multiple turns, background agents outliving the turns that launched them,
// and one nested launch — the fleet shape.
const TURNS = [
  `Do exactly this, nothing else. Use the Task tool THREE times, each with subagent_type "general-purpose" and run_in_background true:
 1. description "alpha", prompt: "Run: sleep 25. Then reply ALPHA-DONE."
 2. description "beta", prompt: "Run: sleep 55. Then reply BETA-DONE."
 3. description "gamma", prompt: "Run: sleep 8. Then use the Task tool ONCE with subagent_type general-purpose, run_in_background true, description 'gamma-child', prompt 'Run: sleep 10. Then reply GAMMA-CHILD-DONE.'. Immediately after launching it reply GAMMA-LAUNCHED-CHILD (do not wait)."
Launch all three, then reply LAUNCHED-3 and END YOUR TURN IMMEDIATELY. Do not wait for any of them.`,

  `Do exactly this, nothing else. Use the Task tool TWICE, each with subagent_type "general-purpose" and run_in_background true:
 1. description "delta", prompt: "Run: sleep 30. Then reply DELTA-DONE."
 2. description "epsilon", prompt: "Run: sleep 12. Then reply EPSILON-DONE."
Then reply LAUNCHED-2 and END YOUR TURN IMMEDIATELY. Do not wait.`,

  'Reply with exactly: TURN-3-NOOP. Do not use any tools.',
];

let turnIdx = 0;
let releaseTurn = null;
async function* prompts() {
  for (const text of TURNS) {
    yield {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    };
    // Wait for this turn's `result` before sending the next, exactly as the
    // runner's own queue does.
    await new Promise((r) => {
      releaseTurn = r;
    });
  }
  // Keep the stream open so OUT-OF-TURN task traffic keeps arriving.
  await new Promise((r) => setTimeout(r, SECONDS * 1000));
}

const q = query({
  prompt: prompts(),
  options: {
    cwd: WORK,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    model: MODEL,
    settingSources: [],
  },
});

const t0 = Date.now();
const rel = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
const captured = [];

if (STOP_AFTER !== null) {
  setTimeout(() => {
    console.log(`${rel()} >>> INTERRUPT (the user pressing Stop with agents outstanding)`);
    q.interrupt().then(
      () => console.log(`${rel()} >>> interrupt resolved`),
      (e) => console.log(`${rel()} >>> interrupt REJECTED: ${e?.message}`),
    );
  }, STOP_AFTER * 1000);
}

const timer = setTimeout(() => {
  console.log(`\n== window closed after ${SECONDS}s ==`);
  finish();
}, SECONDS * 1000);

function finish() {
  clearTimeout(timer);
  const leaked = report(captured);
  process.exit(leaked === 0 ? 0 : 1);
}

for await (const m of q) {
  // stream_event is high-volume and carries no task information — record it as
  // a count only, so the capture stays readable and replayable.
  if (m.type === 'stream_event') continue;
  captured.push(m);
  appendFileSync(CAPTURE, `${JSON.stringify(m)}\n`);

  if (m.type === 'system') {
    const { type, subtype, task_id, tool_use_id, status, task_type, patch, tasks, description } = m;
    if (subtype === 'init') {
      console.log(`${rel()} system/init session=${m.session_id}`);
      continue;
    }
    console.log(
      `${rel()} ${JSON.stringify({
        type,
        subtype,
        task_id,
        tool_use_id,
        status,
        task_type,
        description,
        patch,
        tasks: tasks?.map((t) => t.task_id),
      })}`,
    );
  } else if (m.type === 'assistant' || m.type === 'user') {
    const c = m.message?.content;
    const brief =
      typeof c === 'string'
        ? `STR:${c.slice(0, 100)}`
        : (c ?? [])
            .map((b) =>
              b.type === 'text'
                ? `TEXT:${b.text.slice(0, 80)}`
                : b.type === 'tool_use'
                  ? `TOOL_USE:${b.name}#${b.id}`
                  : b.type === 'tool_result'
                    ? `TOOL_RESULT#${b.tool_use_id}:${JSON.stringify(b.content).slice(0, 80)}`
                    : b.type,
            )
            .join(' | ');
    console.log(`${rel()} ${m.type} ptu=${m.parent_tool_use_id ?? 'TOP'} ${brief}`);
  } else if (m.type === 'result') {
    console.log(`${rel()} result/${m.subtype}  (turn ${++turnIdx})`);
    releaseTurn?.();
    releaseTurn = null;
  }
}
finish();
