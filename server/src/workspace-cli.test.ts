import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const MUXPAD = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'muxpad');
const SRC = readFileSync(MUXPAD, 'utf8');

const fn = (name: string) => {
  const i = SRC.indexOf(`${name}() {`);
  expect(i, name).toBeGreaterThan(-1);
  const rest = SRC.slice(i);
  return rest.slice(0, rest.indexOf('\n}\n') + 2);
};

/**
 * THE CLI IS WHAT AGENTS DRIVE, AND THAT SPLITS THE PANEL IN TWO.
 *
 * Instructions are prose — an agent maintaining its own workspace's notes is
 * the point of the feature, so they are read AND write here. A capability is
 * permission, and a tool that can grant itself a capability is a guard in name
 * only, so `caps` reads and nothing writes. The server enforces it too (it
 * refuses a capability PATCH with no browser `Origin`); this is the honest
 * message in front of that, and the assertion that no second path appears here
 * later by accident.
 */
describe('muxpad workspace instructions', () => {
  it('reads with no text argument and writes with one', () => {
    const body = fn('cmd_workspace_instructions');
    expect(body).toContain('http_request GET "/api/workspaces/$id"');
    expect(body).toContain('http_request PATCH');
    expect(body).toMatch(/\\"instructions\\"/);
  });

  it('takes `-` to mean stdin — these are paragraphs', () => {
    expect(fn('cmd_workspace_instructions')).toContain('text="$(cat)"');
  });
});

describe('muxpad workspace caps', () => {
  it('never writes', () => {
    const body = fn('cmd_workspace_caps');
    expect(body).toContain('http_request GET');
    expect(body).not.toContain('PATCH');
    expect(body).not.toContain('POST');
  });

  it('says where the switch actually is', () => {
    expect(fn('cmd_workspace_caps')).toContain('changed in the UI only');
  });

  it('is reachable, and so is the verb list that advertises it', () => {
    expect(SRC).toContain('caps|capabilities) cmd_workspace_caps');
    expect(SRC).toContain('{new|list|delete|instructions|caps}');
  });
});
