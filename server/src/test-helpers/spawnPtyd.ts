import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PtydClient } from '../ptyd-client/PtydClient.js';
import { type PtydHandle, type PtydOptions, startPtyd } from '../ptyd/index.js';

export interface SpawnedPtyd {
  socketPath: string;
  dir: string;
  handle: PtydHandle;
  client: PtydClient;
  cleanup(): Promise<void>;
}

/**
 * Spin up an in-process ptyd on a tmpdir unix socket plus a connected
 * PtydClient. Tests use this where they previously did `new PaneManager(...)`
 * directly. Resolves only after the client has reached 'connected' so callers
 * can issue control RPCs immediately.
 *
 * Fast poll intervals by default (50ms each) so periodic events fire inside
 * test timeouts. Callers can override individual options.
 */
export async function spawnPtyd(options: Partial<PtydOptions> = {}): Promise<SpawnedPtyd> {
  const dir = mkdtempSync(join(tmpdir(), 'spawn-ptyd-'));
  const socketPath = join(dir, 'ptyd.sock');
  const handle = await startPtyd({
    socketPath,
    cwdPollInterval: 50,
    cmdPollInterval: 50,
    ...options,
  });
  const client = new PtydClient({ socketPath });
  await new Promise<void>((resolve) => client.once('connected', resolve));
  return {
    socketPath,
    dir,
    handle,
    client,
    async cleanup() {
      await client.close();
      await handle.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
