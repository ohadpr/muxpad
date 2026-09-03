// Backend dispatch. The harness parses `--backend <id>` and calls this to
// construct the matching AgentBackend; everything downstream speaks the
// provider-neutral interface.
import type { BackendId } from '../protocol.js';
import { createClaudeBackend } from './claude.js';
import { createCodexBackend } from './codex.js';
import { createCursorBackend } from './cursor.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

export function createBackend(id: BackendId, host: RunnerHost, opts: BackendOptions): AgentBackend {
  switch (id) {
    case 'claude':
      return createClaudeBackend(host, opts);
    case 'codex':
      return createCodexBackend(host, opts);
    case 'cursor':
      return createCursorBackend(host, opts);
    default:
      throw new Error(`unknown backend: ${id}`);
  }
}
