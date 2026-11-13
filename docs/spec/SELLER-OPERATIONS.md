# Essential TypeScript seller operations

The seller command uses the installed runtime configuration and injected
operator credential files. It neither initializes wallets nor installs,
unlocks, funds or resets one. First and later spaces use the same operation.
The installer establishes the node, existing wallet references, stable data
paths and credential injection first. Individual listing, price, reservation
and pause edits then go through the running store without reinstalling.

The pilot catalog is explicitly listed. A space has a canonical label, a
durable pause flag and catalog mode `listed`. Every listing retains its exact
full handle, explicit space and integer price. Seller reservation, withdrawal,
buyer holds and fulfillment reservations are separate. Listing records are
never removed by withdrawal because old orders must keep their relationship
and historical invoices remain payable.

Seller reservation blocks new invoices and unheld acquisition, including
pay-first invoices that have not acquired a hold. It never
revokes an active buyer hold or fulfillment reservation. Unreserve reverses
the seller policy; an order already made refund due stays refund-only.
Withdrawal blocks new invoices and records an immutable restriction for each
existing invoiced, unconverted checkout. A current held invoice retains its
grant and mempool extension. Once that protected grant ends, it can never
acquire the name again. An existing pay-first invoice may acquire during its
original 900-second quote window. At exact expiry it becomes refund-only;
partial money supplies no hold or extension. If it acquired a hold in time,
that grant and subsequent conversion remain protected. Reopening clears only
the current seller policy and never removes an invoice restriction. Confirmed
money on a restricted invoice becomes refund due under the existing refund
rules. Withdraw/reopen before expiry does not bypass this restriction.

Converted, issuing, ready and fulfilled orders keep their ownership. Seller
policy changes do not change addresses, quoted prices, financial history,
certificates, issuance bindings, refunds or identifiers. Existing initial
quotes retain their price; ordinary late-payment pricing still follows P12
and K7. The exposure formula remains the smaller of the risk budget and ten
times the highest configured listed price across the installation, including
retained reserved/withdrawn listings. It is not calculated per space.

Global and per-space pauses block new invoices. They do not cancel existing
invoices or prevent payment observation, conversion, issuance or refunds.
The hold ration is per full handle; the active-hold cap, exposure and
ten-conversion review count are global. Journal restore forces global pause
and preserves per-space and seller flags, invoice restrictions, request
counters and the monotonic conversion count.

## Admission and persistent records

`seller_settings/global` has version 1, seller policy revision, an explicit
configuration marker, admission limits and the current request window.
Limits are positive integers: windowSeconds, maximumRequests and maximumOrders.
The window is fixed from its recorded start and rolls to the current request
time on the first admitted request at or after its end. Every admitted
request consumes one slot; malformed/refused requests consume no slot or order
identifier. The retained-order ceiling counts all orders and never deletes
history to admit a new one. Changing limits does not reset the count or window.
Refusal is HTTP 429 and allocates no invoice address.

Unsigned requests are nominations, not identities. Limits are installation
wide, independent of scripts, handles, bearer tokens, accounts or untrusted
forwarded IP headers. Two admitted identical nominations still receive fresh
opaque links, and earlier links remain valid. Requests continue to claim no
script. These limits bound creation separately from holds; neither constitutes
a guarantee that an anonymous caller cannot exhaust the shared allowance.

Historical regtest fixtures receive development values of 120 requests per
3,600 seconds and 10,000 retained orders, marked `configured: false`. These
are not funded installation defaults. The installed operator must set explicit
limits through the admitted command before production admission readiness.
Pause/resume alone never sets this marker. The production package must refuse
readiness with development limits; network qualification remains separate.

Additional version-1 records are `space_policy/<space>` with paused/catalog,
`name_policy/<handle>` with reserved/withdrawn, `invoice_withdrawal/<oid>` with
its immutable recorded time and `owner_authorization/<oid>` below. Old valid
TypeScript records receive derived space policies and development settings on
normalization through the existing journal. Duplicate identities, unknown
versions/fields, mismatched keys or orphan relationships refuse. No financial
record is rewritten to perform this normalization.

## Operator protocol and review

Authenticated `POST /operator/seller/preview` accepts one flat command:

```text
{action:"space",space}
{action:"listing",handle,price_sats}
{action:"reservation",handle,reserved}
{action:"withdrawal",handle,withdrawn}
{action:"pause",paused,space?}
{action:"admission",window_seconds,maximum_requests,maximum_orders}
```

