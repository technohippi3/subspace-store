# Commitment observations for the TypeScript store

This extends `ENTRY-RELEASE.md`. The controller still verifies the chain,
delegate and Spaces root; the store records trusted controller observations.
It does not verify a Spaces commitment by accepting a report. No new signing
or send path is introduced. The Python store's payment baseline is unchanged.

## Binding, ordering and evidence

Only an armed entry can receive observations. Its exact entry ID, root,
member IDs and delegate must match. Its transaction ID becomes immutable on
the first observation. Replacement/supersession needs a separate protocol;
changing the transaction ID through this callback refuses.

An observation contains the transaction ID, Core tip hash and height, mined
height or null, matching active-chain root height or null, and newest root
anchor height or null. The controller samples Core and spaced before and
after those reads and retries a changing or mismatched tip. Root height is
reported only when spaced returns the exact root at the transaction's mined
height. The store independently refreshes its payment snapshot and requires
the report's tip hash and height to match. Impossible heights refuse.

The report's phase is derived: no mined height means `broadcast`; a mined
transaction means `mined`; only depth `tipHeight - minedHeight >= 150` with
the matching root height means `final`. Depth is zero in the mining block.
Anchor coverage is separate and requires finality plus an anchor at least
144 blocks after the mined height. Losing root visibility removes finality
even if the transaction retains depth. Neither phase `final` nor coverage
is a certificate verification or a delivery acknowledgment.
`broadcast` includes an absent or unconfirmed transaction; it does not prove
mempool presence, supersession or permission to unlock an order.

Each entry starts at revision zero with no observation. A report specifies
`expectedRevision`; acceptance increments that revision atomically with its
facts. Exact retries return the same revision while the tip still matches.
Changed facts at an old revision refuse. Concurrent reports cannot both
replace the same revision. A delayed final report cannot overwrite a newer
reorg report, even when the old final tip becomes active again later.
Reordered member IDs and observation fields are canonicalized.

Receipts require live journal confirmation of the immutable entry, its arm
and the exact observation record. Missing history, unconfirmed local history
and acknowledged history remain distinct. A lookup reports durable history;
it is not a fresh chain check. A journal outage withholds acknowledgment.
An unconfirmed write retains its revision locally; an outage at startup
withholds readiness, and recovery preserves that same history. These
records do not prove whole-host recovery.

## Controller and HTTP contract

The controller reads the store's current revision before collecting fresh
chain facts. It confirms the exact report intent in its own journal before
posting to the store. Controller progress waits for the store's live
acknowledgment. A lost reply or process exit resumes with the current store
revision and new chain evidence; it never repeats a commitment send. Losing
finality updates the controller state and its alert in one local transaction.
The legacy Python watch path remains unchanged.

Authenticated `POST /operator/commitments/lookup` accepts exactly the armed
binding fields `entry`, `root`, `oids` and `delegate`. `POST
/operator/commitments` adds `expectedRevision` and an `observation` object
with exactly `txid`, `tipHeight`, `tipHash`, `minedHeight`, `rootHeight` and
`anchorHeight`. Hashes are lowercase hex. Heights and revisions are safe
nonnegative integers; only the three optional heights accept null. Duplicate,
escaped, unknown or malformed fields refuse. No fallback protocol is used.

Replies contain exactly the four binding fields, `revision`, `observation`
and boolean `acknowledged`. Observation is null at revision zero; otherwise
it includes the six recorded fields plus derived `phase`, `depth` and
`covered`. The Python client checks those derivations and the exact report
acknowledgment. A lookup also checks the controller's transaction identity.

## Scope and remaining work

Without a certificate callback, order state stays `issuing` through these reports. Payment loss still
records a post-issuance deficit and never unlocks a name, frees its price
reservation or permits cancellation. `CERTIFICATES.md` now adds bound
readiness, reconstructible bytes, buyer download and invalidation. The
TypeScript controller requires a successful verification callback before
reporting certificates verified. Covered finality alone says
`awaiting_certificate_verification`. Verified relay fulfillment, supersession and
whole-application recovery remain unported. Sales remain closed.

The independent deterministic model checks revision ordering, depth,
coverage and snapshot continuity without production imports. Controller
HTTP tests use recording Core/spaced/subs stand-ins, not a real Spaces
commitment. The separate Core qualification uses a real newly mined regtest
transaction and reorg, with mock Spaces root and anchor facts. These scopes
must be reported separately.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O28 | an armed entry and a coherent store tip | report wrong binding, foreign tip, missing arm or changed transaction | refuse without replacing history; exact binding and tip accepted |
| O29 | mined transaction, root and anchor facts | cross depth 150 and anchor gap 144, lose root or mining | derive finality and coverage separately; order stays issuing with price reserve |
| O30 | a prior report revision | repeat exactly, race changed reports or replay an older final report after reorg | exact retry idempotent, one replacement per revision, stale overwrite refused across restore |
| O31 | an observation locally committed during journal outage | inspect, restart, recover journal and lose payment | acknowledgment withheld, startup blocked during outage, revision survives, post-issuance loss does not unlock |
| O32 | operator commitment HTTP routes | send wrong credential, duplicate/escaped/unknown fields or valid report and lookup | authentication and exact grammar enforced; only valid report commits |
| O33 | invalid commitment version, revision, height or absent arm | open application | refuse and preserve evidence while releasing process ownership |
| O34 | actual controller/client and recording chain RPCs | watch mining, finality, root loss and reorgs | same bound entry and transaction, fresh reports, one alert per loss, no additional send or order unlock |
| O35 | an observation request | drop reply before/after forwarding or exit after store commit | next watch reconciles revision and fresh facts, one original send |
| A33 | controller or store acknowledgment unavailable | watch and recover repeatedly, then request certificates without finality | no report without controller journal, no controller progress without store acknowledgment, fresh retries, no certificate without finality |
| A34 | Core/spaced observations | change tip mid-read or return a root at another height | retry coherent snapshot up to three times; wrong root height never establishes finality |
| A35 | a malformed or inconsistent commitment receipt | validate report acknowledgment | reject changed binding/revision, malformed hashes/heights and inconsistent phase/depth/coverage |
