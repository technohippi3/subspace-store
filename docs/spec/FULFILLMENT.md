# Verified relay fulfillment and recovery incidents

This extends `CERTIFICATES.md`. Publishing is not delivery. The publisher
requires final per-handle publication, a verified relay `/query` answer
matching the exact handle/recipient, sovereign status and a final, covered
on-chain root. It never treats `/peek` as delivery. The store trusts that
authenticated publisher; a proof digest alone is not cryptographic evidence.
The Python store's baseline is unchanged. No payment send is introduced.

## Publication, delivery and retries

The TypeScript publisher checks distinct known members, a fresh commitment
observation and each current acknowledged certificate. Its outstanding set
is confirmed in the controller journal before publication. Chunks stay at
most 100 handles; empty chunks make no call and foreign/duplicate chunks
refuse. A temporary publication status never counts as published.

Only a published member can reach delivery lookup. The configured verifier
must exit successfully and return boolean verified. A dependent zone, wrong
recipient or invalid root refuses. Otherwise sound relay answers under
immature/uncovered later roots wait. The original batch root remains subject
to its live chain, depth and anchor gates too. After lookup, the publisher
repeats the coherent chain observation and requires the same facts.

Before the store callback, journal the final publication state and verified
delivery's entry, order, observation revision, certificate digest, relay root,
height and proof digest. The store checks the exact armed binding, current
snapshot tip/revision/certificate and root bounds. It atomically records
first delivery and changes ready to fulfilled. Only a live store
acknowledgment permits the publisher's local row to become delivered.

A lost response or process exit retries through fresh checks and an
idempotent callback. Previously recorded final publication needs no new
publication call. A crash after local completion is safe because store
acknowledgment came first. Repeated valid delivery preserves the original
receipt. A lost publication reply can still require safe re-publication of
a public certificate; it never repeats a commitment send or moves funds.
Legacy Python publication keeps its existing protocol.

## Sticky fulfillment and incidents

Fulfilled orders permanently retain name/recipient ownership, price reserve
and first delivery history. Cancellation and reentry refuse. Post-issuance
deficit and excess-refund accounting still apply. Until fulfillment is
acknowledged, buyer status must not claim the final sale.

Certificate checkpoint, commitment or coverage loss withholds bytes, but
never returns a fulfilled order to issuing. It opens a durable incident and
alerts once per new reason; reads do not repeat the alert. New verification
can restore the certificate without downgrading fulfillment or rewriting its
receipt. It does not close the incident. Incidents can open before
supersession; supersession remains a separate unported protocol.

Resolution is a journaled operator note, limited to 2,000 characters. Exact
retries are idempotent; changing an existing resolution refuses. Resolution
changes no sale state, reservation, refund or certificate validity. Buyer
closure waits for acknowledgment and exposes only open/reasons/resolution.
Operator views retain identifiers and delivery history. A later loss after
resolution opens another episode. An invalid fulfilled certificate without
incident history is invalid stored state, not a silent recovery outcome.

## HTTP contract

Authenticated `POST /operator/deliveries/lookup` accepts exactly entry, root,
oids, delegate and oid. Its exact reply is oid, entry, revision, nullable
certificateHash, boolean fulfilled and acknowledged. The acknowledgment
concerns the current certificate's bound records, not cache presence or
mere historical fulfillment.

`POST /operator/fulfillments` adds revision, certificateHash, relayRoot,
relayHeight and proofHash. Its exact reply is oid, entry, fulfilled: true
and boolean acknowledged. Publication and relay verification remain the
publisher's responsibility. A privileged direct callback is not independent
proof of relay delivery. Raw relay messages are not journaled here.

`POST /operator/incidents/resolve` accepts exactly integer incident and a
nonempty resolution. Its receipt has incident, resolution and boolean
acknowledged. Bodies retain the 65,536-byte limit. Duplicate, escaped,
unknown and malformed field names refuse. The explicit TypeScript client
never falls back to anonymous fulfillment.

## Evidence and remaining work

The independent model imports no production code. Shipped publisher/client
and real store tests use recording subs/relay/spaced RPCs and a recording
verifier: these prove ordering/recovery, not real relay or cryptographic
verification. Core regtest separately checks sticky fulfillment and
checkpoint loss with actual chain ancestry and mock Spaces/relay metadata.
A full TypeScript sale through the real Spaces stack, relay and libveritas
remains a gate, alongside supersession and whole-application recovery.
Nothing here authorizes deployment or opening sales.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O46 | current verified certificate and trusted delivery | fulfill, repeat another valid proof and restart | sticky fulfilled order, immutable first receipt, reserve retained and cancellation refused |
| O47 | absent readiness or changed certificate/binding/revision/root | request fulfillment | refuse without changing the sale |
| O48 | fulfilled order | lose checkpoint, read repeatedly, restart and reverify | certificate withheld, sale/reserve/history stay, one incident alert, verification does not resolve it |
| O49 | recovery incident | resolve during journal outage, retry or replace note | acknowledgment gates closure, exact retry safe, conflict refuses, accounting and certificate unchanged |
| O50 | locally committed unacknowledged fulfillment | inspect and recover | final buyer status withheld; acknowledgment recovers one fulfillment |
| O51 | delivery/incident HTTP | authenticate and send duplicate/escaped/unknown fields | exact grammar and roles; buyer incident view omits internal identifiers |
| O52 | corrupt delivery/incident or missing incident for invalid fulfilled certificate | open application | refuse, retain evidence and release ownership |
| O53 | shipped publisher/client and real store | lose reply before/after forwarding or exit after store/local completion | fresh retry finishes with one original send and one already-recorded publication call |
| O54 | temporary publication, immature root, invalid verifier or changing chain | publish/confirm | no fulfillment; pending roots wait; original send never repeated |
| A40 | unpublished then published member | confirm delivery | no lookup/callback before publication; bound intent journaled before fulfillment |
| A41 | controller journal or store acknowledgment unavailable | confirm and retry | no callback during journal outage, no local completion before store acknowledgment |
| A42 | malformed status/completion reply | decode | strict binding/types, no anonymous fallback |
| A43 | empty/duplicate/foreign chunk or changed tip | publish | no external publication for invalid/stale input |
