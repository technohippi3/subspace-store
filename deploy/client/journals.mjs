import { MAX_PAGE, MAX_PLAIN, MAX_RECORD, base64, exact, integer, require, sha, Refused } from './transport.mjs';

function stream(value) { require(['store', 'controller'].includes(value)); return value; }
function context(name, sequence) { return 'journal:' + stream(name) + ':' + sequence; }
function chunkContext(name, sequence, index) { return 'journal-chunk:' + stream(name) + ':' + sequence + ':' + index; }
function plaintext(client, name, sequence, envelope) {
  const body = client.decrypt(envelope, context(name, sequence));
  if (body.subarray(0, 3).equals(Buffer.from('J1\0'))) return body.subarray(3);
  require(body.subarray(0, 3).equals(Buffer.from('J2\0')), 'invalid-journal-envelope');
  const descriptor = JSON.parse(body.subarray(3));
  exact(descriptor, 'size sha256 chunks'); integer(descriptor.size, 1, MAX_RECORD);
  require(Array.isArray(descriptor.chunks) && descriptor.chunks.length === Math.ceil(descriptor.size / MAX_PLAIN), 'invalid-journal-chunks');
  const pieces = []; let size = 0;
  for (const [index, hash] of descriptor.chunks.entries()) {
    require(typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash), 'invalid-journal-chunks');
    const object = client.request({ op: 'blob-get', sha256: hash });
    const encrypted = base64(object.data); require(object.sha256 === hash && sha(encrypted) === hash, 'digest-mismatch');
    const piece = client.decrypt(encrypted, chunkContext(name, sequence, index));
    require(piece.length === Math.min(MAX_PLAIN, descriptor.size - size), 'invalid-journal-chunks');
    pieces.push(piece); size += piece.length;
  }
  const value = Buffer.concat(pieces);
  require(size === descriptor.size && sha(value) === descriptor.sha256, 'journal-record-digest-mismatch');
  return value;
}
function encryptedRecord(client, name, sequence, data) {
  if (data.length + 3 <= MAX_PLAIN) return client.encrypt(Buffer.concat([Buffer.from('J1\0'), data]), context(name, sequence));
  const chunks = [];
  for (let offset = 0; offset < data.length; offset += MAX_PLAIN) {
    const encrypted = client.encrypt(data.subarray(offset, offset + MAX_PLAIN), chunkContext(name, sequence, chunks.length));
    const hash = sha(encrypted);
    const ack = client.request({ op: 'blob-put', sha256: hash, data: encrypted.toString('base64') });
    require(ack.sha256 === hash && ack.size === encrypted.length, 'invalid-remote-response'); chunks.push(hash);
  }
  const metadata = Buffer.from(JSON.stringify({ size: data.length, sha256: sha(data), chunks }));
  return client.encrypt(Buffer.concat([Buffer.from('J2\0'), metadata]), context(name, sequence));
}
function decode(client, name, item) {
  exact(item, 'sequence sha256 data');
  integer(item.sequence, 1);
  const encrypted = base64(item.data);
  require(sha(encrypted) === item.sha256, 'digest-mismatch');
  const data = plaintext(client, name, item.sequence, encrypted);
  return { sequence: item.sequence, sha256: sha(data), remoteSha256: item.sha256, data: data.toString('base64') };
}
export function journalRead(client, name, after, limit = MAX_PAGE) {
  stream(name); integer(after); integer(limit, 1, MAX_PAGE);
  const result = client.request({ op: 'journal-read', stream: name, after, limit });
  require(Array.isArray(result.entries) && result.entries.length <= limit, 'invalid-remote-response');
  integer(result.head, after);
  const entries = []; let total = 0;
  for (const [index, item] of result.entries.entries()) {
    require(item.sequence === after + index + 1 && item.sequence <= result.head, 'journal-gap');
    const decoded = decode(client, name, item); const size = base64(decoded.data, MAX_RECORD).length;
    if (entries.length && total + size > MAX_RECORD) break;
    total += size; entries.push(decoded);
  }
  require(entries.length > 0 || after === result.head, 'journal-gap');
  return { entries, head: result.head };
}
export function journalPosition(client, name, sequence) {
  stream(name); integer(sequence);
  if (!sequence) return { sequence: 0, sha256: null, remoteSha256: null };
  const result = journalRead(client, name, sequence - 1, 1);
  require(result.entries[0]?.sequence === sequence, 'journal-gap');
  const { sha256, remoteSha256 } = result.entries[0];
  return { sequence, sha256, remoteSha256 };
}
export function journalHead(client, name) {
  stream(name);
  const result = client.request({ op: 'journal-head', stream: name });
  integer(result.sequence);
  const position = journalPosition(client, name, result.sequence);
  require(position.remoteSha256 === result.sha256, 'journal-changed');
  return position;
}
export function journalAppend(client, request) {
  exact(request, 'op stream sequence sha256 data');
  stream(request.stream); integer(request.sequence, 1);
  const data = base64(request.data, MAX_RECORD);
  require(sha(data) === request.sha256, 'digest-mismatch');
  const existing = () => {
    const result = journalRead(client, request.stream, request.sequence - 1, 1);
    const item = result.entries[0];
    if (!item) return undefined;
    require(base64(item.data, MAX_RECORD).equals(data), 'immutable-conflict');
    return { sequence: request.sequence, sha256: sha(data), remoteSha256: item.remoteSha256 };
  };
  const previous = existing();
  if (previous) return previous;
  const encrypted = encryptedRecord(client, request.stream, request.sequence, data);
  try {
    const result = client.request({ op: 'journal-append', stream: request.stream, sequence: request.sequence,
      sha256: sha(encrypted), data: encrypted.toString('base64') });
    require(result.sequence === request.sequence && result.sha256 === sha(encrypted), 'invalid-remote-response');
  } catch (error) {
    if (!(error instanceof Refused)) throw error;
    const recovered = existing();
    if (recovered) return recovered;
    throw error;
  }
  const recovered = existing();
  require(recovered, 'journal-readback-failed');
  return recovered;
}
