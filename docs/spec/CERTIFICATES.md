# Bound certificate readiness and buyer download

This extends `COMMITMENT-TRACKING.md`. The Python controller still verifies
certificate messages with its configured libveritas executable. The store
trusts that authenticated controller; it does not verify certificate
cryptography itself. The Python store's owner-only baseline is unchanged.

## Verification and acceptance

The TypeScript controller first watches the batch, obtaining a currently
acknowledged, final, covered commitment observation. It verifies each message
against anchors read from spaced, the exact handle and recipient script,
and sovereign status. The message can use the batch root at its mined
height or a later root of that space, final and covered at its stated height,
while the original root remains on chain. Otherwise sound later roots that
are pending coverage/finality wait; dependent or invalid certificates fail.
The verifier must exit successfully and return boolean `verified: true`.

Before accepting each verified message, the controller repeats its coherent
chain observation and requires the same facts as before verification. It
journals the entry, order, observation revision, root basis, height, digest
and length before the callback. A changed chain, journal outage or negative
acknowledgment withholds delivery. The runner does not follow a successful
bound callback with an anonymous delivery request.

The store checks the exact armed entry/root/member/delegate association,
order membership, current observation revision and matching snapshot tip.
Both the original commitment and certificate root must be final and covered.
The root basis is the original root at its exact height or a different root
at a greater height. The store trusts the controller's verified statement
about the message contents and later root's chain inclusion. A digest alone
is not evidence of inclusion or cryptographic verification.

Cache the exact bytes first, then atomically journal certificate metadata
and change that order to `ready`. Acknowledgment requires live confirmation
of the metadata, order, commitment, immutable entry and arm. Exact retries
are idempotent. A reply lost after acceptance recovers through a fresh watch
and verification. No send path is introduced. Ready orders retain name and
recipient ownership, their price reserve, excess-refund accounting and
post-issuance deficit reporting. They cannot cancel or reenter a batch.

## Chain continuity and invalidation

The metadata records the tip hash and height used for verification. Before
serving bytes or reporting availability, check that this block remains in
the active chain, fenced by the same Core tip as the payment snapshot.
Normal descendant tips preserve the verified roots and anchors without
repeating verification. An unavailable or changing Core view withholds the
response. After restart, this check runs before application readiness.

Losing that checkpoint invalidates the certificate and returns a ready
order to `issuing`. This conservatively includes a shallow reorg that leaves
the root final but replaces the verification tip. A commitment report that
loses finality, root inclusion or certificate-root coverage also invalidates
the relevant certificates in its local transaction, before acknowledgment.
Neither transition unlocks the name or price reservation. An unconfirmed
invalidation never serves an older acknowledged certificate.

Invalidation records a blocked observation revision. Returning to the old
chain does not revive cached bytes, and a delayed callback at that revision
cannot do so. A newer observation and fresh verification are required.
These guarantees apply to ready orders; verified relay fulfillment and its
sticky fulfilled/recovery-incident rules remain to be ported.

## Cache and HTTP contract

Only metadata, including digest and byte length, is journaled. Bytes live
under `<database>.certificates/`, in files named by SHA-256, with directory
mode 0700 and file mode 0600. Writes use a temporary file, fsync and atomic
rename. Bytes are reconstructible through `certify`; they are not required
in a journal-only restore. Missing or corrupt bytes are never served. Exact
verified redelivery can repair the cache. Whole-application restore remains
blocked until its separate reconciliation exists.

Authenticated `POST /operator/certificates` accepts exactly `entry`, `root`,
`oids`, `delegate`, `revision`, `oid`, `certificateRoot`, `certificateHeight`
and canonical `message_b64`. The decoded message must contain 1 to 1,048,576
bytes. Only this route has the larger transport allowance for base64 and
binding metadata; other bodies retain their 65,536-byte bound. Duplicate,
escaped, unknown, malformed and oversized fields refuse.

The receipt contains exactly `oid`, `entry`, `revision`, `certificateRoot`,
`certificateHeight`, `hash`, `length` and boolean `acknowledged`. The client
checks every field and never falls back to an anonymous callback. A buyer's
opaque order link gains `GET /orders/<token>/certificate`, returning the
original binary message only while available. It has attachment, no-store,
no-referrer and nosniff headers. Numeric order IDs and operator credentials
are not buyer links. Order JSON has `certificate_available`; unconfirmed
readiness or missing bytes is shown as issuing until a certificate is available.

Live journal confirmation and the Core checkpoint check are on the download
path. Their outages withhold availability. No installer, public listener or
sales authorization is introduced by this component.

## Evidence scope

The independent deterministic certificate model imports no production code.
HTTP/controller tests run the shipped client, controller verification loop,
runner, SQLite and journals with recording RPCs and a recording verifier
executable. They are not cryptographic verification evidence. Isolated Core
regtest checks real checkpoint ancestry and reorgs with mock certificate,
root and anchor facts. A complete TypeScript sale through the pinned Spaces
stack and real libveritas remains a separate gate. Sales remain closed.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O36 | a current final/covered armed entry | accept own/later-root messages and retry | exact cache digest, atomic ready metadata, one immutable order binding, reservations retained and cancellation refused |
| O37 | verified readiness | restart and advance to descendant tips | bytes remain available without repeated verification while checkpoint stays active |
| O38 | certificate accepted during journal outage | inspect, restart and recover | readiness withheld until live acknowledgment; metadata revision and bytes retained |
| O39 | a ready certificate | lose verification checkpoint, return old chain and deliver old callback | invalidate durably, old callback cannot revive it; newer observation plus verification restores availability |
| O40 | a ready order with payment loss | lose root/finality/coverage | certificate withheld, order issuing, price reserve and post-issuance deficit retained; cancellation refused |
| O41 | operator upload and opaque buyer download | authenticate, send exact/invalid bodies and boundary sizes | 1 MiB certificate accepted, larger refused, other bodies stay bounded; exact binary with private-response headers |
| O42 | journaled valid metadata | lose or corrupt local bytes and redeliver exactly | never serve bad bytes; verified redelivery repairs reconstructible cache |
| O43 | invalid metadata version, entry, revision, digest or blocked revision | open application | refuse without erasing evidence or retaining ownership |
| O44 | real controller/client/runner with recording verifier | lose callback reply before/after forwarding, exit after acceptance or certify a later root | fresh watch/verification recovers readiness for both members, one original commitment send |
| O45 | verification attempt | change chain, mismatch recipient, return dependent status or verifier failure | no readiness, no certificate download or additional send |
| A36 | successful verifier and current observation | accept certificate | journal public digest and exact binding before callback; never journal message bytes |
| A37 | controller journal outage, changed chain or unconfirmed callback | certify | no callback during outage or chain mismatch; negative acknowledgment withholds delivery |
| A38 | malformed certificate callback receipt | decode | reject mismatched binding, digest, length, revision and boolean fields without fallback |
| A39 | bound callback already delivered verified bytes | attended runner completes certify | no anonymous duplicate delivery; report the bound result |
