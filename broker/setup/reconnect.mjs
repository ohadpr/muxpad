export function selectReconnect(record, answer = '') {
  if (record?.phase !== 'ready') return record;
  if (answer === 'REPLACE TOKEN') return null;
  if (answer === '') return record;
  throw Error('Replacement not requested');
}
/** Root-only credential replacement. Adapter owns protected files, exact identity and the native lock. */
export async function reconnect(a) {
  let p = await a.load();
  if (!p) p = await a.prepare(); // Hidden TTY token, auth.test + same team, durable secret BEFORE any stop.
  await a.validate(p);
  if (p.phase === 'ready') {
    await a.verifyInstalled(p);
    await a.ready(p);
    await a.forgetSecret(p);
    return;
  }
  if (p.phase === 'prepared') {
    p = { ...p, stateMayHaveChanged: true };
    await a.save(p);
    await a.disable();
    await a.stop();
    p = { ...p, credential: await a.captureCredential(), phase: 'stopped' };
    await a.save(p);
  }
  if (p.phase === 'stopped') {
    await a.requireStopped();
    await a.install(p);
    p = { ...p, phase: 'installed', stateMayHaveChanged: true };
    await a.save(p);
  }
  if (p.phase === 'installed') {
    await a.requireStopped();
    p = { ...p, phase: 'starting', stateMayHaveChanged: true };
    await a.save(p);
  }
  if (p.phase === 'starting') {
    await a.verifyInstalled(p);
    const s = await a.running();
    if (!s.loaded && !s.processes) {
      await a.enable();
      await a.start();
    } else if (!s.loaded || !s.processes) throw Error('Service state ambiguous; no restart');
    await a.ready(p); // Exact retained credential, token hash, no observed storage fault.
    p = { ...p, phase: 'ready', stateMayHaveChanged: true };
    await a.save(p);
    await a.forgetSecret(p);
    return;
  }
  if (p.phase !== 'ready') throw Error('Unknown replacement phase');
}
