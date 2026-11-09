import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { arch, cpus, homedir, platform, totalmem, userInfo } from 'node:os';
import { join } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { ArchiveDb } from '../archive/ArchiveDb.js';
import { Archiver } from '../archive/Archiver.js';
import {
  TranscriptTail,
  identityNormalize,
  muxpadLocate,
  projectsDir,
} from '../chat/TranscriptReader.js';
import { LinkServer, linkUpgradeKind } from './link-server.js';
import { readOriginIdentity } from './origin-identity.js';

/**
 * MUXPAD-NODE — the front door of a machine that is not the one with the UI.
 *
 * ── WHAT IT IS ────────────────────────────────────────────────────────────
 * One small process per remote machine. It owns no state, no database and no
 * UI. It listens for the control plane, authenticates it, and then forwards
 * bytes to the ptyd running beside it on the same host.
 *
 * ── WHY PTYD IS NOT THE THING LISTENING ───────────────────────────────────
 * ptyd has NO AUTHENTICATION, by design and in writing: its unix socket's file
 * permissions are the whole of its security, and its own comment says "the only
 * legitimate consumer is the main muxpad server, which runs as the same user."
 * Its two endpoints are `/control` — spawn, kill, write — and `/pty/:id`.
 * Putting that on a TCP port is publishing a remote shell.
 *
 * So ptyd is NOT MODIFIED and keeps its unix socket. This process is the only
 * thing that faces the network, which makes it the only thing that has to be
 * right about authentication, and it is small enough to read in one sitting.
 *
 * ── WHO DIALS WHOM ────────────────────────────────────────────────────────
 * The CONTROL PLANE dials US. Measured on the real pair: mac→VM works, VM→mac
 * is blocked (no tailnet view, ping 100% loss, port unreachable), and changing
 * Tailscale is out of scope. So this listens and never initiates. That is also
 * the better security posture: the machine holding the user's whole life needs
 * no inbound exposure at all.
 *
 * ── THE TAILNET IS NOT A PASSWORD ─────────────────────────────────────────
 * This runs on a company tailnet with other people's dev VMs on it and an
 * admin who is not the user. "Reachable" cannot mean "allowed", so an
 * unauthenticated peer is refused even though it arrived from a trusted-looking
 * network. The token is compared in constant time and never logged.
 */

/** Default port. Chosen above muxpad's 7777 and out of the browser-host range
 *  (9400-9600) so a node and a host can share a machine without collision. */
export const DEFAULT_NODE_PORT = 7797;

const TOKEN_FILE = 'node-token';

export interface NodeAgentOptions {
  port?: number;
  host?: string;
  /** Where ptyd's unix socket is. */
  ptydSocket?: string;
  /** This machine's muxpad data dir. Where the archive is kept. */
  dataDir?: string;
  /**
   * Keep an archive of this machine's chats and answer searches of it.
   *
   * On by default, and off in tests: an archiver is a sweep timer and a
   * SQLite file, and a unit test for the front door should not acquire either.
   */
  archive?: boolean;
  /** The shared token the control plane must present. */
  token: string;
  /** Injected for tests. */
  log?: (line: string) => void;
}

/**
 * What this machine is, for the control plane's Settings → Machines row — and
 * for one decision that is not cosmetic.
 *
 * `shell` and `home` ARE LOAD-BEARING. The server's own default is `/bin/zsh`, which is
 * right on a mac and does not exist on this Ubuntu VM: a pane created with it
 * died the instant it started, and the chat said only "the pty exited
 * immediately after starting". Same family as the cwd bug — a path from the
 * server's world shipped to a machine that is not it. So the host says what
 * its shell is and the server uses that for a pane it creates here.
 */
export function describeSelf(): Record<string, unknown> {
  return {
    platform: platform(),
    arch: arch(),
    cpus: cpus().length,
    // GiB, rounded — the exact byte count is noise in a UI row.
    memoryGb: Math.round(totalmem() / 1024 ** 3),
    node: process.version,
    shell: defaultShell(),
    // THE OTHER HALF OF THE SAME BUG. A remote pane whose row has no cwd was
    // spawned with `safeCwd(null)` — the SERVER's home, `/Users/ohadpr`, which
    // does not exist here, so the pty died instantly. The row's cwd is used
    // when it has one; this is what "no cwd" has to mean on this machine.
    home: homedir(),
  };
}

