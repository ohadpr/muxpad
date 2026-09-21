// Claude backend — the Anthropic Agent SDK behind the AgentBackend seam. This
// is the entire Claude/SDK surface of the runner: a persistent streaming
// `query()` session, the in-process MCP question/show-files tools, subagent
// progress, self-titling, the context/model status meter, and the turn queue.
// The harness (../index.ts) owns everything provider-neutral and drives this
// through the AgentBackend methods; this file emits frames via `host.emit`.
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  type Options,
  type SDKUserMessage,
  createSdkMcpServer,
  query,
  tool,
} from '@anthropic-ai/claude-agent-sdk';
import {
  LAUNCH_ACK_RE,
  REPLY_ACK,
  blockText,
  isAgentLaunchTool,
  needsReplyFallback,
  parseCronMarker,
  subagentLabel,
  summarizeToolInput,
  taskNotificationToolUseId,
} from '@muxpad/shared';
import { z } from 'zod';
import { readAgentInstructions } from '../../agent-instructions.js';
import { readChatModeOverlay, wrapModeNote } from '../../agent-modes.js';
import { findTranscript } from '../../chat/TranscriptReader.js';
import { bold, dim } from '../ansi.js';
import { AuthHealPolicy, authGiveUpNotice, isAuthFailureText } from '../auth-heal.js';
import type { AgentMode, AgentQuestion, NotifyStatus, RunnerFrame } from '../protocol.js';
import { ReplyBlockTracker, replyToolUseId } from '../reply-stream.js';
import {
  classifyAction,
  denialNote,
  gateEnabled,
  gateQuestion,
  isApproval,
} from '../reversibility.js';
import { markSessionTurned, sessionHadTurn } from '../session-marks.js';
import { SubagentRoster } from '../subagent-roster.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

// Default model for a FRESH agent chat with no explicit `--model` pin: muxpad
// starts new chats on Opus rather than the account/settings default. A resume
// deliberately gets NO default (undefined) so an existing session keeps the
// model it was running — this only steers brand-new chats. Still switchable
// per-session via the model picker (set-model).
const DEFAULT_AGENT_MODEL = 'opus';

/**
 * The universal muxpad instructions (<dataDir>/agent-instructions.md) PLUS —
 * when the pane launched in Chat mode — the Chat-mode overlay
 * (<dataDir>/chat-mode.md), as an SDK `systemPrompt` option.
 *
 * Injection mechanism for the CLAUDE backend, identical for both blocks: the
 * Agent SDK's NATIVE preset+append — the default claude_code system prompt
 * (with CLAUDE.md, settings, skills all loading exactly as before) plus our
 * text appended. Both files missing/empty → undefined, and the option is
 * omitted entirely (inject nothing, no error).
 *
 * Order matters: the standing instructions describe muxpad's CAPABILITIES,
 * the mode overlay describes HOW to behave. Behavior last, so it reads as the
 * most recent (and therefore governing) instruction.
 *
 * Exported for tests: constructing the backend spawns a real SDK session, so
 * the option-building is the testable seam.
 */
export function claudeSystemPromptOption(
  instructions: string | null,
  modeOverlay: string | null = null,
): Options['systemPrompt'] | undefined {
  const append = [instructions, modeOverlay]
    .filter((s): s is string => !!s?.trim())
    .map((s) => s.trim())
    .join('\n\n');
  return append ? { type: 'preset', preset: 'claude_code', append } : undefined;
}

/**
 * The `reply` tool's description, built from the session's LAUNCH mode.
 *
 * A tool description is a system-prompt-strength instruction, and this one used
 * to open with "your plain assistant text is a private scratchpad they never
 * see" in both modes. In Agent mode that is false — plain text is the voice
 * there — and a live Claude, with no way to check, believed it: measured over
 * live Agent-mode turns, three of five called `reply` and then ALSO wrote a
 * closing recap for an audience they thought did not exist, so the user read
 * the same answer twice, the second time in the third person. With the wording
 * below, zero of seven did.
 *
 * Agent mode therefore gets a description that says plainly what is true of
 * it. The tool stays registered (a mid-session switch cannot add tools) but it
 * now advertises itself as inert until the switch note says otherwise.
 *
 * Exported for tests: constructing the backend spawns a real SDK session, so
 * the description-building is the testable seam.
 */
export function replyToolDescription(): string {
  return [
    'Say something to the user. This is your ONLY voice: your plain assistant text is a private scratchpad they never see, and nothing is delivered until it is the content of a reply call.',
    'The screen already shows your tool calls, their diffs and output, every subagent you launched, and the tool you are running right now. Point at that; restating it is what makes a reply long.',
    'A reply is the answer in its first sentence. Lead with the OUTCOME and the ARTIFACT — the destination a file landed in, the link, the command to run. "Done" on its own is not evidence.',
    'One to three lines is the size, and under 400 characters for the whole turn. Real replies look like: "Fixed — `PaneRuntime.spawn` set `tab_id` before the row existed. Suite green." / "~/Documents/2026-taxes.pdf" / "Three agents are on it. I\'ll come back when the last one lands."',
    'One claim, not a survey: the strongest point and its reason, then OFFER the rest ("two smaller ones, want them?"). Prose, not a document — no bold headings, no bulleted survey. If the answer really wants that shape, write it to a file and reply with the path.',
    'Say it in full when it matters: errors the user must act on (message verbatim), security or data-loss warnings, anything irreversible, and any direct request for depth.',
    // ONE reply, at the END. The previous wording asked for "two to four" and
    // measured a median of three per turn at ~1,600 chars each — the model
    // reported every subagent as it returned, so the user got a stream of walls
    // while the work was still running. Progress is already on screen.
    'Send ONE reply, when you have an answer — not as you go. Do not narrate progress or report subagents as they finish; the roster and the working row already show that live. Your reply ends the turn.',
  ].join(' ');
}

/**
 * The `notify` tool's description — the whole UX of this feature.
 *
 * A tool description is a system-prompt-strength instruction, and for a tool
 * whose effect is a vibration in someone's pocket it is also the only thing
 * standing between "the agent can finally reach me" and "I muted muxpad".
 * Two things it has to do that a naive description does not:
 *
 *  - Say when NOT to call it, concretely. muxpad ALREADY pushes when a turn
 *    ends more than two minutes after the user last typed, so the single most
 *    likely misuse is a notify sitting next to the final reply of a normal
 *    turn — two buzzes, the second one worse. That case is named outright.
 *  - Make every non-delivery a NON-EVENT. A model that reads "held" or "no
 *    devices" as a failure will retry, and a retry loop is the exact thing the
 *    rate limit exists to survive. The outcomes are stated as normal, with the
 *    correct fallback (put it in the reply).
 *
 * Exported for tests: constructing the backend spawns a real SDK session, so
 * the description is the testable seam.
 */
export function notifyToolDescription(): string {
  return [
    "Buzz the user on their phone and their desktop — a real push notification on the lock screen, wherever they are. Tapping it opens THIS pane. It is the only way you can reach someone who isn't looking at the screen.",
    'Call it when something cannot wait for the end of the turn: a long run hit a blocker only they can clear, a deploy or a suite failed, a watch they asked you to keep just fired, or you are about to spend a long time on something they should know about now. Also call it once, with the result, at the end of a long autonomous run (a cron, a wakeup, an overnight batch) they are actually waiting on.',
    'Do NOT call it to announce an ordinary finished turn. A turn that ends more than two minutes after the user last typed already notifies them on its own, so a notify next to your final reply just buzzes them twice, the second time with less news. Do not use it for progress updates, for anything that can wait until they next look at the screen, or twice in a minute — this pane sends at most one notification per minute and the rest are dropped.',
    'The `text` IS the notification: one sentence, on a lock screen, all they get until they tap. Name what happened and what it needs — "staging deploy failed: migration 0042 timed out" or "the 40-file rename is done, 3 conflicts need you" — never "check muxpad" or "I have an update".',
    'The result tells you what happened: sent, held because the user is already at a device, no subscribed device on this server, or dropped by the rate limit. None of those is an error and none is a reason to call again — if it was not sent, say the thing in your reply instead.',
  ].join(' ');
}

// ─── The SDK's task lifecycle → the subagent roster ─────────────────────────
// The SDK reports background work on its own channel, independent of the
// message stream: `task_started` / `task_notification` / `task_updated` edges
// and `background_tasks_changed`, the full live-set LEVEL. That channel is the
// roster's source of truth — the message-shape recognisers (a `Task` tool_use,
// a `<task-notification>` text) only cover what the CONVERSATION happens to
// show, and a background agent's end is routinely not in it.
//
// Split out of the session loop because constructing this backend spawns a real
// SDK session: this is the only way the message SHAPES — every one of whose
// id fields is optional — get a unit test.

const TASK_LIFECYCLE_SUBTYPES = new Set([
  'task_started',
  'task_progress',
  'task_notification',
  'task_updated',
  'background_tasks_changed',
]);

export function isTaskLifecycle(subtype: string): boolean {
  return TASK_LIFECYCLE_SUBTYPES.has(subtype);
}

/** The fields we read, all optional exactly as the SDK declares them. */
export interface TaskLifecycleMessage {
  subtype: string;
  task_id?: string;
  tool_use_id?: string;
  tasks?: Array<{ task_id: string }>;
  patch?: { status?: string; is_backgrounded?: boolean };
}

/** Task ids whose `task_updated` means the task is OVER. */
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'killed']);

/**
 * Is this launch a BACKGROUND one? Read off the launching tool_use INPUT, which
 * is where the SDK actually states it.
 *
 * This has to come from a typed field, not from prose. The tool_result texts do
 * NOT distinguish the two reliably: probe-verified (0.3.220), a FOREGROUND
 * Agent's completion carries its own `agentId: <task_id>` trailer, and its body
 * is the subagent's report — which, in a codebase whose agents write about
 * launching agents, can say "async agent launched" as easily as the real ack
 * does. Classifying on that text is how a foreground row gets marked background
 * and becomes unreachable by every end-path that applies to it.
 *
 * Default when the flag is absent: sdk-tools.d.ts says of `Agent`'s
 * `run_in_background?: boolean` — "Agents run in the background by default; you
 * will be notified when one completes." The legacy `Task` name carries no such
 * documented default here, so an unflagged `Task` is treated as foreground.
 */
export function isBackgroundLaunch(name: string, input: unknown): boolean {
  const flag = (input as { run_in_background?: unknown } | null | undefined)?.run_in_background;
  if (typeof flag === 'boolean') return flag;
  return name === 'Agent';
}

/** The machine trailer the SDK appends to a FINISHED agent's tool_result
 *  (`<usage>subagent_tokens: … tool_uses: … duration_ms: …</usage>`).
 *  A launch ack never carries one — probe-verified both ways. */
const COMPLETION_TRAILER_RE = /<usage>[\s\S]*?<\/usage>/;

/** Is this tool_result the immediate "launched" ACK rather than a completion? */
export function isLaunchAck(text: string): boolean {
  return !COMPLETION_TRAILER_RE.test(text) && LAUNCH_ACK_RE.test(text);
}

