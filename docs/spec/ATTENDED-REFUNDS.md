# Attended TypeScript refunds over HTTP

This connects the existing refund policy, reservation, signing and sender
components to the TypeScript operator API and shipped attended runner.
It changes no fee, credit, settlement or cancellation rule. The independent
pilot model and refund-family model remain the governing economic checks.
The Python store keeps its frozen baseline protocol. Runtime polling never
signs, retries or broadcasts refunds. Paid sales remain closed.

## Preparation and inspection

Authenticated `POST /operator/orders/<oid>/refunds` accepts exactly kind
(cancellation or excess) and cause (buyer or merchant). Cancellation still
requires the checkout to be cancelled or refund due; K21 keeps ongoing
partial checkouts cancel-first. Settled credit, a refund destination,
configured fees and the existing merchant-funding guards still apply.
A merchant-caused refund returns the full refundable principal, with fees
funded by the merchant. The operator must identify the cause explicitly.
This command does not cancel an order or infer who caused it.

Before allocating a group, inspect the order's nonvoid, unsettled groups.
One outstanding group of the same kind and cause is resumed, including a
reserved group whose signing was interrupted. A different kind/cause or
multiple outstanding groups refuses and directs inspection first. New
late credit does not make a retry allocate another outstanding group. After
all earlier groups settle, newly refundable credit can fund another group.
This is a conservative attended-command boundary; lower-level group and
family APIs retain their existing behavior.

Reservation must be durably acknowledged before signing. A lost HTTP reply
or signer failure retains that reservation; retry recovers the same group.
Built bytes survive restart and preparation retries. Receipt fields show
whether the group is reserved, built and acknowledged. A pending receipt
does not authorize sending. No signed bytes or funding proofs leave these
routes. `GET /operator/refunds/<gid>` refreshes and returns the current
bounded receipt without signing or sending. A node failure refuses the
read rather than presenting stale settlement evidence.

## Concrete broadcast confirmation

Authenticated `POST /operator/refunds/<gid>/broadcast` requires exactly
txid (64 lowercase hex characters) and confirm (the exact group ID in the
path). A bare group, nullable transaction, duplicate/escaped/unknown field
or wrong confirmation refuses before observation or sending. Buyer and
subs listeners expose none of these routes.

Under the store's serialized queue, refresh chain and refund facts, then
require that transaction to be the currently selected member: the settled
winner if one exists, otherwise the preferred built member. Check this
before returning a settled result too. A changed preferred transaction
requires fresh inspection and confirmation. Never silently substitute a
fee bump for reviewed bytes. Existing send-intent journaling, live journal
permission immediately before Core, funding/exclusivity guards and signed
byte validation remain in force. Journal loss sends nothing. Unknown send
outcomes retain intent, reservation and the same transaction. Reads and
startup never retry them. An explicitly confirmed retry observes a member
already in the mempool or chain without another send; an absent previously
attempted member can be retried only through the existing guarded sender.

## Receipt and runner contract

Every route returns exactly gid, oid, kind, cause, phase, acknowledged,
txid, refund_address, charged_sats, maximum_charge_sats, to_buyer_sats,
fee_sats, buyer_fee_sats, merchant_fee_sats, status, confirmations,
intent_acknowledged, broadcast_intents and broadcast_result. HTTP 200 means
the command returned this receipt; inspect its phase and acknowledgment.
Group and send-intent acknowledgment are separate. The selected charge is
the amount that member pays; maximum_charge_sats is the historical family
reservation maximum. They can differ when an older member wins. Before
signing, transaction/fee/output fields are null. Money is whole sats.

The explicit TypeScript client checks exact fields, identities, types and
fee/charge conservation, including rejection of booleans as money. It never
falls back to the Python protocol. The attended commands are:

```text
python3 -m runner <config> refund <oid> --cause buyer
python3 -m runner <config> refund <oid> --kind excess --cause buyer
python3 -m runner <config> refund <oid> --cause merchant
python3 -m runner <config> refund-status <gid>
python3 -m runner <config> broadcast-refund <gid> --txid <reviewed-txid> --confirm <gid>
```

Preparation defaults to cancellation but TypeScript always requires cause.
Review destination, amount, fees, group and transaction before the separate
broadcast command. The runner requires both the group confirmation and
explicit transaction, re-reads its receipt and refuses changed or
unacknowledged bytes. The server repeats the exact-member guard atomically.
The client verifies that the returned transaction and economic fields match
its reviewed receipt; a response mismatch is an uncertain outcome to inspect,
not a reason to build another refund. Python's earlier command behavior stays
unchanged; the new options/inspection require TypeScript. Operator
cancellation, fee-bump/rebuild CLI commands and whole-host recovery remain
separate work. Buyer cancellation already uses the opaque checkout link.

## Qualification

Production HTTP/runner tests use real SQLite, journals and listeners with
recording wallet adapters. They cover lost replies, restart, journal loss,
stale confirmations and strict client receipts. These are not real Bitcoin
transactions. Isolated Core qualification separately drives the standalone
process through real signing, capped buyer fees plus merchant remainder,
explicit send, retry, settlement and restart. The full Spaces-stack harness
also includes a buyer cancellation and attended runner refund into its
fresh buyer wallet. `regtest/REPORT.md` records actual run results. Neither
scenario establishes buyer-client import or whole-host restore.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O61 | interrupted preparation and later extra credit | retry | same outstanding group and signed bytes; one reservation; changed cause refuses |
| O62 | wrong role or malformed/oversized refund body | request | refuse before observation/signing; buyer/subs expose no financial route |
| O63 | missing/wrong group confirmation, nullable transaction or a newer preferred member | broadcast | exact body and current-member check; stale bytes never replaced silently |
| O64 | journal outage or lost send reply | prepare, send, restart, inspect and retry | signing/send gates hold; one signed refund retained; reads never send; known mempool retry makes no second send |
| O65 | a larger family maximum but an older settled winner | inspect | actual winning charge and historic maximum reported separately; fee/charge conservation holds |
| O66 | shipped runner/client and real HTTP store | lose preparation and broadcast replies, then retry with explicit cause/transaction | one build and send, same group and transaction, no anonymous fallback |
| A44 | TypeScript runner | omit cause, transaction or group confirmation | refuse without store mutation; correct explicit choices reach the bound API |
| A45 | malformed refund receipts | decode | reject unknown fields, wrong identities, boolean money and invalid accounting; pending receipts remain pending |
| A46 | stale, unacknowledged or malformed current receipt or changed response | broadcast through client | no send before a valid current receipt; changed responses require inspection; no legacy fallback |
