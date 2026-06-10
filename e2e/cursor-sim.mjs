#!/usr/bin/env node
/** Cursor-like PTY output for e2e: incremental lines + occasional redraws. */
let i = 0;
const max = 2500;

function tick() {
  i += 1;
  // Carriage-return redraw (common in TUIs).
  process.stdout.write(`\x1b[2K\r[agent] step ${i}/${max}\n`);
  if (i % 15 === 0) {
    for (let k = 0; k < 4; k++) {
      process.stdout.write(`  · log ${i}.${k}\n`);
    }
  }
  if (i < max) setTimeout(tick, 30);
}

tick();
