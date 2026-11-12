# TypeScript buyer checkout

This increment connects real SQLite and the journal to buyer requests,
quotes, cancellation and a loopback JSON HTTP API. Chain observations and
wallet address allocation are injected Effect adapters. A 200-step seeded
trace compares the supported sales behavior with the independent model,
in addition to fixed expected cases. The production
tests exercise real persistence and HTTP with a simulated adapter; they are
not regtest, buyer acceptance or a deployment result.

The same loopback listener now serves a complete browser workflow beside
the JSON API. It uses ordinary HTML forms without scripts, external assets,
accounts or cookies. The responsive pages show the catalog, public request,
private order, invoice, payment progress, cancellation, refund destination,
attended refund progress and certificate download. Every command goes
through the production application queue and validation used by JSON.

## Browser routes and privacy

`GET /` lists only canonical handles, fixed prices and current availability.
It evaluates current observations and expiry before projecting the public
catalog, never exposing order identifiers, recipients, links or addresses.
`GET /buy/<handle>` accepts the complete public recipient request as one
`request` form field. `POST` uses the exact JSON parser of `/requests`,
including escaped duplicate-member rejection, and requires the request's
handle to match the page. Invalid forms and refusals never echo input or
adapter exception text. A successful request redirects with HTTP 303 to
`/o/<token>`. Creation alone grants no hold.

`GET /o/<token>` refreshes the production order view before rendering.
`POST /o/<token>/invoice` requests its quote; an unacknowledged quote returns
503, with retry copy and no address. A successful retry redirects to the
same private order and retains the original destination. `POST` to
`/cancel` uses buyer cancellation, serialized against issuance, with HTTP
202 until journal acknowledgment and 303 when final. `/refund-address`
accepts exactly one `address` field and uses the production network/address
resolver and store-destination exclusions. It cannot change a built refund.
`GET /o/<token>/certificate` serves exactly the currently usable bytes under
the existing bound-certificate rules, or the same undetailed 404 as other
absent private resources. Readiness and finality loss withdraw both link
and download. Unknown or malformed tokens disclose no order detail.

All browser responses, including redirects, errors and downloads, carry
no-store, no-referrer, nosniff, and a CSP with no scripts, no framing, no
external resources and same-origin form actions. All inserted text is HTML
escaped; Bitcoin payment addresses are also URI-encoded. The listener has
no request logging. A reverse proxy must likewise avoid logging private
paths, request bodies or links. Its TLS/public-listening setup remains a
deployment requirement. Every form and JSON buyer body is bounded to
65,536 wire bytes, both declared and streamed. Form decoding rejects
duplicates, unexpected members, malformed percent escapes and invalid
UTF-8. Only authenticated certificate delivery has the separate larger
base64 envelope bound and 1 MiB decoded certificate bound.

## Invoice safety and pilot equivalents

`payment_request_open` is an additive production order-view fact evaluated
from refreshed state. It is true only for a quoted, never-detected invoice
inside its original quote window with an active ordinary hold or an
explicit pay-first invoice. Browser instructions additionally require the
acknowledged address and no pending cancellation. The pilot's pay-first
decision supersedes the baseline hold-only display condition: before an
address or BIP21 link it discloses that another buyer may win and the loser
pays the refund fee. The buyer fee ceiling and excess minimum are also
shown before the payment address. Pay-first still reserves no name.
`quoted_price_sats` retains the original invoice price separately from
`price_sats`, which can fall when a late payment qualifies after a price
drop. Invoice history displays the original amount requested.

Every detected, previously detected, unknown, cancelled, refund-due,
expired, converted or later invoice is history, with no amount-to-pay or
BIP21 link and a warning not to pay again. Current mempool amounts are
displayed as awaiting confirmation and as partial when appropriate. The
page changes no accounting or hold rule; its ordinary observation uses
the existing conversion and extension rules. A disappeared or replaced
payment may still confirm, including after expiry as a late payment.
Restored unknown history explains the outage and withholds the address,
as `APPLICATION-RESTORE.md` requires. Node/RPC failure returns a fixed 503
message that warns against sending another payment.

`PILOT-SPEC.md` maps all C1–C12 requirements to the pilot, including the
historical Python SQL migration portions of C12. TypeScript has always
required payment history in its strict application format; it neither
imports a Python database nor silently upgrades a pre-history format.
Unsupported older records refuse before serving or publishing a restored
database and preserve the journal, with no partial migration. Supported
journal recovery normalizes every non-detected invoice to unknown, keeps
durable detection sticky and leaves unquoted orders as none. Production
tests cover browser and JSON views after real journal-only replay and
the supported offline reconciliation protocol, including detection lost
during an outage and expiry after recovery.

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

## Remaining release boundaries

The HTTP component remains loopback only. `RUNTIME.md` defines the shipped
launcher and separate authenticated operator/registry interfaces;
`CORE-SPEC.md` qualifies the real Core payment adapter. `RECONCILIATION.md`
permits paused startup after supported journal recovery and controller/chain
reconciliation; `HOST-RECOVERY.md` covers a separate known-history host
replacement. Complete in-flight recovery remains a release requirement.
Browser C1–C12 tests use real SQLite, journals, HTTP and simulated adapters.
They are neither real-wallet browser qualification nor Nacho acceptance.
The existing real Spaces-stack sale/refund demonstrations use JSON; their
browser equivalent and the buyer gate with Nacho remain to demonstrate.

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
