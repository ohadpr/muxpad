// A stand-in agent runner for README captures. It speaks the real runner
// protocol to the real server and writes a real Claude-format transcript, but
// every word comes from a scripted story (MXD_STORY). Nothing calls a model.
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const REPLY = 'mcp__muxpad__reply';
const ACK = 'Delivered to the user. [muxpad-reply]';
const paneId = process.env.MUXPAD_PANE_ID;
const apiUrl = process.env.MUXPAD_API_URL;
const storyPath = process.env.MXD_STORY ?? '/private/tmp/mxd/story.mjs';
const mapPath = process.env.MXD_MAP ?? '/private/tmp/mxd/map.json';
const logp = '/private/tmp/mxd/fake-runner.log';
const log = (s) => appendFileSync(logp, `${new Date().toISOString()} ${paneId} ${s}\n`);

const argv = process.argv.slice(2);
const flag = (n) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === n) return argv[i + 1];
    if (argv[i].startsWith(`${n}=`)) return argv[i].slice(n.length + 1);
  }
  return null;
};

const { scenarios } = await import(`${storyPath}?t=${Date.now()}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mapped() {
  try {
    return JSON.parse(readFileSync(mapPath, 'utf8'))[paneId] ?? null;
  } catch {
    return null;
  }
}
const uuidFrom = (s) => {
  const h = createHash('sha1').update(s).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

let scenario = null;
let key = mapped();
if (key) scenario = scenarios.find((s) => s.key === key) ?? null;
const sid = flag('--resume') ?? (key ? uuidFrom(`${key}:${paneId}`) : randomUUID());
const model = scenario?.model ?? 'claude-opus-5-5';
const cwd = process.cwd();
const tdir = join(homedir(), '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
const tpath = () => join(tdir, `${sid}.jsonl`);
mkdirSync(tdir, { recursive: true });

let clock = null; // a fake clock for history lines
const stamp = () => new Date(clock ?? Date.now()).toISOString();
function line(obj) {
  appendFileSync(
    tpath(),
    `${JSON.stringify({ uuid: randomUUID(), timestamp: stamp(), sessionId: sid, cwd, ...obj })}\n`,
  );
}
const userLine = (text) => line({ type: 'user', message: { role: 'user', content: text } });
const asst = (content) =>
  line({ type: 'assistant', message: { role: 'assistant', model, content } });
const toolResult = (id, text, isError = false) =>
  line({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: text, is_error: isError }],
    },
  });

let ws = null;
let turnActive = false;
const send = (f) => ws?.readyState === WebSocket.OPEN && ws.send(JSON.stringify(f));
const hello = () => ({ t: 'hello', sid, cwd, pid: process.pid, turnActive, backend: 'claude' });
const status = () => ({
  t: 'status',
  model: 'opus',
  activeModel: model,
  context: { pct: scenario?.ctx ?? 18, tokens: 36000, max: 200000 },
});

function run(cmd) {
  try {
    return execFileSync('/bin/bash', ['-c', cmd], { encoding: 'utf8', timeout: 30000 }).trim();
  } catch (e) {
    log(`cmd failed: ${cmd} :: ${e.stderr ?? e.message}`);
    return String(e.stdout ?? '').trim();
  }
}

async function step(s, live) {
  if (s.wait) return live ? sleep(s.wait) : undefined;
  if (s.clock) {
    clock = s.clock;
    return;
  }
  if (s.user) return userLine(s.user);
  if (s.think) return asst([{ type: 'text', text: s.think }]);
  if (s.say) {
    const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    if (live && s.stream !== false) {
      const words = s.say.split(/(?<=\s)/);
      const per = Math.max(1, Math.ceil(words.length / 24));
      for (let i = 0; i < words.length; i += per) {
        send({ t: 'speak-delta', id, delta: words.slice(i, i + per).join('') });
        await sleep(s.pace ?? 70);
      }
    }
    asst([{ type: 'tool_use', id, name: REPLY, input: { text: s.say } }]);
    toolResult(id, ACK);
    if (live) send({ t: 'speak', id, text: s.say, n: 1 });
    return;
  }
  if (s.bash) {
    const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    asst([
      {
        type: 'tool_use',
        id,
        name: 'Bash',
        input: { command: s.bash, ...(s.desc ? { description: s.desc } : {}) },
      },
    ]);
    if (live) await sleep(s.dur ?? 500);
    let out = s.out ?? '';
    if (s.run) {
      const got = run(s.run === true ? s.bash : s.run);
      if (s.out == null) out = got;
    }
    if (s.act) actRow(s.act);
    if (s.publish) {
      const r = await fetch(`${apiUrl}/api/publish`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...s.publish, pane: paneId }),
      }).then((x) => x.json());
      log(`publish ${JSON.stringify(r).slice(0, 300)}`);
      if (s.out == null) out = r.url ?? JSON.stringify(r);
    }
    toolResult(id, out, !!s.error);
    return;
  }
  if (s.tool) {
    const id = `toolu_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
    asst([{ type: 'tool_use', id, name: s.tool, input: s.input ?? {} }]);
    if (live) await sleep(s.dur ?? 400);
    toolResult(id, s.out ?? '');
    return;
  }
  if (s.report && live) return send({ t: 'report', text: s.report });
  if (s.title && live) return send({ t: 'title', title: s.title });
  if (s.exec) return void run(s.exec);
}