/**
 * The task id a BACKGROUND launch ack carries, or null.
 *
 * Probe-verified (SDK 0.3.220, seventeen background launches across four runs,
 * counting the repro harness's): the top-level `tool_result` for a
 * `run_in_background` Agent call is always shaped
 *
 *     Async agent launched successfully. (…internal metadata…)
 *     agentId: ae957386e1ac03ddb (internal ID - … Use SendMessage with to: '…')
 *     The agent is working in the background. …
 *
 * This is the ONLY tool_use_id ↔ task_id binding that rides in the conversation
 * itself. The `system/task_started` binding is the SDK's, and its `tool_use_id`
 * is declared OPTIONAL — an omitted one leaves the entry with no task id, and an
 * entry with no task id is invisible to BOTH background end-paths
 * (`reconcileBackground` skips it, `doneByTaskId` cannot match it).
 */
export function launchAckTaskId(text: string): string | null {
  if (!isLaunchAck(text)) return null;
  return /\bagentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
}

export function applyTaskLifecycle(roster: SubagentRoster, msg: TaskLifecycleMessage): void {
  switch (msg.subtype) {
    // Both bind task id ↔ launching tool_use. Ids we never launched (nested
    // agents, background Bash) are ignored inside bindTask. `task_progress` is
    // here purely as a SECOND chance at the binding: it carries the same pair,
    // and `task_started`'s `tool_use_id` is optional.
    case 'task_started':
    case 'task_progress':
      if (msg.tool_use_id && msg.task_id) roster.bindTask(msg.tool_use_id, msg.task_id);
      break;
    case 'task_notification':
      // BOTH keys: `tool_use_id` is optional on this message and `task_id` is
      // not, so keying only on the former would leave an entry with no edge
      // end-path at all whenever the SDK omits it.
      if (msg.tool_use_id) roster.done(msg.tool_use_id);
      if (msg.task_id) roster.doneByTaskId(msg.task_id);
      break;
    case 'task_updated': {
      if (!msg.task_id) break;
      const status = msg.patch?.status;
      if (status && TERMINAL_TASK_STATUSES.has(status)) {
        roster.doneByTaskId(msg.task_id);
        break;
      }
      // A paused task may leave the live set without dying — see pauseTask.
      if (status === 'paused') roster.pauseTask(msg.task_id);
      else if (status === 'running') roster.resumeTask(msg.task_id);
      // …and so does one that has just been UN-backgrounded. The level doc lists
      // "a foreground agent being backgrounded" as a membership change, so the
      // inverse drops the task from the live set while the agent runs on.
      // Absence must not kill it.
      if (msg.patch?.is_backgrounded === false) roster.pauseTask(msg.task_id);
      else if (msg.patch?.is_backgrounded === true) roster.resumeTask(msg.task_id);
      break;
    }
    case 'background_tasks_changed':
      roster.reconcileBackground((msg.tasks ?? []).map((t) => t.task_id));
      break;
  }
}

/** The SDK message fields the roster reads. Deliberately structural, so a
 *  RECORDED stream can be replayed through this verbatim. */
export interface SubagentStreamMessage {
  type: string;
  subtype?: string;
  parent_tool_use_id?: string | null;
  message?: { content?: unknown };
}

type ContentBlock = {
  type?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
};

function blocksOf(msg: SubagentStreamMessage): ContentBlock[] {
  const c = msg.message?.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? (c as ContentBlock[]) : [];
}

/**
 * EVERY roster mutation the SDK message stream can cause, in one place.
 *
 * Extracted from the session loop for one reason: the loop is unreachable from a
 * test (constructing the backend spawns a real SDK session), and the roster's
 * end-paths have now been got wrong twice while its unit tests — which speak the
 * roster's own API, not the SDK's — stayed green. This function speaks the SDK's
 * wire shapes, so `claude.replay.test.ts` can drive it with message streams
 * RECORDED from a real 0.3.220 session and assert the roster empties.
 *
 * Turn-boundary work lives in {@link applyTurnResult}: it needs the turn's own
 * state (was it interrupted?), not just the message.
 */
export function applySubagentMessage(roster: SubagentRoster, msg: SubagentStreamMessage): void {
  if (msg.type === 'system') {
    if (msg.subtype && isTaskLifecycle(msg.subtype)) {
      applyTaskLifecycle(roster, msg as unknown as TaskLifecycleMessage);
    }
    return;
  }

  // The SDK declares `parent_tool_use_id: string | null` on every message that
  // has one — never optional. Match `null` exactly rather than "not a string",
  // so a degraded frame that omits the field is ignored instead of silently
  // treated as top level (where it could both create and retire rows).
  const parent = msg.parent_tool_use_id;

  // Subagent traffic (parent set): live progress on the parent Task row.
  //
  // NOTE this stream also carries NESTED agents' traffic, tagged with the nested
  // tool_use id (probe-verified, 0.3.220). Those ids are not in the roster and
  // `activity` ignores them — a grandchild's launch AND its end both live inside
  // its parent's stream, so an adopted one could never be retired. That adoption
  // is what made `agents:` climb forever.
  if (typeof parent === 'string') {
    if (msg.type !== 'assistant' && msg.type !== 'user') return;
    let lastTool: string | undefined;
    if (msg.type === 'assistant') {
      for (const b of blocksOf(msg)) {
        if (b.type === 'tool_use' && b.name) {
          const arg = summarizeToolInput(b.name, b.input);
          lastTool = arg ? `${b.name}: ${arg}` : b.name;
        }
      }
    }
    roster.activity(parent, lastTool);
    return;
  }

  if (parent !== null) return;

  if (msg.type === 'assistant') {
    // A Task/Agent call is a subagent LAUNCH. Roster it here, at the parent's
    // tool_use: this is the only message carrying the description AND the
    // run_in_background flag, and a background subagent's first child message
    // can be a minute away.
    for (const b of blocksOf(msg)) {
      if (
        b.type === 'tool_use' &&
        b.name &&
        isAgentLaunchTool(b.name) &&
        typeof b.id === 'string'
      ) {
        roster.launch(
          b.id,
          subagentLabel(b.input) || 'subagent',
          isBackgroundLaunch(b.name, b.input),
        );
      }
    }
    return;
  }

  if (msg.type === 'user') {
    // TOP-LEVEL user traffic is where a subagent's END shows up, in two shapes —
    // both must retire the entry, or a finished agent lingers forever now that
    // nothing expires it on a timer:
    //  1. the parent's own tool_result for the Task call (a FOREGROUND
    //     subagent's completion).
    //  2. the `<task-notification>` the harness injects when a BACKGROUND
    //     subagent finishes, which carries the launching tool-use-id.
    //
    // A background launch's immediate ack is NEITHER — but telling it apart from
    // a completion cannot rest on the launch phrase alone. Probe-verified
    // (0.3.220): a FOREGROUND Agent's completion carries its own `agentId:`
    // trailer and its body is the subagent's report, which in this codebase can
    // say "async agent launched" verbatim. What separates them is the machine
    // `<usage>` trailer only a FINISHED agent gets — see isLaunchAck.
    for (const b of blocksOf(msg)) {
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        if (!roster.has(b.tool_use_id)) continue;
        const text = blockText(b.content);
        const taskId = launchAckTaskId(text);
        if (taskId) roster.bindBackgroundTask(b.tool_use_id, taskId);
        // An ack that says "launched" but carries no `agentId:` still PROVES the
        // launch happened, which is the fact `retireUnstarted` needs. Binding a
        // null task id records exactly that: acked, not yet bound. Drop this
        // branch and `launchAcked` becomes unreachable — the turn's `result`
        // then retires a live background agent that simply has not reached its
        // first child message yet (probe: up to 44s).
        else if (isLaunchAck(text)) roster.bindBackgroundTask(b.tool_use_id, null);
        else roster.done(b.tool_use_id);
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const id = taskNotificationToolUseId(b.text);
        if (id) roster.done(id);
      }
    }
  }
}

/**
 * The roster work a turn `result` does. Exported for the same reason as
 * {@link applySubagentMessage}: it is policy, and policy the loop hides is
 * policy nothing tests.
 *
 * Emphatically does NOT clear the roster on a successful turn: a
 * `run_in_background` Task routinely outlives the turn that launched it, and
 * clearing here is what made those subagents vanish from the sidebar the instant
 * the turn ended.
 */
export function applyTurnResult(
  roster: SubagentRoster,
  subtype: string,
  interrupted: boolean,
): void {
  // Push any throttled-but-unsent progress.
  roster.flush();
  // A `Task` tool_use that never actually ran — a retracted refusal leg, a call
  // the harness dropped — produces no task_started, no tool_result and no child
  // traffic, so no end-path can reach it. The turn's end is where "it produced
  // nothing at all" becomes decidable.
  roster.retireUnstarted();
  // …and a turn that was STOPPED or FAILED takes its FOREGROUND subagents down
  // with it silently. Its BACKGROUND ones are a different matter: the SDK
  // announces the kills it makes and the level payload at the interrupt still
  // lists the agents earlier turns launched, which keep running. See
  // retireForeground — retiring everything here was deleting live agents.
  if (interrupted) roster.retireForeground('stopped');
  else if (subtype !== 'success') roster.retireForeground('turn failed');
}

