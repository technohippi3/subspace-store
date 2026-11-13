#!/usr/bin/env node
import { createServer, request as tlsRequest } from 'node:https';
import { request as upstreamRequest } from 'node:http';
import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { protectedFile, require } from '../client/transport.mjs';

function configuration(path) {
  const config = JSON.parse(protectedFile(path, 65536, false));
  const origin = new URL(config.publicOrigin);
  require(origin.protocol === 'https:' && origin.origin === config.publicOrigin && !origin.username && !origin.password &&
    origin.pathname === '/' && !origin.search && !origin.hash, 'invalid-public-origin');
  require(Number.isInteger(config.tls.listenPort) && config.tls.listenPort > 0 && config.tls.listenPort <= 65535);
  require(Number(origin.port || 443) === config.tls.listenPort, 'public-port-mismatch');
  return { config, origin };
}
function inspect(config, origin, credentialDirectory) {
  const cert = protectedFile(credentialDirectory ? join(credentialDirectory, 'tls-cert') : config.tls.certificateFile, 1024 * 1024, false);
  const key = protectedFile(credentialDirectory ? join(credentialDirectory, 'tls-key') : config.tls.privateKeyFile, 16384);
  const certificate = new X509Certificate(cert);
  require(Date.parse(certificate.validFrom) <= Date.now() && Date.parse(certificate.validTo) > Date.now() + 86400000, 'certificate-expiring');
  require(isIP(origin.hostname) ? certificate.checkIP(origin.hostname) : certificate.checkHost(origin.hostname), 'certificate-host-mismatch');
  require(certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(
    createPublicKey(createPrivateKey(key)).export({ type: 'spki', format: 'der' })), 'certificate-key-mismatch');
  return { cert, key };
}
async function live(config, origin) {
  const ca = config.tls.caFile === null ? undefined : protectedFile(config.tls.caFile, 1024 * 1024, false);
  await new Promise((resolve, reject) => {
    const request = tlsRequest({ hostname: '127.0.0.1', port: config.tls.listenPort, servername: origin.hostname,
      path: '/.well-known/subspace-store-health', headers: { Host: origin.host }, ca, rejectUnauthorized: true, timeout: 5000 }, response => {
      response.resume(); response.once('end', () => response.statusCode === 204 ? resolve() : reject(Error('proxy unavailable')));
    });
    request.once('error', reject); request.once('timeout', () => request.destroy(Error('proxy unavailable'))); request.end();
  });
}
try {
  require(process.argv.length === 4 && ['--serve', '--check-tls', '--check-live'].includes(process.argv[2]));
  const { config, origin } = configuration(process.argv[3]);
  if (process.argv[2] === '--check-live') { await live(config, origin); process.stdout.write('{"ready":true}\n'); }
  else if (process.argv[2] === '--check-tls') { inspect(config, origin); process.stdout.write('{"ready":true}\n'); }
  else {
    require(process.env.CREDENTIALS_DIRECTORY, 'runtime-credentials-required');
    const credentials = inspect(config, origin, process.env.CREDENTIALS_DIRECTORY);
    const runtime = JSON.parse(protectedFile(config.storeConfig, 65536, false));
    require(Number.isInteger(runtime.listen.buyer) && runtime.listen.buyer > 0 && runtime.listen.buyer <= 65535);
    const server = createServer({ ...credentials, minVersion: 'TLSv1.2', insecureHTTPParser: false }, (incoming, outgoing) => {
      const hosts = incoming.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === 'host').length;
      if (hosts !== 1 || incoming.headers.host !== origin.host || !incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.method === 'CONNECT') {
        outgoing.writeHead(421).end(); incoming.resume(); return;
      }
      let normalized;
      try {
        normalized = incoming.url.split('?')[0];
        for (let i = 0; i < 3; i++) normalized = decodeURIComponent(normalized);
        if (normalized.startsWith('//') || normalized.includes('\\')) { outgoing.writeHead(404).end(); incoming.resume(); return; }
        normalized = new URL(normalized, origin).pathname;
      } catch { outgoing.writeHead(400).end(); incoming.resume(); return; }
      if (incoming.method === 'GET' && incoming.url === '/.well-known/subspace-store-health') { outgoing.writeHead(204).end(); return; }
      if (/^\/(?:operator|registry)(?:\/|$)/.test(normalized)) { outgoing.writeHead(404).end(); incoming.resume(); return; }
      if (Number(incoming.headers['content-length'] ?? 0) > 1048576) { outgoing.writeHead(413).end(); incoming.resume(); return; }
      const hop = new Set(['connection', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer', 'transfer-encoding',
        ...String(incoming.headers.connection ?? '').toLowerCase().split(',').map(value => value.trim())]);
      const headers = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => name !== 'forwarded' && !name.startsWith('x-forwarded-') && !hop.has(name)));
      headers.host = '127.0.0.1:' + runtime.listen.buyer;
      const upstream = upstreamRequest({ hostname: '127.0.0.1', port: runtime.listen.buyer, method: incoming.method,
        path: incoming.url, headers, timeout: 30000 }, response => { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); });
      let bytes = 0;
      incoming.on('data', data => { bytes += data.length; if (bytes > 1048576) {
        upstream.destroy(); if (!outgoing.headersSent) outgoing.writeHead(413).end(); else outgoing.destroy();
      } });
      upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(503); outgoing.end(); });
      upstream.once('timeout', () => upstream.destroy());
      incoming.once('aborted', () => upstream.destroy()); incoming.pipe(upstream);
    });
    server.requestTimeout = 30000; server.headersTimeout = 10000;
    server.on('connect', (_request, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
    server.on('upgrade', (_request, socket) => socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n'));
    require(['127.0.0.1', '0.0.0.0'].includes(config.tls.listenAddress));
    server.listen(config.tls.listenPort, config.tls.listenAddress);
    const close = () => { server.close(); server.closeIdleConnections(); };
    process.once('SIGTERM', close); process.once('SIGINT', close);
  }
} catch { process.stderr.write('HTTPS service unavailable; check configured origin and runtime credentials\n'); process.exitCode = 2; }