/**
 * This machine's login shell.
 *
 * `$SHELL` first because it is what the user actually uses, then the
 * passwd-file answer, then bash — which every host muxpad runs on has, and
 * zsh conspicuously does not.
 */
export function defaultShell(): string {
  const fromEnv = process.env.SHELL?.trim();
  if (fromEnv) return fromEnv;
  try {
    return userInfo().shell?.trim() || '/bin/bash';
  } catch {
    return '/bin/bash';
  }
}

/**
 * Read the token from disk.
 *
 * Per call rather than captured, so rotating it does not need a restart — the
 * same reasoning as every other credential reader in this codebase, and the
 * reason the mac's CLI survived auth being switched on.
 */
export function readNodeToken(dataDir?: string): string | null {
  const dir = dataDir ?? process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');
  try {
    const v = readFileSync(join(dir, TOKEN_FILE), 'utf8').trim();
    return v.length >= 32 ? v : null;
  } catch {
    return null;
  }
}

/** Constant-time compare that cannot throw on a length mismatch. */
export function tokenMatches(presented: string | null | undefined, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Which ptyd paths this agent will forward, and nothing else.
 *
 * AN ALLOW-LIST, not a prefix check. The review of the plan put it plainly:
 * "reject arbitrary URL forwarding". A proxy that forwards whatever path it is
 * handed is a proxy that will one day forward something nobody audited —
 * including a path ptyd grows later. Two shapes are allowed because two are
 * all ptyd has.
 */
export function isForwardablePath(path: string): boolean {
  if (path === '/control') return true;
  return /^\/pty\/[A-Za-z0-9_-]{1,64}$/.test(path);
}

/**
 * Is this request from a process on THIS machine?
 *
 * The in-pane CLI's funnel (`/api/...`) is forwarded to the control plane with
 * NO token, because a pane cannot hold one — the pane's environment is visible
 * to anything running as the user, so a credential there protects nothing. What
 * does the protecting is that the listener only honours it over loopback.
 *
 * This agent binds 0.0.0.0, and it has to: the control plane dials it across
 * the tailnet. That same port is therefore visible to every other machine on
 * a COMPANY tailnet with other people's VMs and an admin who is not the user.
 * Forwarding `/api` from there would hand all of them the user's cards and
 * `agent send`. So the check is on the peer address, per request.
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what Node reports on a dual-stack
 * listener, and missing it would have made this refuse everything on exactly
 * the machines it is meant to serve.
 */
export function isLoopbackPeer(addr: string | undefined | null): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, '');
  return a === '127.0.0.1' || a === '::1' || a === 'localhost' || /^127\./.test(a);
}

/**
 * The in-pane CLI's funnel, and only that.
 *
 * A prefix check here, not an allowlist — unusual for this file, and
 * deliberate. The POLICY lives on the server (node-link/host-api.ts), which is
 * the only side that knows which machine is asking and can check an id against
 * the pane table. Two copies of an allowlist is two things to keep in sync and
 * a host that can be lied to about its own rights; the server refuses what it
 * does not allow, and this side carries it.
 */
export function isApiFunnelPath(path: string): boolean {
  return path === '/api' || path.startsWith('/api/');
}

/** A card can be 64KB; nothing the CLI sends is bigger than this. */
const MAX_API_BODY = 256 * 1024;

/**
 * Start the agent. Resolves once it is listening.
 */
