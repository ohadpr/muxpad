import { main } from './mcp.js';

/**
 * Entry point for the MCP config.
 *
 * Kept separate from mcp.ts so the decision logic stays importable and testable
 * without spawning anything — the same split as host/cli.ts and host/run.ts.
 */
await main();
