import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { MAX_OBJECT, MAX_PAGE, MAX_PLAIN, MAX_RECORD, RecoveryClient, Refused, sha } from './transport.mjs';
import { journalAppend, journalHead, journalRead } from './journals.mjs';
import { snapshotGet, snapshotPut } from './snapshots.mjs';

const here = dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'subspace-recovery-client-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, 'remote'); mkdirSync(root, { mode: 0o700 });
  const config = { version: 1, installation: 'fixture-installation', host: 'fixture.invalid', port: 2222,
    user: 'recovery', identityFile: join(directory, 'identity'), knownHostsFile: join(directory, 'known-hosts'),
    encryptionKeyFile: join(directory, 'encryption-key'), connectTimeoutSeconds: 2, operationTimeoutSeconds: 5 };
  writeFileSync(config.identityFile, 'fixture identity file', { mode: 0o600 });
  writeFileSync(config.knownHostsFile, 'fixture public host key', { mode: 0o600 });
  writeFileSync(config.encryptionKeyFile, randomBytes(32), { mode: 0o600 });
  let dropOperation;
  let calls = 0; let rejectOperation; let rejectAfter = 0;
  const execute = (command, args, options) => {
    assert.equal(command, '/usr/bin/ssh');
    assert(args.includes('-oStrictHostKeyChecking=yes'));
    assert(args.includes('-oIdentityAgent=none'));
    const request = JSON.parse(options.input);
    if (request.op === rejectOperation && --rejectAfter === 0) {
      rejectOperation = undefined;
      return { status: 255, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    }
    const result = spawnSync('/usr/bin/python3', [join(here, '../recovery/helper.py'), '--root', root,
      '--installation', config.installation], { ...options, env: undefined });
    calls++;
    if (request.op === dropOperation) { dropOperation = undefined; return { status: 255, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }; }
    return result;
  };
  return { directory, root, config, execute, client: new RecoveryClient(config, execute),
    drop: operation => { dropOperation = operation; }, reject: (operation, after = 1) => { rejectOperation = operation; rejectAfter = after; }, calls: () => calls };
}
function append(client, sequence, data = Buffer.from('sensitive fixture data'), stream = 'store') {
  return journalAppend(client, { op: 'journal-append', stream, sequence, sha256: sha(data), data: data.toString('base64') });
}
function source(f, kind = 'checkpoint') {
  const directory = join(f.directory, kind); mkdirSync(directory, { mode: 0o700 });
  const files = kind === 'checkpoint' ? { 'registry.db': Buffer.from('store database'), 'controller.db': Buffer.from('controller database'),
    'subs/state': Buffer.concat([Buffer.alloc(MAX_PLAIN, 120), Buffer.from('sensitive fixture state')]) } :
    { 'core-wallet.backup': Buffer.from('fixture backup bytes'), 'spaced-wallet.export': Buffer.from('fixture export bytes') };
  const manifest = { label: 'fixture', store_journal: 1, controller_journal: 1, files: {} };
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(directory, path), bytes, { mode: 0o600 }); manifest.files[path] = sha(bytes);
  }
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
  return { directory, files };
}
test('encrypted journal retry and lost acknowledgment retain exact existing ciphertext', t => {
  const f = fixture(t); f.drop('journal-append');
  const result = append(f.client, 1);
  const encrypted = readFileSync(join(f.root, 'store', '0000000000000001.json'));
  assert(!encrypted.includes(Buffer.from('sensitive fixture data')));
  assert.deepEqual(append(f.client, 1), result);
  assert.deepEqual(readFileSync(join(f.root, 'store', '0000000000000001.json')), encrypted);
  assert.throws(() => append(f.client, 1, Buffer.from('changed')), { code: 'immutable-conflict' });
  assert.equal(Buffer.from(journalRead(f.client, 'store', 0).entries[0].data, 'base64').toString(), 'sensitive fixture data');
  assert.equal(journalHead(f.client, 'store').sha256, sha(Buffer.from('sensitive fixture data')));
});
test('AEAD rejects modified bytes, another stream, another sequence and wrong keys', t => {
  const f = fixture(t); append(f.client, 1);
  const bytes = readFileSync(join(f.root, 'store', '0000000000000001.json'));
  assert.throws(() => f.client.decrypt(bytes, 'journal:controller:1'), { code: 'authentication-failed' });
  assert.throws(() => f.client.decrypt(bytes, 'journal:store:2'), { code: 'authentication-failed' });
  bytes[bytes.length - 1] ^= 1;
  assert.throws(() => f.client.decrypt(bytes, 'journal:store:1'), { code: 'authentication-failed' });
  writeFileSync(f.config.encryptionKeyFile, randomBytes(32));
  const other = new RecoveryClient(f.config, f.execute);
  assert.throws(() => journalRead(other, 'store', 0), { code: 'authentication-failed' });
});
test('large journal page stops at bounded response bytes', t => {
  const f = fixture(t);
  for (let sequence = 1; sequence <= 17; sequence++) append(f.client, sequence, Buffer.alloc(MAX_PLAIN, sequence));
  const page = journalRead(f.client, 'store', 0, MAX_PAGE);
  assert.equal(page.entries.length, 16); assert.equal(page.head, 17);
  assert.equal(journalRead(f.client, 'store', 16, 1024).entries.length, 1);
});
test('oversized page count and malformed prefix response fail before plaintext authorization', t => {
  const f=fixture(t);
  const client=new RecoveryClient(f.config,()=>({status:0,stdout:Buffer.from(JSON.stringify({ok:true,installation:f.config.installation,
    entries:Array.from({length:MAX_PAGE+1},()=>({})),head:MAX_PAGE+1})),stderr:Buffer.alloc(0)}));
  assert.throws(()=>journalRead(client,'store',0,MAX_PAGE),{code:'invalid-remote-response'});
  assert.throws(()=>journalRead(f.client,'store',0,MAX_PAGE+1));
  const gap=new RecoveryClient(f.config,()=>({status:0,stdout:Buffer.from(JSON.stringify({ok:true,installation:f.config.installation,
    entries:[{sequence:2,sha256:'0'.repeat(64),data:''}],head:2})),stderr:Buffer.alloc(0)}));
  assert.throws(()=>journalRead(gap,'store',0,MAX_PAGE),{code:'journal-gap'});
});
test('large records publish their descriptor last and retry lost descriptor acknowledgment exactly', t => {
  const f = fixture(t); const bytes = Buffer.alloc(MAX_PLAIN * 2 + 119, 117);
  f.reject('blob-put', 2);
  assert.throws(() => append(f.client, 1, bytes), { code: 'transport-unavailable' });
  assert.equal(journalHead(f.client, 'store').sequence, 0);
  assert.equal(readdirSync(join(f.root, 'blobs')).length, 1);
  f.drop('journal-append');
  const ack = append(f.client, 1, bytes);
  const descriptor = readFileSync(join(f.root, 'store', '0000000000000001.json'));
  const count = readdirSync(join(f.root, 'blobs')).length;
  assert.deepEqual(append(f.client, 1, bytes), ack);
  assert.deepEqual(readFileSync(join(f.root, 'store', '0000000000000001.json')), descriptor);
  assert.equal(readdirSync(join(f.root, 'blobs')).length, count);
  assert.deepEqual(Buffer.from(journalRead(f.client, 'store', 0).entries[0].data, 'base64'), bytes);
  assert.throws(() => append(f.client, 2, Buffer.alloc(MAX_RECORD + 1)));
  const body = f.client.decrypt(descriptor, 'journal:store:1');
  const metadata = JSON.parse(body.subarray(3));
  const path = join(f.root, 'blobs', metadata.chunks[1]); const encrypted = readFileSync(path);
  rmSync(path);
  assert.throws(() => journalRead(f.client, 'store', 0));
  writeFileSync(path, encrypted, { mode: 0o600 }); encrypted[encrypted.length - 1] ^= 1; writeFileSync(path, encrypted);
  assert.throws(() => journalRead(f.client, 'store', 0));
});
test('checkpoint and wallet backups are encrypted, chunked, idempotent and restore exact bytes', t => {
  const f = fixture(t); append(f.client, 1); append(f.client, 1, Buffer.from('controller'), 'controller');
  for (const kind of ['checkpoint', 'wallet-backups']) {
    const local = source(f, kind); const snapshot = 'fixture-' + kind;
    f.drop('snapshot-commit');
    snapshotPut(f.client, { op: 'snapshot-put', snapshot, kind, directory: local.directory });
    const existingCount = readdirSync(join(f.root, 'blobs')).length;
    assert.equal(snapshotPut(f.client, { op: 'snapshot-put', snapshot, kind, directory: local.directory }).existing, true);
    assert.equal(readdirSync(join(f.root, 'blobs')).length, existingCount);
    for (const name of readdirSync(join(f.root, 'blobs'))) assert(!readFileSync(join(f.root, 'blobs', name)).includes(Buffer.from('sensitive fixture')));
    const target = join(f.directory, 'restored-' + kind);
    const result = snapshotGet(f.client, { op: 'snapshot-get', snapshot, directory: target });
    assert.equal(result.kind, kind);
    for (const [path, bytes] of Object.entries(local.files)) assert.deepEqual(readFileSync(join(target, path)), bytes);
    assert.deepEqual(readFileSync(join(target, 'manifest.json')), readFileSync(join(local.directory, 'manifest.json')));
    assert.throws(() => snapshotGet(f.client, { op: 'snapshot-get', snapshot, directory: target }));
  }
});
test('changed source, symlink source, foreign manifest and tampered remote bytes fail', t => {
  const f = fixture(t); append(f.client, 1); append(f.client, 1, Buffer.from('controller'), 'controller');
  const local = source(f);
  snapshotPut(f.client, { op: 'snapshot-put', snapshot: 'fixture-snapshot', kind: 'checkpoint', directory: local.directory });
  writeFileSync(join(local.directory, 'registry.db'), 'changed source');
  assert.throws(() => snapshotPut(f.client, { op: 'snapshot-put', snapshot: 'fixture-snapshot', kind: 'checkpoint', directory: local.directory }), { code: 'source-changed' });
  symlinkSync('/etc/passwd', join(local.directory, 'subs', 'escape'));
  assert.throws(() => snapshotPut(f.client, { op: 'snapshot-put', snapshot: 'other-snapshot', kind: 'checkpoint', directory: local.directory }), { code: 'unsafe-source' });
  const manifestPath = join(f.root, 'snapshots', 'fixture-snapshot.json');
  const manifest = JSON.parse(readFileSync(manifestPath));
  const changedManifest = structuredClone(manifest);
  changedManifest.files['registry.db'] = changedManifest.files['controller.db'];
  writeFileSync(manifestPath, JSON.stringify(changedManifest));
  assert.throws(() => snapshotGet(f.client, { op: 'snapshot-get', snapshot: 'fixture-snapshot', directory: join(f.directory, 'changed-descriptor') }), { code: 'snapshot-authentication-failed' });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  const blobPath = join(f.root, 'blobs', manifest.files['registry.db'].chunks[0]);
  const bytes = readFileSync(blobPath); bytes[bytes.length - 1] ^= 1; writeFileSync(blobPath, bytes);
  assert.throws(() => snapshotGet(f.client, { op: 'snapshot-get', snapshot: 'fixture-snapshot', directory: join(f.directory, 'tampered-restore') }), { code: 'snapshot-blob-mismatch' });
});
test('key paths reject permissions and symlinks, and transport failures scrub stderr', t => {
  const f = fixture(t); chmodSync(f.config.encryptionKeyFile, 0o644);
  assert.throws(() => new RecoveryClient(f.config, f.execute), { code: 'unsafe-credential-file' });
  chmodSync(f.config.encryptionKeyFile, 0o600);
  const rejected = new RecoveryClient(f.config, () => ({ status: 255, stdout: Buffer.alloc(0), stderr: Buffer.from('Host key verification failed. sensitive fixture') }));
  assert.throws(() => rejected.probe(), { code: 'host-key-rejected' });
  const down = new RecoveryClient(f.config, () => ({ status: 255, stdout: Buffer.alloc(0), stderr: Buffer.from('sensitive fixture') }));
  assert.throws(() => down.probe(), error => error.code === 'transport-unavailable' && !error.message.includes('sensitive'));
});
