import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { type KeyInput, type MouseInput, keyEvents, mouseEvent } from '../BrowserInput.js';
import { browserLaunchSpec } from '../BrowserLaunch.js';
import { browserViewerPort } from '../BrowserProfile.js';
import { CdpConnection } from '../CdpConnection.js';
import {
  type CdpCookie,
  cdpCookiesToStorageState,
  storageStateToCdpCookies,
} from '../CookieJar.js';
import { emulationParams } from '../MobileEmulation.js';
import { clearStaleProfileLock } from '../ProfileLock.js';
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
  /** Where the shared cookie jar is written. Agents read it with --storage-state. */
  jarPath?: string;
  /** Called when Chrome exits on its own. Defaults to taking this process with it. */
  onChromeExit?: () => void;
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
  const jarPath = opts.jarPath ?? null;
  const onChromeExit = opts.onChromeExit ?? (() => process.exit(1));
  let closing = false;
  const spec = browserLaunchSpec(opts);

  mkdirSync(spec.profileDir, { recursive: true });
  // A lock left by an unclean exit makes every subsequent launch die on
  // startup, which `muxpad serve` then retries forever. One profile has one
  // owner, so a lock present as WE start is by definition stale.
  clearStaleProfileLock(spec.profileDir);
  const chrome = spawn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr?.on('data', (b) => log(`[chrome] ${String(b).trimEnd()}`));
  // WHEN CHROME DIES, THIS PROCESS DIES. It used to just log, and the result was
  // a host serving a viewer against a dead browser: the socket opened, no frames
  // ever came, and /healthz cheerfully said ok. `muxpad serve` already supplies
  // crash-loop backoff, so exiting is how a restart happens — a second opinion
  // about recovery, inside a process whose CDP connection is already gone, is
  // how you get a thing that looks alive and does nothing.
  chrome.on('exit', (code) => {
    log(`[chrome] exited ${code}`);
    if (!closing) onChromeExit();
  });

  // findChrome deliberately does NOT verify a path inside an app bundle —
  // stat-ing there is what raises a macOS permission dialog on the real screen.
  // So a wrong path arrives HERE instead, and this is where it has to become a
  // sentence rather than an unhandled 'error' event that takes the process down
  // with a stack trace nobody can act on.
  let spawnFailure: Error | null = null;
  chrome.on('error', (err) => {
    spawnFailure = new Error(`cannot launch ${spec.command}: ${err.message}`);
    log(`[chrome] ${spawnFailure.message}`);
  });

  await waitForCdp(spec.url, chrome, () => spawnFailure);

  const cdp = new CdpConnection({
    endpoint: spec.url,
    onError: (where, err) => log(`[cdp] ${where}: ${err.message}`),
  });
  await cdp.connect();
  const target = await cdp.attachToPage();
  log(`[host] attached to ${target.url}`);

  // The page the browser is ON, kept current. Captured once at attach it goes
  // stale the first time anything navigates — and this value is what a card in
  // a chat says the browser is looking at, so a stale one is a card that lies.
  let currentUrl = target.url;
  const announceUrl = () => {
    const msg = JSON.stringify({ t: 'url', url: currentUrl });
    for (const viewer of viewers) if (viewer.readyState === 1) viewer.send(msg);
  };
  cdp.on('Page.frameNavigated', ((p: { frame: { parentId?: string; url: string } }) => {
    if (p.frame.parentId) return;
    currentUrl = p.frame.url;
    // The viewer shows the address, so it has to hear about every navigation —
    // including ones the AGENT made, which is most of them.
    announceUrl();
  }) as never);

  const viewers = new Set<WsSocket>();
  let pendingFileChooser: { backendNodeId: number } | null = null;

  // The host owns emulation, so it owns the repaint kick too — the default one
  // clears device metrics and would wipe the mobile layout on every re-arm.
  let emulation = emulationParams(false);
  const applyEmulation = async () => {
    if (emulation.metrics) await cdp.send('Emulation.setDeviceMetricsOverride', emulation.metrics);
    else await cdp.send('Emulation.clearDeviceMetricsOverride');
  };
  const screencast = new ScreencastSession(cdp, {
    kick: async () => {
      // One pixel taller than whatever is currently in force, then back — a
      // commit without losing the override.
      const base = emulation.metrics ?? {
        width: 1280,
        height: 900,
        deviceScaleFactor: 0,
        mobile: false,
      };
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        ...base,
        height: (base.height as number) + 1,
      });
      await applyEmulation();
    },
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
  // SEED FROM THE SHARED JAR. A browser muxpad launches for an agent starts
  // with the logins a PERSON has already performed — that is the whole point of
  // the jar, and without it a per-session browser is just a cold one with extra
  // steps. Best-effort: a missing or unreadable jar is the ordinary first-run
  // case, not a reason to refuse to start.
  if (jarPath && existsSync(jarPath)) {
    try {
      const cookies = storageStateToCdpCookies(JSON.parse(readFileSync(jarPath, 'utf8')));
      if (cookies.length) await cdp.send('Storage.setCookies', { cookies });
      log(`[host] seeded ${cookies.length} cookies from the shared jar`);
    } catch (err) {
      log(`[host] could not seed cookies: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
  await screencast.start();

  const http = createServer((req, res) => void handleHttp(req, res));
  // The path is NOT pinned to '/ws': muxpad proxies this viewer under
  // /browser/<profile>/, and the upgrade arrives with that prefix intact.
  // Anything ending in /ws is us — nothing else is listening on this port.
  const wss = new WebSocketServer({ noServer: true });
  http.on('upgrade', (req, socket, head) => {
    if (!new URL(req.url ?? '/', 'http://127.0.0.1').pathname.endsWith('/ws')) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (socket) => {
    viewers.add(socket);
    // Tell a new viewer where the browser IS, before any frame arrives.
    if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'url', url: currentUrl }));
    // A viewer that arrives after the page settled would otherwise see black
    // forever: the compositor only commits on change, and a finished page never
    // changes again. Cost is one frame.
    void screencast.repaint();
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
        // After a RELEASE, report whether the page now has a text field focused.
        // A phone shows no keyboard unless something on ITS side is focused, so
        // the viewer needs to know when to put one there — tapping a text box in
        // a video stream is otherwise a tap into a picture.
        if (message.type === 'mouseReleased') {
          try {
            const r = (await cdp.send('Runtime.evaluate', {
              expression: `(() => { const a = document.activeElement; if (!a) return false;
                const t = (a.tagName || '').toLowerCase();
                if (t === 'textarea') return true;
                if (a.isContentEditable) return true;
                if (t !== 'input') return false;
                return !['button','submit','reset','checkbox','radio','file','range','color','image'].includes((a.type||'text').toLowerCase());
              })()`,
              returnByValue: true,
            })) as unknown as { result?: { value?: boolean } };
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ t: 'focus', editable: Boolean(r.result?.value) }));
            }
          } catch {
            // Not knowing is fine; the viewer keeps whatever it had.
          }
        }
      } else if (message.t === 'text') {
        // Whole strings, not keystrokes. A phone keyboard gives autocorrect,
        // dictation and emoji as composed text, and replaying that as synthetic
        // keydowns loses all three — insertText is what the page would have got
        // from a real IME.
        await cdp.send('Input.insertText', { text: String(message.text ?? '') });
      } else if (message.t === 'emulate') {
        // Phone layout on demand. All three signals together — see
        // MobileEmulation.ts for why metrics alone is not enough.
        emulation = emulationParams(Boolean(message.mobile));
        await applyEmulation();
        await cdp.send('Emulation.setTouchEmulationEnabled', emulation.touch);
        await cdp.send('Emulation.setUserAgentOverride', emulation.userAgent ?? { userAgent: '' });
        // The page has to be re-fetched for a server-rendered mobile layout;
        // a resize alone gets a desktop page in a narrow window.
        await cdp.send('Page.reload', {});
      } else if (message.t === 'nav') {
        // Back, forward and reload. A person looking at a page they did not
        // navigate to needs a way out of it that is not "ask the agent".
        if (message.action === 'back')
          await cdp.send('Page.goBack' as string, {}).catch(async () => {
            await cdp.send('Runtime.evaluate', { expression: 'history.back()' });
          });
        else if (message.action === 'forward')
          await cdp.send('Runtime.evaluate', { expression: 'history.forward()' });
        else if (message.action === 'reload') await cdp.send('Page.reload', {});
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
    // Served either directly or behind muxpad's /browser/<profile>/ proxy, so
    // match on the TAIL rather than the whole path.
    const full = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    const path = `/${full.split('/').pop() ?? ''}`;

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(VIEWER_HTML);
      return;
    }
    // The shared jar. Agents start warm from this file — see CookieJar.ts for
    // why they cannot simply share this browser. Written on demand rather than
    // on a timer: it is only read when an agent starts, and a stale file is
    // better than a write every few seconds against a live profile.
    if (path === '/storage-state') {
      try {
        const { cookies } = (await cdp.send('Storage.getCookies')) as unknown as {
          cookies: CdpCookie[];
        };
        const state = cdpCookiesToStorageState(cookies);
        if (jarPath) writeFileSync(jarPath, JSON.stringify(state));
        res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: true, cookies: state.cookies.length, path: jarPath }));
      } catch (err) {
        res
          .writeHead(500, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
          );
      }
      return;
    }
    if (path === '/healthz') {
      // PROBE, do not assert. This used to return ok:true unconditionally, so a
      // host whose Chrome had died reported healthy to the app status probe and
      // to anyone reading it — while the viewer sat black. A health check that
      // cannot fail is worse than none, because it is believed.
      try {
        await cdp.send('Runtime.evaluate', { expression: '1', returnByValue: true });
      } catch (err) {
        res.writeHead(503, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: false,
            error: `browser unreachable: ${err instanceof Error ? err.message : String(err)}`,
          }),
        );
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: true, viewers: viewers.size, url: currentUrl }));
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
      closing = true;
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
async function waitForCdp(
  endpoint: string,
  chrome: ChildProcess,
  spawnFailure: () => Error | null,
) {
  const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const failed = spawnFailure();
    if (failed) throw failed;
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
