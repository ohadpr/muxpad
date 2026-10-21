import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { isIP } from 'node:net';
import { assertProtectedPath } from './protected-path.mjs';

export const NODE_POLICY_PATH = '/Library/muxpad-broker/node-policy.json';
export const AUTHORITY_SOCKET = '/Library/muxpad-broker/state/authority.sock';
export const PEER_HEADER = 'x-muxpad-verified-peer';
const id = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(s);
// Both policy and transport assertions have a flat, bounded scalar schema.
// Parse keys before JSON object construction so duplicates/case aliases cannot
// acquire different meanings in Go and JavaScript.
function flatObject(raw, fields, numericVersion = false) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw) > 16384)
    throw Error('Oversized identity object');
  let at = 0;
  const space = () => {
    while (/[ \t\r\n]/.test(raw[at] || '~')) at++;
  };
  const char = (c) => {
    space();
    if (raw[at++] !== c) throw Error('Invalid identity object');
  };
  const string = () => {
    space();
    const m = /^"(?:[^"\\\x00-\x1f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.exec(raw.slice(at));
    if (!m) throw Error('Invalid identity string');
    at += m[0].length;
    return JSON.parse(m[0]);
  };
  const object = (expected, version = false) => {
    const result = Object.create(null);
    char('{');
    space();
    if (raw[at] !== '}')
      while (true) {
        const key = string();
        if (!expected.includes(key) || Object.hasOwn(result, key))
          throw Error('Unknown or duplicate identity field');
        char(':');
        if (version && key === 'version') {
          space();
          if (raw[at++] !== '1') throw Error('Invalid identity version');
          result[key] = 1;
        } else result[key] = string();
        space();
        if (raw[at] !== ',') break;
        at++;
      }
    char('}');
    if (Object.keys(result).length !== expected.length) throw Error('Incomplete identity object');
    return { ...result };
  };
  const result = object(fields, numericVersion);
  space();
  if (at !== raw.length) throw Error('Trailing identity data');
  return result;
}

export function parseNodePolicy(raw) {
  const p = flatObject(
    raw,
    ['version', 'revision', 'hostNodeID', 'brokerNodeID', 'tailnetID', 'controlURL', 'capability'],
    true,
  );
  if (
    !id(p.revision) ||
    !id(p.hostNodeID) ||
    !id(p.brokerNodeID) ||
    p.hostNodeID === p.brokerNodeID ||
    !id(p.tailnetID) ||
    p.controlURL !== 'https://controlplane.tailscale.com' ||
    p.capability !== 'muxpad.org/cap/approve-member-v1'
  )
    throw Error('Invalid node policy');
  return Object.defineProperty(p, 'digest', {
    value: createHash('sha256').update(raw).digest('hex'),
  });
}
export function readNodePolicy() {
  assertProtectedPath(NODE_POLICY_PATH, [0], { mode: 0o644 });
  return parseNodePolicy(readFileSync(NODE_POLICY_PATH, 'utf8'));
}
export function allowedPeer(policy, peer) {
  // The private transport only emits this assertion after its own WhoIs has
  // verified the administrator-issued member capability and direct source.
  return (
    !!peer &&
    peer.policy === policy.digest &&
    peer.nodeID !== policy.hostNodeID &&
    peer.nodeID !== policy.brokerNodeID &&
    peer.authorizationID === policy.revision
  );
}
// Only call on the dedicated private-Unix HTTP server. Client headers are
// stripped and replaced by the root-pinned Go transport before this boundary.
export function verifiedPeer(req) {
  const values = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2)
    if (req.rawHeaders[i].toLowerCase() === PEER_HEADER) values.push(req.rawHeaders[i + 1]);
  if (values.length !== 1 || !/^[A-Za-z0-9_-]{1,2048}$/.test(values[0]))
    throw Error('Verified source required');
  const peer = flatObject(Buffer.from(values[0], 'base64url').toString(), [
    'nodeID',
    'ownerID',
    'authorizationID',
    'policy',
    'ip',
    'generation',
  ]);
  if (
    !id(peer.generation) ||
    !id(peer.nodeID) ||
    !/^[1-9][0-9]{0,19}$/.test(peer.ownerID) ||
    !id(peer.authorizationID) ||
    !/^[a-f0-9]{64}$/.test(peer.policy) ||
    !isIP(peer.ip)
  )
    throw Error('Invalid verified source');
  return Object.freeze(peer);
}
export function checkNodeAuthority(peer, { socketPath = AUTHORITY_SOCKET, timeout = 2500 } = {}) {
  return new Promise((resolve) => {
    const req = request(
      {
        socketPath,
        path: '/check',
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) {
            resolve(false);
            res.destroy();
          }
        });
        res.on('end', () => {
          try {
            const fields = ['nodeID', 'ownerID', 'authorizationID', 'policy', 'ip', 'generation'];
            const got = flatObject(body, fields);
            resolve(res.statusCode === 200 && fields.every((key) => got[key] === peer[key]));
          } catch {
            resolve(false);
          }
        });
        res.on('error', () => resolve(false));
      },
    );
    const timer = setTimeout(() => req.destroy(), timeout);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => resolve(false));
    req.end(JSON.stringify(peer));
  });
}
