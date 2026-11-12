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
| K22 | first or later space setup with existing invoices | repeat setup and make individual edits | same validated operations, no wallet setup repeated, identifiers and invoice attribution preserved |
| K23 | existing and expired invoices at one listed price | change the seller price | initial quote stays fixed; P12/K7 lower/higher late outcomes and the existing global exposure formula remain |
| K24 | active holds, fulfillment reservations and seller reservation | reserve, unreserve and pay | new invoices/unheld acquisition refuse while reserved; protected commitments remain; refund-only orders never revive |
| K25 | a withdrawn invoiced name with a valid hold extension | extension ends and later money arrives | current grant honored; no new grant after expiry; original invoice and money retained for refund |
| K26 | withdrawal followed by reopening before or after invoice expiry | old invoice is paid with the name free or held by another buyer | old invoice never reacquires; new checkout may acquire without duplicate ownership |
| K27 | an existing pay-first invoice on a withdrawn/reopened name | full money qualifies before or exactly at 900 seconds, or partial money reaches expiry | initial window honored; exact expiry/partial money cannot create a hold; an acquired valid grant remains protected |
| K28 | multiple listed spaces and existing invoices | pause one or all spaces, then pay existing invoices | only new admission pauses; ration per full handle and global hold/exposure/review limits remain |
| K29 | acknowledged seller policies, restrictions and request counters | journal-only restore | force global pause; preserve per-space flags, restrictions, admission settings and monotonic history |
| K30 | repeated anonymous unsigned nominations and configured aggregate limits | create requests across scripts/handles until exhausted | fresh links for admitted retries, no script claim, aggregate refusal allocates no order or destination |
| K31 | exhausted quota or retained-order capacity | restart and cross the exact window boundary | allowance never resets on restart; capacity retains history; refused requests consume no identifier or address |
| K32 | two acknowledged signed refunds, one settled and one attempted but absent | startup, journal-only recovery, inspection and exact attended retry | observe before readiness; preserve settlement, reservations, bytes and uncertainty; no startup/read send; guarded exact retry only |
| K33 | invoices, issuing/issued ownership, certificates and refund history | seller edits, restart or malformed metadata replay | preserve obligations and lineage; duplicate/orphan/mismatched metadata refuses |
| K34 | exact operator nomination for a reserved listed name | authenticated reviewed owner invoice, funding, reply loss and retry | only reservation bypassed; normal price/payment/issuance/refund guards remain; one operation/order/destination; existing bearer never redisclosed |

The seller rule details, protocol, private CLI receipts and explicit installation
limits are defined in `SELLER-OPERATIONS.md`. The independent seller model is
`ts/model/seller.ts`; production tests exercise the separately written store.

The TypeScript pilot replaces baseline H6's automatic startup refund
rebroadcast with K32's attended contract. Both groups are still reconciled
before readiness, and exact signed bytes, original attempts, reservations and
settled accounting survive. An attempted absent transaction is reported for
explicit group/transaction-confirmed retry. Startup, polling, status and offline
recovery neither sign nor send. This changes no other refund recovery guard.
The Python baseline H6 test and implementation remain historical checks.

The exemption belongs to each hold, not to all holds of an order that later
converts. K7 also checks a late pay-first payment equal to its original
quote after a price increase: it becomes refund due without needing to
pay the increased price first.

## Pilot production applicability

The production release requires all non-deferred fixed-price cases except
the Y cases, which exercise the separate owner-only mode. Cases A, B, L,
X and J3–J4/J6–J10 require the shipped Python controller/runner's production
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
| baseline H6 | K32 |

K6 adds the full-payment constraint to P9; it does not remove the normal
full-payment P9 scenario from pilot coverage. K7 preserves the P12 result.

## Browser case applicability

All C1–C12 cases remain required TypeScript production coverage. The
browser is a transport over the same commands as JSON; it grants no
alternative payment, cancellation or issuance permission. The following
mapping resolves differences from the retained Python checkout cases,
without exempting their safety outcomes.

