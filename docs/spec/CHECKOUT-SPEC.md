# TypeScript checkout application boundary

This increment connects real SQLite and the journal to buyer requests,
quotes, cancellation and a loopback JSON HTTP API. Chain observations and
wallet address allocation are injected Effect adapters. A 200-step seeded
trace compares the supported sales behavior with the independent model,
in addition to fixed expected cases. The production
tests exercise real persistence and HTTP with a simulated adapter; they are
not regtest, buyer acceptance or a deployment result.

## Commands and persistence

One Effect semaphore serializes application commands, including chain and
wallet calls. RPCs run outside SQLite write transactions. Interruption
releases the permit and never commits a partially constructed invoice.
Each command reads fresh records, validates a separate working copy and
atomically commits changed records. Application version 1 has explicit
settings, listings, orders and payment records; unknown kinds, fields,
inconsistent identities and unsupported settings fail startup.

An operator-supplied risk budget is required. Admission retains the agreed
formula, the smaller of the budget and ten times the highest listed price.
Initial sales are paused. The programmatic listing/pause operations are
building blocks for the later authenticated operator API and CLI; they are
not a completed setup interface. Explicit full handles retain their space
identity. Multi-space seller acceptance remains later work.

Public requests carry exactly two string fields, as V1–V7 require. The HTTP
parser retains duplicate-member rejection, including escaped duplicate
keys. Refusals store nothing and never echo the submitted data. The order
link contains 192 random bits. Only its SHA-256 digest is stored or
journaled. Order reads, quotes and cancellations use that link; a request
for the same recipient never reveals an older link. HTTP responses use
`no-store` and `no-referrer`; the component has no request logging.

The quote preflight confirms the journal before requesting a wallet address.
An outage before preflight takes neither an address nor a hold. An outage
after recording the quote leaves it pending and returns HTTP 503 without
an address. Retrying uses the recorded quote. Only the acknowledged order
version can disclose the address. A local cancellation returns HTTP 202
until acknowledged; its view retains the last acknowledged status and
labels cancellation unconfirmed. Recovery of the journal makes it final.
Historical payment destinations are retained across status changes.

The pilot admission/hold rules have a production implementation independent
of `ts/model/`. Current chain outputs have immutable outpoint contents,
explicit confirmations and a supplied tip. Missing outputs stop contributing
but remain in payment history. Duplicate outpoints, changed contents,
invalid amounts/depths and a backward clock refuse atomically. A real Core
adapter still needs to prove complete observations and reorg behavior.

Pay-first invoices carry an explicit warning and reserve no name. Full
confirmed payment qualifies; block height, quote time and immutable order
sequence resolve races. Late payment honors P12 and cannot reacquire with
partial money. A price increase returns even a fully paid original quote
to refund due; it does not demand the increased amount first. The hold
ration exempts only a grant that actually converted (K20).

`beginIssuance` serializes the status freeze with cancellation and checks
batchable money and recipient conflicts. It does not build, sign, broadcast
or expose a frozen registry batch. Controller reconciliation and the full
binding pre-broadcast check remain required.

## Remaining boundaries

The HTTP component currently serves `/requests`, private order reads,
`/quote`, `/cancel` and `/refund-destination`, on loopback only. `CORE-SPEC.md` describes the
separately qualified real Core payment adapter. There is no launcher, public
checkout page, authenticated operator/registry API or
certificate delivery. The application refuses restored storage
until controller/chain reconciliation is implemented. The generic storage
restore component is not full application recovery. Future restore must
retain ration and conversion history and start paused; existing model
cases remain required production work wherever full recovery is untested.

`REFUND-PREPARATION.md` now defines durable first-attempt reservations,
fee policy and explicit-input signing. `REFUND-SENDING.md` adds a
programmatic sender and first-attempt chain reconciliation. Admission now
subtracts settled refunds, restoring that charge on a reorg. Multiple
attempts and exclusive family rebuilds are now described in `REFUND-FAMILIES.md`.
K5's complete refund/resume scenario, K8/K9/K20's full
restore scenarios and K11/K12/K17's complete refund rules remain release requirements.
The pilot release gate remains blocked.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z10 | invalid application records or configuration | open the application | refuse foreign kinds/fields and inconsistent identities without serving; release ownership on failure |
| Z11 | a buyer order and a journal that fails before or after wallet allocation | quote through HTTP, retry, cancel a converted order twice during an outage, then restart with the journal available | no address before acknowledgment; no wallet call during a known outage; retry keeps the original address; cancellation stays unconfirmed with its prior status until acknowledged |
| Z12 | a quote waiting for its wallet adapter | try another SQLite write transaction, queue cancellation and interrupt the quote | no SQLite transaction is held across the wait; cancellation proceeds after interruption; no address or hold from the interrupted quote is committed |
