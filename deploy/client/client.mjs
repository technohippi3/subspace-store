#!/usr/bin/env node
import { readSync } from 'node:fs';
import { RecoveryClient, Refused, exact, protectedFile, require, MAX_LOCAL_MESSAGE } from './transport.mjs';
import { journalAppend, journalHead, journalRead } from './journals.mjs';
import { snapshotGet, snapshotPut } from './snapshots.mjs';

export function dispatch(client, request) {
  require(request && typeof request === 'object');
  switch (request.op) {
    case 'journal-append': return journalAppend(client, request);
    case 'journal-read': exact(request, 'op stream after limit'); return journalRead(client, request.stream, request.after, request.limit);
    case 'journal-head': exact(request, 'op stream'); return journalHead(client, request.stream);
    case 'snapshot-put': return snapshotPut(client, request);
    case 'snapshot-get': return snapshotGet(client, request);
    case 'snapshot-list': {
      exact(request, 'op');
      const result = client.request({ op: 'snapshot-list' });
      require(Array.isArray(result.snapshots) && result.snapshots.length <= 4096 &&
        result.snapshots.every(name => typeof name === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(name)), 'invalid-remote-response');
      return { snapshots: result.snapshots };
    }
    case 'probe': exact(request, 'op'); return client.probe();
    default: throw new Refused('invalid-request');
  }
}
if (process.argv[1]?.endsWith('/client.mjs')) {
  try {
    require(process.argv.length === 4 && process.argv[2] === '--config');
    const config = JSON.parse(protectedFile(process.argv[3], 65536, false));
    const bytes = Buffer.alloc(MAX_LOCAL_MESSAGE + 1);
    let length = 0;
    while (length < bytes.length) {
      const n = readSync(0, bytes, length, bytes.length - length, null);
      if (!n) break;
      length += n;
    }
    require(length < bytes.length, 'oversize-request');
    const client = new RecoveryClient(config);
    const result = dispatch(client, JSON.parse(bytes.subarray(0, length)));
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, code: error instanceof Refused ? error.code : 'recovery-unavailable' }) + '\n');
    process.exitCode = 2;
  }
}
