# TypeScript pilot cases

These cases make the pilot decisions in `PAYMENT-SPEC.md` executable in
`ts/model/`. They govern the TypeScript pilot; the Python owner-only store
retains its pinned baseline plus recorded safety amendments. The model is
independent of `ts/src/` and has no network, database or wall-clock access.
These are model results, not production, regtest or buyer acceptance.

The model covers the new admission, conversion-review, cancellation and
refund-policy rules. It is not yet a full replacement for the older Python
payment/controller model. Runtime journal acknowledgment, transaction
signing, chain polling and actual UTXO selection still need production and
regtest evidence. Snapshot round trips model acknowledged state; they do
not demonstrate an off-host backup implementation.

## Rule details

An ordinary hold ending short follows P5 and becomes refund due when money
has confirmed. It cannot be reacquired by a partial late payment. Pay-first
has no hold to expire: partial payments reserve no name and only the full
qualifying amount can win. After quote expiry, the current price must be
no higher than quoted, as in P12. If several blocks are first read together,
compare the block in which the full amount qualified before applying the
same-block quote-time and immutable-order-sequence tie break.
Creation sequence means request creation, independently of the order in
which quotes were requested. The model accepts that sequence explicitly;
its default keeps the existing direct-quote traces concise.

The review pause fires when the tenth distinct order first converts. The
count never decreases. An explicit operator resume after review is not
immediately undone by the eleventh conversion; no second review threshold
is specified. Existing invoices continue during the pause. Restore still
starts globally paused independently of the counter.

Fee inputs use whole sats per 1,000 virtual bytes and a measured transaction
size. Round the estimated total fee upward to whole sats. The operator
supplies minimum/maximum rates, an optional explicit fallback and the buyer
fee ceiling. A missing estimate without a configured fallback or a rate
above the operator maximum authorizes no send. The buyer pays at most the
disclosed ceiling; any remainder is merchant-funded. A merchant-caused
refund returns the full refundable principal. These are configurable
limits, not chosen deployment amounts. A refund deadline starts when all
three prerequisites are first met; losing a prerequisite cannot reset it,
and sending after the deadline does not clear the incident.

The first release uses cancel-first for a partial refund (K21). This is
the coordinator's choice under the workspace_owner's delegated judgment
on 2026-11-11. An ongoing unconverted checkout is cancelled, or reaches
refund due, before money is returned. That order stays refund-only after
refund, restart or a later payment. A subsequent purchase uses a new
checkout and destination. A continuing checkout after a partial withdrawal
is outside the first-release scope. This avoids treating the same partial
payment as both purchase funding and an irrevocable refund obligation.

## Named cases

