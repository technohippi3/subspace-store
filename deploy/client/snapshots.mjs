import { constants, closeSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readSync, readdirSync, realpathSync, writeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { MAX_OBJECT, MAX_PLAIN, base64, digest, exact, integer, require, sha } from './transport.mjs';
import { journalPosition } from './journals.mjs';

const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
const SNAPSHOT_PART = /^@?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/;
function safePath(path) {
  require(typeof path === 'string' && path.length <= 4096);
  const parts = path.split('/');
  require(parts.length <= 128 && parts.every(part => part.length <= 100 && SNAPSHOT_PART.exec(part)?.[0] === part && !['.', '..'].includes(part)), 'unsafe-path');
  require(['registry.db', 'controller.db', 'manifest.json', 'core-wallet.backup', 'spaced-wallet.export'].includes(path) ||
    parts.length > 1 && parts[0] === 'subs', 'unsafe-path');
}
function required(kind) {
  require(['checkpoint', 'wallet-backups'].includes(kind));
  return kind === 'checkpoint' ? ['registry.db', 'controller.db'] : ['core-wallet.backup', 'spaced-wallet.export'];
}
function collect(root, relative = '', files = []) {
  for (const name of readdirSync(join(root, relative))) {
    const path = relative ? relative + '/' + name : name;
    safePath(path === 'subs' ? 'subs/placeholder' : path);
    const info = lstatSync(join(root, path));
    require(!info.isSymbolicLink(), 'unsafe-source');
    if (info.isDirectory()) {
      require(path === 'subs' || path.startsWith('subs/'), 'unsafe-source');
      collect(root, path, files);
    } else {
      require(info.isFile() && info.nlink === 1 && info.size <= 15 * 1024 ** 3, 'unsafe-source');
      files.push(path);
      require(files.length <= 4096, 'snapshot-too-large');
    }
  }
  return files.sort();
}
function originalManifest(value, files, kind) {
  exact(value, 'label store_journal controller_journal files');
  require(typeof value.label === 'string' && ID.test(value.label));
  integer(value.store_journal); integer(value.controller_journal);
  require(value.files && typeof value.files === 'object' && !Array.isArray(value.files));
  require(Object.keys(value.files).sort().join() === files.filter(path => path !== 'manifest.json').sort().join(), 'snapshot-files-mismatch');
  require(required(kind).every(path => files.includes(path)), 'snapshot-files-mismatch');
  if (kind === 'wallet-backups') require(files.length === 3, 'snapshot-files-mismatch');
  for (const [path, hash] of Object.entries(value.files)) { safePath(path); digest(hash); }
  return value;
}
function readFileBounded(path, maximum = MAX_OBJECT) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const buffer = Buffer.alloc(maximum + 1);
    let size = 0;
    while (size < buffer.length) {
      const n = readSync(fd, buffer, size, buffer.length - size, null);
      if (!n) break;
      size += n;
    }
    require(size <= maximum, 'oversize-object');
    return buffer.subarray(0, size);
  } finally { closeSync(fd); }
}
function syncDirectory(path) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function writeAll(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset);
    require(count > 0, 'storage-unavailable');
    offset += count;
  }
}
function source(root) {
  require(typeof root === 'string' && isAbsolute(root) && realpathSync(root) === resolve(root), 'unsafe-source');
  require(lstatSync(root).isDirectory(), 'unsafe-source');
}
function context(snapshot, path, chunk) { return 'snapshot:' + snapshot + ':' + path + ':' + chunk; }
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}';
  return JSON.stringify(value);
}
function authenticate(client, manifest) {
  exact(manifest, 'format kind installation snapshot journals files authentication');
  const { authentication, ...unsigned } = manifest;
  require(client.decrypt(base64(authentication, 256), 'snapshot-manifest:' + manifest.snapshot)
    .equals(Buffer.from(sha(Buffer.from(canonical(unsigned))))), 'snapshot-authentication-failed');
}
export function snapshotPut(client, request) {
  exact(request, 'op snapshot kind directory');
  require(ID.test(request.snapshot)); required(request.kind); source(request.directory);
  const paths = collect(request.directory);
  require(paths.includes('manifest.json'), 'snapshot-files-mismatch');
  const originalBytes = readFileBounded(join(request.directory, 'manifest.json'));
  const original = originalManifest(JSON.parse(originalBytes), paths, request.kind);
  const existing = () => {
    let result;
    try { result = client.request({ op: 'snapshot-get', snapshot: request.snapshot }); }
    catch (error) { if (error.code === 'not-found') return undefined; throw error; }
    const saved = result.manifest;
    authenticate(client, saved);
    require(saved?.kind === request.kind && saved.snapshot === request.snapshot && saved.installation === client.config.installation &&
      Object.keys(saved.files ?? {}).sort().join() === paths.join(), 'immutable-conflict');
    const item = saved.files['manifest.json'];
    require(Array.isArray(item?.chunks) && item.chunks.length <= 2, 'invalid-remote-response');
    const metadata = item.chunks.map((hash, index) => {
      const object = client.request({ op: 'blob-get', sha256: digest(hash) });
      const bytes = base64(object.data); require(sha(bytes) === hash, 'digest-mismatch');
      return client.decrypt(bytes, context(request.snapshot, 'manifest.json', index));
    });
    require(Buffer.concat(metadata).equals(originalBytes), 'immutable-conflict');
    for (const path of paths.filter(p => p !== 'manifest.json')) {
      const fd = openSync(join(request.directory, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      const hash = createHash('sha256'); const buffer = Buffer.alloc(MAX_PLAIN);
      try { let n; while ((n = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, n)); }
      finally { closeSync(fd); }
      require(hash.digest('hex') === original.files[path], 'source-changed');
    }
    return { snapshot: request.snapshot, files: paths.length, sha256: result.sha256, existing: true };
  };
  const saved = existing();
  if (saved) return saved;
  const journals = {};
  for (const name of ['store', 'controller']) {
    const sequence = original[name + '_journal'];
    const position = journalPosition(client, name, sequence);
    journals[name] = { sequence, sha256: position.remoteSha256 };
  }
  const files = {};
  let total = 0;
  for (const path of paths) {
    const fd = openSync(join(request.directory, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const plainHash = createHash('sha256');
    const encryptedHash = createHash('sha256');
    const chunks = [];
    let size = 0;
    try {
      const buffer = Buffer.alloc(MAX_PLAIN);
      while (true) {
        let offset = 0;
        while (offset < buffer.length) {
          const n = readSync(fd, buffer, offset, buffer.length - offset, null);
          if (!n) break;
          offset += n;
        }
        if (!offset) break;
        total += offset;
        require(total <= 15 * 1024 ** 3, 'snapshot-too-large');
        const data = buffer.subarray(0, offset);
        plainHash.update(data);
        const encrypted = client.encrypt(data, context(request.snapshot, path, chunks.length));
        const hash = sha(encrypted);
        const ack = client.request({ op: 'blob-put', sha256: hash, data: encrypted.toString('base64') });
        require(ack.sha256 === hash && ack.size === encrypted.length, 'invalid-remote-response');
        chunks.push(hash); encryptedHash.update(encrypted); size += encrypted.length;
      }
    } finally { closeSync(fd); }
    const plaintextDigest = plainHash.digest('hex');
    require(path === 'manifest.json' || plaintextDigest === original.files[path], 'source-changed');
    if (path === 'manifest.json') require(plaintextDigest === sha(originalBytes), 'source-changed');
    files[path] = { size, sha256: encryptedHash.digest('hex'), chunks };
  }
  require(collect(request.directory).join() === paths.join(), 'source-changed');
  const manifest = { format: 1, kind: request.kind, installation: client.config.installation,
    snapshot: request.snapshot, journals, files };
  manifest.authentication = client.encrypt(Buffer.from(sha(Buffer.from(canonical(manifest)))),
    'snapshot-manifest:' + request.snapshot).toString('base64');
  let result;
  try { result = client.request({ op: 'snapshot-commit', snapshot: request.snapshot, manifest }); }
  catch (error) { const recovered = existing(); if (recovered) return recovered; throw error; }
  require(result.manifest?.snapshot === request.snapshot, 'invalid-remote-response');
  return { snapshot: request.snapshot, files: paths.length, plaintextBytes: total, sha256: result.sha256 };
}
export function snapshotGet(client, request) {
  exact(request, 'op snapshot directory');
  require(ID.test(request.snapshot) && typeof request.directory === 'string' && isAbsolute(request.directory));
  require(realpathSync(dirname(request.directory)) === resolve(dirname(request.directory)), 'unsafe-destination');
  const result = client.request({ op: 'snapshot-get', snapshot: request.snapshot });
  const manifest = result.manifest;
  authenticate(client, manifest);
  require(manifest.format === 1 && manifest.installation === client.config.installation && manifest.snapshot === request.snapshot, 'snapshot-identity');
  required(manifest.kind); exact(manifest.journals, 'store controller');
  require(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files));
  const paths = Object.keys(manifest.files).sort();
  require(paths.length >= 3 && paths.length <= 4096 && paths.includes('manifest.json'), 'snapshot-files-mismatch');
  for (const name of ['store', 'controller']) {
    exact(manifest.journals[name], 'sequence sha256');
    const position = journalPosition(client, name, integer(manifest.journals[name].sequence));
    require(position.remoteSha256 === manifest.journals[name].sha256, 'snapshot-journal-mismatch');
  }
  mkdirSync(request.directory, { mode: 0o700 });
  const plaintextDigests = {};
  let originalBytes;
  let total = 0;
  const directories = new Set([request.directory]);
  for (const path of paths) {
    safePath(path);
    const item = manifest.files[path];
    exact(item, 'size sha256 chunks'); integer(item.size, 0, 16 * 1024 ** 3); digest(item.sha256);
    require(Array.isArray(item.chunks) && item.chunks.length === Math.ceil(item.size / MAX_OBJECT), 'snapshot-chunks-mismatch');
    const destination = join(request.directory, path);
    if (path !== 'manifest.json') {
      for (let next = dirname(destination); next !== request.directory; next = dirname(next)) directories.add(next);
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    }
    const fd = path === 'manifest.json' ? undefined : openSync(destination, 'wx', 0o600);
    const plainHash = createHash('sha256'); const encryptedHash = createHash('sha256');
    const metadata = [];
    let encryptedSize = 0;
    try {
      for (const [index, hash] of item.chunks.entries()) {
        digest(hash);
        const object = client.request({ op: 'blob-get', sha256: hash });
        const bytes = base64(object.data);
        require(object.sha256 === hash && sha(bytes) === hash && bytes.length === Math.min(MAX_OBJECT, item.size - encryptedSize), 'snapshot-blob-mismatch');
        encryptedHash.update(bytes); encryptedSize += bytes.length;
        const plain = client.decrypt(bytes, context(request.snapshot, path, index));
        total += plain.length; require(total <= 15 * 1024 ** 3, 'snapshot-too-large');
        plainHash.update(plain);
        if (fd === undefined) { metadata.push(plain); require(metadata.reduce((n, b) => n + b.length, 0) <= MAX_OBJECT, 'oversize-object'); }
        else writeAll(fd, plain);
      }
      require(encryptedSize === item.size && encryptedHash.digest('hex') === item.sha256, 'snapshot-file-mismatch');
      plaintextDigests[path] = plainHash.digest('hex');
      if (fd === undefined) originalBytes = Buffer.concat(metadata);
      else fsyncSync(fd);
    } finally { if (fd !== undefined) closeSync(fd); }
  }
  const original = originalManifest(JSON.parse(originalBytes), paths, manifest.kind);
  for (const [path, hash] of Object.entries(original.files)) require(plaintextDigests[path] === hash, 'snapshot-file-mismatch');
  for (const name of ['store', 'controller']) require(original[name + '_journal'] === manifest.journals[name].sequence, 'snapshot-journal-mismatch');
  const fd = openSync(join(request.directory, 'manifest.json'), 'wx', 0o600);
  try { writeAll(fd, originalBytes); fsyncSync(fd); } finally { closeSync(fd); }
  for (const directory of [...directories].sort((a, b) => b.length - a.length)) syncDirectory(directory);
  syncDirectory(dirname(request.directory));
  return { snapshot: request.snapshot, kind: manifest.kind, files: paths.length, plaintextBytes: total };
}
