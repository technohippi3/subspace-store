# Confirmed delegate-conflict supersession

This extends `ENTRY-RELEASE.md`, `COMMITMENT-TRACKING.md` and
`FULFILLMENT.md` for the TypeScript store and shipped Python controller.
The independent deterministic oracle is `ts/model/supersession.ts`.
Python's frozen store baseline is unchanged. Missing transactions, elapsed
time, a mempool disappearance or a reorg alone never unlock an attempted
batch. This protocol observes an already-settled conflicting transaction;
it does not construct, sign or broadcast a rollback transaction.

## Explicit proof and trust boundary

An operator selects a different transaction that spends the original
batch's exact delegate input. The original transaction ID and archived
signed bytes must be known. Both transactions must decode to their stated
identities, and the original must carry the bound root in an OP_RETURN.
The conflicting transaction must be in the active chain at six or more
confirmations. Core and spaced must agree on a stable tip, and spaced must
return absence for the original root. RPC errors, malformed facts, a root
still present or unknown signed bytes retain the locks.

The controller journals its decision before calling the store. The store
independently checks both transactions, the exact delegate conflict, the
active block and depth against Core, bracketed by its current snapshot tip.
It also requires the exact armed entry/root/members/delegate and a current
original commitment observation with no mined original. The controller
requires that observation's live acknowledgment before submitting proof.
Spaces root exclusion remains an attestation by the authenticated controller;
the store does not independently query spaced or prove a Spaces rollback.
An operator credential therefore crosses this trust boundary.

The proof records the original signed bytes locally, conflict identity,
block height/hash, verification tip and commitment-observation revision.
Its identity is immutable per entry/revision. Public receipts omit signed
bytes. Store acknowledgment requires the current complete journal prefix,
not a historical row alone. Controller completion waits for that live
acknowledgment. A lost reply recovers the same proof, without another send.

## Release, reversal and history

With an active proof, invalidate certificates for the old entry and return
its undelivered issuing/ready orders to converted. Their price claim and
payment/refund history remain. A fulfilled order stays fulfilled, retaining
its first receipt and price reserve, and opens a recovery incident. Pending
selection no longer contains the superseded entry's members. Issuance arms
remain one-use; an arm for the same delegate cannot bypass a live older arm.

Before subsequent issuance, cancellation, chain observations and startup, check every
active proof's saved checkpoint against Core. Missing ancestry or lost depth
revokes it permanently. Unknown RPC outcomes refuse progress rather than
asserting reversal or safety. A converted order belonging only to the old
entry relocks to issuing. Cancellation, refunds, fulfillment and entry into
another batch are never undone; they instead receive durable recovery
incidents. Overlapping live entries refuse arming, verification and delivery.
This check follows the handle across order IDs: cancelling an old order and
selling through another checkout cannot evade a revived issuance lock.
Closing an unsent successor cannot unlock the revived original.

Reconsidering the old checkpoint does not reactivate a revoked proof. A
retry returns its current inactive receipt. Unambiguous original members
may recover by a fresh original commitment observation and certificate, or
by a newer observation and a new explicit supersession decision. Proof
history is appended, not replaced. The attended controller refuses further
progress if cancellation or overlapping entries need manual recovery.
Certificates verified for a new entry use that entry's own revision;
invalidation barriers from an old entry do not contaminate it. First
fulfillment remains immutable even if an older supersession later reverses.

## Operator interface

Authenticated `POST /operator/supersessions/lookup` accepts exactly entry,
root, oids and delegate. `POST /operator/supersessions` adds revision, txid,
originalRaw, conflictTxid, blockHash, height, tipHeight, tipHash, rootAbsent
(literal true) and confirm (the entry ID). The archived transaction body is
bounded to 1 MiB, including at most 400,000 transaction bytes. Duplicate,
escaped or unknown fields refuse. Other operator bodies retain their
smaller existing limits. Buyer and subs listeners expose no such route.

Receipts contain exactly entry, nullable proof, boolean conflicted and
acknowledged. The proof contains version, entry, revision, txid,
conflictTxid, blockHash, height, tipHeight, tipHash and active. The explicit
TypeScript runner client validates every field, identity and numeric bound
and never falls back to an anonymous transition. Invoke the attended command
only after inspecting the already-confirmed conflict:

```text
python3 -m runner <config> supersede <batch> --conflict-txid <txid> --confirm <batch>
```

`watch` consults live supersession history before original commitment
observations; rebroadcast refuses active supersession or conflicting
recovery. Reads and startup do not send. The owner decision is about the
selected conflict, not authorization to generate one.

## Qualification and limits

Model cases cover release, irreversible history, reversal and explicit
reaffirmation independently of production reducers. Store/controller tests
use recording Core/spaced/subs adapters, real SQLite/journals and HTTP.
Separate isolated Core 31.2 qualification uses real signed competing
transactions, six confirmations, checkpoint loss and restart; its Spaces
root-exclusion fact is a fixture attestation. The full-stack normal sale
and refund qualification does not exercise an actual Spaces supersession.

Unknown original transactions/bytes, alternative protocol rollback or newer
commitment supersession, Spaces tree repair, conflicting-history resolution
and whole-application/host restore remain separate work. This is not the
complete supersession or recovery gate. No deployment or opening of sales
is authorized here.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O67 | owner-selected settled conflict and excluded original root | accept exact proof | release only undelivered orders; retain fulfillment/reserves, invalidate old certificates; missing prerequisites refuse |
| O68 | active supersession | lose checkpoint with paid, cancelled or rebatching members and restart | revoke; relock unambiguous paid orders, preserve other history and open incidents; no overlapping arm or unlock via successor close |
| O69 | unavailable journal or proof RPC | accept, retry or start application | no acknowledged completion without live prefix; unknown RPC changes nothing; missing verifier refuses startup |
| O70 | revoked proof | retry old proof, substitute its conflict or reverify original | no reactivation or changed identity; fresh original verification may restore readiness |
| O71 | corrupt supersession relationships | start application | refuse and preserve authoritative evidence |
| O72 | supersession HTTP | wrong role, duplicate/escaped/unknown/oversized fields or lost reply | exact bounded authenticated contract; retry same proof; signed bytes never returned |
| O73 | rebatched order with old certificate invalidation | verify and fulfill new entry, then reverse old supersession | new revision independent; first receipt unchanged, bytes withheld on chain loss and recovery incident retained |
| O74 | Core proof verifier | wrong original identity/root/input, wrong conflict, lost depth/checkpoint or unavailable RPC | independently verify exact transactions and ancestry without signing; failure or unknown never releases |
| O75 | revoked proof and unambiguous original members | fresh observation and explicit safe decision | append newer proof history and release; no automatic reactivation |
| O76 | shipped controller/client and real HTTP store | lose proof replies, exit after store commit, retry and reverse with cancellation | adopt one proof, retain one original send; relock paid member and preserve cancellation with one reversal alert |
| O77 | cancelled superseded order and a later checkout for the same handle | reverse proof before or after later entry is armed | preserve both histories but block issuance/verification by handle across order IDs |
| A47 | attended controller | omit confirmation or provide immature/wrong-input/inactive/root-present conflict | refuse; exact confirmed conflict journals and completes without creating a transaction |
| A48 | decision journal outage or lost store callback reply | acknowledge and retry | no callback during journal outage or local completion before store acknowledgment; retry adopts same proof |
| A49 | supersession reversal | watch repeatedly or attempt conflicted rebroadcast | journal reversal and alert once; conflicts require manual recovery; no send |
| A50 | malformed or unbound proof receipt | decode through explicit client | strict fields, identities and numeric types; no anonymous transition |