Fixture prices, fee rates and budgets below are test inputs only. Unless a
row says otherwise, a name costs 1,000 sats and the model budget is 1,000,000
sats. A hold lasts 900 seconds, the ration is two per full handle over a
rolling 86,400 seconds, and the global admission cap is ten active holds.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| K1 | a listed name with two unpaid holds | quote before/at expiry and at the 24-hour boundary | hold blocks until 900 seconds; the third counted hold becomes pay-first; a hold exactly 24 hours old no longer counts |
| K2 | a small mempool payment seen during a hold | six blocks pass, then a seventh; repeat quotes | extension lasts through the sixth block; no exemption from the ration; two counted holds force pay-first |
| K3 | ten active holds on different handles | request further invoices | give pay-first invoices without reserving another name or adding unpaid exposure |
| K4 | competing pay-first invoices | full amounts qualify in different blocks or the same block, including a delayed read of several blocks | earliest qualifying block wins; same block uses quote time then immutable sequence, regardless of observation array order; loser refund due |
| K5 | unpaid reservations or mempool-only payments fill exposure | quote another name, then confirm money | reservations yield pay-first; mempool money alone never closes admission; confirmed money plus the proposed price above the limit refuses |
| K6 | an expired ordinary hold, name free | a partial payment confirms | no new hold, refund due under P5; another quote may reserve the name |
| K7 | an expired ordinary invoice | full payment confirms after a price drop or rise | lower current price proceeds and the difference is excess (P12); price rise makes refund due |
| K8 | ten distinct conversions and an additional issued invoice | convert the additional invoice, cancel, reorg, restore, then resume after review | count never decreases; initial ten pause new quotes; existing invoices proceed; restore paused; explicit resume is not a new pause threshold |
| K9 | a converted hold and later unpaid holds | cancel the converted order and restore state | converted hold exempt; unpaid ration retained across restore |
| K10 | a converted order not yet issuing | buyer cancellation races serialized entry into issuance | exactly one succeeds; no issuance after cancellation and no buyer cancellation after issuance |
| K11 | a refundable order missing one prerequisite | vary settled funds, eligibility and known destination | deadline starts only when all hold, and never moves later when a prerequisite disappears |
| K12 | a refund due at time 20 | broadcast at 86,420 or 86,421 | first meets the target; second records an incident that later evaluation cannot clear |
| K13 | estimated fee 280, buyer ceiling 200 | plan a buyer-caused refund of 10,000 | buyer gets 9,800; buyer fee 200, merchant fee 80; principal charged to order once |
| K14 | a merchant-caused refund of 10,000 | plan a fee of 280 with insufficient merchant fee budget | full 10,000 remains due to buyer; no authorization without merchant funding |
| K15 | missing or excessive fee estimate | plan refund, with and without explicit fallback | absent fallback and above-limit rate refuse; configured bounded fallback works with upward fee rounding |
| K16 | fee 300 and excess 845 or 846 | test excess minimum | 845 not refundable; 846 meets the inclusive 546-over-fee minimum |
| K17 | original payment outputs already spent, with an available change output | fund a later refund | may use available change against remaining order credit; never another order's reserved coins or spent inputs; missing credit/funding refuses |

| K18 | a pay-first invoice with partial confirmed funds | reach expiry, then confirm the full price | partial money waits without a hold; only the full price takes the name, with conversion at three confirmations |

| K19 | a hold released after payment loss, then a new buyer holds the name | the original payment returns after a reorg | old hold never revives automatically; new owner preserved, old order refund due |

| K20 | an order's original hold expires, a later hold converts, then the order is cancelled | quote again, cancel that unpaid hold, and restore | only the converted hold is exempt; the original unpaid hold and the new unpaid hold exhaust the ration across restore |
| K21 | an ongoing checkout with a settled partial payment | request a refund, cancel and refund, restart, then pay the old and a new checkout | refuse a refund before cancellation/refund due; old invoice stays refund-only and retains its address/history; only the new invoice can qualify the purchase |

The exemption belongs to each hold, not to all holds of an order that later
converts. K7 also checks a late pay-first payment equal to its original
quote after a price increase: it becomes refund due without needing to
pay the increased price first.

## Pilot production applicability

The production release requires all non-deferred fixed-price cases except
the Y cases, which exercise the separate owner-only mode. Cases A, B, L,
X and J1–J10 require the shipped Python controller/runner's production
tests; other applicable cases require TypeScript store production tests.
The latter live in `ts/test/production/`, and independent model tests in
`ts/test/model/`. Baseline Python store tests do not count for that target.
The discovery checker is a coverage gate; the corresponding suites must
also execute and pass. Every case in this pilot specification additionally
requires its independent TypeScript model test under both gate modes.
Test names alone do not establish implementation.

The following exact baseline cases describe exposure behavior replaced by
K5. The baseline cases and Python tests stay as historical checks. Every
replacement remains a required pilot case, including production coverage.
This table describes applicability, not a temporary case-status exemption.

| Baseline case | Pilot replacement |
| --- | --- |
| baseline S2 | K5 |
| baseline S3 | K5 |
| baseline S4 | K5 |

K6 adds the full-payment constraint to P9; it does not remove the normal
full-payment P9 scenario from pilot coverage. K7 preserves the P12 result.
