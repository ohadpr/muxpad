import { randomUUID } from 'node:crypto';
import {
  constants,
  closeSync,
  fsyncSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// Unique names avoid permanent failure after a crash leaves an old temporary
// file behind. The directory must already belong to the protected broker.
export function saveState(path, value) {
  const json = JSON.stringify(value);
  const tmp = `${path}.${randomUUID()}.tmp`;
  let fd;
  try {
    fd = openSync(
      tmp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, json);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(tmp);
    } catch (error) {
      // A leftover unique temp file is harmless; preserve any primary error.
      // It will never block the next save, unlike the old fixed temp path.
    }
  }
}
