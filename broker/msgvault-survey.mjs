#!/usr/bin/env node
/**
 * WHAT CAN THIS msgvault DO FOR AN AGENT, AND WHAT DOES MUXPAD OFFER?
 *
 *   node broker/msgvault-survey.mjs
 *
 * Every capability muxpad was missing cost an admin install to add: the
 * attachment fetch, then compose, then the calendar. Each one was found the
 * same way — a chat failed in front of the owner — and each needed its own
 * `sudo update-code.sh`. "each time it requires me to go run stuff."
 *
 * The information was always available locally. The CLI enumerates its own
 * commands, and it decides what an agent may do CLIENT-SIDE: against a dead
 * loopback port with an empty token it still answers "not available in
 * agent-delegated mode" for what is forbidden, and fails at the network for
 * what is allowed. No daemon, no archive, no privileges, no mail.
 *
 * So this prints three lists: offered, AVAILABLE BUT NOT OFFERED (the ones
 * worth a single release instead of five), and refused. Run it after any
 * msgvault upgrade.
 */
import { execFileSync } from 'node:child_process';
import { CAPABILITIES } from './capabilities.mjs';

const BINARY = process.env.MSGVAULT_BIN ?? '/usr/local/libexec/msgvault/msgvault';
const DELEGATED = [
  '--agent-url',
  'http://127.0.0.1:1',
  '--agent-token-file',
  '/dev/null',
  '--agent-allow-insecure',
  '--no-log-file',
];

function run(args) {
  try {
    return { ok: true, out: execFileSync(BINARY, args, { encoding: 'utf8', timeout: 20_000, stdio: 'pipe' }) };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || e.message) };
  }
}

/** Top-level commands, from the binary's own help. */
function commands() {
  const help = run(['--help']).out;
  const names = new Set();
  for (const line of help.split('\n')) {
    const m = /^\s{2}([a-z][a-z0-9-]+)\s{2,}\S/.exec(line);
    if (m?.[1] && !['help', 'completion', 'version'].includes(m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

const offered = new Set(
  CAPABILITIES.msgvault.actions.map((a) => a.replace(/^msgvault\./, '').split(' ')[0]),
);
const available = [];
const refused = [];
for (const cmd of commands()) {
  // No arguments: enough to reach the delegated-mode gate, never enough to
  // do anything. A verb that needs args answers about ITS ARGS, which means
  // it got past the gate.
  const { out } = run([cmd, ...DELEGATED, '--json']);
  if (/not available in agent-delegated mode/i.test(out)) refused.push(cmd);
  else available.push(cmd);
}

/**
 * "Not refused by delegated mode" is a long way from "an agent should ever
 * call this". The archive's own ADMINISTRATION — connecting accounts,
 * minting tokens, syncing, backing up, repairing, the TUI — is the owner's
 * work on their own machine, and several of those verbs would widen the
 * grant if they ran at all (`agent-token`, `credentials`, `export-token`).
 * They are not candidates; they are the things the broker exists to keep out
 * of reach.
 *
 * So the suggestion list is what is left after the install's own plumbing:
 * verbs about the owner's CONTENT.
 */
const ADMIN =
  /^(add|sync|backfill|repair|rebuild|delete|stage|show-deletion|list-deletions|migrate|init|setup|serve|tui|update|upgrade|backup|restore|verify|schema|credentials|agent-token|export-token|oauth|login|logout|pack|unpack|create-subset|archive-remote|deduplicate|merge|eval|skills|activity|daemon|doctor|cache|embeddings|index|reindex|vacuum|stats-rebuild)/;
const missing = available.filter((c) => !offered.has(c) && !ADMIN.test(c));
const say = (title, list) =>
  console.log(`\n${title} (${list.length})\n${list.length ? `  ${list.join('\n  ')}` : '  —'}`);
say('OFFERED by muxpad', [...offered].sort());
say('CONTENT verbs an agent could use but muxpad does not offer', missing);
console.log(
  '\n  (each still has to be checked by hand: delegated mode is only the FIRST\n' +
    '   gate, and the daemon can refuse on permissions afterwards.)',
);
say('REFUSED by msgvault in delegated mode — a verb here can never work', refused);
