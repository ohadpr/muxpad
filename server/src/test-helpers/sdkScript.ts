// SDK message builders, transcribed from a LIVE probe of
// @anthropic-ai/claude-agent-sdk 0.3.220 (scripts/sdk-task-probe.mjs).
//
// Every field, and every message ORDER these helpers encode, was observed on
// the wire — including the two orderings that turn out to matter:
//
//   launch:  assistant(tool_use) → background_tasks_changed(LEVEL, +new)
//            → task_started(task_id, tool_use_id) → user(tool_result "Async
//            agent launched successfully…")
//   finish:  background_tasks_changed(LEVEL, −gone) → task_updated(completed)
//            → task_notification(task_id, tool_use_id) → system(init)
//            → assistant(prose) [only if a turn is open]
//
// The LEVEL precedes the edges in both directions. The `init` on a background
// finish is real: the harness re-inits the CLI when it folds the notification
// into the conversation, and it carries the SAME session_id.
//
// Kept in test-helpers (not a test file) so the leak reproduction and any
// future runner test share ONE transcription — two hand-kept copies of these
// shapes is how a roster starts disagreeing with the SDK.

const SESSION_ID = '11111111-2222-3333-4444-555555555555';

let uuidSeq = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++uuidSeq).padStart(12, '0')}`;

/** A live background task as it appears in a `background_tasks_changed` payload. */
export interface LiveTask {
  task_id: string;
  task_type: string;
  description: string;
}

export const sdk = {
  /** `system/init`. Emitted at boot AND again whenever the harness folds a
   *  background finish into the conversation (probe-observed, same session_id). */
  init(sessionId = SESSION_ID) {
    return {
      type: 'system' as const,
      subtype: 'init' as const,
      model: 'claude-opus-4-8',
      tools: ['Bash', 'Read', 'Task'],
      session_id: sessionId,
      uuid: uuid(),
    };
  },

  /** The parent's top-level `Task`/`Agent` tool_use — the LAUNCH. */
  launchToolUse(toolUseId: string, description: string, name: 'Task' | 'Agent' = 'Agent') {
    return {
      type: 'assistant' as const,
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: uuid(),
      message: {
        model: 'claude-opus-4-8',
        content: [
          {
            type: 'tool_use' as const,
            id: toolUseId,
            name,
            input: { description, subagent_type: 'general-purpose', run_in_background: true },
          },
        ],
      },
    };
  },

  /** The immediate "launched" ack. NOT a completion — the runner must skip it. */
  launchAck(toolUseId: string) {
    return {
      type: 'user' as const,
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: uuid(),
      message: {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: toolUseId,
            content: [
              {
                type: 'text' as const,
                text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste it.)',
              },
            ],
          },
        ],
      },
    };
  },

  /** A FOREGROUND Task's real completion: a tool_result that is not the ack. */
  foregroundResult(toolUseId: string, text = 'Done. Found 3 files.') {
    return {
      type: 'user' as const,
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: uuid(),
      message: {
        role: 'user' as const,
        content: [
          {
            type: 'tool_result' as const,
            tool_use_id: toolUseId,
            content: [{ type: 'text', text }],
          },
        ],
      },
    };
  },

  /** `system/task_started`. `tool_use_id` is OPTIONAL in the SDK declaration —
   *  pass null to script the shape where the CLI omits it. */
  taskStarted(taskId: string, toolUseId: string | null, description = 'worker') {
    return {
      type: 'system' as const,
      subtype: 'task_started' as const,
      task_id: taskId,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      description,
      subagent_type: 'general-purpose',
      task_type: 'local_agent',
      session_id: SESSION_ID,
      uuid: uuid(),
    };
  },

  /** `system/task_progress` — a live subagent heartbeat. The runner does NOT
   *  handle this subtype; scripted so the reproduction carries real traffic. */
  taskProgress(taskId: string, toolUseId: string, description = 'working') {
    return {
      type: 'system' as const,
      subtype: 'task_progress' as const,
      task_id: taskId,
      tool_use_id: toolUseId,
      description,
      subagent_type: 'general-purpose',
      usage: { total_tokens: 100, tool_uses: 1, duration_ms: 1000 },
      session_id: SESSION_ID,
      uuid: uuid(),
    };
  },

  /** `system/task_notification` — the finish EDGE. */
  taskNotification(
    taskId: string,
    toolUseId: string | null,
    status: 'completed' | 'failed' | 'stopped' = 'completed',
  ) {
    return {
      type: 'system' as const,
      subtype: 'task_notification' as const,
      task_id: taskId,
      ...(toolUseId ? { tool_use_id: toolUseId } : {}),
      status,
      output_file: '/tmp/out.md',
      summary: 'done',
      session_id: SESSION_ID,
      uuid: uuid(),
    };
  },

  /** `system/task_updated` — carries NO tool_use_id, only a patch. */
  taskUpdated(
    taskId: string,
    status: 'pending' | 'running' | 'completed' | 'failed' | 'killed' | 'paused',
  ) {
    return {
      type: 'system' as const,
      subtype: 'task_updated' as const,
      task_id: taskId,
      patch: { status, ...(status === 'completed' ? { end_time: Date.now() } : {}) },
      session_id: SESSION_ID,
      uuid: uuid(),
    };
  },

  /** `system/background_tasks_changed` — the LEVEL signal (REPLACE semantics). */
  level(tasks: LiveTask[]) {
    return {
      type: 'system' as const,
      subtype: 'background_tasks_changed' as const,
      tasks,
      session_id: SESSION_ID,
      uuid: uuid(),
    };
  },

  /** A subagent's own traffic, tagged with the tool_use id it belongs to. This
   *  stream also carries NESTED agents' traffic under the nested id. */
  childActivity(parentToolUseId: string, toolName = 'Bash', arg = 'sleep 5') {
    return {
      type: 'assistant' as const,
      parent_tool_use_id: parentToolUseId,
      session_id: SESSION_ID,
      uuid: uuid(),
      message: {
        model: 'claude-sonnet-4-8',
        content: [
          {
            type: 'tool_use' as const,
            id: `toolu_child_${uuidSeq}`,
            name: toolName,
            input: { command: arg },
          },
        ],
      },
    };
  },

  /** A NESTED launch: a subagent spawning its own. Rides the PARENT's
   *  parent_tool_use_id, so it is never a top-level launch (probe-verified). */
  nestedLaunch(parentToolUseId: string, nestedToolUseId: string, description = 'nested worker') {
    return {
      type: 'assistant' as const,
      parent_tool_use_id: parentToolUseId,
      session_id: SESSION_ID,
      uuid: uuid(),
      message: {
        model: 'claude-sonnet-4-8',
        content: [
          {
            type: 'tool_use' as const,
            id: nestedToolUseId,
            name: 'Agent',
            input: { description, subagent_type: 'general-purpose', run_in_background: true },
          },
        ],
      },
    };
  },

  /** Top-level assistant prose. */
  text(body: string) {
    return {
      type: 'assistant' as const,
      parent_tool_use_id: null,
      session_id: SESSION_ID,
      uuid: uuid(),
      message: { model: 'claude-opus-4-8', content: [{ type: 'text' as const, text: body }] },
    };
  },

  /** The turn `result`. */
  result(subtype: 'success' | 'error_during_execution' | 'error_max_turns' = 'success') {
    return {
      type: 'result' as const,
      subtype,
      duration_ms: 1200,
      total_cost_usd: 0.01,
      result: 'ok',
      ...(subtype === 'success' ? {} : { errors: [subtype] }),
      session_id: SESSION_ID,
      uuid: uuid(),
    };
  },
};

/** A background launch, in the exact four-message order the probe recorded. */
export function backgroundLaunch(
  toolUseId: string,
  taskId: string,
  description: string,
  liveAfter: LiveTask[],
): unknown[] {
  return [
    sdk.launchToolUse(toolUseId, description),
    sdk.level(liveAfter),
    sdk.taskStarted(taskId, toolUseId, description),
    sdk.launchAck(toolUseId),
  ];
}

/** A background finish, in the exact order the probe recorded. */
export function backgroundFinish(
  toolUseId: string,
  taskId: string,
  liveAfter: LiveTask[],
  status: 'completed' | 'failed' | 'stopped' = 'completed',
): unknown[] {
  return [
    sdk.level(liveAfter),
    sdk.taskUpdated(taskId, status === 'completed' ? 'completed' : 'failed'),
    sdk.taskNotification(taskId, toolUseId, status),
    sdk.init(),
  ];
}

/** Shorthand for a level-payload entry. */
export function liveTask(taskId: string, description = 'worker'): LiveTask {
  return { task_id: taskId, task_type: 'local_agent', description };
}