`POST /operator/seller/apply` accepts those exact fields plus `review`, the
preview's material SHA-256 digest. Both refresh current payment/hold facts
under the store queue. Preview lists affected orders, prices, active grants,
payment detection, fulfillment reservations, withdrawal restrictions and
issuance entries. The digest covers the command, seller revision and relevant
commitments and exposure. It excludes irrelevant polling clock/tip changes;
new holds, expiry, payment/ownership changes and policy changes require a new
preview. Canonical object ordering prevents JSON member order from changing
the digest. Apply returns HTTP 200 only after journal acknowledgment; a local
pending mutation returns 503 and can be re-previewed and acknowledged.

Unknown, repeated, escaped or malformed command fields refuse before
observation or mutation. Buyer and subs listeners expose none of these routes.
Existing narrow listing/global-pause routes remain for the shipped regtest
runner and use the same retained state and policy revision. They do not become
alternate wallet or installation configuration paths.

## Funded owner invoice

Authenticated `POST /operator/owner-orders/preview` accepts exactly handle and
script_pubkey. `POST /operator/owner-orders` accepts those fields plus operation,
confirm and review. The operation is a caller-created 32-character base64url
identifier. Confirm equals the exact full handle; review binds the exact
nomination and current material preview. The durable owner authorization binds
operation, order, handle, recipient, listed price, review and authorization time.

Only that exact order may bypass seller reservation. Global/per-space pause,
withdrawal, another buyer's active hold, fulfillment/issued ownership, script
conflicts, exposure, recovery quarantine, issuance ownership and live journal
guards all remain. The order uses the same listed price and a distinct normal
payment destination. The operator funds it through a separately authorized
external wallet action. The store performs no funding send, invented credit,
complimentary conversion or batch-entry bypass. Three-confirmation conversion,
normal late-payment/cancellation/refund rules and certificate/delivery gates
still apply. The seller reservation remains set.

Exact operation retries are looked up before fresh-preview checks and recover
the same order; changed nomination/review refuses. A previously authorized
requested order may finish its interrupted invoice preparation on an attended
retry. A fresh acknowledged response alone can include `/o/<opaque-token>`.
Retries return only created=false, order ID and persisted status, never the
earlier bearer, link or destination. Lost-reply recovery uses authenticated
order inspection rather than disclosure of someone else's bearer link.

The CLI reserves a new mode-0600 operation file with exclusive creation before
submitting. It writes the exact request there for lost-reply recovery and saves
any fresh link only in that file. Standard output never includes the bearer.
`owner retry` submits the saved exact request and writes a new private receipt
file; it never overwrites the original file or asks the server to reveal an old
link. Existing files, malformed nominations or mismatched confirmations refuse.

## Commands and diagnostics

Run commands with the existing installed runtime configuration. Omitting
`--apply` previews a change; including it submits that exact preview.

```text
node ts/src/seller.ts <config> space add <space> --apply
node ts/src/seller.ts <config> name list <handle> <price-sats> --apply
node ts/src/seller.ts <config> name price <handle> <price-sats> --apply
node ts/src/seller.ts <config> name reserve|unreserve|withdraw|reopen <handle> --apply
node ts/src/seller.ts <config> space pause|resume <space> --apply
node ts/src/seller.ts <config> pause|resume --apply
node ts/src/seller.ts <config> admission set <window-seconds> <maximum-requests> <maximum-orders> --apply
node ts/src/seller.ts <config> owner invoice <request.json> --operation <id> --confirm <handle> --save-link <private-path> --apply
node ts/src/seller.ts <config> owner retry <operation-record> --save-link <new-private-path> --apply
node ts/src/seller.ts <config> status
node ts/src/seller.ts <config> diagnose
```

Status includes explicit-limit readiness, global/per-space policy, admission
counters, holds, exposure, monotonic review count and uncertain refund sends.
The existing status retains live chain facts, journal acknowledgment, refund
deadlines, incidents and application recovery state. Diagnose identifies
missing readiness and points to documented offline recovery. Neither command
signs, retries refunds or clears recovery flags. A setup wizard is optional;
these validated commands are the only policy configuration path it may use.

These are independent model and production component results. They do not
establish funded sales, a deployed package, wallet actions or client acceptance.
