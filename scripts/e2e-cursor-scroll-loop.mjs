#!/usr/bin/env node
/** Run cursor-scroll e2e until green (12 runs × repeat-each 3 = 36 test executions). */
import { spawnSync } from 'node:child_process';

const max = Number(process.env.MUXPAD_E2E_LOOP_MAX ?? 12);
for (let i = 1; i <= max; i++) {
  console.log(`\n[e2e loop ${i}/${max}] pnpm test:e2e:cursor-scroll\n`);
  const r = spawnSync('pnpm', ['test:e2e:cursor-scroll'], { stdio: 'inherit' });
  if (r.status === 0) {
    console.log('\n[e2e loop] all runs passed');
    process.exit(0);
  }
}
console.error(`\n[e2e loop] failed after ${max} attempts`);
process.exit(1);
