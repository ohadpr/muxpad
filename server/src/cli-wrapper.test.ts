import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { type ServerType, serve } from '@hono/node-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventBus } from './events.js';
import { localFunnel } from './funnel.js';
import { PtydCache } from './ptyd-cache.js';
import { createApp } from './server.js';
import { AgentSessionStore } from './store/AgentSessionStore.js';
import { PaneStore } from './store/PaneStore.js';
import { TabStore } from './store/TabStore.js';
import { WorkspaceStore } from './store/WorkspaceStore.js';
import { openDb } from './store/db.js';
import { type SpawnedPtyd, spawnPtyd } from './test-helpers/spawnPtyd.js';

const execFileAsync = promisify(execFile);

const MUXPAD_BIN = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'scripts',
  'muxpad',
);

/**
 * Boots a real HTTP server (not just Hono in-memory) so the bash
 * wrapper's curl calls hit it. One workspace round-trip end-to-end is
 * enough to prove the pipe; per-verb correctness is covered by the
 * route tests this wrapper is just a curl-shaped client for.
 */
describe('scripts/muxpad HTTP wrapper', () => {
  let server: ServerType;
  let port: number;
  let tmp: string;
  let ptyd: SpawnedPtyd;
  let workspaces: WorkspaceStore;
  let tabs: TabStore;
  let panes: PaneStore;
  let agents: AgentSessionStore;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'muxpad-cli-'));
    const db = openDb(':memory:');
    workspaces = new WorkspaceStore(db);
    tabs = new TabStore(db);
    panes = new PaneStore(db);
    agents = new AgentSessionStore(db);
    ptyd = await spawnPtyd();
    const cache = new PtydCache();
    cache.attach(ptyd.client);
    const app = createApp({
      db,
      ptyd: ptyd.client,
      cache,
      dataDir: tmp,
      events: new EventBus(),
      publish: {
        // The real localFunnel (no tailscale exec — the CLI's own stub does the
        // discovering here), plus a reachability probe that always answers.
        // This test is about the HINT/PERSIST chain; without the stub it would
        // depend on `stub-host.ts.net` resolving on the internet, and the
        // base-url probe would correctly warn that it does not.
        funnel: localFunnel(7799, 'funnel disabled in tests'),
        baseProbe: async () => ({
          alive: true,
          status: 404,
          reason: 'client_error' as const,
          elapsedMs: 1,
        }),
      },
    });
    // serve() returns a node http server; bind to port 0 → kernel picks one.
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => server.once('listening', () => r()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    port = addr.port;
  });

  afterAll(async () => {
    await ptyd.cleanup();
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(tmp, { recursive: true, force: true });
  });

  it('workspace new returns the created id and persists in the server', async () => {
    const env = { ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` };
    const { stdout } = await execFileAsync(
      MUXPAD_BIN,
      ['workspace', 'new', '--name=test-from-cli'],
      { env, encoding: 'utf-8' },
    );
    // Server-generated ids are ULIDs (26 chars, Crockford base32). Extract
    // the first match and confirm the server has it.
    const idMatch = stdout.match(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(idMatch, `wrapper stdout did not contain a ULID:\n${stdout}`).not.toBeNull();
    const id = idMatch![0];
    const persisted = workspaces.getById(id);
    expect(persisted).not.toBeNull();
    expect(persisted!.name).toBe('test-from-cli');
  });

  it('--json emits raw server JSON', async () => {
    const env = { ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` };
    const { stdout } = await execFileAsync(
      MUXPAD_BIN,
      ['--json', 'workspace', 'new', '--name=json-cli'],
      { env, encoding: 'utf-8' },
    );
    // Must be parseable JSON with the fields we expect from POST /workspaces.
    const parsed = JSON.parse(stdout) as { id: string; name: string };
    expect(parsed.id).toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
    expect(parsed.name).toBe('json-cli');
    expect(workspaces.getById(parsed.id)).not.toBeNull();
  });

  it('publish discovers the base url via a STUBBED tailscale, then falls back to the persisted value', async () => {
    // The stub stands in for the real binary via MUXPAD_TAILSCALE_BIN —
    // tests must NEVER run the real tailscale (a funnel exec would expose
    // content publicly). It logs its argv and answers `status --json`.
    const stub = join(tmp, 'tailscale-stub.sh');
    const stubLog = join(tmp, 'tailscale-stub.log');
    writeFileSync(
      stub,
      `#!/bin/sh\necho "$@" >> "${stubLog}"\nif [ "$1" = "status" ]; then printf '%s' '{"Self":{"DNSName":"stub-host.ts.net."}}'; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const srcFile = join(tmp, 'artifact.html');
    writeFileSync(srcFile, '<html>cli</html>');

    // The CLI now prefers a no-exec PTR lookup (tailnet_hostname) over execing
    // anything, so on a machine that IS on a tailnet the stub below would never
    // run and this test would silently stop covering the exec tier. A `dig`
    // shim earlier on PATH removes the cheap answer so the fallback is the thing
    // under test. Shimming `dig` rather than `ifconfig` keeps the change to the
    // one command whose answer we want to suppress.
    const shimDir = join(tmp, 'shim');
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(join(shimDir, 'dig'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    // Phase 1: no PTR answer and a stubbed tailscale — the CLI ensures the
    // funnel, reads Self.DNSName, and the server uses + persists the hint.
    const env = {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH ?? ''}`,
      MUXPAD_API_URL: `http://127.0.0.1:${port}`,
      MUXPAD_TAILSCALE_BIN: stub,
      MUXPAD_PUBLIC_PORT: '7799',
    };
    const first = await execFileAsync(MUXPAD_BIN, ['publish', srcFile, '--name=cli-hint'], {
      env,
      encoding: 'utf-8',
    });
    expect(first.stdout.trim()).toBe('https://stub-host.ts.net:8443/cli-hint/');
    // stdout stays JUST the url, so `$(muxpad publish …)` keeps working — the
    // caveat goes to stderr. And there IS a caveat: this assertion once read
    // `stderr === ''` with the comment "no warning — the URL is public", which
    // is not a thing the server can know.
    //
    // CORRECTED AGAIN, and in the opposite direction. It then asserted the
    // hedged wording ("it reaches the public internet only if Funnel is enabled
    // for this node"), which was right while a tailnet address was a reluctant
    // fallback. It is now the DEFAULT, and the note has to be plain rather than
    // hedged: it works on every device on your tailnet, and nowhere else.
    expect(first.stderr).toContain('every device on your tailnet');
    expect(first.stderr).toContain('--public');
    expect(first.stderr).not.toContain('Funnel is enabled');
    const logged = readFileSync(stubLog, 'utf-8');
    expect(logged).toContain('funnel --bg --https=8443 http://127.0.0.1:7799');
    expect(logged).toContain('status --json');

    // Phase 2: tailscale "unavailable" (launchd-shaped failure) — the hint
    // is silently skipped and the server serves the PERSISTED base url,
    // still without a warning.
    const second = await execFileAsync(MUXPAD_BIN, ['publish', srcFile, '--name=cli-fallback'], {
      env: { ...env, MUXPAD_TAILSCALE_BIN: join(tmp, 'does-not-exist') },
      encoding: 'utf-8',
    });
    expect(second.stdout.trim()).toBe('https://stub-host.ts.net:8443/cli-fallback/');
    expect(second.stderr).toContain('every device on your tailnet');

    // Phase 3: THE BUG. tailscale is available again, and the CLI must still
    // not run it — the server already has a base, so the hint could only
    // re-confirm what it knows. Every one of those pointless execs read the
    // Tailscale app's container and made macOS ask "node would like to access
    // data from other apps", about five times a day on the machine that runs
    // muxpad.
    const quietLog = join(tmp, 'tailscale-quiet.log');
    const quietStub = join(tmp, 'tailscale-quiet.sh');
    writeFileSync(
      quietStub,
      `#!/bin/sh\necho "$@" >> "${quietLog}"\nif [ "$1" = "status" ]; then printf '%s' '{"Self":{"DNSName":"stub-host.ts.net."}}'; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    const third = await execFileAsync(MUXPAD_BIN, ['publish', srcFile, '--name=cli-cached'], {
      env: { ...env, MUXPAD_TAILSCALE_BIN: quietStub },
      encoding: 'utf-8',
    });
    expect(third.stdout.trim()).toBe('https://stub-host.ts.net:8443/cli-cached/');
    expect(existsSync(quietLog), 'publish execed tailscale despite a known base').toBe(false);
  });

  /**
   * RECOVERING A LINK WHOSE HOSTNAME IS GONE.
   *
   * On 2026-09-27 at 19:45 a ptyd restart rebuilt the tunnel pane, cloudflared
   * was handed a new random hostname, and every link published in the preceding
   * nine days went NXDOMAIN at once — in chat transcripts, in reports, in
   * anything anyone had been sent. The bytes were never touched: all 150
   * artifacts were still on disk under slugs that had not moved.
   *
   * So the dead link is not lost information, it is a stale prefix on a live
   * slug, and recovering it is mechanical. `--url` does the mechanical part,
   * taking the dead URL WHOLE because that is the form the user has.
   */
  describe('publish --url reprints a link for an artifact whose address rotted', () => {
    const env = () => ({ ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` });

    it('accepts a bare slug', async () => {
      const src = join(tmp, 'recover.html');
      writeFileSync(src, '<html>recover</html>');
      await execFileAsync(MUXPAD_BIN, ['publish', src, '--name=recoverable'], {
        env: env(),
        encoding: 'utf-8',
      });
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['publish', '--url', 'recoverable'], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout.trim()).toMatch(/\/recoverable\/$/);
    });

    it('accepts the whole dead URL and reads the slug out of its path', async () => {
      const dead = 'https://search-particle-rules-ten.trycloudflare.com/recoverable/';
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['publish', '--url', dead], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout.trim()).toMatch(/\/recoverable\/$/);
      // The whole point: the answer is NOT the host it was handed.
      expect(stdout).not.toContain('search-particle-rules-ten');
    });

    /**
     * The recovery verb is the thing that was most wrong: its whole job is to
     * replace a dead link, and it was replacing it with another link built on
     * the same rotating hostname. Default it to the durable base and the SECOND
     * recovery becomes unnecessary.
     */
    it('reprints the DURABLE link, not another one that expires', async () => {
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['publish', '--url', 'recoverable'], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout.trim()).toBe('https://stub-host.ts.net:8443/recoverable/');
      expect(stdout).not.toContain('trycloudflare');
    });

    it('--public asks for a sendable link and SAYS when there is not one', async () => {
      // This server has no tunnel, so the only base is the tailnet one. The flag
      // must reach the server (or the note would be the default's) and the
      // answer must not look like a share link it is not.
      const { stdout, stderr } = await execFileAsync(
        MUXPAD_BIN,
        ['publish', '--url', 'recoverable', '--public'],
        { env: env(), encoding: 'utf-8' },
      );
      expect(stdout.trim()).toBe('https://stub-host.ts.net:8443/recoverable/');
      expect(stderr).toContain('no public base is available');
      expect(stderr).toContain('cannot open it');
    });

    it('fails readably on a slug that was never published', async () => {
      await expect(
        execFileAsync(MUXPAD_BIN, ['publish', '--url', 'no-such-artifact'], {
          env: env(),
          encoding: 'utf-8',
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('no artifact named') });
    });
  });

  /**
   * `muxpad tunnel setup` — the one command that turns published links
   * permanent AND public.
   *
   * The plist approach was rejected for being annoying, so this must not be a
   * nine-step checklist wearing a command's clothes. It is driven with a STUB
   * cloudflared: the real one would talk to a live Cloudflare account, which is
   * the user's and not something a test (or an agent) may touch.
   */
  describe('tunnel setup', () => {
    let home: string;
    let log: string;
    let data: string;

    const stub = (body: string) => {
      const p = join(home, 'cloudflared-stub.sh');
      writeFileSync(p, `#!/bin/sh\necho "$@" >> "${log}"\n${body}\n`, { mode: 0o755 });
      return p;
    };

    const envFor = (bin: string) => ({
      ...process.env,
      MUXPAD_API_URL: `http://127.0.0.1:${port}`,
      MUXPAD_CLOUDFLARED_BIN: bin,
      MUXPAD_DATA_DIR: data,
      MUXPAD_CLOUDFLARED_HOME: home,
    });

    beforeEach(() => {
      home = mkdtempSync(join(tmpdir(), 'muxpad-cfhome-'));
      data = mkdtempSync(join(tmpdir(), 'muxpad-cfdata-'));
      log = join(home, 'calls.log');
    });

    it('logs in, creates, routes and writes the config — in one command', async () => {
      // `create` must produce a credentials file, because that file's existence
      // is what muxpad treats as "this tunnel is runnable" (tunnel/named.ts).
      const bin = stub(`
case "$2" in
  login)  : > "${home}/cert.pem" ;;
  create) printf '{"AccountTag":"a","TunnelSecret":"b","TunnelID":"u-1"}' > "${home}/u-1.json" ;;
  list)   printf '[]' ;;
esac
exit 0`);
      const { stdout } = await execFileAsync(
        MUXPAD_BIN,
        ['tunnel', 'setup', '--hostname=artifacts.example.dev'],
        { env: envFor(bin), encoding: 'utf-8' },
      );
      const calls = readFileSync(log, 'utf-8');
      expect(calls).toContain('tunnel login');
      expect(calls).toContain('tunnel create muxpad');
      expect(calls).toContain('tunnel route dns muxpad artifacts.example.dev');

      // The config muxpad reads, with the credentials path resolved — not a
      // guess, the file `create` actually wrote.
      const cfg = JSON.parse(readFileSync(join(data, 'tunnel.json'), 'utf-8')) as {
        name: string;
        hostname: string;
        credentials_file: string;
      };
      expect(cfg).toMatchObject({ name: 'muxpad', hostname: 'artifacts.example.dev' });
      expect(cfg.credentials_file).toBe(join(home, 'u-1.json'));
      // And it says what is now true, and what to do next.
      expect(stdout).toContain('https://artifacts.example.dev');
    });

    it('SKIPS the browser login when the account cert is already there', async () => {
      // The one genuinely interactive step. Re-running it on every setup would
      // open a browser for no reason, which is exactly the annoyance being
      // avoided.
      writeFileSync(join(home, 'cert.pem'), 'x');
      const bin = stub(`
case "$2" in
  create) printf '{"TunnelID":"u-2"}' > "${home}/u-2.json" ;;
  list)   printf '[]' ;;
esac
exit 0`);
      await execFileAsync(MUXPAD_BIN, ['tunnel', 'setup', '--hostname=a.example.dev'], {
        env: envFor(bin),
        encoding: 'utf-8',
      });
      expect(readFileSync(log, 'utf-8')).not.toContain('tunnel login');
    });

    it('reuses an existing tunnel of that name instead of failing on it', async () => {
      // Re-running setup — after a typo in the hostname, say — must be safe.
      writeFileSync(join(home, 'cert.pem'), 'x');
      writeFileSync(join(home, 'u-9.json'), '{"TunnelID":"u-9"}');
      const bin = stub(`
case "$2" in
  list) printf '[{"id":"u-9","name":"muxpad"}]' ;;
esac
exit 0`);
      const { stdout } = await execFileAsync(
        MUXPAD_BIN,
        ['tunnel', 'setup', '--hostname=b.example.dev'],
        { env: envFor(bin), encoding: 'utf-8' },
      );
      const calls = readFileSync(log, 'utf-8');
      expect(calls).not.toContain('tunnel create');
      expect(calls).toContain('tunnel route dns muxpad b.example.dev');
      expect(stdout).toContain('already exists');
    });

    it('refuses a hostname that is not a hostname, before touching the account', async () => {
      const bin = stub('exit 0');
      for (const bad of ['https://x.example.dev', 'x.example.dev/p', 'not a host']) {
        await expect(
          execFileAsync(MUXPAD_BIN, ['tunnel', 'setup', `--hostname=${bad}`], {
            env: envFor(bin),
            encoding: 'utf-8',
          }),
        ).rejects.toMatchObject({ stderr: expect.stringContaining('bare hostname') });
      }
      expect(existsSync(log)).toBe(false); // nothing was run
    });

    it('requires a hostname, and names the zone requirement when asked for none', async () => {
      const bin = stub('exit 0');
      await expect(
        execFileAsync(MUXPAD_BIN, ['tunnel', 'setup'], { env: envFor(bin), encoding: 'utf-8' }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('--hostname') });
    });

    it('does NOT write a config when routing the DNS fails', async () => {
      // The failure that must not be papered over: no CNAME means the hostname
      // resolves nowhere, and a config written anyway would make muxpad announce
      // a permanent base that is permanently dead.
      writeFileSync(join(home, 'cert.pem'), 'x');
      const bin = stub(`
case "$2" in
  create) printf '{"TunnelID":"u-3"}' > "${home}/u-3.json" ;;
  list)   printf '[]' ;;
  route)  echo 'failed to add route: zone not found' >&2; exit 1 ;;
esac
exit 0`);
      await expect(
        execFileAsync(MUXPAD_BIN, ['tunnel', 'setup', '--hostname=c.example.dev'], {
          env: envFor(bin),
          encoding: 'utf-8',
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('zone') });
      expect(existsSync(join(data, 'tunnel.json'))).toBe(false);
    });

    it('prints the exact commands when cloudflared is missing, rather than half-doing it', async () => {
      await expect(
        execFileAsync(MUXPAD_BIN, ['tunnel', 'setup', '--hostname=d.example.dev'], {
          env: { ...envFor(join(home, 'nope')), MUXPAD_CLOUDFLARED_BIN: join(home, 'nope') },
          encoding: 'utf-8',
        }),
      ).rejects.toMatchObject({ stderr: expect.stringContaining('brew install cloudflared') });
    });
  });

  it('a COLD publish prefers the no-exec PTR name over execing tailscale', async () => {
    // The other half of the fix, and the half the App Store constraint forces:
    // even with nothing persisted, the CLI must not open the app bundle. It
    // derives the tailnet name from this machine's own 100.64/10 address via
    // MagicDNS instead. Requires the box to be on a tailnet, so it reports
    // rather than silently passing when it is not.
    const { stdout: ptr } = await execFileAsync(MUXPAD_BIN, ['_tailnet-hostname'], {
      env: { ...process.env },
      encoding: 'utf-8',
    });
    const host = ptr.trim();
    if (!host) {
      console.log('skipped: this machine is not on a tailnet, so there is no PTR to prefer');
      return;
    }

    // A SEPARATE server with its own empty db — a cold cache, so
    // `discovery_needed` is true and the CLI really does try to discover.
    const coldDb = openDb(':memory:');
    const coldDir = mkdtempSync(join(tmpdir(), 'muxpad-cold-'));
    const coldApp = createApp({
      db: coldDb,
      ptyd: ptyd.client,
      cache: new PtydCache(),
      dataDir: coldDir,
      events: new EventBus(),
      publish: {
        funnel: localFunnel(7799, 'funnel disabled in tests'),
        baseProbe: async () => ({
          alive: true,
          status: 404,
          reason: 'client_error' as const,
          elapsedMs: 1,
        }),
      },
    });
    const coldServer = serve({ fetch: coldApp.fetch, port: 0, hostname: '127.0.0.1' });
    await new Promise<void>((r) => coldServer.once('listening', () => r()));
    const coldPort = (coldServer.address() as { port: number }).port;

    const log = join(tmp, 'cold-must-not-run.log');
    const stub = join(tmp, 'cold-must-not-run.sh');
    writeFileSync(stub, `#!/bin/sh\necho "$@" >> "${log}"\nexit 0\n`, { mode: 0o755 });
    const srcFile = join(tmp, 'cold.html');
    writeFileSync(srcFile, '<html>cold</html>');

    try {
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['publish', srcFile, '--name=cold'], {
        env: {
          ...process.env,
          MUXPAD_API_URL: `http://127.0.0.1:${coldPort}`,
          MUXPAD_TAILSCALE_BIN: stub,
        },
        encoding: 'utf-8',
      });
      expect(stdout.trim()).toBe(`https://${host}:8443/cold/`);
      expect(existsSync(log), 'a cold publish execed tailscale instead of using the PTR').toBe(
        false,
      );
    } finally {
      await new Promise<void>((r) => coldServer.close(() => r()));
      coldDb.close();
      rmSync(coldDir, { recursive: true, force: true });
    }
  });

  // ── RECOVERING A ROOM FULL OF DEAD AGENT PANES ──────────────────────────
  // On 2026-09-20 every Claude pane stopped answering at once and the fix was
  // a respawn of all 24. There was no command for that, so it was attempted as
  // a shell loop over `muxpad agent list` — and two attempts produced nothing
  // at all, because the ids carried whitespace the loop did not strip and
  // every URL built from them was malformed (curl returns 000 and says
  // nothing). Both halves of that are pinned below.
  describe('agent list / agent respawn', () => {
    const env = () => ({ ...process.env, MUXPAD_API_URL: `http://127.0.0.1:${port}` });

    /** An agent pane on a real ptyd, of a given backend. */
    function makeAgentPane(assistant: string): string {
      const ws = workspaces.create({ name: `ws-${assistant}-${Math.random()}` });
      const tab = tabs.create({ name: 'T', layout: 'p1', workspace_id: ws.id });
      const pane = panes.create({
        tab_id: tab.id,
        shell: '/bin/cat',
        cwd: tmp,
        startup_cmd: `muxpad agent --backend ${assistant}`,
      });
      agents.register({ pane_id: pane.id, assistant, session_id: `sid-${pane.id}` });
      return pane.id;
    }

    it('list output carries no control characters and no trailing whitespace', async () => {
      makeAgentPane('claude');
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['agent', 'list'], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout).not.toMatch(/\r/);
      // Every column used to be padded — including the LAST one — so every row
      // ended in invisible spaces that a caller had to know to strip.
      for (const line of stdout.split('\n')) {
        expect(line, `row has trailing whitespace: ${JSON.stringify(line)}`).toBe(
          line.replace(/\s+$/, ''),
        );
      }
    });

    it('an id taken straight out of list output is usable as a URL component', async () => {
      const id = makeAgentPane('claude');
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['agent', 'list'], {
        env: env(),
        encoding: 'utf-8',
      });
      const row = stdout.split('\n').find((l) => l.startsWith(id));
      expect(row, `no row for ${id}`).toBeDefined();
      const parsed = (row as string).split(/\s+/)[0] as string;
      expect(parsed).toBe(id);
      expect(encodeURIComponent(parsed)).toBe(parsed);
    });

    it('respawn --all covers every agent pane', async () => {
      const a = makeAgentPane('claude');
      const b = makeAgentPane('codex');
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['agent', 'respawn', '--all'], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout).toContain(a);
      expect(stdout).toContain(b);
      expect(stdout).toMatch(/respawned/);
    });

    it('--backend narrows it to one harness', async () => {
      const claudePane = makeAgentPane('claude');
      const codexPane = makeAgentPane('codex');
      const { stdout } = await execFileAsync(
        MUXPAD_BIN,
        ['agent', 'respawn', '--all', '--backend=codex'],
        { env: env(), encoding: 'utf-8' },
      );
      expect(stdout).toContain(codexPane);
      expect(stdout).not.toContain(claudePane);
    });

    it('respawns a single named pane', async () => {
      const id = makeAgentPane('claude');
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['agent', 'respawn', id], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout).toContain(id);
      expect(stdout).toContain('1 respawned');
    });

    // A bulk recovery that stops at the first bad pane leaves the rest dead —
    // which is the whole reason it is a command and not a shell loop.
    it('keeps going past a pane that fails, and exits nonzero', async () => {
      const good = makeAgentPane('claude');
      await expect(
        execFileAsync(MUXPAD_BIN, ['agent', 'respawn', 'NOSUCHPANEID'], {
          env: env(),
          encoding: 'utf-8',
        }),
      ).rejects.toMatchObject({ code: 1 });
      // …and the good one still works on its own.
      const { stdout } = await execFileAsync(MUXPAD_BIN, ['agent', 'respawn', good], {
        env: env(),
        encoding: 'utf-8',
      });
      expect(stdout).toContain('1 respawned');
    });

    it('refuses a pane id AND --all together rather than guessing', async () => {
      await expect(
        execFileAsync(MUXPAD_BIN, ['agent', 'respawn', '--all', 'SOMEPANE'], {
          env: env(),
          encoding: 'utf-8',
        }),
      ).rejects.toMatchObject({ code: 1 });
    });
  });
});
