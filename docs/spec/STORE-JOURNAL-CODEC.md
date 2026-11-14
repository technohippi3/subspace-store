# Store journal envelope codec slice

This implements a dormant envelope-only boundary for
[the proposed journal format](STORE-OPERATION-JOURNAL.md). The separate dormant
[local file backend](STORE-ENVELOPE-FILE-JOURNAL.md) and
[SSH backend](STORE-ENVELOPE-SSH-JOURNAL.md) consume it. No existing selected
storage adapter, runtime entrypoint, operation API, database/schema, bootstrap or
Python code selects it. The pure codec grants no append, acknowledgment, activation or effect
permission. Domain validation and real ownership/lifecycle qualification remain
separate requirements; the broader format is not implemented by this slice.

## Implemented boundary

`ts/src/storage/journal-envelope.ts` exposes readJournalPayload, readJournalFile,
encodeJournalEnvelope, journalFileBytes and inspectEnvelopePrefix. Pure failures
throw without logging input contents; a later Effect storage adapter must map them
to typed failures, never absence. Returned records and prefix summaries explicitly
say `validation: "envelope-only"`.

A payload record retains the exact original lossless UTF-8 text, its plaintext
SHA-256, and a deeply frozen decoded Entry. Each bytes access returns an owned copy;
input/output buffer mutations cannot alter the retained payload or its digest.
Logical embedded hashes and plaintext record digests remain distinct. Legacy
parsing/hashing delegates to the unchanged v1 codec, preserving its property-order,
duplicate-key, whitespace and exponent behavior within the declared byte/head bounds.
Legacy payloads that are not lossless UTF-8 refuse under the format's eligibility
rules. No payload is reconstructed from a decoded object as evidence.

V2 decoding requires the literal frame, canonical UTF-8 JCS, exact envelope/change
fields, metadata bounds, unique change identities and correct embedded SHA-256.
The pure encoder emits that same format. The separate canonical JSON helper uses
ECMAScript primitive serialization, UTF-16 key sorting, valid Unicode and iterative
array/object traversal, retaining array order and original string normalization.
It rejects unsupported values, cycles, accessors and serialization hooks.
The imported [I-JSON character rule](https://www.rfc-editor.org/rfc/rfc7493.html#section-2.1)
also rejects all 66 Unicode noncharacters in v2 keys/values, including escaped
spellings after parsing. This admission check is separate from serialization;
reference serialization alone is insufficient. V1 character behavior stays unchanged.

The file reader removes at most one physical LF for v1 and requires exactly one
for v2. Remote/outbox parsing removes none. File construction accepts only v2;
it cannot normalize an old file. Streaming prefix inspection checks contiguous
sequence, stable UUID, previous hash, size/head limits, the exact singleton floor
and no downgrade/repeated floor. It returns the parsed floor for a later caller's
trusted configuration check, not proof that its identity/capability is authorized.

The 16-MiB payload, 512-MiB prefix and 1000000-head bounds are enforced here. A
16-MiB ordinary value is not subject to the future per-protocol one-MiB rule.
Operation schemas/raw-integer fields, protocol value bounds, immutable/revision
history, native evidence, pending-owner/entry relationships and complete domain
projection validation are deliberately not supplied by this envelope boundary.
An opaque syntactically valid change can pass it and still fail those later gates.

## Evidence and remaining qualification

The checked-in literal vectors independently specify legacy compact/pretty and
duplicate/exponent payloads, first/after-legacy floors and successor bytes/digests.
Their ASCII-key/integer serialization was calculated separately with Python;
every hash was cross-checked with OpenSSL, without importing this codec. That is
not a general Python JCS oracle. Separate literal RFC 8785 numeric/property/escaping
examples exercise noninteger and Unicode behavior. Tests cover buffer ownership,
framing, malformed bytes/metadata, lineage/floor negatives, exact 16-MiB payloads
and the streamed 512-MiB boundary. Fixture changes do not derive expected bytes
or hashes from the production encoder.

These are pure data-format tests, not storage/process/native, restore, billing,
installed-package or buyer evidence. Byte limits and deep-nesting controls do not
qualify worst-case heap/CPU or process availability. Old backends remain selected. Integrating
the byte-carrying view through selected FileJournal, SshJournal, SQLite/outbox, checkpoint,
replay and trusted bootstrap readers needs its own bounded implementation/tests.
Governing domain models and actual operation/crash/concurrency/restore evidence
must accompany behavior before capability selection. No Python removal, bootstrap
choice, runtime activation or sales permission follows from these envelope checks.
