import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import {
  type KeyInput,
  type MouseInput,
  keyEvents,
  mouseEvent,
  probeEditable,
} from '../BrowserInput.js';
import { browserLaunchSpec } from '../BrowserLaunch.js';
import { browserViewerPort } from '../BrowserProfile.js';
import { CdpConnection } from '../CdpConnection.js';
import {
  type CdpCookie,
  cdpCookiesToStorageState,
  storageStateToCdpCookies,
} from '../CookieJar.js';
import { emulationParams } from '../MobileEmulation.js';
import { focusProbeExpression } from '../FocusProbe.js';
import { isBrowsingUrl } from '../PageAttachment.js';
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
  /**
   * Where to announce the first page actually visited, so the conversation gets
   * its card at the right moment. Optional: without it the browser works and
   * simply says nothing.
   */
  apiUrl?: string;
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
  /**
   * "Browser opened", once, when a page is actually visited.
   *
   * NOT when the browser was provisioned. That happens as the agent's MCP
   * server starts — before the person has typed anything — so a card stamped
   * there sorted above the very prompt that caused it, in every new chat. And
   * it announced a process rather than an event: a session that never browses
   * got a card about a browser nobody used.
   *
   * Once per host process. A browser that navigates forty times has opened
   * once, and the conversation is not a log of its address bar.
   */
  let announcedFirstPage = false;
  const announceFirstPage = () => {
    if (announcedFirstPage || !opts.apiUrl || !isBrowsingUrl(currentUrl)) return;
    announcedFirstPage = true;
    void fetch(`${opts.apiUrl}/api/browsers/${encodeURIComponent(opts.profile)}/opened`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      // A card is decoration on a conversation. It must never be able to take
      // the browser down with it, so a failure here is silence and nothing else.
    }).catch(() => undefined);
  };

  cdp.on('Page.frameNavigated', ((p: { frame: { parentId?: string; url: string } }) => {
    if (p.frame.parentId) return;
    currentUrl = p.frame.url;
    // The viewer shows the address, so it has to hear about every navigation —
    // including ones the AGENT made, which is most of them.
    announceUrl();
    announceFirstPage();
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
    // A viewer that has just connected knows nothing about the page, so its
    // first tap would be a guess. Measure now, and keep measuring while it is
    // attached: pages grow forms, collapse them and scroll themselves without
    // anybody touching the mouse, and a stale box is a keyboard in the wrong
    // place — or, worse, none where there should be one.
    void sendFieldBoxes(socket);
    const boxes = setInterval(() => {
      if (socket.readyState !== 1) return;
      void sendFieldBoxes(socket);
      // AND CHECK THE PICTURE IS REAL. Chrome refuses startScreencast on a WebUI
      // page, `chrome://newtab` included — which is where every browser begins,
      // so the first start of every session can fail. That failure is silent:
      // the error is handled, the session goes on saying it is running, and the
      // viewer is black from boot with every layer reporting health. Caught on a
      // live host holding a loaded page.
      //
      // Only while somebody is watching: a black viewer nobody has open is not a
      // problem worth waking Chrome for.
      void (async () => {
        try {
          // A page target can be swapped out from under us too — navigating away
          // from the new-tab page does it — which leaves the session attached to
          // something that no longer exists.
          const moved = await cdp.reattachIfLost();
          if (moved) {
            log(`[host] re-attached to ${moved.url}`);
            currentUrl = moved.url;
            await screencast.start();
            // Everyone watching is looking at an address that is no longer the
            // one on screen.
            for (const viewer of viewers) {
              if (viewer.readyState === 1) {
                viewer.send(JSON.stringify({ t: 'url', url: currentUrl }));
              }
            }
          }
          await screencast.ensureStreaming(Date.now());
        } catch {
          // Next tick tries again; this is the repair path, not the happy one.
        }
      })();
    }, 2000);
    socket.on('close', () => clearInterval(boxes));
  });

  /**
   * Every text field's box, so the viewer can answer a tap without asking.
   *
   * Viewport coordinates, which is what CDP mouse events already use, so no
   * conversion is needed at either end — and they follow the page as it scrolls
   * for free, provided they are refreshed after anything that scrolls it.
   *
   * Capped: a pathological page with a thousand inputs would put a payload on
   * every scroll bigger than the frame it is decorating.
   */
  const FIELD_BOXES = `(() => {
    const skip = ['button','submit','reset','checkbox','radio','file','range','color','image','hidden'];
    const out = [];
    for (const el of document.querySelectorAll('input,textarea,[contenteditable=""],[contenteditable=true]')) {
      if ((el.tagName || '').toLowerCase() === 'input' && skip.includes((el.type || 'text').toLowerCase())) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) continue;
      out.push([Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]);
      if (out.length >= 80) break;
    }
    return out;
  })()`;

  async function sendFieldBoxes(socket: WsSocket) {
    try {
      const r = (await cdp.send('Runtime.evaluate', {
        expression: FIELD_BOXES,
        returnByValue: true,
      })) as unknown as { result?: { value?: unknown } };
      const rects = r.result?.value;
      if (Array.isArray(rects) && socket.readyState === 1) {
        socket.send(JSON.stringify({ t: 'fields', rects }));
      }
    } catch {
      // The viewer falls back to guessing, which is the old behaviour.
    }
  }

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
            const read = async () => {
              // Descends into shadow roots and same-origin frames — see
              // FocusProbe.ts. The flat version reported the IFRAME or the
              // shadow HOST, said "not editable", and the viewer took the
              // keyboard away a third of a second after the tap raised it.
              const r = (await cdp.send('Runtime.evaluate', {
                expression: focusProbeExpression(),
                returnByValue: true,
              })) as unknown as { result?: { value?: boolean } };
              return Boolean(r.result?.value);
            };
            // Asked twice before believing "no" — see probeEditable. A keyboard
            // is already up by now, and taking it away wrongly is the bug.
            const editable = await probeEditable(
              read,
              (ms) => new Promise((r) => setTimeout(r, ms)),
            );
            if (socket.readyState === 1) {
              socket.send(JSON.stringify({ t: 'focus', editable }));
            }
            // A click can reveal a form, or move the page. Re-measure.
            void sendFieldBoxes(socket);
          } catch {
            // Not knowing is fine; the viewer keeps whatever it had.
          }
        }
        // Scrolling moves every box on the page.
        if (message.type === 'mouseWheel') void sendFieldBoxes(socket);
      } else if (message.t === 'reveal') {
        // Scroll the thing that needs a person into view and report where it
        // landed, so the viewer can ring it.
        //
        // SCROLL AND HIGHLIGHT, NOT CROP. A cropped login box with no address
        // and no branding is indistinguishable from a phishing overlay, and
        // credential entry is the one screen that must not lose its context.
        // Forms move as you type, too — autocomplete, validation, multi-step
        // logins — so a locked viewport ends up framing the wrong rectangle.
        // Put the person in front of the field; let them keep the page.
        const sel = String(message.selector ?? '');
        try {
          const r = (await cdp.send('Runtime.evaluate', {
            expression: `(() => {
              const el = document.querySelector(${JSON.stringify(sel)});
              if (!el) return null;
              el.scrollIntoView({ block: 'center', inline: 'center' });
              const b = el.getBoundingClientRect();
              return JSON.stringify({ x: b.x, y: b.y, w: b.width, h: b.height });
            })()`,
            returnByValue: true,
          })) as unknown as { result?: { value?: string | null } };
          const rect = r.result?.value ? JSON.parse(r.result.value) : null;
          if (socket.readyState === 1) socket.send(JSON.stringify({ t: 'revealed', rect }));
        } catch {
          // A selector that does not resolve is not an error — the browser is
          // simply left where it was, which is the old behaviour.
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
        // A different page has entirely different fields. Measured after a beat,
        // because the boxes of a page mid-load are the boxes of the old one.
        setTimeout(() => void sendFieldBoxes(socket), 700);
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