export async function startNodeAgent(opts: NodeAgentOptions): Promise<{ close: () => void }> {
  const port = opts.port ?? DEFAULT_NODE_PORT;
  const host = opts.host ?? '0.0.0.0';
  const ptydSocket =
    opts.ptydSocket ?? process.env.MUXPAD_PTYD_SOCKET ?? join(homedir(), '.muxpad', 'ptyd.sock');
  const log = opts.log ?? ((l: string) => console.log(l));
  const dataDir = opts.dataDir ?? process.env.MUXPAD_DATA_DIR ?? join(homedir(), '.muxpad');

  // ── THIS MACHINE'S OWN ARCHIVE ──────────────────────────────────────────
  //
  // A chat on this host writes its transcript HERE, and nothing on the server
  // ever reads it (the transcript chokepoint refuses) — so until this existed,
  // a remote chat was unsearchable from anywhere: the server's archiver skips
  // panes that are not its own, and there was no second archiver.
  //
  // It needs no database. The Archiver discovers sessions by SCANNING for
  // transcripts, and `db` is only for enrichment the server does — which is
  // exactly the shape a host needs, and the reason this is a few lines rather
  // than a port of the server's session tables.
  //
  // Search across machines is then the SERVER asking each host and merging for
  // the user to look at. The in-pane `muxpad search` on this machine still
  // sees only this machine, which is the host-scoping rule and not an
  // accident of what is implemented.
  const archive = opts.archive === false ? null : new ArchiveDb(join(dataDir, 'archive.sqlite'));
  const archiver = archive
    ? new Archiver({
        archive,
        archiveDir: join(dataDir, 'archive'),
        claudeProjectsDir: projectsDir(),
        muxpadTranscriptsDir: join(dataDir, 'agent-transcripts'),
      })
    : null;
  archiver?.start();

  const http = createServer();
  const wss = new WebSocketServer({ noServer: true });

  // ── THE LINK ────────────────────────────────────────────────────────────
  //
  // `/control` and `/pty/:id` stay exactly as they are: the server still dials
  // them per use, which works because server→host was never the blocked
  // direction. `/link` is additive, and it is the only path that can carry
  // host→server traffic — a runner's frames and a chat's history — because it
  // is a socket the server already holds open.
  const link = new LinkServer({
    connectPtyd: () => new WebSocket(`ws+unix://${ptydSocket}:/control`),
    // Absent when archiving is off, which makes the host answer "no index
    // here" — a different fact from "no hits", and one the server shows.
    ...(archive
      ? {
          /**
           * Hits WITH their session metadata, because a result has to be
           * navigable.
           *
           * The server cannot enrich these: a remote sid does not appear in
           * its session tables. But the pane id does — a remote pane's ROW
           * lives on the server with `node_id` set — so passing the host's
           * own `archive_sessions` row through is what turns a cross-host hit
           * into a row you can click and land in the chat.
           */
          search: (q: string, o: { limit: number; role?: string }) => {
            const { hits, fallback } = archive.search(q, o);
            const metas = new Map<string, unknown>();
            for (const h of hits)
              if (!metas.has(h.sid)) metas.set(h.sid, archive.getSession(h.sid) ?? null);
            return {
              hits: hits.map((h) => ({ ...h, session: metas.get(h.sid) })),
              fallback,
            };
          },
        }
      : {}),
    /**
     * Read PER SIGNATURE, not cached: rotating the key is then a file write,
     * where caching would make it a node-agent restart — and a restart here
     * drops every pane's link on this machine.
     */
    originKey: () => readOriginIdentity(dataDir),
    makeTail: (sid, assistant, sink, tailBytes) =>
      new TranscriptTail(sid, {
        ...(tailBytes === undefined ? {} : { tailBytes }),
        onEvents: sink.onEvents as (e: unknown[], phase: string) => void,
        onTitle: sink.onTitle,
        // Non-Claude backends write muxpad's own normalised log rather than a
        // Claude-format transcript, exactly as the server's local tail does.
        ...(assistant !== 'claude' ? { locate: muxpadLocate, normalize: identityNormalize } : {}),
      }) as never,
    log,
  });

  // A refusal says WHY in the log but never echoes the presented token — a
  // credential in a log file is a credential in a backup.
  const refuse = (socket: import('node:stream').Duplex, why: string, peer: string): void => {
    log(`[muxpad-node] refused ${peer}: ${why}`);
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    } catch {
      /* the peer is gone; nothing to tell it */
    }
  };

  http.on('request', (req, res) => {
    // ONE unauthenticated route, deliberately: a liveness probe that needed the
    // token would report a credential problem as a dead machine, and the
    // control plane could not tell those apart.
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (
      req.url === '/self' &&
      tokenMatches(req.headers['x-muxpad-node-token'] as string, opts.token)
    ) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(describeSelf()));
      return;
    }
    if (isApiFunnelPath(req.url ?? '') && isLoopbackPeer(req.socket.remoteAddress)) {
      void forwardApi(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  /** Read the body (capped), ask the control plane, answer the pane. */
  async function forwardApi(
    req: import('node:http').IncomingMessage,
    res: import('node:http').ServerResponse,
  ): Promise<void> {
    const reply = (status: number, body: string, contentType = 'application/json') => {
      res.writeHead(status, { 'content-type': contentType });
      res.end(body);
    };
    let body: string | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      try {
        body = await new Promise<string>((resolve, reject) => {
          const chunks: Buffer[] = [];
          let size = 0;
          req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_API_BODY) {
              reject(new Error('too large'));
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          req.on('error', reject);
        });
      } catch {
        reply(413, JSON.stringify({ error: 'body too large' }));
        return;
      }
    }
    /**
     * WHAT THE CALLER SAYS THIS CALL IS FOR.
     *
     * A label from the in-pane CLI (`x-muxpad-connector-action: slack.post`),
     * carried no further than this machine: the control plane never sees it,
     * and it is used for exactly one thing — refusing to sign an action the
     * caller did not ask for, when the server later asks this host to prove
     * the request is its own. See LinkServer#signOrigin.
     *
     * Unvalidated beyond a charset, because it is not authority. A caller
     * that lies about its own action only narrows what it can get signed.
     */
    const declared = req.headers['x-muxpad-connector-action'];
    const action = (Array.isArray(declared) ? declared[0] : declared) ?? '';
    const out = await link.callApi(
      req.method ?? 'GET',
      req.url ?? '/',
      body,
      /^[a-z][a-z0-9]*\.[a-z][a-z0-9-]*$/.test(action) ? action : undefined,
    );
    reply(out.status, out.body, out.contentType ?? 'application/json');
  }

  http.on('upgrade', (req, socket, head) => {
    // `upgrade` hands a Duplex, which is a Socket in practice but not in the
    // types. The peer address is only ever for a log line, so read it
    // defensively rather than widening the signature.
    const peer = String((socket as { remoteAddress?: string }).remoteAddress ?? '?');
    const raw = req.headers['x-muxpad-node-token'];
    const presented = (Array.isArray(raw) ? raw[0] : raw) ?? null;
    if (!tokenMatches(presented, opts.token)) {
      refuse(socket, 'bad or missing node token', peer);
      return;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    const linkRoute = linkUpgradeKind(url.pathname);
    if (linkRoute) {
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (linkRoute.kind === 'link') link.attachLink(ws);
        else link.attachRunner(linkRoute.paneId, ws);
      });
      return;
    }
    if (!isForwardablePath(url.pathname)) {
      refuse(socket, `path not forwardable: ${url.pathname}`, peer);
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // A plain byte pipe in both directions, which is the same shape the main
      // server already uses to proxy a browser viewer's socket. Nothing here
      // inspects frames: ptyd validates its own input, and a second opinion
      // about the protocol is a second thing to keep in sync.
      const target = `ws+unix://${ptydSocket}:${url.pathname}${url.search}`;
      const upstream = new WebSocket(target);
      upstream.binaryType = 'nodebuffer';
      const closeBoth = () => {
        try {
          ws.close();
        } catch {}
        try {
          upstream.close();
        } catch {}
      };
      // Buffer what the peer says before ptyd is ready. Without this, the
      // first frame after an upgrade — which for /control is the one that
      // matters — is dropped on a cold socket.
      const pending: Array<Buffer | ArrayBuffer | Buffer[]> = [];
      ws.on('message', (d) => {
        if (upstream.readyState === WebSocket.OPEN) upstream.send(d as Buffer);
        else pending.push(d as Buffer);
      });
      upstream.on('open', () => {
        for (const d of pending) upstream.send(d as Buffer);
        pending.length = 0;
      });
      upstream.on('message', (d, isBinary) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: isBinary });
      });
      upstream.on('close', closeBoth);
      upstream.on('error', (e) => {
        log(`[muxpad-node] ptyd error on ${url.pathname}: ${(e as Error).message}`);
        closeBoth();
      });
      ws.on('close', closeBoth);
      ws.on('error', closeBoth);
    });
  });

  await new Promise<void>((r) => http.listen(port, host, r));
  log(`[muxpad-node] listening on ${host}:${port} → ptyd ${ptydSocket}`);
  return {
    close: () => {
      archiver?.stop();
      archive?.close?.();
      link.close();
      try {
        wss.close();
      } catch {}
      http.close();
    },
  };
}