function actRow(a) {
  const db = join(process.env.MUXPAD_DATA_DIR ?? '/private/tmp/mxd/data', 'db.sqlite');
  const esc = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
  const id = `01MXD${randomUUID().replace(/-/g, '').toUpperCase().slice(0, 21)}`;
  const sqlText = `INSERT INTO chat_actions (id,pane_id,at,kind,title,body,url,state,detail,ref) VALUES (${esc(id)},${esc(paneId)},${Date.now()},${esc(a.kind)},${esc(a.title)},${esc(a.body)},${esc(a.url)},${esc(a.state)},${esc(a.detail)},NULL)`;
  try {
    execFileSync('sqlite3', [db, sqlText]);
  } catch (e) {
    log(`act failed ${e.message}`);
  }
}

const queue = [];
const used = new Set();
async function turn(text) {
  if (!scenario) {
    scenario = scenarios.find((s) => s.match?.test(text)) ?? null;
    if (scenario) key = scenario.key;
  }
  log(`send key=${key} text=${text.slice(0, 80).replace(/\n/g, ' ')}`);
  turnActive = true;
  send({ t: 'turn-start' });
  clock = null;
  userLine(text);
  const turns = scenario?.turns ?? [];
  let t = turns.find((x, i) => !used.has(i) && x.match && x.match.test(text));
  if (!t) t = turns.find((x, i) => !used.has(i) && !x.match);
  if (t) used.add(turns.indexOf(t));
  for (const s of t?.steps ?? [{ wait: 800 }, { say: 'On it.' }]) {
    if (!turnActive) break;
    await step(s, true);
  }
  turnActive = false;
  send({ t: 'turn-done', ok: true });
  send(status());
}
async function pump() {
  while (queue.length) await turn(queue.shift());
}

// history: written once, before the first hello, so the server tails it whole
if (scenario?.history && !existsSync(tpath())) {
  for (const s of scenario.history) await step(s, false);
  clock = null;
}

function connect() {
  const sock = new WebSocket(`${apiUrl.replace(/^http/, 'ws')}/ws/agent-runner/${paneId}`);
  ws = sock;
  sock.on('open', () => {
    send(hello());
    send(status());
    if (scenario?.titleOnBoot) send({ t: 'title', title: scenario.titleOnBoot });
  });
  sock.on('message', (data) => {
    let f;
    try {
      f = JSON.parse(String(data));
    } catch {
      return;
    }
    if (f.t === 'send' && typeof f.text === 'string') {
      queue.push(f.text);
      if (queue.length === 1 && !turnActive) void pump();
    } else if (f.t === 'stop') {
      turnActive = false;
    }
  });
  sock.on('close', () => setTimeout(connect, 1000));
  sock.on('error', () => {});
}
log(`boot key=${key} sid=${sid} cwd=${cwd}`);
connect();
setInterval(() => {}, 1 << 30);
