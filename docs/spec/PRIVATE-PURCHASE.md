# Private attended purchase

This specification covers local implementation of the owner-only test
planned in `docs/PRIVATE-PURCHASE.md`. It does not adopt the public pilot
policies or authorize deployment, wallet actions or mainnet transactions.
Those still require the separate concrete transaction plan.

## Configuration

Regtest remains the default supported test network. Mainnet additionally
requires a `private_attended_test` object in both service and runner
configuration. Its fields are `handle`, `script_pubkey`, `price_sats`
(exactly 1000), `max_fee_rate_sat_vb` and `refund_fee_rate_sat_vb`.
Rates are positive integer sat/vB; the refund rate cannot exceed the ceiling.
The service listens on a loopback IP. The runner's store, spaced and subs
URLs use loopback IPs inside the clean VM. Core may be a separately
authenticated node; the relay is external. The VM's isolation is an
operational precondition, not something these configuration checks prove.

The configured network is checked against the live components. Core and
the store report `main`, spaced and subs' spaced report `mainnet`. The
controller's and store's nodes need a synced transaction index and must
have finished initial block download. The payment wallet must be loaded,
able to sign and not rescanning. The runner also checks that the store has
the same private-test configuration and that the chain hashes agree.

## One order

The immutable admission tuple is network, handle, recipient script and price.
Enabling it requires an empty order history. Each request must match it.
Listing or repricing the configured name at a different price is refused,
so late-payment reacquisition cannot change the fixed test price.
The first successful quote consumes the allowance for that order id in
the same SQLite transaction that records the invoice. A single journal
entry acknowledges both; the address stays hidden until acknowledgment.
Other orders never acquire an invoice, including duplicate requests made
before the first quote. Requests made afterwards are refused and must use
the original private order link.

Repeating that order's quote returns its existing invoice without taking
a new hold or asking the wallet for another address. Expiry, cancellation,
reorgs and restart do not release the allowance. Payment and late-payment
evaluation keep their existing rules. A journal-only restore preserves
every acknowledged consumption. An unacknowledged invoice was never
shown, so losing it before acknowledgment creates no second disclosed
invoice. Restoring an older database behind its journal is refused before
it can issue an invoice. Removing or changing the admission configuration
also refuses startup.

## Fees and sends

Private-test issuance requires an explicit rate at or below the configured
ceiling; the regtest default of 1 sat/vB does not apply. Resume and identical
byte rebroadcast check the batch's recorded rate against the current
ceiling too. Unknown commitment outcomes retain the existing no-repeat
rule. The allowance does not weaken either journal acknowledgment gate.

Refunds use the configured explicit refund rate. The signed transaction is
decoded to measure virtual size, rebuilt if necessary, and its actual fee
is checked against the ceiling before reservation and again before send.
The 1000-sat per-refund payout cap and existing minimum output rule apply.
A refund that cannot meet those limits is refused, not silently subsidized.
The private mode never rebroadcasts refunds automatically on startup: it
reports pending rebroadcasts for the attended runner.

## Cases

Y4 and Y5 compare allowance decisions with the independent reference model.
Y4 to Y6 also exercise real SQLite and journal recovery. Other Y cases are
service and runner tests over fake RPCs, not mainnet or regtest acceptance
evidence.

| ID | Setup | Action | Required result |
| --- | --- | --- | --- |
| Y1 | service or runner configuration | omit or malform the mainnet opt-in, recipient, price, rate or loopback boundary | refused before credentials, databases or RPC side effects |
| Y2 | private mainnet configuration | inspect components and node capabilities | require matching configuration, network and chain; synced index and signing wallet |
| Y3 | private issuance or resume | omit, malform or exceed the rate ceiling | no send; a valid explicit rate keeps the attended confirmation |
| Y4 | matching private requests | quote, expire, cancel, restart or restore | one order gets one invoice; no second invoice; same-order retries keep its address |
| Y5 | journal append fails after quote commit | retry or restart, then acknowledge | no address before acknowledgment; allowance and invoice acknowledged together |
| Y6 | durable allowance | alter configuration or reopen a database behind its journal | startup refused; journal restore retains the consumed allowance |
| Y7 | private refund | size and sign at the explicit rate, then broadcast | enforce measured fee ceiling and payout limits before reservation and send |
| Y8 | attempted refund unknown at startup | open the private service | report pending rebroadcast; do not send automatically |

## Repeating the local checks

The focused checks are `python3 -m unittest tests.test_private_purchase`.
The full Python suite, coverage gate and TypeScript replay remain required.
The standard service, checkout and recovery regtest scripts check the
unchanged ordinary mode. The private mode has two additional isolated
regtest scenarios in `regtest/harness/private_purchase.py`: `private_checkout`
and `private_refund`. Each requires its own fresh run id, the pinned
`subs-relay` binary, `SUBSPACE_RELAY=1` and `regtest/in-netns.sh`, exactly as
the checkout harness does. The checkout runs a real 1000-sat invoice to
certificate delivery with the allowance active. The refund builds and
settles a transaction at the explicit rate, measured from its signed bytes.
Neither scenario establishes mainnet or buyer-client acceptance.
