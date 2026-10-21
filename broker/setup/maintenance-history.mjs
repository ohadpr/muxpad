import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertCompleteHistory } from './transaction-ledger.mjs';
/** Never use enrollment/token maintenance to bypass an unfinished protected code update. */
export function maintenanceHistory(history, activePath, validate) {
  if (!existsSync(history)) {
    if (existsSync(activePath)) throw Error('Orphaned code update pointer');
    return;
  }
  validate(history);
  const names = readdirSync(history);
  for (const id of names) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw Error('Unknown code update history entry');
    assertCompleteHistory(join(history, id), id, validate);
  }
  if (names.length && !existsSync(activePath)) throw Error('Missing code update pointer');
  if (existsSync(activePath)) {
    validate(activePath);
    const a = JSON.parse(readFileSync(activePath, 'utf8'));
    if (
      a.version !== 1 ||
      Object.keys(a).sort().join(',') !== 'release,version' ||
      !names.includes(a.release)
    )
      throw Error('Invalid code update pointer');
    assertCompleteHistory(join(history, a.release), a.release, validate);
  }
}
