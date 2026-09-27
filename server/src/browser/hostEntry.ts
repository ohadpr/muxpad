import { fileURLToPath } from 'node:url';

/**
 * Absolute path to the browser host entry point.
 *
 * Self-locating rather than configured, because this string is baked into an
 * app row's COMMAND and that row outlives the process that wrote it. A path
 * derived from `process.cwd()` would be correct exactly once — at registration
 * — and would then point somewhere arbitrary forever after, with the failure
 * surfacing as a browser that crash-loops in a hidden pane nobody is looking at.
 *
 * `import.meta.url` is the compiled module's own location, so this resolves
 * against the same `dist/` the server is actually running from.
 */
export function browserHostEntry(): string {
  return fileURLToPath(new URL('./host/cli.js', import.meta.url));
}