| Baseline requirement | Public-pilot equivalent |
| --- | --- |
| C1–C6 and C9 | Public prices/availability only; exact recipient parsing; private 303 order links; journal-gated address retry; token isolation; escaping and private, scriptless, unframeable responses. |
| C7–C8 | A converted order without a bound armed entry cannot accept a certificate. Under `CERTIFICATES.md`, a verified bound callback atomically changes issuing to ready rather than requiring a separate anonymous readiness mutation. Only currently verified ready/fulfilled bytes are downloadable; finality loss withdraws both link and bytes until fresh observation and verification. |
| C10 certificate bounds | The kept 226,511-byte certificate is delivered through the authenticated bound callback and served byte for byte. Oversize certificate/envelope requests preserve the previous bytes. All other buyer and operator bodies retain the 65,536-byte limit, including declared bounds; unauthenticated delivery remains 401. |
| C11 ordinary invoices | Only an unexpired, never-detected, acknowledged quoted invoice with its ordinary hold can ask for payment. Confirmation, conversion, issuance, readiness, fulfillment, cancellation pending/final, refund due and unevaluated expiry all remove payment instructions and explain not to pay. |
| C11 pay-first invoices | K1/K3/K5 require usable invoices without a hold. Inside the original quote window a never-detected acknowledged pay-first invoice can ask for payment only after the race-loss/refund-fee warning and ceiling. Outside that window it is history. This is the explicit pilot replacement of C11's hold-only display condition, not a new hold or race rule. |
| C12 live observations | Full or partial mempool payment, first confirmation, replacement by less payment or no payment, disappearance and expiry keep detected history sticky; displayed detection never counts as confirmation or grants an extra extension. No replacement-payment prompt is shown. The JSON order link reports the same detected amounts. |
| C12 supported journal-only restore | Acknowledged detection remains detected even when gone. Detection seen only during an outage and then lost, and an invoice never observed paid, become unknown. Unquoted orders remain none and offer the invoice button under the normal pause/admission rules. Browser and JSON keep these outcomes after reconciliation and expiry; later fresh detection advances unknown to detected. |
| C12 pre-history journals and direct/older/interrupted Python SQL upgrades | Those SQL formats belong to the pinned Python service and its unchanged executable migration tests. TypeScript's first strict application format already requires payment history and has no older shipped SQL history column to migrate. Missing-history records, including those accompanied by a payment output, refuse repeated startup and journal restore without changing the journal, publishing a serving database, or leaving partial domain/schema changes. A Python database is not an accepted TypeScript input. This fail-closed production check preserves the no-payment-request outcome; any future import requires its own explicit migration specification and atomic interruption tests. |

The production browser suite uses real HTTP, SQLite and journal replay with
recording chain/wallet/controller adapters. It does not establish a funded
wallet purchase, real Spaces browser sale or buyer-client acceptance.

## Cross-component qualification

The production controller suite has typed, unconditional Node test entry
points in `ts/test/production/controller-cases.test.ts`. Its scenarios run
fresh processes of the shipped Python controller and runner against the
real TypeScript HTTP store, SQLite and journals. Only native RPCs, upstream
proof verification and relay behavior are recorded. The coverage checker
classifies this exact suite as controller evidence. Other TypeScript tests
cannot satisfy a controller case merely by using its identifier. Simulated
transactions and proofs are not Core, Spaces or buyer acceptance evidence.

J1, J2 and J5 concern the refund journal, which the pilot's TypeScript store
owns. They require TypeScript production coverage. Their tests restore the
signed family and reservation from its journal, observe before any send,
and withhold signing or sending while the relevant acknowledgment is
missing. An operator receipt exposes neither PSBT nor signed bytes. Owner
PSBT export is deferred by the attended hot-wallet decision; no export
capability is implied by these receipts. R10 retains that reservation:
a built transaction cannot be discarded, and an unsettled conflict grants
no release or independent payment authority. A settled conflict permits
only the already specified exclusive rebuild.

B2's historical proof-quota conflict is outside the owner-selected pilot
without proof eligibility. Its pilot test refuses unsupported proof
configuration and request members, and repeats real availability and
recipient binding checks. B1 and J9 repeat the funding check. This does
not supply a quota or nullifier implementation. The historical model case
remains unchanged.

J3 and J4 use the stricter bound-entry order: the controller cannot record
an intent before exact store acknowledgment. A locally issuing but
unacknowledged entry remains checkpointed without a send. A journal-only
restore of an armed entry remains issuing and quarantined until controller
reconciliation; neither cancellation nor an unknown-send retry is granted.
J6 retries the same acknowledged known-unsent identity after independent
reconciliation. J8 and J10 deliberately supply stale controller recovery
journals while preserving their newer copies separately in the fixture.
They exercise actual adoption or supersession before paused startup;
they do not claim arbitrary native tree repair.

V15 and the historical-SQL part of V17 concern Python records predating
its recipient-audit column. Those formats are not accepted TypeScript
inputs. The first strict TypeScript format refuses invalid recipients at
repeated startup and journal-only restore, preserves the invalid history,
and never publishes a serving target. It cannot expose the old invoice,
freeze a batch or send. There is no in-place Python SQL upgrade. V16 and
the valid current-recipient part of V17 still audit current conflicts,
retain their orders, alert once and refuse unsafe entry or payment
instructions. Any future historical import needs a separate specification
and atomic interruption qualification, as C12 already requires.
