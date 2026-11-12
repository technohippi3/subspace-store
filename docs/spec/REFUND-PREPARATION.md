# TypeScript refund preparation

This is a partial implementation of the existing refund rules, not a new
refund policy. `PAYMENT-SPEC.md` and K13–K17 in `PILOT-SPEC.md` govern amounts,
fee allocation and funding. The independent model predates this component.
This component prepares a group's first signed attempt. `REFUND-SENDING.md`
now adds sending and settlement/reorg reconciliation. `REFUND-FAMILIES.md`
adds fee bumps and exclusive rebuilds. Raw transaction export remains unbuilt.
Paid sales remain closed.

## Policy and destinations

Installation must explicitly configure minimum/maximum fee rates in sats
per 1,000 virtual bytes, a nullable fallback, confirmation target, buyer fee
ceiling, maximum transaction fee and maximum refund charge. These numbers
are test inputs in fixtures, not suggested deployment amounts. Settings are
journaled; silently changing them at startup refuses. An operator command
for journaled future policy updates remains to build.

Each quote snapshots the buyer ceiling in its order's refund account before
disclosing its payment address. The JSON view exposes that ceiling and the
546-over-estimated-fee excess minimum. Complete checkout fee estimation and
HTML disclosure remain acceptance requirements.

`POST /orders/<token>/refund-destination` accepts exactly one string member,
`address`. Core validates it on the configured network. It may be supplied
before a quote, is acknowledged through the journal and stays fixed once
any refund is built. Never infer a refund address from transaction inputs.
Every historical payment script, merchant fee-pool script and refund change
script is excluded. Payment allocation also skips refund/funding scripts.
The T3 operator alert for a skipped refund script remains to build; the
narrower allocation check is Z26 and does not claim full T3 coverage.

## Durable reservation and build

The operator-only programmatic preparation command runs in the same Effect
queue as quotes, observations, cancellation and issuance entry. There is no
unauthenticated operator route. Cancellation refunds require cancelled or
refund-due status. This incremental excess path accepts only converted or
issuing orders. Unconverted excess remains unsupported until outgoing-spend
accounting prevents an already-refunded partial payment from later converting.
The broader existing specification still requires that path before release.

Available credit is settled original receipts less the price reserve and
every non-void group's charge. A UUID group snapshots its cause, charge,
fee policy and estimated rate. The reservation commits to SQLite and the
journal before signing. An unavailable journal leaves a pending reservation
and makes no signing call. Retry uses the same group, refreshes chain credit
and proves the latest journal position is currently acknowledged. A failed
build leaves its reservation intact. Only an unbuilt reservation can be
explicitly discarded. Signed drafts discarded inside a failed build never
leave the wallet adapter; once built, a group cannot be released this way.

Core receives explicit settled, safe, spendable inputs. Order funding is
limited to its original outpoints and proven change from its earlier built
refunds. Merchant fee funding is limited to explicitly configured fee-pool
scripts and proven merchant change. No unrelated wallet coin or other
order's receipt is eligible. All earlier built inputs remain excluded.
The first implementation requires unspent order funding for its full
charge; it refuses rather than silently advancing merchant principal.

Order and merchant change are separate outputs with recorded provenance.
Coin selection refuses dust change rather than adding it to a buyer's fee.
Amounts sent to Core are decimal strings; returned money retains exact JSON
number text before conversion to integer sats. The builder signs and
measures virtual size, then recomputes the upward-rounded fee, bounded to
eight drafts. Buyer-caused fees stop at the disclosed ceiling; the merchant
funds the remainder. Merchant-caused refunds preserve full buyer principal.
Actual fee, output floor, excess minimum and explicit hot-wallet caps must
all pass. Decoded inputs, sequences, outputs and value conservation must
match the plan. `testmempoolaccept`, final unspent checks and unchanged
Core/wallet readiness guard the completed build. No RPC-wide atomic chain
snapshot is claimed; the future sender must reconcile again before sending.

The signed transaction, ID, complete input/output provenance and fee split
are committed and journaled. Responses expose summaries and acknowledgment
status, never raw transactions or intermediate drafts. A built group is
retained across restart, even if its latest journal acknowledgment is still
pending. Full application restore continues to refuse until recovery and
controller/chain reconciliation are implemented.

## Remaining refund work

`REFUND-SENDING.md` now adds journaled intent, live acknowledgment,
uncertain-result recovery and settlement/reorg accounting for the first
attempt. `REFUND-FAMILIES.md` extends it to all saved members and conservative
exclusive rebuilds. General operator alerts/losses and maintenance/full
recovery tests remain. Deadlines K11/K12 need an
obligation lifecycle that survives several excess and cancellation refunds;
a timestamp on this preparation group is not deadline implementation.
Admission now subtracts observed settled refunds and restores the charge
when they lose settlement. Earlier manual test-operator broadcasts are
historical evidence; the expanded regtest now uses the application sender.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z19 | settled excess and an unavailable journal | reserve, retry and restart | retain one pending reservation, sign only after live acknowledgment and never allocate its credit twice |
| Z20 | a reserved cancellation refund, failed signing and lost settlement | retry, discard unbuilt, then restore settlement | keep reservation on failure, refuse depleted credit and release only explicitly unbuilt credit |
| Z21 | a private buyer link | submit refund-destination JSON | accept one exact string member, reject duplicate/extra/non-string members and expose no operator route on the buyer listener or raw transaction |
| Z22 | journaled policy/settings | change startup policy or journal malformed settings | refuse startup; SQLite-only damage is repaired from the authoritative journal |
| Z23 | explicit order and merchant funding | sign a capped buyer-fee refund | conserve each owner's funds with separate change, validate actual size and never call a send or automatic-funding RPC |
| Z24 | unsafe, unsettled, spent, reserved, unrelated or mismatched coins, dust change or excessive fees | build | refuse; unrelated wallet money cannot replace missing order funding |
| Z25 | incomplete signing, changed outputs, unacceptable transaction, spent funding or a changed tip | build | refuse rather than return a signed attempt |
| Z26 | a refund destination supplied before a quote | quote on several orders while the wallet returns that script | skip it globally and choose unused payment scripts |

RPC behavior is checked against the Core 31.2
[raw transaction source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/rawtransaction.cpp),
[wallet spending source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/wallet/rpc/spend.cpp)
and [fee estimator source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/fees.cpp),
with real signed refunds qualified on the checksum-pinned regtest binary.
