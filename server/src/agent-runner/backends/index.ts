// Backend dispatch. The harness parses `--backend <id>` and calls this to
// construct the matching AgentBackend; everything downstream speaks the
// provider-neutral interface.
import type { BackendId } from '../protocol.js';
import { createClaudeBackend } from './claude.js';
import type { AgentBackend, BackendOptions, RunnerHost } from './types.js';

export function createBackend(
  id: BackendId,
  host: RunnerHost,
  opts: BackendOptions,
): AgentBackend {
  switch (id) {
    case 'claude':
      return createClaudeBackend(host, opts);
    // codex / cursor land here in Phase 1 / Phase 2.
    default:
      throw new Error(`unknown backend: ${id}`);
  }
}
