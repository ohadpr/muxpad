import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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
import {
  fieldBoxesExpression,
  fillLoginExpression,
  focusProbeExpression,
  loginFormExpression,
} from '../FocusProbe.js';
import { appendKeyboardLog } from '../KeyboardLog.js';
import { emulationParams } from '../MobileEmulation.js';
import { isBrowsingUrl } from '../PageAttachment.js';
import { clearStaleProfileLock } from '../ProfileLock.js';
import { ScreencastSession } from '../ScreencastSession.js';
import { stampViewer } from '../ViewerBuild.js';
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

/**
 * The page, stamped with its own build, once.
 *
 * Module scope because it cannot change while this process lives — and that is
 * the whole point: a page carrying a DIFFERENT stamp was served by a different
 * process, which is exactly what a viewer needs to be told.
 */
const VIEWER_PAGE = stampViewer(VIEWER_HTML);

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
  /**
   * Everything a CDP session has to be told, in one place.
   *
   * All of it is per-SESSION, and the session is replaced whenever the page
   * target is swapped — which happens on its own, for reasons nothing to do with
   * the person. Applied once at startup, each of these silently stopped being
   * true the first time that happened:
   *
   *   · file-chooser interception — uploads then do nothing at all, because the
   *     chooser is never intercepted and the viewer is never told to offer one.
   *     Measured: broken on a re-attached host, perfect on a freshly started one.
   *   · the phone layout — the page quietly reverts to 1280px mid-handoff.
   *
   * Called after every attach, so "what a session needs" is a list rather than a
   * thing you remember.
   */
  const applySessionState = async () => {
    await cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    await applyEmulation();
    await cdp.send('Emulation.setTouchEmulationEnabled', emulation.touch);
    await cdp.send('Emulation.setUserAgentOverride', emulation.userAgent ?? { userAgent: '' });
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

  await applySessionState();
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

  /**
   * The repair loop, and there is exactly ONE of it.
   *
   * It first lived on each socket's own timer, which is wrong in a way that only
   * shows with two viewers open: both notice the same broken attachment in the
   * same tick, both re-attach, and both call `screencast.start()` on a session
   * the other has just replaced. Whose browser it is does not depend on how many
   * people are looking at it.
   *
   * Only while somebody IS looking, though — a black viewer nobody has open is
   * not worth waking Chrome for.
   */
  let repairTimer: ReturnType<typeof setInterval> | null = null;
  const repairOnce = async () => {
    try {
      // A page target can be swapped out from under us — navigating away from
      // the new-tab page does it — leaving the session attached to something
      // that no longer exists.
      const moved = await cdp.reattachIfLost();
      if (moved) {
        log(`[host] re-attached to ${moved.url}`);
        currentUrl = moved.url;
        // The new session knows none of what the old one was told.
        await applySessionState();
        await screencast.start();
        // Everyone watching is looking at an address that is no longer the one
        // on screen.
        announceUrl();
      }
      // AND CHECK THE PICTURE IS REAL. Chrome refuses startScreencast on a WebUI
      // page, `chrome://newtab` included — which is where every browser begins,
      // so the first start of every session can fail. That failure is silent:
      // the error is handled, the session goes on saying it is running, and the
      // viewer is black from boot with every layer reporting health.
      await screencast.ensureStreaming(Date.now());
    } catch {
      // Next tick tries again; this is the repair path, not the happy one.
    }
  };
  const startWatching = () => {
    if (repairTimer) return;
    repairTimer = setInterval(() => {
      void repairOnce();
      for (const viewer of viewers) {
        if (viewer.readyState !== 1) continue;
        void sendFieldBoxes(viewer);
        void sendLoginState(viewer);
      }
    }, 2000);
  };
  const stopWatching = () => {
    if (!repairTimer) return;
    clearInterval(repairTimer);
    repairTimer = null;
  };

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
    // FIRST, before anything else it might act on: a page running yesterday's
    // script should find out before it starts reporting bugs in it.
    socket.send(JSON.stringify({ t: 'build', id: VIEWER_PAGE.build }));
    void sendFieldBoxes(socket);
    void sendLoginState(socket);
    startWatching();
    socket.on('close', () => {
      if (viewers.size === 0) stopWatching();
    });
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

  /**
   * Tells the viewer whether a sign-in is on screen.
   *
   * The viewer answers by putting up a real form of its own — see the login
   * panel there — because a password manager fills the page it is looking at,
   * and that page is muxpad rather than the site.
   */
  async function sendLoginState(socket: WsSocket) {
    try {
      const r = (await cdp.send('Runtime.evaluate', {
        expression: loginFormExpression(),
        returnByValue: true,
      })) as unknown as { result?: { value?: unknown } };
      const login = r.result?.value as { present?: boolean } | undefined;
      if (login && socket.readyState === 1) {
        socket.send(JSON.stringify({ t: 'login', ...login }));
      }
    } catch {
      // No panel offered. Typing by hand still works.
    }
  }

  async function sendFieldBoxes(socket: WsSocket) {
    try {
      const r = (await cdp.send('Runtime.evaluate', {
        expression: fieldBoxesExpression(),
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
      } else if (message.t === 'hello') {
        // A VIEWER SAYING WHAT IT IS. The one that matters is `build`: a page
        // whose stamp is not the one this process serves is running a script that
        // was replaced, and everything measured on it is measured on code that no
        // longer exists. Said out loud here so the answer is in the logs rather
        // than inferred from the outside.
        const stale = message.build !== VIEWER_PAGE.build;
        log(
          `[host] viewer connected · build ${String(message.build)}` +
            `${stale ? ` STALE (serving ${VIEWER_PAGE.build})` : ' current'}` +
            ` · ${String(message.mode)} · ${String(message.w)}x${String(message.h)}`,
        );
      } else if (message.t === 'diag') {
        // A phone reporting what its keyboard actually did. The browser runs
        // here and the keyboard is three hundred miles away on somebody's
        // handset, so without this the only evidence available is a person
        // describing what they saw — which is how three fixes in a row came to
        // be aimed at the wrong thing. Appended, never read back by the page.
        appendKeyboardLog(
          opts.dataDir,
          opts.profile,
          message as { what?: unknown; events?: unknown },
        );
      } else if (message.t === 'fillLogin') {
        // WHAT A PASSWORD MANAGER FILLED, PUT INTO THE PAGE. The viewer's own
        // form is a stand-in: 1Password can see it, the site's cannot be seen at
        // all. Typed here with the events a controlled form needs, and NOT
        // submitted — pressing the button stays the person's decision.
        const ok = (await cdp.send('Runtime.evaluate', {
          expression: fillLoginExpression(
            String(message.username ?? ''),
            String(message.password ?? ''),
          ),
          returnByValue: true,
        })) as unknown as { result?: { value?: boolean } };
        if (socket.readyState === 1) {
          socket.send(JSON.stringify({ t: 'filled', ok: Boolean(ok.result?.value) }));
        }
        void sendFieldBoxes(socket);
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
        // THE SHAPE OF THE SCREEN LOOKING AT IT. The viewer sends its own size,
        // so turning the phone gives the page a landscape viewport instead of
        // leaving a portrait column with a black half beside it. Absent or
        // implausible, it falls back to a phone — see phoneViewport.
        const wanted = emulationParams(Boolean(message.mobile), {
          width: Number(message.width),
          height: Number(message.height),
        });
        // A RELOAD IS EXPENSIVE and an orientation change is not a new page.
        // Reload only when the mobile SIGNALS change; a pure resize is a resize.
        const signalsChanged =
          Boolean(wanted.metrics) !== Boolean(emulation.metrics) ||
          wanted.userAgent?.userAgent !== emulation.userAgent?.userAgent;
        emulation = wanted;
        await applyEmulation();
        await cdp.send('Emulation.setTouchEmulationEnabled', emulation.touch);
        await cdp.send('Emulation.setUserAgentOverride', emulation.userAgent ?? { userAgent: '' });
        // The page has to be re-fetched for a server-rendered mobile layout;
        // a resize alone gets a desktop page in a narrow window. But re-fetching
        // on every rotation would throw away whatever was typed into it.
        if (signalsChanged) await cdp.send('Page.reload', {});
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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(VIEWER_PAGE.html);
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
    /**
     * A still of what the browser is looking at, right now.
     *
     * Page.captureScreenshot rather than the last streamed frame: the screencast
     * only commits on CHANGE, so a page that has finished loading and is sitting
     * still — which is exactly the moment worth photographing, the one an agent
     * stops on — may not have produced a frame for minutes. This asks.
     */
    if (path === '/shot') {
      try {
        const shot = (await cdp.send('Page.captureScreenshot', {
          format: 'jpeg',
          quality: 55,
          captureBeyondViewport: false,
        })) as unknown as { data?: string };
        const bytes = Buffer.from(shot.data ?? '', 'base64');
        if (!bytes.length) throw new Error('empty screenshot');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': bytes.length });
        res.end(bytes);
      } catch (err) {
        res
          .writeHead(503, { 'content-type': 'application/json' })
          .end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
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
        const safe = raw.replace(/[/\\]/g, '_').slice(-120) || 'upload.bin';
        // THE PAGE SEES THIS NAME. Prefixing the file made a photo arrive as
        // "muxpad-handoff-IMG_0421.jpg" — measured — which is our plumbing
        // written into somebody's upload, and a name a site is entitled to
        // validate. The uniqueness goes in a directory instead, where the page
        // never looks.
        const dir = mkdtempSync(join(tmpdir(), 'muxpad-handoff-'));
        const file = join(dir, safe);
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
      // PHOTOGRAPH IT ON THE WAY OUT, before anything is torn down. The card for
      // a closed browser is the only record of what it was doing, and a still
      // captured when it OPENED would show the first page it visited dressed as
      // the last — confidently wrong. Bounded and best-effort: a browser being
      // shut down must not be held up by a picture of itself, and one that is
      // killed outright never gets here at all.
      if (opts.apiUrl) {
        try {
          const shot = (await Promise.race([
            cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 55 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('slow')), 2500)),
          ])) as { data?: string };
          const bytes = Buffer.from(shot?.data ?? '', 'base64');
          if (bytes.length) {
            await fetch(`${opts.apiUrl}/api/browsers/${encodeURIComponent(opts.profile)}/closing`, {
              method: 'POST',
              headers: { 'content-type': 'image/jpeg' },
              body: bytes,
              signal: AbortSignal.timeout(2500),
            });
          }
        } catch (err) {
          log(`[host] no last picture: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
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
