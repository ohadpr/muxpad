import { type ChildProcess, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { type KeyInput, type MouseInput, keyEvents, mouseEvent } from '../BrowserInput.js';
import { browserLaunchSpec } from '../BrowserLaunch.js';
import { browserViewerPort } from '../BrowserProfile.js';
import { CdpConnection } from '../CdpConnection.js';
import { ScreencastSession } from '../ScreencastSession.js';
import { VIEWER_HTML } from './viewer.js';

/**
 * The owner process for one browser profile.
 *
 * This is what an app row runs. It owns exactly three things and nothing else:
 *
 *   1. a headless Chrome, launched against ONE named profile directory — which
 *      is the whole point, because one owner per profile is what makes cookies
 *      survivable (see BrowserProfile.ts);
 *   2. a CDP connection to it, attached at the BROWSER endpoint so the agent's
 *      Playwright MCP can attach to the same browser at the same time;
 *   3. a loopback HTTP server: the viewer page, the frame stream, and the input
 *      channel back.
 *
 * WHY IT LAUNCHES CHROME ITSELF INSTEAD OF LETTING THE MCP DO IT
 * -------------------------------------------------------------
 * Because whoever launches it owns its lifetime. Today the MCP launches one per
 * agent session, which is why there are ninety of them and why none of them
 * share a cookie. Putting the launch here makes the browser a supervised thing
 * with a start, a stop and logs, and leaves the MCP as one more client dialling
 * in over `--cdp-endpoint`.
 *
 * EVERYTHING BINDS LOOPBACK. This machine is on a tailnet and this process is a
 * driveable browser holding every cookie the user has; bound wide it would be
 * offered to every device on the network. Reaching it from a phone is muxpad's
 * job, through muxpad's own auth — not this server's.
 */

export interface BrowserHostOptions {
  profile: string;
  /** CDP port. The viewer is derived from it — see browserViewerPort. */
  port: number;
  dataDir: string;
  chromePath: string;
  /** Overrides the derived viewer port. Tests only; production wants it stable. */
  viewerPort?: number;
  log?: (line: string) => void;
}

/** A running owner. */
export interface BrowserHost {
  /** Where a person goes to watch and drive. */
  url: string;
  /** Where the agent's Playwright MCP dials in with --cdp-endpoint. */
  cdpUrl: string;
  close(): Promise<void>;
}

const CDP_READY_TIMEOUT_MS = 20_000;

export async function startBrowserHost(opts: BrowserHostOptions): Promise<BrowserHost> {
  const log = opts.log ?? ((line: string) => console.log(line));
  const spec = browserLaunchSpec(opts);

  mkdirSync(spec.profileDir, { recursive: true });
  const chrome = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr?.on('data', (b) => log(`[chrome] ${String(b).trimEnd()}`));
  chrome.on('exit', (code) => log(`[chrome] exited ${code}`));

  await waitForCdp(spec.url, chrome);

  const cdp = new CdpConnection({
    endpoint: spec.url,
    onError: (where, err) => log(`[cdp] ${where}: ${err.message}`),
  });
  await cdp.connect();
  const target = await cdp.attachToPage();
  log(`[host] attached to ${target.url}`);

  const viewers = new Set<WsSocket>();
  let pendingFileChooser: { backendNodeId: number } | null = null;

  const screencast = new ScreencastSession(cdp, {
    onError: (where, err) => log(`[screencast] ${where}: ${err.message}`),
    onFrame: ({ bytes, metadata }) => {
      const header = JSON.stringify({ t: 'frame', meta: metadata, bytes: bytes.length });
      for (const viewer of viewers) {
        if (viewer.readyState !== 1) continue;
        viewer.send(header);
        viewer.send(bytes, { binary: true });
      }
    },
  });

  // The file chooser is INTERCEPTED, never shown. A native file dialog is a
  // window on the user's screen, which is the thing this whole design forbids —
  // and intercepting it is also what lets somebody upload from their phone.
  cdp.on('Page.fileChooserOpened', ((p: { backendNodeId: number }) => {
    pendingFileChooser = p;
    for (const viewer of viewers) {
      if (viewer.readyState === 1) viewer.send(JSON.stringify({ t: 'fileChooser' }));
    }
  }) as never);
  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await screencast.start();

  const http = createServer((req, res) => void handleHttp(req, res));
  const wss = new WebSocketServer({ server: http, path: '/ws' });

  wss.on('connection', (socket) => {
    viewers.add(socket);
    socket.on('close', () => viewers.delete(socket));
    socket.on('message', (raw) => void handleInput(socket, raw.toString()));
  });

  async function handleInput(socket: WsSocket, raw: string) {
    let message: { t: string } & Record<string, unknown>;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    try {
      if (message.t === 'mouse') {
        await cdp.send('Input.dispatchMouseEvent', mouseEvent(message as unknown as MouseInput));
      } else if (message.t === 'key') {
        for (const event of keyEvents(message as unknown as KeyInput)) {
          await cdp.send('Input.dispatchKeyEvent', event);
        }
      }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      log(`[input] ${text}`);
      if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'error', error: text }));
    }
  }

  async function handleHttp(req: IncomingMessage, res: ServerResponse) {
    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(VIEWER_HTML);
      return;
    }
    if (path === '/healthz') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, viewers: viewers.size, url: target.url }));
      return;
    }
    if (path === '/upload' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      try {
        if (!pendingFileChooser) throw new Error('no file chooser is open');
        // The page chose when to ask and the name rides a header, so basename
        // it — it must not be able to climb out of the temp dir.
        const raw = String(req.headers['x-filename'] ?? 'upload.bin');
        const safe = raw.replace(/[/\\]/g, '_').slice(-120);
        const file = join(tmpdir(), `muxpad-handoff-${safe}`);
        writeFileSync(file, Buffer.concat(chunks));
        await cdp.send('DOM.setFileInputFiles', {
          files: [file],
          backendNodeId: pendingFileChooser.backendNodeId,
        });
        pendingFileChooser = null;
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true }));
      } catch (err) {
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          );
      }
      return;
    }
    res.writeHead(404).end('not found');
  }

  // LOOPBACK, and a DERIVED port. Both matter: this process is a driveable
  // browser holding every cookie the user has, and its URL ends up in a card in
  // a chat log that outlives the process — an ephemeral port would strand it.
  const viewerPort = opts.viewerPort ?? browserViewerPort(opts.port);
  await new Promise<void>((resolve) => http.listen(viewerPort, '127.0.0.1', resolve));
  log(`[host] viewer on http://127.0.0.1:${viewerPort}/ (profile ${opts.profile})`);

  return {
    url: `http://127.0.0.1:${viewerPort}`,
    cdpUrl: spec.url,
    async close() {
      await screencast.stop().catch(() => {});
      cdp.close();
      wss.close();
      await new Promise<void>((resolve) => http.close(() => resolve()));
      chrome.kill();
    },
  };
}

/**
 * Waits for the debugging port to answer.
 *
 * Polls rather than trusting a fixed sleep, and gives up the moment Chrome
 * exits — otherwise a browser that died on a bad flag is indistinguishable from
 * one that is merely slow, for twenty seconds, on every single start.
 */
async function waitForCdp(endpoint: string, chrome: ChildProcess) {
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (chrome.exitCode !== null) {
      throw new Error(`chrome exited (${chrome.exitCode}) before CDP came up`);
    }
    try {
      if ((await fetch(`${endpoint}/json/version`)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`CDP did not come up at ${endpoint} within ${CDP_READY_TIMEOUT_MS}ms`);
}
