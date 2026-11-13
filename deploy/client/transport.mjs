import { constants, openSync, closeSync, readSync, fstatSync } from 'node:fs';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { verifiedSystemdCredential } from './systemd-credential.mjs';

export const MAX_PAGE = 8192;
export const MAX_OBJECT = 1024 * 1024;
export const MAX_PLAIN = MAX_OBJECT - 35;
export const MAX_RECORD = 16 * 1024 * 1024;
export const MAX_LOCAL_MESSAGE = 24 * 1024 * 1024;
export const sha = data => createHash('sha256').update(data).digest('hex');
export class Refused extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function require(value, code = 'invalid-request') {
  if (!value) throw new Refused(code);
}
export function exact(value, keys) {
  require(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join() === keys.split(' ').sort().join());
}
export function integer(value, min = 0, max = 1_000_000) {
  require(Number.isSafeInteger(value) && value >= min && value <= max);
  return value;
}
export function digest(value) { require(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)); return value; }
function path(value) { require(typeof value === 'string' && isAbsolute(value) && !value.includes('\0') && value.length <= 4096); }
export function protectedFile(name, maximum, secret = true) {
  path(name);
  const fd = openSync(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    require(info.isFile() && info.nlink === 1 && info.size <= maximum &&
      (process.geteuid() === 0 || [0, process.geteuid()].includes(info.uid)) &&
      ((info.mode & (secret ? 0o077 : 0o022)) === 0 || secret && verifiedSystemdCredential(name, info)),
      'unsafe-credential-file');
    const data = Buffer.alloc(maximum + 1);
    let length = 0;
    while (length < data.length) {
      const n = readSync(fd, data, length, data.length - length, null);
      if (!n) break;
      length += n;
    }
    require(length <= maximum, 'oversize-file');
    return data.subarray(0, length);
  } finally { closeSync(fd); }
}
export function configuration(value) {
  exact(value, 'version installation host port user knownHostsFile identityFile encryptionKeyFile connectTimeoutSeconds operationTimeoutSeconds');
  require(value.version === 1 && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(value.installation));
  require(typeof value.host === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(value.host));
  require(typeof value.user === 'string' && /^[a-z_][a-z0-9_-]{0,31}$/.test(value.user));
  integer(value.port, 1, 65535);
  integer(value.connectTimeoutSeconds, 1, 30);
  integer(value.operationTimeoutSeconds, 1, 300);
  for (const key of ['knownHostsFile', 'identityFile', 'encryptionKeyFile']) path(value[key]);
  return value;
}
export class RecoveryClient {
  constructor(config, execute = spawnSync) {
    this.config = configuration(config);
    this.execute = execute;
    this.key = protectedFile(config.encryptionKeyFile, 32);
    require(this.key.length === 32, 'invalid-encryption-key');
    protectedFile(config.identityFile, 16384);
    protectedFile(config.knownHostsFile, 1024 * 1024, false);
  }
  request(request) {
    const config = this.config;
    const bytes = Buffer.from(JSON.stringify({ version: 1, ...request }));
    require(bytes.length <= 4 * MAX_OBJECT, 'oversize-request');
    const args = ['-F', '/dev/null', '-T', '-oBatchMode=yes', '-oIdentitiesOnly=yes',
      '-oIdentityAgent=none', '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no',
      '-oGlobalKnownHostsFile=/dev/null', '-oUserKnownHostsFile=' + config.knownHostsFile,
      '-oConnectTimeout=' + config.connectTimeoutSeconds, '-oServerAliveInterval=5',
      '-oServerAliveCountMax=2', '-p', String(config.port), '-i', config.identityFile,
      config.user + '@' + config.host];
    const child = this.execute('/usr/bin/ssh', args, { input: bytes, timeout: config.operationTimeoutSeconds * 1000,
      maxBuffer: 12 * MAX_OBJECT, windowsHide: true, env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    require(!child.error, 'transport-unavailable');
    if (child.status !== 0 && /Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/.test(child.stderr?.toString() ?? ''))
      throw new Refused('host-key-rejected');
    let result;
    try { result = JSON.parse(child.stdout.toString()); } catch { throw new Refused('transport-unavailable'); }
    require(result && typeof result === 'object' && typeof result.ok === 'boolean', 'invalid-remote-response');
    if (!result.ok) throw new Refused(typeof result.code === 'string' && /^[a-z-]{1,64}$/.test(result.code) ? result.code : 'remote-refused');
    require(child.status === 0, 'transport-unavailable');
    require(result.installation === config.installation, 'installation-mismatch');
    return result;
  }
  aad(context) { return Buffer.from('subspace-recovery-v1\n' + this.config.installation + '\n' + context); }
  encrypt(data, context) {
    require(data.length <= MAX_PLAIN, 'oversize-object');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(this.aad(context));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([Buffer.from('SSREC1\0'), nonce, cipher.getAuthTag(), encrypted]);
  }
  decrypt(data, context) {
    require(data.length >= 35 && data.length <= MAX_OBJECT && data.subarray(0, 7).equals(Buffer.from('SSREC1\0')), 'invalid-envelope');
    try {
      const cipher = createDecipheriv('aes-256-gcm', this.key, data.subarray(7, 19));
      cipher.setAAD(this.aad(context));
      cipher.setAuthTag(data.subarray(19, 35));
      return Buffer.concat([cipher.update(data.subarray(35)), cipher.final()]);
    } catch { throw new Refused('authentication-failed'); }
  }
  probe() {
    const result = this.request({ op: 'probe' });
    require(result.installation === this.config.installation && result.protocol === 1, 'installation-mismatch');
    return result;
  }
}
export function base64(value, maximum = MAX_OBJECT) {
  require(typeof value === 'string' && value.length <= 4 * Math.ceil(maximum / 3));
  const data = Buffer.from(value, 'base64');
  require(data.length <= maximum && data.toString('base64') === value);
  return data;
}
