import { closeSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';

/** systemd255 system services use root:root0550/0440 plus per-UID ACLs. */
export function verifiedSystemdCredential(path, file) {
  try {
    const directory = process.env.CREDENTIALS_DIRECTORY;
    if (!directory || !/^\/run\/credentials\/[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,240}\.service$/.test(directory) ||
      dirname(path) !== directory || realpathSync(directory) !== directory) return false;
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || info.gid !== 0 || (info.mode & 0o777) !== 0o550 ||
      !file.isFile() || file.uid !== 0 || file.gid !== 0 || file.nlink !== 1 || (file.mode & 0o777) !== 0o440) return false;
    const fd = openSync('/proc/self/mountinfo', 'r');
    let text;
    try {
      const bytes = Buffer.alloc(1024 * 1024 + 1); let count = 0;
      while (count < bytes.length) { const n = readSync(fd, bytes, count, bytes.length - count, null); if (!n) break; count += n; }
      if (count === bytes.length) return false; text = bytes.subarray(0, count).toString();
    }
    finally { closeSync(fd); }
    return text.split('\n').some(line => { const fields = line.split(' '); return fields[4] === directory && fields[5]?.split(',').includes('ro'); });
  } catch { return false; }
}