export function createClaudeBackend(host: RunnerHost, opts: BackendOptions): AgentBackend {
  const { emit, log } = host;
  const { requestedSid, requestedModel } = opts;

  // ── Agent mode (⚡ do / 🧠 deep) ──────────────────────────────────────────
  // The LAUNCH mode is the only one that can reach the SDK as system-prompt
  // material (systemPrompt is fixed at query() construction and the Query
  // control surface has no prompt mutator — see agent-modes.ts). A later
  // switch sets `pendingModeNote`, which rides the next user message as a
  // delimited <muxpad-mode> block.
  let currentMode: AgentMode = opts.mode;
  let pendingModeNote: string | null = null;
  function setMode(next: AgentMode): void {
    if (next === currentMode) return;
    currentMode = next;
    pendingModeNote = wrapModeNote(next, readChatModeOverlay(next));
    log(dim(`mode → ${next} (applies from the next message; the live system prompt is fixed)`));
  }

  // The self-heal startup_cmd is written on hello — BEFORE any turn — so a pane
  // can respawn with `--resume <sid>` for a session that never wrote a
  // transcript. `resume` on a transcript-less sid kills the session ("no
  // conversation found"); start fresh UNDER that id instead, exactly like the
  // headless runner's fresh-mode fallback. Either way the pane keeps the id.
  const resumeSid = requestedSid && findTranscript(requestedSid) ? requestedSid : null;
  // A resume we had to drop. Two very different situations wear the same face
  // on disk — see session-marks.ts — and only the mark can tell them apart.
  // When the session DID talk to someone and its transcript is gone anyway,
  // history is being lost right here, and the old log line ("no transcript
  // YET") said the opposite of the truth. Say it plainly, and reach the user:
  // this is not something they can discover by reading a pane log later.
  let lostHistoryNotice: string | null = null;
  if (requestedSid && !resumeSid) {
    if (sessionHadTurn(requestedSid)) {
      log(
        `${bold('⚠ history lost')} — session ${requestedSid} had turns but its transcript is gone; starting a NEW conversation under that id`,
      );
      log(
        dim(
          '  (the transcript lives in <CLAUDE_CONFIG_DIR|~/.claude>/projects/<cwd>/<sid>.jsonl — a pruned dir, a moved config or a changed HOME all land here)',
        ),
      );
      lostHistoryNotice = `${basename(process.cwd())}: an agent pane lost its conversation — session ${requestedSid.slice(0, 8)} had history but no transcript on disk, so it restarted empty.`;
    } else {
      log(`no transcript yet for ${requestedSid} — starting the session fresh under that id`);
    }
  }
  const sid = requestedSid ?? randomUUID();
  // The id the live session actually runs under — updated if a resume drifts.
  let liveSid = sid;

  /**
   * Remember that this session has a transcript on disk, so a future respawn
   * that cannot find one knows whether that is normal (never used) or a
   * conversation going missing. See session-marks.ts.
   *
   * The mark is written only once `findTranscript` has actually SEEN the file,
   * never merely because a turn happened: the mark's whole meaning is "a
   * transcript existed here", and recording a turn that produced no file would
   * make every later respawn cry wolf. Called at the end of a completed turn —
   * by then the CLI has written it — and at most once per session id.
   */
  let markedSid: string | null = null;
  function markTurn(): void {
    if (markedSid === liveSid) return;
    if (!findTranscript(liveSid)) return;
    markedSid = liveSid;
    markSessionTurned(liveSid);
  }

  // -------------------------------------------------------------------------
  // Turn queue. Sends arriving from chat are serialized: one user turn in
  // flight at a time, the next yielded to the SDK only after the previous
  // turn's result. (The SDK would accept queued messages, but merging/queuing
  // semantics are its own; explicit serialization keeps turn-start/turn-done
  // accounting exact for the chat UI.)
  // -------------------------------------------------------------------------
  const pendingTexts: string[] = [];
  let inTurn = false;
  // Timestamp of the last message seen from the SDK session — the "is a query
  // actually alive" signal the failed-interrupt disambiguation relies on.
  // NOTE: silent stretches inside a long tool call don't advance it, so the
  // quiet-window reset can false-positive there — which is why it never
  // kick()s the queue (see the stop handler).
  let lastSessionActivityAt = 0;
  // The single pending quiet-window check for a failed interrupt.
  let interruptFailTimer: ReturnType<typeof setTimeout> | null = null;
  let interruptRequested = false;
  let wakeQueue: (() => void) | null = null;
  const kick = () => {
    wakeQueue?.();
    wakeQueue = null;
  };

  // ── Self-heal state (see auth-heal.ts for what this is for) ───────────────
  // Bumped every time the SDK session is (re-)spawned. The user-message
  // generator is bound to ONE epoch: a generator left behind by a re-exec must
  // never hand the next user turn to the dead child, so it returns instead.
  let sessionEpoch = 0;
  /** The text of the turn in flight — what a re-exec has to put back. */
  let currentTurnText: string | null = null;
  /** The auth message seen during the current turn, if any. */
  let authFailureThisTurn: string | null = null;
  /**
   * Tool calls made in the current turn — the classifier's corroboration.
   *
   * A dead credential fails BEFORE the child reaches a model (0.05 s, $0, one
   * message), so it can never have called anything. A turn that did call
   * something was working, and whatever it wrote about auth is a note about
   * auth. In Chat mode that covers the whole normal shape twice over, since
   * the `reply` that ends a good turn is itself a tool call.
   */
  let toolUsesThisTurn = 0;
  const authHeal = new AuthHealPolicy(
    opts.authHealDelaysMs ? { delaysMs: opts.authHealDelaysMs } : {},
  );
  /**
   * Set by the turn-result branch when a turn died of a dead credential; read
   * by the session loop, which is the only place allowed to tear the session
   * down and build another.
   */
  let healPlan: { delayMs: number; attempt: number; of: number; retry: string | null } | null =
    null;
  /** Set by shutdown(): a heal parked on its backoff must not resurrect the
   *  session after the runner has been told to die. */
  let shuttingDown = false;

  // -------------------------------------------------------------------------
  // ask_user: the chat-native question tool. Claude Code's own AskUserQuestion
  // is not offered to SDK-hosted sessions (spike-verified), so the runner
  // provides an equivalent through the SDK's in-process MCP server: the model
  // calls it, the question renders as tappable chips in the chat UI, and the
  // tool call blocks until the answer frame comes back (or the turn is
  // interrupted — Stop resolves it so the session never wedges).
  // -------------------------------------------------------------------------
  interface PendingQuestion {
    qid: string;
    /** The frame, kept so a server reconnect can re-deliver the question. */
    frame: RunnerFrame & { t: 'question' };
    resolve: (answers: Array<{ question: string; answers: string[] }> | null) => void;
  }
  const pendingQuestions = new Map<string, PendingQuestion>();

  function resolveAllQuestions(reason: 'interrupted' | 'shutdown'): void {
    for (const [qid, pq] of pendingQuestions) {
      pendingQuestions.delete(qid);
      emit({ t: 'question-done', qid });
      log(dim(`question dismissed (${reason})`));
      pq.resolve(null);
    }
  }

  /**
   * Put a question to the user and BLOCK until it is resolved.
   *
   * Extracted from `ask_user` so the reversibility gate can reuse the exact
   * same machinery — same frame, same tappable chips, same `blocked` pane
   * status, same push, same re-delivery on reconnect. A second approval UI
   * would be a second set of bugs and a second thing for the user to learn.
   *
   * Resolves with `null` when the question is DISMISSED rather than answered
   * (Stop, or runner shutdown). There is no timer: see the gate's note on why
   * an unanswered question must not lapse.
   */
  function askUser(questions: AgentQuestion[]): Promise<Array<{
    question: string;
    answers: string[];
  }> | null> {
    const qid = randomUUID();
    return new Promise((resolve) => {
      const frame = { t: 'question', qid, questions } as const;
      pendingQuestions.set(qid, { qid, frame, resolve });
      emit(frame);
    });
  }

  // ── LENGTH BUDGETS ARE TARGETS; ONLY STRUCTURE IS A HARD RULE ─────────────
  /**
   * Trim a display string to its budget, marking that it was trimmed. The
   * counterpart to NOT capping these in the schema: something over budget is
   * rendered short, never refused.
   */
  const clampDisplay = (s: string, max: number): string =>
    s.length > max ? `${s.slice(0, max - 1)}…` : s;

  // A zod `.max()` on a tool argument is NOT advice — it reaches the wire
  // schema as `maxLength` and the MCP layer validates against it, so a string
  // one word over budget comes back to the model as a tool ERROR in the middle
  // of a turn. (Checkable from any agent pane: the tool listing a session
  // actually receives shows `mcp__muxpad__notify` with `"maxLength": 180` and
  // these questions with 16/80/300/500 — the exact zod numbers. An older
  // comment in this file asserted the opposite, that both the Anthropic and
  // OpenAI SDKs strip it; they do not, and `reply` was written around that
  // false belief.)
  //
  // For a DISPLAY string the error is strictly worse than the overflow: a
  // 20-character chip label renders a little wide, while a failed `ask_user`
  // leaves an agent blocked on a decision it could not ask about. So the
  // budgets live in the descriptions, where they steer generation, and the
  // handler clamps what it renders.
  //
  // STRUCTURE stays hard — 1–3 questions, 2–5 options — because a one-option
  // question is not a question and no amount of truncation makes it one. That
  // is a thing the model must fix, which is what a tool error is FOR.
  const OptionSchema = z.object({
    label: z.string().min(1).describe('Concise display text (1–5 words; ~80 chars, then trimmed)'),
    description: z
      .string()
      .optional()
      .describe('What choosing this means (~300 chars, then trimmed)'),
  });
  const QuestionSchema = z.object({
    question: z
      .string()
      .min(1)
      .describe('The complete question, ending with a question mark (~500 chars, then trimmed)'),
    header: z
      .string()
      .min(1)
      .describe('Very short chip label, e.g. "Approach" (~16 chars, then trimmed)'),
    multiSelect: z.boolean().optional().describe('Allow selecting multiple options'),
    options: z.array(OptionSchema).min(2).max(5),
  });

  const askUserTool = tool(
    'ask_user',
    'Ask the user 1–3 multiple-choice questions when you are blocked on a decision only they can make. Each question renders as tappable options in the muxpad chat UI (the user may also type a custom answer). Use it sparingly: for reversible choices with a sensible default, proceed without asking.',
    { questions: z.array(QuestionSchema).min(1).max(3) },
    async (args) => {
      // Clamped HERE rather than at the schema — see the budgets note above.
      const questions: AgentQuestion[] = args.questions.map((qq) => ({
        question: clampDisplay(qq.question, 500),
        header: clampDisplay(qq.header, 16),
        multiSelect: qq.multiSelect === true,
        options: qq.options.map((o) => ({
          label: clampDisplay(o.label, 80),
          ...(o.description ? { description: clampDisplay(o.description, 300) } : {}),
        })),
      }));
      log(`${bold('? asking user')} ${questions.map((qq) => qq.header).join(', ')}`);
      const answers = await askUser(questions);
      if (!answers) {
        return {
          content: [
            { type: 'text' as const, text: 'The user dismissed the question without answering.' },
          ],
        };
      }
      const text = answers
        .map((a) => `${a.question}\n→ ${a.answers.join(', ') || '(no selection)'}`)
        .join('\n\n');
      log(dim(`answered: ${answers.map((a) => a.answers.join(', ')).join(' · ')}`));
      return { content: [{ type: 'text' as const, text }] };
    },
  );

  // Let the agent SHOW files in the chat: screenshots, videos, or documents.
  // Each local path is copied (server-side, disk-to-disk) into the pane's
  // served attachment dir; the returned served paths go verbatim into the
  // agent's reply, where muxpad renders them by type — images/videos inline
  // (multiple → a gallery), other files as a click-to-open chip. No server to
  // start, no Linear round-trip.
  const showFilesTool = tool(
    'show_files',
    'Show files to the user directly in THIS chat: screenshots, images, videos (mp4/webm), or documents (pdf, csv, txt, json, …). Save the file(s) locally first (e.g. `screencapture`, an ffmpeg/webm recording, or write a report), then pass their ABSOLUTE paths. Each is served and a path returned; include those returned paths in your reply — one per line, bare paths (not markdown links) — and they render inline: images/videos as thumbnails (several → a gallery), other files as a download chip. Use whenever the user asks to see/be shown something, or when a file is the best way to share output.',
    {
      paths: z
        .array(z.string())
        .min(1)
        .describe('Absolute paths of local files to show (images, videos, or documents).'),
    },
    async (args) => {
      const served: string[] = [];
      const failed: string[] = [];
      for (const p of args.paths) {
        try {
          const res = await fetch(`${host.apiUrl}/api/panes/${host.paneId}/attachments/by-path`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: p }),
          });
          if (!res.ok) {
            failed.push(`${basename(p)} (${res.status}: ${(await res.text()).slice(0, 120)})`);
            continue;
          }
          const { path } = (await res.json()) as { path: string };
          served.push(path);
        } catch (err) {
          failed.push(`${basename(p)} (${(err as Error).message})`);
        }
      }
      log(
        `${bold('▸ show_files')} ${dim(`${served.length} shown${failed.length ? `, ${failed.length} failed` : ''}`)}`,
      );
      if (served.length === 0)
        return {
          content: [
            { type: 'text' as const, text: `Could not show any file: ${failed.join('; ')}` },
          ],
          isError: true,
        };
      const lines = [
        'Displayed to the user. Include these exact paths in your reply — one per line, bare paths (not markdown links) — so they render inline:',
        ...served,
      ];
      if (failed.length) lines.push(`(Failed: ${failed.join('; ')})`);
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );

  // -------------------------------------------------------------------------
  // notify: the agent deliberately reaching the user's DEVICES.
  //
  // Push used to be one heuristic: a turn that ends more than two minutes after
  // the user's last message notifies, everything else doesn't. That is a decent
  // default and it was the ONLY signal, so a five-second turn carrying
  // something urgent could not reach a phone and a ten-minute turn carrying
  // nothing always did. The agent is the one thing in the system that knows
  // which is which; this is where it gets to say so.
  //
  // The runner is a separate process and cannot touch the PushService, so the
  // mechanism is a frame out and a `notify-result` back (see protocol.ts). The
  // round trip is not ceremony: the server owns the rate limit, the presence
  // check and whether any device is even subscribed, and the tool's whole
  // contract is that it tells the model the truth about which of those
  // happened rather than claiming a delivery it cannot observe.
  // -------------------------------------------------------------------------

  /** How long to wait for the server's `notify-result` before giving up on it.
   *  Reached only by a server too old to know the frame — runners are
   *  version-skewed by design — so the answer is a neutral "no acknowledgement",
   *  never a throw that would derail the turn. */
  const NOTIFY_ACK_TIMEOUT_MS = 5_000;
  const pendingNotifies = new Map<string, (status: NotifyStatus | 'no-ack') => void>();

  /** The server's answer to a `notify` (harness → AgentBackend.notifyResult). */
  function notifyResult(nid: string, status: NotifyStatus): void {
    const resolve = pendingNotifies.get(nid);
    if (!resolve) return; // already timed out, or never ours
    pendingNotifies.delete(nid);
    resolve(status);
  }

  /** What the MODEL reads back. Each one says plainly whether the user was
   *  reached and what to do instead — a retry is never the answer. */
  const NOTIFY_RESULT_TEXT: Record<NotifyStatus | 'no-ack', string> = {
    sent: "Sent — it is on the user's devices now.",
    'held-active':
      'Not sent: the user is actively using a device right now, so they can already see this pane. Nothing more to do — this is normal, do not call again.',
    'no-devices':
      'Not sent: no device is subscribed to push on this server, so notifications are a no-op here. Say it in your reply instead; do not call again.',
    'rate-limited':
      'Dropped: this pane already sent a notification within the last minute. Put this in your reply instead; do not call again.',
    unavailable:
      'Not sent: this server has no push configured. Say it in your reply instead; do not call again.',
    'no-ack':
      'Sent, but the server did not acknowledge it, so delivery is unconfirmed. Do not call again — say it in your reply too.',
  };

  const notifyTool = tool(
    'notify',
    notifyToolDescription(),
    {
      text: z
        .string()
        .min(1)
        .describe(
          'The notification body — one sentence, naming what happened and what it needs, in about 180 characters (longer is trimmed). This is all the user sees until they tap it.',
        ),
    },
    async (args) => {
      // Newlines are invisible in a notification body and a lock screen collapses
      // them anyway; do it here so what we log is what they will read.
      //
      // The length is TRIMMED, not refused. It used to be a zod `.max(180)`,
      // which reaches the wire as `maxLength` and fails validation — turning
      // the one call that is only ever made because something cannot wait into
      // a mid-turn tool error, on a tool whose entire contract is "never give
      // the model something to retry". ws.ts clamps the body to the same two
      // lines before it reaches a device; this keeps the pane log honest about
      // what was actually delivered. (Two constants, deliberately equal —
      // NOTIFY_BODY_MAX in ws.ts is the server's own bound on a runner it does
      // not trust to be the same version as itself.)
      const text = clampDisplay(args.text.replace(/\s+/g, ' ').trim(), 180);
      if (!text) {
        return { content: [{ type: 'text' as const, text: 'Nothing sent — `text` was empty.' }] };
      }
      // A frame emitted while the socket is down is DROPPED, not queued (see
      // RunnerHost.emit), so waiting five seconds for an ack that cannot come
      // is pure latency in the middle of a turn.
      if (!host.connected()) {
        log(`${bold('✗ notify')} ${dim('not connected to muxpad — dropped')}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Not sent: this pane is not connected to muxpad right now. Say it in your reply instead.',
            },
          ],
        };
      }
      const nid = randomUUID();
      const status = await new Promise<NotifyStatus | 'no-ack'>((resolve) => {
        const timer = setTimeout(() => {
          pendingNotifies.delete(nid);
          resolve('no-ack');
        }, NOTIFY_ACK_TIMEOUT_MS);
        // Don't hold the process open on an ack that may never come.
        timer.unref?.();
        pendingNotifies.set(nid, (s) => {
          clearTimeout(timer);
          resolve(s);
        });
        emit({ t: 'notify', nid, text });
      });
      log(
        `${bold(status === 'sent' ? '🔔 notify' : '✗ notify')} ${status === 'sent' ? text : dim(`${status} — ${text}`)}`,
      );
      return { content: [{ type: 'text' as const, text: NOTIFY_RESULT_TEXT[status] }] };
    },
  );

  // -------------------------------------------------------------------------
  // reply: the agent's VOICE in Chat mode.
  //
  // The mechanism, not the plea. `chat-mode.md` has asked for brevity since
  // modes shipped and it demonstrably is not enough — you send the agent to do
  // something and it writes back two pages of deliberation and asks a question
  // it could have answered itself. Asking a model to be brief costs it nothing.
  //
  // What works is making deliberation FREE and speech EXPENSIVE: plain
  // assistant text becomes a private scratchpad the user never sees, and the
  // only way to reach them is a deliberate tool call. Reasoning stays
  // unlimited; every user-facing word is now a decision.
  //
  // Registered UNCONDITIONALLY, in both modes, even though only Chat mode
  // hides plain text. A pane that launched in Agent mode and was switched to
  // Chat mid-session cannot gain new tools — `mcpServers` is fixed at query()
  // construction, exactly like `systemPrompt` — and a Chat-mode session with no
  // `reply` tool is a session with no voice at all.
  //
  // …but "in Agent mode the tool is simply an unused one" was WRONG, and a
  // live model proved it: THREE of five Agent-mode turns called `reply`,
  // because the description asserted "your plain assistant text is a private
  // scratchpad they never see" — which in Agent mode is a lie the model has no
  // way to check. The user saw the answer twice: once as the reply bubble,
  // then again as a third-person recap ("Told the user, and offered to…"),
  // because the model wrote its closing prose believing nobody would read it.
  //
  // So the DESCRIPTION is built per-session from the launch mode. It is the
  // one lever available: the text is fixed at query() construction alongside
  // `systemPrompt` and `mcpServers`, and the launch mode is exactly what the
  // system prompt was built from, so the two always agree. A mid-session
  // switch still gets its tool (see wrapModeNote, which restates the contract
  // in-conversation and, in the agent→chat direction, is the thing that
  // overrides this description).
  //
  // Counting lives here because this is the only place a reply can happen, and
  // the turn-result guard below needs the count.
  // -------------------------------------------------------------------------
  let repliesThisTurn = 0;
  // Reply tool calls currently being GENERATED, so their argument deltas can be
  // decoded into speakable text before the call runs (see reply-stream.ts).
  const replyBlocks = new ReplyBlockTracker();
  // The turn's FIRST reply, not its last. The contract asks for one reply that
  // LEADS with the outcome, and allows a short run when there is a genuinely
  // separate second thing — so when a turn does send more than one, the later
  // ones are routinely the caveat ("one note: the calls ran in parallel") and
  // the first one is the answer. A push that quotes the trailing aside tells
  // the user the least useful thing the agent said.
  let firstReplyText = '';
  const replyTool = tool(
    'reply',
    replyToolDescription(),
    {
      text: z.string().min(1).describe(
        // The budget is stated HERE, in prose, as a TARGET rather than a cap —
        // the named exemptions above must stay reachable.
        //
        // It used to be stated here AND enforced as `.max(4000)`, on the
        // reasoning that "a schema maxLength would be theatre — both the
        // Anthropic and OpenAI SDKs strip it off the wire schema". That
        // reasoning was wrong (see the budgets note further up: the constraint
        // is right there in the tool listing a live session receives), so the
        // cap was real — and a reply is the ONE argument where a validation
        // error is unrecoverable in kind. Chat mode has no other channel out:
        // a refused `reply` is a turn that ends with zero replies, which the
        // guard covers by promoting the model's private scratchpad into the
        // user's answer. The 4,200-character security warning the exemption
        // exists for was exactly the shape that hit it.
        'What the user reads. Markdown renders. One to three lines is the normal size; go longer only for an error, a security or data-loss warning, an irreversible action, or when depth was asked for.',
      ),
    },
    async (args, extra) => {
      const text = args.text.trim();
      if (!text) return { content: [{ type: 'text' as const, text: REPLY_ACK }] };
      repliesThisTurn++;
      if (!firstReplyText) firstReplyText = text;
      // Feed the self-titler too: in Chat mode the plain text it would
      // otherwise read is scratchpad, and a title drawn from scratchpad
      // describes the agent's process rather than the conversation.
      if (!titleGenerated && firstAssistantText.length < 500) firstAssistantText += `${text}\n`;
      log(`${bold('↪ reply')} ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
      // ── The wire frame ────────────────────────────────────────────────────
      // This used to emit NOTHING, and the reasoning was sound for text: the
      // call is already in the transcript, the transcript tail is how every
      // message reaches an open chat, and a second DELIVERY path would race it
      // and render the reply twice.
      //
      // It does not survive voice. The transcript only has this reply once the
      // whole tool_use block finished generating, and the chat only learns
      // within 250 ms of that — so a voice turn could not start speaking until
      // the agent had stopped talking. `speak` is not a second delivery path:
      // it is a SIGNAL, on a frame kind the chat UI has no branch for, so it
      // cannot draw a bubble however badly a consumer behaves. The transcript
      // remains the one thing that renders.
      //
      // The id is the reply's transcript identity, read from MCP's `_meta`
      // (live-probed — see replyToolUseId), so a consumer can line a spoken
      // reply up with the bubble that appears for it. Missing id → a null,
      // never a throw: an SDK that renames that key costs us correlation, not
      // the reply.
      emit({
        t: 'speak',
        id: replyToolUseId(extra) ?? randomUUID(),
        text,
        n: repliesThisTurn,
      });
      return { content: [{ type: 'text' as const, text: REPLY_ACK }] };
    },
  );

  // -------------------------------------------------------------------------
  // Subagent roster. Subagent messages arrive on the same stream with
  // parent_tool_use_id set; count them per task and forward throttled live
  // progress so the chat's Task row shows "running · N steps · lastTool"
  // instead of sitting inert for minutes.
  //
  // The lifecycle rules (durable, no decay window, the four end-paths that
  // make that safe, and why membership is top-level launches ONLY) live in
  // SubagentRoster — extracted so they are testable without spawning a real
  // SDK session.
  // -------------------------------------------------------------------------
  const subagents = new SubagentRoster(
    (progress) => emit({ t: 'subagent', progress }),
    (line) => log(dim(line)),
  );
  /** How often a live roster entry re-announces itself when the SDK is silent. */
  const SUBAGENT_KEEPALIVE_MS = 5_000;
  // Keepalive: re-announce every live entry on a fixed tick so the server's
  // copy (and the per-row busy dot) stays fresh through the long silent tool
  // calls the P1 experiment measured. Cheap — one small frame per live
  // subagent per tick, and nothing at all when the roster is empty.
  const subagentKeepalive = setInterval(() => subagents.announceAll(), SUBAGENT_KEEPALIVE_MS);
  subagentKeepalive.unref?.();

  // -------------------------------------------------------------------------
  // Self-titling. Interactive Claude Code writes `ai-title` records into the
  // transcript; SDK-hosted sessions don't (verified: no ai-title lines, and
  // getSessionInfo().summary just echoes the first prompt). So after the first
  // completed turn of a FRESH session, generate a title ourselves with a cheap
  // one-shot haiku query and send it to the server, which names the pane/tab
  // (user renames always win there). Fire-and-forget — never blocks the queue.
  // -------------------------------------------------------------------------
  let firstUserText: string | null = null;
  let firstAssistantText = '';
  let titleGenerated = false;
  // The current turn's most recent assistant prose — rides along on turn-done so
  // the push notification can say WHAT the agent finished with, not just "done".
  let lastAssistantText = '';
  /** The transcript id of {@link lastAssistantText}'s block, so the reply
   *  guard's promoted speech can share an identity with the bubble that
   *  renders for it. Null when the SDK message carried no uuid. */
  let lastAssistantTextId: string | null = null;
  /**
   * Was the CURRENT turn started by somebody who is waiting for an answer?
   *
   * True for a real chat send and for another agent's `muxpad agent send` (both
   * arrive as queued user text, and both have a waiter). False for an
   * autonomous turn — a scheduled wakeup, a background subagent completing, a
   * cron fire — and false for a slash command, which is an instruction to the
   * session rather than a question to the agent. This is the input to the
   * reply guard; see needsReplyFallback.
   */
  let turnHuman = false;

  /** One-line snippet of assistant prose for a push body — strip the loudest
   *  markdown, collapse whitespace, truncate. Empty → undefined (caller falls
   *  back to a generic line). */
  function notifySnippet(text: string): string | undefined {
    const s = text
      .replace(/```[\s\S]*?```/g, ' ') // fenced code
      .replace(/`([^`]+)`/g, '$1') // inline code
      .replace(/\*\*|__|\*|_/g, '') // emphasis
      .replace(/^\s{0,3}#{1,6}\s+/gm, '') // heading markers
      .replace(/^\s*[-*>]\s+/gm, '') // list / quote markers
      .replace(/\s+/g, ' ')
      .trim();
    if (!s) return undefined;
    return s.length > 120 ? `${s.slice(0, 120)}…` : s;
  }

  async function generateTitle(): Promise<void> {
    if (titleGenerated || !firstUserText) return;
    titleGenerated = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 60_000);
    try {
      const prompt = `Generate a concise 3–6 word title for this conversation, in its language. Reply with ONLY the title — no quotes, no trailing punctuation.\n\nUser: ${firstUserText.slice(0, 500)}\n\nAssistant: ${firstAssistantText.slice(0, 500)}`;
      const one = query({
        prompt,
        options: {
          model: 'haiku',
          maxTurns: 1,
          // Bare completion: no user/project settings, no MCP, no tools.
          settingSources: [],
          allowedTools: [],
          abortController: abort,
        },
      });
      let title = '';
      for await (const m of one) {
        if (m.type === 'result' && m.subtype === 'success') title = m.result;
      }
      title = title
        .trim()
        .replace(/^["'“”]+|["'“”.]+$/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 60)
        .trim();
      if (!title) return;
      log(dim(`titled: ${title}`));
      emit({ t: 'title', title });
      process.stdout.write(`\x1b]0;✳ ${title}\x07`);
    } catch (e) {
      log(dim(`title generation failed: ${e instanceof Error ? e.message : String(e)}`));
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * The session's user-turn stream, bound to the SDK session epoch that owns
   * it. A re-exec bumps the epoch, so the generator feeding the DEAD child
   * returns rather than racing the new one for the next queued message — the
   * `wakeQueue` slot holds exactly one waiter and both generators want it.
   */
  async function* userMessages(epoch: number): AsyncGenerator<SDKUserMessage> {
    while (epoch === sessionEpoch) {
      while (epoch === sessionEpoch && !inTurn && pendingTexts.length > 0) {
        const text = pendingTexts.shift() as string;
        if (firstUserText === null) firstUserText = text;
        inTurn = true;
        interruptRequested = false;
        lastAssistantText = '';
        repliesThisTurn = 0;
        firstReplyText = '';
        currentTurnText = text;
        authFailureThisTurn = null;
        toolUsesThisTurn = 0;
        // A cron fire is a relay, not a person: the scheduler wrote it and
        // nobody is sitting there, so it may legitimately end silent. Read off
        // the message itself (the marker rides the text), exactly as ws.ts's
        // `isHumanMessage` does — a flag would be lost across the durable queue
        // and a server restart. A slash command is the user talking to the
        // SESSION (`/compact`, `/clear`), not asking the agent anything.
        turnHuman = parseCronMarker(text) === null && !text.startsWith('/');
        emit({ t: 'turn-start' });
        log(`${bold('▸ user')} ${text.length > 200 ? `${text.slice(0, 200)}…` : text}`);
        // A pending mode switch rides the next REAL message. Slash commands
        // (`/compact`, `/clear`) are executed in-band by the CLI and must
        // reach it as the bare command — prefixing one would turn it into
        // ordinary prose — so the note stays pending past them.
        let content = text;
        if (pendingModeNote && !text.startsWith('/')) {
          content = `${pendingModeNote}\n\n${text}`;
          pendingModeNote = null;
        }
        yield {
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
        };
      }
      if (epoch !== sessionEpoch) return;
      await new Promise<void>((r) => {
        wakeQueue = r;
      });
    }
  }

  // -------------------------------------------------------------------------
  // The Claude session. Streaming input keeps ONE process alive across every
  // turn — so in-session state (scheduled wakeups, background tasks, warm
  // context) survives between chat messages, which per-turn `claude -p` spawns
  // structurally could not.
  // -------------------------------------------------------------------------
  const startModel = requestedModel ?? (resumeSid ? null : DEFAULT_AGENT_MODEL);

  // Universal muxpad instructions + the launch mode's overlay, read at
  // injection time (session construction). Applies to fresh AND resumed
  // sessions alike — it's session-level system-prompt material, not a
  // message. Agent mode contributes nothing, so an Agent-mode pane's prompt
  // is byte-for-byte what it was before modes existed.
  const muxpadSystemPrompt = claudeSystemPromptOption(
    readAgentInstructions(),
    readChatModeOverlay(currentMode),
  );

  // -------------------------------------------------------------------------
  // THE REVERSIBILITY GATE. The verb list and its reasoning live in
  // ../reversibility.ts; this is the wiring, and the three decisions the
  // wiring makes.
  //
  // 1. WHERE IT SITS: `hooks.PreToolUse`, not `canUseTool`. `canUseTool` is the
  //    surface you would reach for and it is UNAVAILABLE here — muxpad runs
  //    `permissionMode: 'bypassPermissions'` (yolo parity, and the reason no
  //    permission prompt can wedge a headless turn) and bypass never consults
  //    it. PreToolUse is the one that still fires, and all three properties the
  //    gate needs are live-probed against SDK 0.3.220 rather than assumed: the
  //    hook FIRES under bypass; an `await` inside it genuinely HOLDS the tool
  //    call (measured to 150 s with no default timeout cutting in); and
  //    `permissionDecision:'deny'` actually stops execution — the probed
  //    command never ran, and the reason came back to the model as an error
  //    tool_result it reported rather than retried.
  //
  // 2. HOW IT LOOKS: `ask_user`'s existing `{t:'question'}` frame — the same
  //    tappable chips, the same `blocked` pane status, the same push, the same
  //    re-delivery after a reconnect. No second approval UI.
  //
  // 3. WHAT EXPIRY DOES: NOTHING. There is no timer, and that is the whole
  //    point. Grok Bot's approval cards lapse into DENIAL while the push that
  //    was supposed to summon you fails to arrive, so unattended work dies
  //    quietly and you never learn you were asked. Here an unanswered gate
  //    just waits — the pane sits `blocked` (top precedence in the nav), the
  //    push has already fired, and the question is re-delivered to every
  //    client that reconnects. A parked turn is VISIBLE; a silently denied one
  //    is not. The only things that resolve a gate other than an answer are
  //    Stop and shutdown, and both mean DENY: dismissal fails closed, always.
  //    (The `timeout` below exists solely so a future SDK default can never
  //    answer on the user's behalf; the contract is "no expiry".)
  const gateOn = gateEnabled(opts.mode, process.env);
  if (gateOn) log(dim('reversibility gate on — irreversible actions will ask first'));

  const options: Options = {
    cwd: process.cwd(),
    ...(gateOn
      ? {
          hooks: {
            PreToolUse: [
              {
                timeout: 604_800,
                hooks: [
                  async (input, _toolUseId, { signal }) => {
                    const pre = input as { tool_name?: string; tool_input?: unknown };
                    if (typeof pre.tool_name !== 'string') return { continue: true };
                    const action = classifyAction(pre.tool_name, pre.tool_input);
                    // The frictionless path, and by far the common one: reads,
                    // builds, tests, local edits, commits — no frame, no chip,
                    // no pause. A gate that fires on those is a gate people
                    // learn to dismiss without reading.
                    if (!action) return { continue: true };
                    log(
                      `${bold('⛔ gate')} ${action.verb} — ${dim(action.detail)} ${dim('(waiting for you; this will not time out)')}`,
                    );
                    const answers = await Promise.race([
                      askUser([gateQuestion(action)]),
                      // If the SDK ever DOES abort a hook, it has stopped
                      // waiting for our decision — so there is no decision left
                      // to make except the safe one.
                      new Promise<null>((resolve) => {
                        if (signal.aborted) resolve(null);
                        else signal.addEventListener('abort', () => resolve(null), { once: true });
                      }),
                    ]);
                    if (isApproval(answers)) {
                      log(dim(`gate: approved — ${action.detail}`));
                      return {
                        hookSpecificOutput: {
                          hookEventName: 'PreToolUse' as const,
                          permissionDecision: 'allow' as const,
                          permissionDecisionReason: 'The user approved this.',
                        },
                      };
                    }
                    // The user's own words, when they typed instead of tapping
                    // ("not to main — use a branch"), reach the model as the
                    // reason. A correction is worth more than a refusal.
                    const note = denialNote(answers);
                    log(dim(`gate: declined — ${action.detail}${note ? ` (${note})` : ''}`));
                    return {
                      hookSpecificOutput: {
                        hookEventName: 'PreToolUse' as const,
                        permissionDecision: 'deny' as const,
                        permissionDecisionReason: note
                          ? `The user declined this and said: ${note}. Do not retry it as-is; follow what they said, or tell them what you need.`
                          : 'The user declined this action. Do not retry it. Tell them it was declined and what you would do instead.',
                      },
                    };
                  },
                ],
              },
            ],
          },
        }
      : {}),
    // NB: the session ANCHOR (`resume` / `sessionId`) is deliberately NOT here
    // — it is the one option that differs between the boot session and a
    // self-heal re-exec, so it is applied by spawnSession() below.
    //
    // Yolo parity with `muxpad claude --dangerously-skip-permissions`. The SDK
    // auto-approves every tool call under bypass (canUseTool is never consulted
    // — spike-verified), so no permission prompt can wedge a headless turn.
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // Model: an explicit `--model <m>` pin wins; else a fresh chat gets
    // DEFAULT_AGENT_MODEL (Opus) and a resume keeps its own model.
    ...(startModel ? { model: startModel } : {}),
    // The chat-native question tool (Claude Code's own AskUserQuestion is not
    // offered to SDK sessions). alwaysLoad keeps it in the prompt rather than
    // behind tool search — it must be discoverable at the moment of doubt.
    mcpServers: {
      muxpad: createSdkMcpServer({
        name: 'muxpad',
        // AGENT MODE IS RAW: no reply tool at all. It used to be registered in
        // both modes, described as inert in Agent, because `mcpServers` is fixed
        // at query() construction and a mid-session switch cannot add tools.
        // That bought a mid-session switch its voice and cost something worse —
        // a tool the model can see, cannot verify the description of, and DID
        // call: 3 of 5 live Agent turns called it and then wrote a closing recap
        // for an audience they believed could not see them, so the user got the
        // same answer twice, the second time in the third person. Describing a
        // tool as "do not use me" is not a mechanism. Not offering it is.
        //
        // A session switched INTO Chat mid-run therefore has no reply tool. It
        // is not mute: every turn ends with zero replies, so the harness guard
        // promotes the turn's final text into a real bubble. One bubble a turn
        // instead of two to four — which is exactly the documented contract that
        // a mid-session switch is weaker than a fresh pane, and the switch note
        // now says so in those terms rather than naming a tool that isn't there.
        //
        // `notify` is registered in BOTH modes, and unlike `reply` that is not
        // a compromise forced by construction order. It is about REACHING the
        // user, not about how this session speaks, and nothing in its
        // description asserts anything mode-dependent that a model could be
        // misled by. Agent mode is also where it matters most: crons, wakeups
        // and overnight batches all run there, and those are precisely the
        // turns nobody is watching.
        tools:
          opts.mode === 'chat'
            ? [askUserTool, showFilesTool, notifyTool, replyTool]
            : [askUserTool, showFilesTool, notifyTool],
        alwaysLoad: true,
      }),
    },
    // Universal agent instructions (<dataDir>/agent-instructions.md) appended
    // to the DEFAULT claude_code system prompt — see claudeSystemPromptOption.
    ...(muxpadSystemPrompt ? { systemPrompt: muxpadSystemPrompt } : {}),
    // No settingSources override: default = user+project+local settings,
    // CLAUDE.md, skills, MCP — same session the terminal TUI would run.
  };

  /**
   * Spawn the SDK session — and therefore the `claude` CHILD PROCESS, which is
   * the entire point of doing this more than once. The CLI reads its OAuth
   * credential at process start and can never re-read it, so a credential that
   * went bad under a live child is only fixable by getting a new child.
   *
   * The anchor is re-decided on every spawn rather than captured at boot: a
   * session that has since drifted (a resume re-minted its id, `/clear` started
   * a new one) must be re-anchored to what it is running NOW, and the same
   * transcript check the boot path does applies — `resume` on a sid with no
   * transcript kills the session, so a transcript-less id starts fresh UNDER
   * itself and the pane keeps its identity either way.
   */
  function spawnSession(anchor: Pick<Options, 'resume' | 'sessionId'>): ReturnType<typeof query> {
    return query({ prompt: userMessages(sessionEpoch), options: { ...options, ...anchor } });
  }

  sessionEpoch = 1;
  let session = spawnSession(resumeSid ? { resume: resumeSid } : { sessionId: sid });

  // -------------------------------------------------------------------------
  // Session status for the chat header: model + context-window fill (+ the
  // model list on the first frame). Refreshed after init, after every turn,
  // and after a model switch; cached for re-delivery on reconnect.
  // -------------------------------------------------------------------------
  let lastStatus: (RunnerFrame & { t: 'status' }) | null = null;
  let modelList: Array<{ value: string; displayName: string; resolvedModel?: string }> | null =
    null;
  // The CONCRETE model the session is actually running (e.g. 'claude-opus-4-8'),
  // captured from the init frame and every assistant message. getContextUsage()
  // reports only the ALIAS ('opus'), so this is the sole reliable source of the
  // exact version — the chat's own self-report is unreliable. Rides the status
  // frame so the picker/chip can show precisely which model is live.
  let activeModel: string | null = null;

  // Single-flight across ALL callers (init, turn-done, interval, set-model,
  // boot) — concurrent control requests buy nothing and race lastStatus.
  let statusInFlight: Promise<void> | null = null;
  // Bumped when the session id rotates (/clear); an in-flight refresh started
  // against the OLD session must not land its numbers on the new one.
  let statusEpoch = 0;

  function refreshStatus(refetchModels: boolean): Promise<void> {
    if (statusInFlight) return statusInFlight;
    const epoch = statusEpoch;
    statusInFlight = (async () => {
      // The model list is fetched independently of the usage numbers: a failed
      // or unsupported supportedModels() must not gate the context meter, and
      // must not be retried forever — only refetch when explicitly asked (or
      // never yet fetched).
      let freshModels = false;
      if (refetchModels || modelList === null) {
        try {
          const models = await session.supportedModels();
          modelList = models.map((m) => ({
            value: m.value,
            displayName: m.displayName,
            ...(m.resolvedModel ? { resolvedModel: m.resolvedModel } : {}),
          }));
          freshModels = true;
        } catch (e) {
          log(dim(`model list fetch failed: ${e instanceof Error ? e.message : String(e)}`));
          if (modelList === null) modelList = []; // don't retry a doomed call on every tick
        }
      }
      try {
        const usage = await session.getContextUsage();
        if (epoch !== statusEpoch) return; // session rotated mid-fetch — stale numbers
        const frame: RunnerFrame & { t: 'status' } = {
          t: 'status',
          model: usage.model,
          // The exact concrete model (getContextUsage reports only the alias).
          ...(activeModel ? { activeModel } : {}),
          context: {
            pct: Math.round(usage.percentage),
            tokens: usage.totalTokens,
            max: usage.maxTokens,
          },
          // The list rides only frames where it was (re)fetched; the server
          // merges frames so reconnect hellos keep the last known list.
          ...(freshModels && modelList && modelList.length > 0 ? { models: modelList } : {}),
        };
        // Unchanged numbers → nothing to say (the 20s tick during a quiet tool
        // call would otherwise re-broadcast a no-op to every open chat).
        const changed =
          !lastStatus ||
          lastStatus.model !== frame.model ||
          lastStatus.activeModel !== frame.activeModel ||
          lastStatus.context?.pct !== frame.context?.pct ||
          lastStatus.context?.tokens !== frame.context?.tokens ||
          freshModels;
        // The CACHE always carries the model list (a reconnect re-delivers
        // lastStatus as the server's whole snapshot — without the list the
        // chip loses its picker and shows raw ids); the WIRE frame stays slim.
        lastStatus = {
          ...frame,
          ...(modelList && modelList.length > 0 ? { models: modelList } : {}),
        };
        if (changed) emit(frame);
      } catch (e) {
        // Status is decoration — never let it break the session loop.
        log(dim(`status refresh failed: ${e instanceof Error ? e.message : String(e)}`));
      }
    })().finally(() => {
      statusInFlight = null;
    });
    return statusInFlight;
  }

  // Long agentic turns grow the context for minutes between results — refresh
  // mid-turn too so the chat's fill meter tracks live instead of only moving at
  // rest. Skipped while disconnected (the frame would drop; reconnect re-sends
  // lastStatus); the single-flight above dedups against other callers.
  const statusInterval = setInterval(() => {
    if (inTurn && host.connected()) void refreshStatus(false);
  }, 20_000);

  function hello(): RunnerFrame {
    return {
      t: 'hello',
      sid: liveSid,
      cwd: process.cwd(),
      pid: process.pid,
      turnActive: inTurn,
      backend: 'claude',
    };
  }

  /**
   * Reach the user's devices for something the SESSION decided rather than the
   * model — the `notify` tool's frame, with nobody's tool call waiting on the
   * answer. The server still owns the rate limit and the presence check, so the
   * unacknowledged `notify-result` that comes back is simply dropped.
   */
  function notifyUser(text: string): void {
    if (!host.connected()) return;
    emit({ t: 'notify', nid: randomUUID(), text: text.replace(/\s+/g, ' ').trim() });
  }

  /**
   * Retire the `claude` child we have decided is broken — IMMEDIATELY, at the
   * moment of the decision rather than after the back-off.
   *
   * The epoch bump is what makes the retirement real. Until it moves, the
   * generator feeding this child is still the one a fresh `send()` would wake,
   * and during a 60-second back-off rung that is a wide-open window in which
   * the user types something and it is handed to a process that cannot
   * authenticate — and then dies with it. Bumping first, and kicking so the
   * old generator wakes up and returns, leaves new sends sitting in the queue
   * for the replacement to pick up.
   */
  function retireSession(): void {
    sessionEpoch += 1;
    kick();
    try {
      session.close();
    } catch {
      // already gone
    }
  }

  /**
   * Spawn the replacement and put the user's turn back. The ONLY recovery for
   * a dead credential — see auth-heal.ts.
   */
  async function performHeal(plan: NonNullable<typeof healPlan>): Promise<void> {
    if (plan.delayMs > 0) {
      log(
        dim(
          `auth: waiting ${Math.round(plan.delayMs / 1000)}s before re-exec ${plan.attempt}/${plan.of}`,
        ),
      );
      await new Promise<void>((r) => {
        const t = setTimeout(r, plan.delayMs);
        t.unref?.();
      });
    }
    if (shuttingDown) return;
    log(
      `${bold('↻ auth')} re-execing the session (attempt ${plan.attempt}/${plan.of}) — a fresh process re-reads the credential`,
    );
    // Half-generated reply blocks and the status cache belong to the process
    // that is now dead; the new session re-inits and re-reports.
    replyBlocks.clear();
    lastStatus = null;
    statusEpoch += 1;
    if (plan.retry !== null) {
      // Front of the queue: this message was never delivered to a model (the
      // failed turn cost $0 and 0.05s), and it is what the user is waiting for.
      pendingTexts.unshift(plan.retry);
      log(dim('auth: the message that failed goes back at the front of the queue'));
    }
    session = spawnSession(findTranscript(liveSid) ? { resume: liveSid } : { sessionId: liveSid });
    kick();
  }

  // -------------------------------------------------------------------------
  // AgentBackend surface.
  // -------------------------------------------------------------------------
  function send(text: string): void {
    pendingTexts.push(text);
    kick();
  }

  function slash(cmd: 'compact' | 'clear'): void {
    // Session-management commands ride the normal turn queue so turn accounting
    // stays exact (the CLI executes them in-band).
    log(dim(`/${cmd} requested from chat`));
    pendingTexts.push(`/${cmd}`);
    kick();
  }

  function setModel(model: string): void {
    session
      .setModel(model)
      .then(() => {
        log(`${bold('model')} → ${model}`);
        return refreshStatus(false);
      })
      .catch((e: unknown) => {
        log(dim(`set-model failed: ${e instanceof Error ? e.message : String(e)}`));
      });
  }

  function stop(): void {
    // Stop always empties the queue — a user pressing Stop wants pending
    // messages cancelled, not delivered into whatever runs next. This also
    // covers the send-then-immediate-stop pattern where the send is queued
    // but its turn hasn't started yet.
    const hadQueued = pendingTexts.length > 0;
    pendingTexts.length = 0;
    if (inTurn) {
      interruptRequested = true;
      log(dim('⏹ interrupt requested'));
      // A turn parked on ask_user must unblock first or the interrupt has
      // nothing to land on but the tool call.
      resolveAllQuestions('interrupted');
      session.interrupt().catch((e: unknown) => {
        log(dim(`interrupt failed: ${e instanceof Error ? e.message : String(e)}`));
        // Two cases hide behind a rejection: a transient failure while a query
        // is genuinely running (its result will close the turn — do nothing),
        // or accounting drift (inTurn stuck true with no query — nothing will
        // ever close it). Disambiguate by waiting for session silence. ONE
        // timer (repeat Stops reschedule, never stack), and the reset
        // deliberately does NOT kick(): a false positive during a long silent
        // tool call must not inject a queued message into the live query — the
        // next send's own kick releases the queue.
        if (interruptFailTimer !== null) clearTimeout(interruptFailTimer);
        const failedAt = Date.now();
        interruptFailTimer = setTimeout(() => {
          interruptFailTimer = null;
          if (inTurn && lastSessionActivityAt < failedAt) {
            log(dim('no session activity since failed interrupt — resetting turn state'));
            inTurn = false;
            // This path ends the turn WITHOUT a `result`, so the retirement in
            // the result branch never runs. Do it here too, or a Stop that
            // needed the fallback leaves immortal roster entries. Foreground
            // only, for the reason retireForeground gives.
            subagents.retireForeground('stop failed — turn state reset');
            emit({ t: 'turn-done', ok: false, error: 'stop failed — turn state reset' });
          }
        }, 10_000);
      });
    } else if (hadQueued) {
      // Nothing running, but queued sends were just cancelled: tell the chat
      // views so their optimistic bubbles/working state clear (that content
      // will never reach the transcript).
      log(dim('⏹ stop cancelled queued sends'));
      emit({ t: 'turn-done', ok: true });
    }
    // Stop while fully idle stays a no-op here — the SERVER answers the
    // requesting socket with a per-client turn-done resync.
  }

  function answer(qid: string, answers: unknown): void {
    const pq = pendingQuestions.get(qid);
    if (pq) {
      pendingQuestions.delete(qid);
      emit({ t: 'question-done', qid });
      pq.resolve(Array.isArray(answers) ? answers : null);
    }
  }

  function onConnected(): void {
    // The server's per-connection state starts empty — re-deliver any question
    // still blocking the turn so chat clients regain it after a server restart
    // or ws blip, and the latest status so the chat header isn't blank until
    // the next turn.
    for (const pq of pendingQuestions.values()) emit(pq.frame);
    if (lastStatus) emit(lastStatus);
    // A conversation went missing at boot. The socket did not exist then, so
    // this is the first moment the user can be told — and a lost conversation
    // is precisely the kind of thing they must not find out about by noticing
    // an agent has forgotten everything. Once only.
    if (lostHistoryNotice) {
      const notice = lostHistoryNotice;
      lostHistoryNotice = null;
      notifyUser(notice);
    }
    // …and the live subagent roster. This is the piece that used to be missing:
    // the server rebuilt questions and status on reconnect but not the roster,
    // so a background subagent working through a server restart became
    // permanently invisible — nothing would ever re-announce it.
    subagents.announceAll();
  }

  async function start(): Promise<void> {
    // Resumed sessions don't emit `init` until their first turn — without a
    // boot-time fetch the chat's session chip stays blank until the user sends
    // something. Two attempts, in case the control channel needs a moment
    // (refreshStatus swallows failures).
    for (const ms of [3_000, 15_000]) {
      setTimeout(() => {
        if (!lastStatus) void refreshStatus(true);
      }, ms);
    }
    // Name the pty deliberately (OSC 0) — otherwise the pane label falls back
    // to whatever the shell last set ("muxpad", the node path, …). The pane's
    // persistent NAME gets the session's AI title via the transcript tail.
    process.stdout.write('\x1b]0;✳ agent\x07');
    log(`${bold('muxpad agent')} — session ${sid}${resumeSid ? ' (resumed)' : ''}`);
    log(dim(`pane ${host.paneId} · ${process.cwd()}`));
    // Only announced for Chat mode: an Agent-mode pane's log stays
    // byte-identical to the pre-modes output.
    if (currentMode === 'chat') log(dim('chat mode — decisive, terse, result-first'));
    log(dim('drive this session from the pane’s Chat face; this log is the terminal face'));

    // A turn can also start WITHOUT a user send: scheduled wakeups and crons
    // fire autonomously inside the persistent session (live-verified). Emit
    // turn-start on the first activity so chat shows the typing indicator, the
    // busy dot lights, and Stop works for those turns too.
    //
    // D7: "first activity" used to mean the first assistant TEXT. A cron turn
    // that opens with a 90-second Bash call produces no text at all, so no
    // turn-start was emitted: agentBusy stayed unset, hello reported
    // turnActive:false, and the runner's single log line never crossed the
    // 600ms pty warmup. The pane read idle while genuinely working. It now
    // fires on the first message of ANY kind that belongs to a turn — a tool
    // call, a subagent's traffic, a stream delta — whichever lands first.
    const noteAutonomousTurn = () => {
      if (inTurn) return;
      inTurn = true;
      interruptRequested = false;
      lastAssistantText = '';
      repliesThisTurn = 0;
      firstReplyText = '';
      // An autonomous turn has no text anyone is waiting on, so a re-exec has
      // nothing to put back — see the turn-result branch.
      currentTurnText = null;
      authFailureThisTurn = null;
      toolUsesThisTurn = 0;
      // Nobody asked for this turn, so nobody is owed an answer for it — the
      // reply guard stays out of the way. (This is the distinction xAI's
      // harness never drew: they applied "you must always reply" everywhere,
      // which is unenforceable, instead of enforcing it where it is true.)
      turnHuman = false;
      emit({ t: 'turn-start' });
      log(dim('▸ autonomous turn (wakeup/cron/background)'));
    };

    // ── THE SESSION LOOP, once per `claude` CHILD PROCESS ────────────────────
    // It used to be a bare `for await` because there was only ever one child.
    // There can now be a second: a credential that dies under a running child
    // is unfixable from inside it (the CLI reads its OAuth token once, at
    // process start), so the turn-result branch can ask for a re-exec instead
    // of surfacing `Not logged in` and leaving the pane dead until a human
    // notices. `healPlan` is the only thing that brings us back around;
    // anything else that ends the stream ends the runner, exactly as before.
    while (true) {
      healPlan = null;
      await runSession();
      const plan = healPlan;
      healPlan = null;
      if (!plan || shuttingDown) return;
      await performHeal(plan);
      if (shuttingDown) return;
    }

    async function runSession(): Promise<void> {
      for await (const msg of session) {
        lastSessionActivityAt = Date.now();
        // The roster's whole view of the stream, in one testable place. The
        // branches below own the pane's LOG and the wire frames; this owns
        // membership, and nothing else is allowed to touch it.
        applySubagentMessage(subagents, msg as unknown as SubagentStreamMessage);
        if (msg.type === 'system' && msg.subtype === 'init') {
          log(dim(`ready · ${msg.model} · ${msg.tools.length} tools`));
          // Init reports the concrete resolved model (e.g. 'claude-opus-4-8').
          if (typeof msg.model === 'string' && msg.model) activeModel = msg.model;
          void refreshStatus(true);
          if (msg.session_id !== liveSid) {
            // Session-id drift (resume minted a new id, /clear started fresh).
            // Re-hello so the server re-points the tail and the self-heal
            // startup_cmd at the real id — and drop the cached status: the old
            // session's context fill must not be re-delivered over the new one.
            log(dim(`session id drifted → ${msg.session_id}`));
            liveSid = msg.session_id;
            lastStatus = null;
            statusEpoch++;
            emit(hello());
          }
        } else if (msg.type === 'system' && isTaskLifecycle(msg.subtype)) {
          // Roster handled above; nothing else to do with these.
        } else if (msg.type === 'stream_event') {
          const evt = msg.event as {
            type?: string;
            index?: number;
            content_block?: unknown;
            delta?: { type?: string; text?: string; partial_json?: string };
          };
          if (msg.parent_tool_use_id === null) {
            // ANY main-thread stream event means a turn is under way — not just a
            // text delta. A turn that opens with a tool call streams
            // content_block_start for the tool_use long before its complete
            // assistant message lands; waiting for text meant a Bash-first cron
            // turn showed nothing at all (D7).
            //
            // Subagent stream events (parent_tool_use_id set) are deliberately
            // NOT a turn signal: a background subagent legitimately emits them
            // with no turn running (measured — see the roster note above), and
            // treating those as a turn start would open a turn nothing ever
            // closes. Their "working" comes from the durable roster instead.
            noteAutonomousTurn();
            if (
              evt.type === 'content_block_delta' &&
              evt.delta?.type === 'text_delta' &&
              typeof evt.delta.text === 'string'
            ) {
              emit({ t: 'stream', delta: evt.delta.text });
            }
            // A `reply` being TYPED. Its text is a tool ARGUMENT, so it arrives
            // as `input_json_delta` — which this branch used to drop on the
            // floor, because the filter above only ever looked for `text_delta`.
            // That discarded stream is the difference between a voice turn that
            // starts speaking with the first phrase and one that waits for the
            // agent to finish the paragraph. See reply-stream.ts for the decoder
            // and the live-probed shapes.
            else if (evt.type === 'content_block_start' && typeof evt.index === 'number') {
              replyBlocks.start(evt.index, evt.content_block);
            } else if (
              evt.type === 'content_block_delta' &&
              evt.delta?.type === 'input_json_delta' &&
              typeof evt.delta.partial_json === 'string' &&
              typeof evt.index === 'number'
            ) {
              const spoken = replyBlocks.delta(evt.index, evt.delta.partial_json);
              if (spoken) emit({ t: 'speak-delta', id: spoken.id, delta: spoken.delta });
            } else if (evt.type === 'content_block_stop' && typeof evt.index === 'number') {
              replyBlocks.stop(evt.index);
            }
          }
        } else if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          noteAutonomousTurn();
          // Track the concrete model per assistant message so a mid-session switch
          // (setModel) is reflected; refresh the status when it actually changes.
          const m = msg.message.model;
          if (typeof m === 'string' && m && m !== activeModel) {
            activeModel = m;
            void refreshStatus(false);
          }
          let msgText = '';
          // The transcript identity of the LAST prose block in this message —
          // `<message uuid>:<block index>` is exactly what
          // normalizeTranscriptLine builds the rendered event's id from. Kept
          // so a promoted (guard) answer can be spoken under the same id as
          // the bubble it promotes; see the guard at the turn's result.
          let msgTextId: string | null = null;
          const blocks = msg.message.content ?? [];
          for (let bi = 0; bi < blocks.length; bi++) {
            const block = blocks[bi] as (typeof blocks)[number];
            if (block.type === 'text' && block.text.trim()) {
              msgText += (msgText ? '\n' : '') + block.text.trim();
              msgTextId = typeof msg.uuid === 'string' ? `${msg.uuid}:${bi}` : null;
              if (!titleGenerated && firstAssistantText.length < 500) {
                firstAssistantText += `${block.text.trim()}\n`;
              }
              // A DEAD CREDENTIAL ARRIVES HERE, as ordinary assistant prose —
              // there is no error subtype and no throw, the turn that follows
              // reports `success`, and this one line is the only signal on the
              // wire. Recorded now, acted on at the turn's result (auth-heal.ts).
              if (isAuthFailureText(block.text)) authFailureThisTurn = block.text.trim();
              log(`${bold('claude')} ${block.text.trim()}`);
            } else if (block.type === 'tool_use') {
              // Counted for the auth classifier: a child that cannot
              // authenticate never reaches a model, so a turn that CALLED
              // something is a turn that was working. See the result branch.
              toolUsesThisTurn++;
              const arg = summarizeToolInput(block.name, block.input);
              log(`${dim('⚙')} ${block.name}${arg ? dim(` ${arg}`) : ''}`);
            }
          }
          // Keep the LATEST prose-bearing assistant message as the turn's summary.
          if (msgText) {
            lastAssistantText = msgText;
            lastAssistantTextId = msgTextId;
          }
        } else if (msg.type === 'result') {
          inTurn = false;
          // A half-generated reply block cannot outlive the turn that was typing
          // it — its index will be reused by the next turn's blocks.
          replyBlocks.clear();
          // Belt-and-braces: no question outlives its turn.
          resolveAllQuestions('interrupted');
          // Push any throttled-but-unsent progress. Deliberately does NOT drop
          // entries: a run_in_background Task routinely outlives the turn that
          // launched it, and clearing here is what made those subagents vanish.
          applyTurnResult(subagents, msg.subtype, interruptRequested);
          const ok = msg.subtype === 'success' || interruptRequested;
          const secs = (msg.duration_ms / 1000).toFixed(1);
          // ── RECOVERABLE-FATAL: the credential, not the turn ───────────────
          // Every other way a turn can fail is about the WORK, and the session
          // that produced it is still good. This one is about the PROCESS: the
          // CLI cached an OAuth token at startup and cannot re-read the store,
          // so this child will fail every turn forever, and a `/login` run
          // anywhere — the thing that actually fixes it — will never reach it.
          // Nothing below applies. No reply-guard promotion (the "reply" would
          // be `Not logged in · Please run /login`, spoken in the agent's
          // voice), no turn-done while we still intend to answer, no cost line.
          //
          // CORROBORATED BY THE TURN, not by the text alone. The classifier
          // matches a short single line that opens and continues like the
          // CLI's error — and a Chat-mode turn's plain text is the model's
          // SCRATCHPAD, whose normal shape is exactly short single-line notes
          // (measured), written here by agents who debug auth for a living. So
          // the turn must also have called NOTHING: the failing child never
          // reaches a model, while any real turn — certainly any Chat turn,
          // whose closing `reply` is itself a tool call — has called
          // something. Without this, a note reading `Not logged in · Please
          // run /login` costs its own session four re-execs and ends in a push
          // telling the user their auth is broken when it is not.
          if (authFailureThisTurn && toolUsesThisTurn > 0) {
            log(
              dim(
                `(auth-looking line in a turn that ran ${toolUsesThisTurn} tool call(s) — treated as prose, not a dead credential)`,
              ),
            );
            authFailureThisTurn = null;
          }
          if (authFailureThisTurn) {
            const message = authFailureThisTurn;
            authFailureThisTurn = null;
            const decision = authHeal.decide();
            if (decision.kind === 'heal') {
              log(`${bold('✗ auth')} ${message}`);
              // The user's turn is NOT swallowed and NOT reported as failed: it
              // never reached a model (0.05s, $0), so it is re-sent to the new
              // session and the turn stays open across the re-exec — the chat
              // keeps its working indicator and the answer lands in the same
              // turn the user started. An AUTONOMOUS turn has no such text, so
              // its turn-done is emitted here and the re-exec is silent.
              healPlan = {
                delayMs: decision.delayMs,
                attempt: decision.attempt,
                of: decision.of,
                retry: currentTurnText,
              };
              if (currentTurnText === null) emit({ t: 'turn-done', ok: false, error: message });
              currentTurnText = null;
              interruptRequested = false;
              // Close the broken child HERE, not after the back-off — see
              // retireSession. It also makes the `break` below trivially safe:
              // the stream is already finishing when the loop asks it to stop.
              retireSession();
              break;
            }
            // Out of attempts, or already given up and inside the re-arm
            // window. Either way this stops being something muxpad can fix, so
            // it becomes something a HUMAN is told about — on their phone, not
            // in a pane log nobody is reading.
            const detail =
              decision.kind === 'give-up'
                ? `${decision.of} re-execs did not help`
                : `re-arming in ${Math.round(decision.rearmInMs / 60_000)} min`;
            log(`${bold('✗ auth')} ${message} ${dim(`(${detail})`)}`);
            if (decision.kind === 'give-up') {
              log(
                `${bold('⚠')} giving up on self-heal — run ${bold('/login')} on this machine; this pane retries on its own afterwards`,
              );
              notifyUser(authGiveUpNotice(basename(process.cwd()), message));
            }
            currentTurnText = null;
            interruptRequested = false;
            emit({
              t: 'turn-done',
              ok: false,
              error: `${message} — run /login on the muxpad host, then send again`,
            });
            kick();
            void refreshStatus(false);
            continue;
          }
          // A turn that got through on this credential forgives the ladder.
          authHeal.ok();
          currentTurnText = null;
          // …and a turn the CLI actually ran has written the transcript a
          // future respawn will look for. Record that it exists, once.
          markTurn();
          // ── THE GUARD ─────────────────────────────────────────────────────
          // A user who sent a message must never get silence. If a turn a human
          // was waiting on ends with zero reply calls, the harness speaks for the
          // agent — falling back to the turn's final assistant text rather than
          // inventing anything, because the fallback has to be something the
          // agent actually said.
          //
          // This half owns the LIVE consequences: the pane log (so the miss is
          // auditable rather than invisible) and the push/notification body,
          // which used to read the last assistant text and must now prefer what
          // was actually spoken. The rendered half lives in the chat client's
          // voice transform, which applies the SAME predicate to the same
          // transcript so a reload shows exactly this text as a real message.
          //
          // WHY PROMOTION AND NOT A FORCED RETRY. Claude Code's equivalent is
          // stronger on paper: it injects a meta message and runs ANOTHER turn,
          // so the model writes a real reply instead of the user reading
          // working-out that was never addressed to them.
          //
          // The first measurement said the guard never fires — zero of 24
          // human-initiated turns in the largest live Chat session, zero of 24
          // across both arms of the brevity A/B — and the reason given was
          // structural: `reply` is Chat mode's only channel out. THAT WAS
          // WRONG, and re-measuring found it: 6 of 10 matched turns, and 4 of
          // 12 in a mixed set, ended with the model answering in plain text
          // and letting this promotion carry it. The misses cluster on
          // ZERO-STAKES turns — a turn whose whole job is one lookup is
          // exactly where reaching for a tool gets skipped.
          //
          // It was fixed by CONTRACT, not by mechanism: a bullet in
          // CHAT_MODE_SEED ("every turn ends with a `reply` — including the
          // easy ones") took it to 0 of 10, Fisher p = 0.011, with reply
          // length unchanged. Note what could NOT have fixed it — the reply
          // tool's own description, which the model had already read and was
          // not consulting. So the promotion stays as the backstop it always
          // was; what changed is that it is a backstop for a thing that does
          // happen.
          //
          // A forced retry still costs more than it buys: a synthetic user
          // message in the transcript (which normalizes to a real user bubble
          // unless a new marker + normalizer + renderer branch hides it), a
          // once-per-turn latch so a model that stays silent cannot loop, and an
          // ordering hazard against the server-side send queue, interrupts and
          // cron fires — all in the turn-result path, which is the one place in
          // this file where a bug is a wedged session. A line of contract text
          // closed the same gap for free. Re-measure before revisiting — and
          // measure the CONTRACT, which is where the fix lives.
          const guarded = needsReplyFallback({
            mode: currentMode,
            humanInitiated: turnHuman,
            replies: repliesThisTurn,
            interrupted: interruptRequested,
            failed: msg.subtype !== 'success',
          });
          if (guarded) {
            log(
              dim(
                lastAssistantText.trim()
                  ? '⚠ turn ended with no reply — speaking its final note for it'
                  : '⚠ turn ended with no reply and nothing to fall back on',
              ),
            );
            // …and SPEAKING it has to mean speaking it. The log line said
            // "speaking its final note for it" while the only two outputs were
            // the pane log and the push body, neither of which is audible:
            // `speak`/`speak-delta` are the entire allow-list a voice session
            // turns into speech (web/src/lib/voice/speak-bridge.ts — `stream`
            // is deliberately NOT one, being the suppressed scratchpad), and
            // they are emitted only inside the reply tool. So a guarded turn
            // reached a live voice session as silence, under a `turn-done
            // ok:true` that says nothing aloud: the user asked out loud, heard
            // nothing, and kept paying for the session until its TTL.
            //
            // A pane switched Agent→Chat mid-session is the sharpest case —
            // mcpServers is fixed at query() construction, so it has NO reply
            // tool and EVERY one of its turns is a guarded turn — and the mic
            // is offered regardless, because the UI reads the mode off the row.
            //
            // Safe to emit exactly here: `guarded` implies repliesThisTurn ===
            // 0 (needsReplyFallback), so no speech has gone out under this
            // turn and nothing can be said twice. It rides the SAME id as the
            // bubble the promoted text renders as, which is what lets a
            // client-side backstop for older runners (they emit no frame at
            // all) dedupe against this instead of doubling it.
            const promoted = lastAssistantText.trim();
            if (promoted) {
              emit({ t: 'speak', id: lastAssistantTextId ?? randomUUID(), text: promoted, n: 1 });
            }
          }
          // Spoken text wins over scratchpad text for the push body; the guard's
          // fallback is the scratchpad, promoted on purpose.
          const summary = notifySnippet(firstReplyText || lastAssistantText);
          if (interruptRequested) {
            log(dim(`⏹ stopped after ${secs}s`));
            emit({ t: 'turn-done', ok: true, ...(summary ? { summary } : {}) });
          } else if (msg.subtype === 'success') {
            log(dim(`✓ turn done · ${secs}s · $${msg.total_cost_usd.toFixed(2)}`));
            emit({ t: 'turn-done', ok: true, ...(summary ? { summary } : {}) });
            // First completed turn of a fresh session: self-title (resumed
            // sessions keep whatever name their pane/tab already carries).
            if (!resumeSid && !titleGenerated) void generateTitle();
          } else {
            const error = msg.errors?.join('; ') || msg.subtype;
            log(`✗ turn failed: ${error}`);
            emit({ t: 'turn-done', ok, error });
          }
          interruptRequested = false;
          kick(); // release the next queued send, if any
          void refreshStatus(false); // context fill changed with the turn
        }
      }
    }
  }

  function shutdown(): void {
    shuttingDown = true;
    clearInterval(statusInterval);
    clearInterval(subagentKeepalive);
    if (interruptFailTimer !== null) clearTimeout(interruptFailTimer); // no spurious post-shutdown turn-done
    resolveAllQuestions('shutdown');
    // Any notify still waiting on an ack it will never get: unblock the tool
    // call rather than leave it to its 5s timeout during teardown.
    for (const [nid, resolve] of pendingNotifies) {
      pendingNotifies.delete(nid);
      resolve('no-ack');
    }
    try {
      session.close();
    } catch {
      // already gone
    }
  }

  return {
    id: 'claude',
    start,
    send,
    slash,
    stop,
    setModel,
    setMode,
    answer,
    notifyResult,
    onConnected,
    hello,
    shutdown,
  };
}
