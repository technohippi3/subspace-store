import { spawn } from 'node:child_process';
import { constants, openSync, fstatSync, readFileSync, closeSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';

export interface Host {
  host: string; port: number; user: string; identityFile: string; knownHostsFile: string;
  installer: string; installationConfig: string; incomingDirectory: string;
}
function require(value: unknown): asserts value { if (!value) throw Error('deployment configuration refused'); }
function safePath(path: unknown): asserts path is string {
  require(typeof path === 'string' && isAbsolute(path) && /^[a-zA-Z0-9_./-]{1,4096}$/.test(path) && !path.split('/').includes('..'));
}
function readConfig(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    require(stat.isFile() && stat.nlink === 1 && stat.size <= 65536 && (stat.mode & 0o077) === 0);
    return JSON.parse(readFileSync(fd, 'utf8'));
  } finally { closeSync(fd); }
}
function protectedReference(path: string, secret: boolean): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    require(stat.isFile() && stat.nlink === 1 && stat.size <= (secret ? 16384 : 1048576) &&
      [0, process.geteuid!()].includes(stat.uid) && (stat.mode & (secret ? 0o077 : 0o022)) === 0);
  } finally { closeSync(fd); }
}
export function host(reference: string): Host {
  require(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(reference));
  const path = process.env.SUBSPACE_DEPLOY_CONFIG; require(path); safePath(path);
  const value = readConfig(path) as { version?: unknown; hosts?: Record<string, Host> };
  require(value.version === 1 && value.hosts && Object.hasOwn(value.hosts, reference));
  const result = value.hosts[reference];
  require(Object.keys(result).sort().join() === 'host,identityFile,incomingDirectory,installationConfig,installer,knownHostsFile,port,user');
  require(/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,252}$/.test(result.host) && /^[a-z_][a-z0-9_-]{0,31}$/.test(result.user));
  require(Number.isInteger(result.port) && result.port > 0 && result.port <= 65535);
  for (const path of [result.identityFile, result.knownHostsFile, result.installer, result.installationConfig, result.incomingDirectory]) safePath(path);
  protectedReference(result.identityFile, true); protectedReference(result.knownHostsFile, false);
  return result;
}
function options(value: Host): string[] {
  return ['-F', '/dev/null', '-oBatchMode=yes', '-oIdentitiesOnly=yes', '-oIdentityAgent=none',
    '-oStrictHostKeyChecking=yes', '-oUpdateHostKeys=no', '-oGlobalKnownHostsFile=/dev/null',
    '-oUserKnownHostsFile=' + value.knownHostsFile, '-oConnectTimeout=10', '-i', value.identityFile];
}
async function child(command: string, args: string[], timeout = 300000): Promise<string> {
  return await new Promise((resolve, reject) => {
    const process = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], env: { PATH: '/usr/bin:/bin', LANG: 'C' } });
    let output = ''; let bytes = 0;
    const timer = setTimeout(() => process.kill('SIGKILL'), timeout);
    process.stdout.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) process.kill('SIGKILL'); else output += chunk.toString(); });
    process.once('error', () => { clearTimeout(timer); reject(Error('deployment transport unavailable')); });
    process.once('close', code => { clearTimeout(timer); code === 0 && bytes <= 65536 ? resolve(output) : reject(Error('deployment transport refused')); });
  });
}
export async function ssh(value: Host, arguments_: string[]): Promise<string> {
  // OpenSSH executes a command string remotely. Every argument is a fixed
  // flag, a validated path or a release digest; no shell metacharacters.
  require(arguments_.every(value => /^[a-zA-Z0-9_./=-]{1,4096}$/.test(value)));
  return await child('/usr/bin/ssh', [...options(value), '-T', '-p', String(value.port), value.user + '@' + value.host, arguments_.join(' ')]);
}
export async function status(value: Host): Promise<{ release: string | null; manifestDigest?: string; ready: boolean; paused: boolean }> {
  const output = JSON.parse(await ssh(value, ['/usr/bin/python3', value.installer, '--config', value.installationConfig, 'status']));
  require(output.ok === true && typeof output.ready === 'boolean' && typeof output.paused === 'boolean' &&
    (output.release === null || typeof output.release === 'string'));
  return { release: output.release, manifestDigest: output.manifestDigest, ready: output.ready, paused: output.paused };
}
export async function apply(value: Host, directory: string, digest: string): Promise<void> {
  safePath(directory); require(/^[0-9a-f]{64}$/.test(digest));
  const destination = value.incomingDirectory + '/' + digest;
  await ssh(value, ['/usr/bin/mkdir', '-p', destination]);
  for (const name of ['manifest.json', 'manifest.sig', 'release.tar.gz'])
    await child('/usr/bin/scp', [...options(value), '-P', String(value.port), join(directory, name), value.user + '@' + value.host + ':' + destination + '/' + name]);
  const result = JSON.parse(await ssh(value, ['/usr/bin/python3', value.installer, '--config', value.installationConfig,
    'apply', '--manifest', destination + '/manifest.json', '--signature', destination + '/manifest.sig', '--artifact', destination + '/release.tar.gz']));
  require(result.ok === true && result.ready === true && result.manifestDigest === digest);
}
