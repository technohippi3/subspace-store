import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { createServer } from 'node:http';
import { request } from 'node:https';
import { connect } from 'node:tls';
import { createServer as portServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
async function port() {
  return await new Promise(resolve => { const socket = portServer(); socket.listen(0, '127.0.0.1', () => {
    const number = socket.address().port; socket.close(() => resolve(number));
  }); });
}
test('HTTPS proxy pins origin and CA, strips forwarding headers and rejects HTTP ambiguity', { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'subspace-proxy-fixture-'));
  let child;
  const upstream = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ path: request.url, headers: request.headers }));
  });
  t.after(async () => {
    if (child) { child.kill('SIGTERM'); await new Promise(resolve => child.once('close', resolve)); }
    await new Promise(resolve => upstream.close(resolve)); rmSync(root, { recursive: true, force: true });
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  const tlsPort = await port();
  const key = join(root, 'tls-key'), cert = join(root, 'tls-cert');
  const generated = spawnSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '3',
    '-subj', '/CN=store.fixture.test', '-addext', 'subjectAltName=DNS:store.fixture.test', '-keyout', key, '-out', cert]);
  assert.equal(generated.status, 0); chmodSync(cert, 0o644); const ca = readFileSync(cert);
  const runtime = join(root, 'runtime.json'); writeFileSync(runtime, JSON.stringify({ listen: { buyer: upstream.address().port } }), { mode: 0o600 });
  const config = { publicOrigin: 'https://store.fixture.test:' + tlsPort, storeConfig: runtime,
    tls: { listenPort: tlsPort, listenAddress: '127.0.0.1', privateKeyFile: key, certificateFile: cert, caFile: cert } };
  const file = join(root, 'installation.json'); writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  const inspected = spawnSync(process.execPath, [join(here, 'proxy.mjs'), '--check-tls', file], { encoding: 'utf8' });
  assert.equal(inspected.status, 0, inspected.stderr);
  child = spawn(process.execPath, [join(here, 'proxy.mjs'), '--serve', file], { env: { ...process.env, CREDENTIALS_DIRECTORY: root }, stdio: ['ignore', 'ignore', 'pipe'] });
  let error = ''; child.stderr.on('data', bytes => error += bytes.toString());
  const get = (path, headers = {}) => new Promise((resolve, reject) => {
    const call = request({ host: '127.0.0.1', port: tlsPort, servername: 'store.fixture.test', ca, rejectUnauthorized: true,
      path, headers: { Host: 'store.fixture.test:' + tlsPort, ...headers } }, response => {
      let body = ''; response.on('data', data => body += data); response.on('end', () => resolve({ code: response.statusCode, body }));
    }); call.on('error', reject); call.end();
  });
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try { ready = (await get('/.well-known/subspace-store-health')).code === 204; if (ready) break; }
    catch {} await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(ready, error);
  const response = await get('/buyer', { Forwarded: 'host=untrusted.invalid', 'X-Forwarded-Host': 'untrusted.invalid', 'X-Forwarded-Proto': 'http' });
  assert.equal(response.code, 200); const echoed = JSON.parse(response.body);
  assert.equal(echoed.headers.forwarded, undefined); assert.equal(echoed.headers['x-forwarded-host'], undefined);
  assert.equal(echoed.headers['x-forwarded-proto'], undefined); assert.match(echoed.headers.host, /^127\.0\.0\.1:/);
  assert.equal((await get('/', { Host: 'untrusted.invalid' })).code, 421);
  for (const path of ['/operator/status', '/registry/sync', '/%6fperator/status', '/buyer/../operator/status', '/%252foperator/status'])
    assert.equal((await get(path)).code, 404, path);
  const raw = data => new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port: tlsPort, servername: 'store.fixture.test', ca, rejectUnauthorized: true }, () => socket.write(data));
    let response = ''; socket.on('data', data => response += data); socket.on('error', reject); socket.on('end', () => resolve(response));
  });
  assert.match(await raw(`GET / HTTP/1.1\r\nHost: store.fixture.test:${tlsPort}\r\nHost: store.fixture.test:${tlsPort}\r\nConnection: close\r\n\r\n`), /^HTTP\/1\.1 (400|421)/);
  assert.match(await raw(`POST / HTTP/1.1\r\nHost: store.fixture.test:${tlsPort}\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n`), /^HTTP\/1\.1 400/);
  assert.match(await raw(`CONNECT untrusted.invalid:443 HTTP/1.1\r\nHost: store.fixture.test:${tlsPort}\r\n\r\n`), /^HTTP\/1\.1 405/);
  const checked = spawnSync(process.execPath, [join(here, 'proxy.mjs'), '--check-live', file], { encoding: 'utf8' });
  assert.equal(checked.status, 0, checked.stderr); assert.equal(error, '');
});
