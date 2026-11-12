import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:net';
import { RecoveryClient, sha } from './transport.mjs';
import { journalAppend, journalRead } from './journals.mjs';
import { snapshotGet, snapshotPut } from './snapshots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function command(binary, args, options = {}) {
  const p = spawnSync(binary, args, { timeout: 30_000, encoding: 'utf8', ...options });
  assert.equal(p.status, 0, p.stderr || p.stdout); return typeof p.stdout === 'string' ? p.stdout.trim() : p.stdout;
}
function append(client, sequence, bytes, stream = 'store') {
  return journalAppend(client, { op: 'journal-append', stream, sequence, sha256: sha(bytes), data: bytes.toString('base64') });
}
test('actual OpenSSH pins the host, preserves encrypted recovery after seller loss and refuses outage', { timeout: 60_000 }, async t => {
  const fixture = mkdtempSync(join(tmpdir(), 'subspace-ssh-fixture-'));
  const name = 'subspace-recovery-ssh-' + randomBytes(6).toString('hex');
  let started = false;
  t.after(() => {
    if (started) command('docker', ['rm', '--force', name]);
    rmSync(fixture, { recursive: true, force: true });
  });
  const server = join(fixture, 'server'); mkdirSync(server, { mode: 0o755 });
  const port = await new Promise((resolve, reject) => {
    const socket = createServer(); socket.on('error', reject);
    socket.listen(0, '127.0.0.1', () => { const number = socket.address().port; socket.close(() => resolve(number)); });
  });
  for (const key of ['client', 'wrong-host']) command('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', join(fixture, key)]);
  command('/usr/bin/ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', join(server, 'host')]);
  writeFileSync(join(server, 'client.pub'), readFileSync(join(fixture, 'client.pub')), { mode: 0o644 });
  const sshConfig = ['Port ' + port, 'ListenAddress 127.0.0.1', 'HostKey /fixture/host', 'PidFile /tmp/sshd.pid',
    'AuthorizedKeysFile /fixture/client.pub', 'StrictModes no', 'UsePAM no', 'PasswordAuthentication no',
    'KbdInteractiveAuthentication no', 'AuthenticationMethods publickey', 'AllowUsers recovery',
    'DisableForwarding yes', 'PermitTTY no', 'PermitUserEnvironment no', 'LogLevel ERROR',
    'ForceCommand /usr/bin/python3 /code/helper.py --root /recovery --installation fixture-installation'].join('\n') + '\n';
  writeFileSync(join(server, 'sshd_config'), sshConfig, { mode: 0o600 });
  command('docker', ['run', '--detach', '--rm', '--name', name, '--network', 'host',
    '--mount', 'type=bind,source=' + server + ',target=/fixture,readonly',
    '--mount', 'type=bind,source=' + join(here, '../recovery') + ',target=/code,readonly',
    'subspace-recovery-ssh-fixture:20261112']);
  started = true;
  const publicHost = readFileSync(join(server, 'host.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  const knownHosts = join(fixture, 'known-hosts');
  writeFileSync(knownHosts, `[127.0.0.1]:${port} ${publicHost}\n`, { mode: 0o600 });
  const encryptionKey = join(fixture, 'encryption-key'); writeFileSync(encryptionKey, randomBytes(32), { mode: 0o600 });
  const config = { version: 1, installation: 'fixture-installation', host: '127.0.0.1', port, user: 'recovery',
    knownHostsFile: knownHosts, identityFile: join(fixture, 'client'), encryptionKeyFile: encryptionKey,
    connectTimeoutSeconds: 2, operationTimeoutSeconds: 5 };
  let lastFailure;
  const client = new RecoveryClient(config, (...args) => {
    const result = spawnSync(...args);
    if (result.status !== 0) lastFailure = { status: result.status, stdout: result.stdout?.toString(), stderr: result.stderr?.toString() };
    return result;
  });
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { client.probe(); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  if (!ready) {
    const banner = command('docker', ['exec', name, 'python3', '-c', "import socket; s=socket.create_connection(('127.0.0.1'," + port + ")); print(s.recv(256))"]);
    assert.fail(JSON.stringify({ lastFailure, banner }) + command('docker', ['logs', name]));
  }
  const configFile = join(fixture, 'recovery.json');
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  const cli = spawnSync(process.execPath, [join(here, 'client.mjs'), '--config', configFile],
    { input: JSON.stringify({ op: 'probe' }), timeout: 10_000, encoding: 'utf8' });
  assert.equal(cli.status, 0); assert.equal(cli.stderr, ''); assert.equal(JSON.parse(cli.stdout).ok, true);
  const journalBytes = Buffer.from('fixture historical payment attribution');
  append(client, 1, journalBytes); append(client, 1, Buffer.from(JSON.stringify({ seq: 1, kind: 'fixture-controller-intent' })), 'controller');
  const python = [
    'import sys,json',
    'sys.path.insert(0,sys.argv[1])',
    'from controller.recovery_backend import RecoveryBackend,RemoteJournal',
    'backend=RecoveryBackend(sys.argv[2],sys.argv[3],sys.argv[4])',
    'journal=RemoteJournal(backend)',
    'assert journal.append("fixture-python",value="fixture") == 2',
    'assert len(journal.entries()) == 2',
    'assert journal.position() == 2',
    'print(json.dumps({"ok":True,"sequence":journal.position()}))',
  ].join('\n');
  const applicationSource=process.env.SUBSPACE_PACKAGE_APPLICATION_SOURCE || join(here,'../..');
  const pythonResult = spawnSync('/usr/bin/python3', ['-c', python, applicationSource, configFile, join(here, 'client.mjs'), process.execPath],
    { timeout: 30_000, encoding: 'utf8' });
  assert.equal(pythonResult.status, 0, pythonResult.stderr); assert.equal(JSON.parse(pythonResult.stdout).sequence, 2);
  const seller = join(fixture, 'seller'); mkdirSync(seller, { mode: 0o700 });
  const files = { 'registry.db': Buffer.from('fixture application history'), 'controller.db': Buffer.from('fixture controller history') };
  const manifest = { label: 'fixture', store_journal: 1, controller_journal: 1, files: {} };
  for (const [path, bytes] of Object.entries(files)) {
    writeFileSync(join(seller, path), bytes, { mode: 0o600 }); manifest.files[path] = sha(bytes);
  }
  writeFileSync(join(seller, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  snapshotPut(client, { op: 'snapshot-put', snapshot: '001-fixture', kind: 'checkpoint', directory: seller });
  rmSync(seller, { recursive: true });
  const target = join(fixture, 'replacement-seller');
  snapshotGet(client, { op: 'snapshot-get', snapshot: '001-fixture', directory: target });
  for (const [path, bytes] of Object.entries(files)) assert.deepEqual(readFileSync(join(target, path)), bytes);
  assert.deepEqual(Buffer.from(journalRead(client, 'store', 0).entries[0].data, 'base64'), journalBytes);
  const wrongKnownHosts = join(fixture, 'wrong-known-hosts');
  const wrongPublic = readFileSync(join(fixture, 'wrong-host.pub'), 'utf8').split(' ').slice(0, 2).join(' ');
  writeFileSync(wrongKnownHosts, `[127.0.0.1]:${port} ${wrongPublic}\n`, { mode: 0o600 });
  const wrongClient = new RecoveryClient({ ...config, knownHostsFile: wrongKnownHosts });
  assert.throws(() => append(wrongClient, 2, Buffer.from('must not append')), { code: 'host-key-rejected' });
  assert.equal(journalRead(client, 'store', 1).entries.length, 0);
  const encrypted = command('docker', ['exec', name, 'cat', '/recovery/store/0000000000000001.json'], { encoding: 'buffer' });
  assert(!encrypted.includes(journalBytes));

  // Generated component throughput. This is not the complete 10,000-order replay gate.
  const prepared = join(fixture, 'prepared'); mkdirSync(prepared, { mode: 0o700 });
  for (let sequence = 2; sequence <= 10_000; sequence++) {
    const bytes = Buffer.from(JSON.stringify({ sequence, order: 'fixture-order-' + sequence, value: 'x'.repeat(512) }));
    writeFileSync(join(prepared, String(sequence).padStart(16, '0') + '.json'), client.encrypt(Buffer.concat([Buffer.from('J1\0'), bytes]), 'journal:store:' + sequence), { mode: 0o600 });
  }
  command('docker', ['cp', prepared + '/.', name + ':/recovery/store/']);
  command('docker', ['exec', name, 'chown', '-R', 'recovery:recovery', '/recovery/store']);
  const begin = performance.now(); let after = 0; let pages = 0;
  while (after < 10_000) {
    const page = journalRead(client, 'store', after, 1024); after += page.entries.length; pages++;
  }
  const milliseconds = Math.round(performance.now() - begin);
  t.diagnostic(JSON.stringify({ generatedEncryptedEntries: after, pages, milliseconds }));
  assert(milliseconds < 60_000);
  command('docker', ['stop', '--time', '2', name]); started = false;
  assert.throws(() => append(client, 10_001, Buffer.from('unacknowledged fixture')), { code: 'transport-unavailable' });
});
