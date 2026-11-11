# Subspace store payment specification (draft 16, 2026-11-10)

MVP scope (workspace_owner, 2026-11-06): fixed-price sales first. The Dutch
auction section, its cases D1 to D35, case N6, and the auction evidence
cases E1 to E4 are kept but deferred until after the MVP.

Launch scope clarification (workspace_owner, 2026-11-08): the
workspace_owner agreed on 2026-11-08 that the first launch targets one
public space, fixed-price Bitcoin sales and Nacho as the first supported
buyer client, without ZK eligibility. Nacho acceptance comes first, with
checkout and an attended operator runner developed alongside it on regtest.
This agreement does not authorize production deployment, mainnet
transactions or funds movement. Paid sales remain conditional on the buyer
and operator acceptance gates. It leaves undecided the hold-admission
policy for public names and the recovery-time targets (open points), and
it approves neither implicitly. Without ZK eligibility the buyer proves
nothing about themselves; the Spaces protocol's issuance proofs for later
batches stay in scope. The plan for the first acceptance gate is
`docs/BUYER-GATE.md`.

Pilot decisions (workspace_owner, 2026-11-10): the workspace_owner adopted
a reviewer's pilot recommendation of the same day. The decisions authorize
writing these rules as cases and building them, and nothing more: no
production deployment, no wallet transaction, no mainnet action and no
opening of sales, each of which needs its own authorization. The rules
they change are not built yet. Until each is written as cases and built,
the store's current rule stands where it differs, and the pilot can't
open. The decisions:
- The finish line for the first launch is the four demonstrations under
  "Acceptance gates": a buyer's acceptance with Nacho, a complete sale and
  a refund through the real service, a small attended pilot that can be
  operated, and one recovery end to end on the deployed stack. Passing
  tests is evidence toward them, not permission to open sales.
- The first pilot is one public space at fixed prices, reviewed at ten
  paid orders. When the tenth distinct order first converts, new quotes
  pause for review. Invoices already given out, including expired ones
  still eligible for a late payment, go on under the payment,
  cancellation and refund rules, so more orders may convert after the
  pause. Ten is a review threshold, not a ceiling on payments or
  conversions. The count takes each order once, survives a restart and a
  restore, and doesn't fall when an order is cancelled or a reorg undoes a
  conversion, so neither reopens sales; only the owner does. The pause at
  ten is a rule still to write and build; until it is built, the owner
  pauses sales by hand. A strict ceiling of ten sales would instead need
  the remaining slots allocated atomically and a policy for refunding the
  overflow; that isn't chosen.
- Hold admission for public names is the design under "Fixed-price
  sales", with these values and changes: a 15-minute hold; at most two
  counted holds per name in a rolling 24 hours; at most ten active holds
  across the store; pay-first beyond those. A late payment, like a
  pay-first order, takes the name only with the full price. Pay-first
  payments that qualify in the same block go to the earlier quote, and
  between quotes made at the same moment to the order created first, by
  its sequence number, which never changes. A buyer
  who loses the race is refunded less the refund fee, and checkout says
  so, and that another buyer may pay first, before it shows an address.
  These are rule changes still to write as cases and build in the model
  and the service.
- Refunds are attended hot-wallet refunds; owner-signed PSBTs are
  deferred. The hot-wallet cap limits each refund, not the wallet's
  balance. A refund after an earlier refund spent the order's payment
  outputs is still to build. The operator wallet, which funds issuance,
  stays separate and small.
- The exposure limit is an admission threshold for new invoices, not a
  cap on the wallet's balance: addresses already given out can still be
  paid. It is the smaller of ten times the highest listed price and the
  workspace_owner's pilot risk budget. Its value in sats waits on the
  prices and that budget.
- The recovery-time targets, to be demonstrated, not yet capabilities:
  under one minute to replay a representative journal of 10,000 orders;
  under four hours for the complete recovery onto a replacement host,
  from the start of its setup, chain catch-up included, until issuance and
  refunds can safely resume.
- The pilot ships on the TypeScript store built on Effect, once it is
  complete, with the Python controller and attended runner at first,
  deployed through Alchemy to a general Linux host over SSH. The launch
  demonstrations run against exactly that combination.

Further pilot decisions (workspace_owner, 2026-11-10, later the same
day), adopting a second reviewer recommendation, with the same limits on
what they authorize. Each is still to build where it differs from today:
- Proof-gated names and auctions stay out of the pilot, as the launch
  scope of 2026-11-08 and the MVP scope of 2026-11-06 already have it.
- A buyer may cancel before the order enters issuance, serialized against
  issuance so that exactly one wins. Once a commitment may have been sent,
  the recovery rules apply as now. Today only the owner can cancel.
- A cancellation shows as pending until the off-host journal acknowledges
  it, and as final only then: the rule of draft 14, now confirmed.
- A refund is broadcast within 24 hours of becoming due: once its funds
  are settled, the refund is eligible and a valid destination is known.
  Confirmation takes its own time. A missed target is an incident.
- Refund fees. A buyer's cancellation, an excess refund and a pay-first
  race the buyer was told about are refunded less the network fee, which
  checkout discloses, up to a fee ceiling for the buyer. A refund the
  store caused returns the full refundable amount, and the store pays its
  fee. The fee is estimated, with Bitcoin Core's `estimatesmartfee` for a
  confirmation target, within limits the operator sets, including what to
  do when no estimate is available; it replaces today's fixed fee. The
  split needs accounting the store doesn't have yet.
- The excess minimum stays at 546 sats over the refund fee, disclosed at
  checkout. It is the store's policy, not a Bitcoin dust rule.
- Delivery: an internal target of 72 hours from the confirmation of the
  payment that qualified the order. No delivery estimate is published
  until the demonstration on the real stack supports one; the order page
  shows progress and says what can delay it.
- Published evidence: software revisions, procedures and sanitized
  results. Never buyer-linked records, recovery material, credentials or
  private details of the infrastructure.

Port handoff recorded at the workspace_owner's request (2026-11-11).
`PORT-PLAN.md` records the implementation order, the independent TypeScript
model, the public-pilot
release gate and the work deferred until after it. The Python store and
Python model used for the owner-only test purchase retain the behavior
specified and implemented at `66db98c7bea395e7521039418d0ce6307ab67222`.
Their tests remain checks of that baseline, even as later pilot cases
change this document. Explicit safety fixes, beginning with process
ownership, must be recorded with their tests; this is not a freeze on
fixing defects. New pilot behavior belongs to the TypeScript model and
store. The pilot still uses the Python controller and attended runner
initially. Neither baseline tests nor TypeScript model coverage alone
establish that the public pilot is ready.

Draft 16 records those decisions. It also gathers what was added since
draft 15: the sales pause and the exposure limit (S1 to S6), refund
destinations, never a payment address in either direction (T1 to T4), and
interrupted broadcasts, always uncertain (A20 to A22, X11).

Status: draft specification under review. Every rule below is a
requirement until its cases are implemented and pass as executable tests.
Implemented behavior has model, service and regtest evidence described in
`README.md`, `docs/SERVICE.md` and `regtest/REPORT.md`; the pilot changes
identified above are still to build. A reviewed specification is not an
implemented system. Rules marked "proposal" are commercial defaults that still
need the owner's agreement; a default that changes merchant risk is always a
proposal. This file is authoritative for payment, reservation and refund
rules; `README.md` summarizes it. Draft 2 applied the third review round in
`REVIEW-5.md`. Draft 3 rewrote the Dutch auction and separated sale mode,
eligibility and availability (fourth round). Draft 4 applies the fifth
round: auction evidence, same-price renewal, floor timing, durable cutover,
and the restored batch-entry section. Draft 5 applies the sixth round:
issuance and refund sufficiency are separated, refund replacements are
mutually exclusive on-chain, and the evidence claims are corrected. Draft 6
keeps detecting payment deficits after issuance starts, and makes refund
accounting group-based throughout. Draft 7 is a narrow consistency edit (N8,
P4, an explicit in-flight rule, finality from the `spaces` source, and
refund-depth round trips). Draft 8 corrects the finality reading, defines how
a recorded merchant loss suppresses repeat alerts, and ties fulfillment to
per-handle publication. Draft 9 applies the model review of 2026-11-07:
issuance waits until the order locks and the broadcast intent are both
acknowledged off-host, every sending path checks its journal entry
immediately before the call, a batch resumed before its first transmission
repeats the binding check, one commitment per space is in flight, and a
commitment that loses finality is tracked, with a recovery incident for a
member already fulfilled (B6, B7, J3 to J10, L1 to L5). Draft 10 applies
the first regtest findings, R10 and R11 of the regtest harness: a member is
ready only once its certificate verifies as sovereign, which can trail
`d >= 150`, and a commitment that lost finality returns to the chain only
from its journaled signed bytes (L6 to L8), and a supersession that a deeper reorg undoes is tracked (X10). Draft 11 adds L9 from regtest findings R23 and
R24: a certificate built on a later commitment than its batch's is
delivered only once that later root is final and covered. Draft 12 brings
the strict request rules from the buyer-gate handoff into this file, as
"Recipient requests" and cases V1 to V16, and records hold abuse as an open
launch blocker. Within draft 12, a review found that a first-come binding let
an unsigned request claim someone else's script for good, and that stored
orders skipped validation. A script is now claimed only by a paid order, and
every start audits stored recipients. Draft 13 adds "Host loss and restore"
and cases H1 to H7: the store restores from its off-host journal alone, and
never starts empty over an existing journal. Draft 14 closes two
acknowledgment boundaries that a review reproduced against the service:
a payment address is given out only once the order carrying it is
acknowledged off-host, and a cancellation is reported final only then,
to the operator and on the buyer's order link (J11, J12, H8 to H10). A
second review found that a quote asked again skipped the recipient checks
(V17). The cancellation reporting rule followed a reviewer's recommendation
of 2026-11-08 and was adopted in the further pilot decisions of 2026-11-10.
Draft 15 adds the runner's recovery commands and the rule that a restore
sends no new commitment until it is reconciled (A11 to A15), and that a
payment wallet restored from an earlier backup never gives a new quote an
address an order holds (H11). Both came from the operator gate's recovery
rehearsal on regtest (scenario 11, `regtest/REPORT.md`). A review of that
work (2026-11-10) added a persisted "restore required" state, an atomic
and resumable replay, and the migration of an older controller database
(A16 to A18). Re-delivering a certificate built on a later root of the
same space, which a restored host needs for an order fulfilled before the
loss, is A19.

## Terms, depth arithmetic and thresholds

An order is created on the server when checkout starts. It holds the space,
the name, the sale mode, the recipient (`handle` and `script_pubkey` from
the buyer's request), the eligibility nonce and original query, and its
quotes. Each quote has a locked price and its own unique destination script,
owned by the space holder's watch-only wallet. A fixed-price order has one
quote. A Dutch-auction order may have several over time (see Dutch auction). Access to the order is the private
order link (ruling 8).

A payment output is an output to one of an order's destination scripts. Its identity
is `txid:vout` and never changes. What changes is its position on the store's
best chain: in the mempool, mined at some height, or gone. Its contribution
to every balance below is derived from that position at the moment of
evaluation.

Depth arithmetic, used everywhere in this file and in `CONTROLLER-DESIGN.md`:
- `d = tip_height - mined_height`, the expression `subs` uses. A transaction
  in the tip block has `d = 0`.
- `c = d + 1` is the conventional confirmation count. An unmined transaction
  has `c = 0`.

Payment thresholds, in conventional confirmations:
- seen: `c = 0`, in the store node's mempool;
- confirmed: `c >= 1`;
- batchable: `c >= 3`;
- settled: `c >= 6`.

Commitment thresholds, with `d` measured at the tip:
- protocol rule: in `spaces` v0.5.0, `Commitment::is_finalized(height)`
  returns `height > block_height + 144`. Here `height` is the height of the
  block being processed (`nums/src/lib.rs`, with the constant in
  `nums/src/constants.rs`).

  A rollback revokes a pending commitment only if it is mined in a block at
  or below `block_height + 144`. A rollback sent at tip `T` can land in block
  `T + 1` at the earliest, so it can take effect only while `d < 144`.
  `subs`' health check uses exactly `d < 144`, which matches next-block
  inclusion. So, absent a reorg, no rollback can take effect once `d >= 144`;
- operational finality: `subs` reports `Finalized`, and allows the next local
  commit, only at `d >= 150` ("144 blocks + 6 safety").

The store treats a commitment as final only at operational finality,
`d >= 150`, which adds six blocks of margin for reorgs.

An order is "ready" once its certificate is verified at `d >= 150` and shown
to the buyer. It is fulfilled only after its publication to the relay
network is confirmed for its handle individually (see the controller
design).

Readiness has two gates. The commitment is at `d >= 150` on the current
chain, and the member's certificate verifies as sovereign. The verifier
judges sovereignty from the newest root anchor, which `spaced` computes
every 36 blocks, and needs that anchor 144 blocks past the commitment. So it
can report a certificate as pending for up to 35 blocks after `d >= 150`.
Pending at `d >= 150` is waiting for anchor coverage, not a failed
verification. The member stays `issuing`, nothing is paused, and it is
verified again once an anchor covers the commitment (L6). Publication and
delivery need both gates.

Finality can be lost. If a reorg later takes a final commitment below
`d >= 150`, or off the best chain, the batch returns to `mined` or
`broadcast` and the owner is alerted. Its ready members return to `issuing`
and stay non-cancellable, as for any commitment that loses depth.
Publication and delivery wait until the commitment is at `d >= 150` on the
current chain again, and each is checked against the live chain immediately
before it happens.

A commitment taken off the best chain may not come back into any mempool
(regtest R10). The controller then rebroadcasts its identical signed bytes
from the journal, after the same journal check as the first broadcast. It
never repeats the wallet's build-and-send, which could build a different
transaction. If no signed bytes were journaled, recovery pauses and the
owner is alerted. Only the same bytes found elsewhere, such as in a peer's
mempool, or the owner's safe supersession resolve it, and the members stay
non-cancellable meanwhile (L7, L8).

A member already fulfilled stays fulfilled, because that status records a
delivery that happened. It doesn't say the certificate is still valid. The
store opens a durable recovery incident on the order, shown to the owner and
on the order, and reports the certificate as not current while its batch
isn't final on the current chain. If the batch is later safely superseded,
its fulfilled members still stay fulfilled, and nothing is unissued,
refunded or reallocated automatically. The incident stays open until the
operator records a resolution (L1 to L5).

The same holds after a restore. A member that the store's journal shows as
ready is ready only while its batch is final on the current chain (J8). A
ready or `issuing` member of a superseded batch, or of no live batch in the
controller's journal, returns to paid, and a fulfilled one gets an incident
(J10).

## Ledger

For each order the store keeps:
- `confirmed_sum`, `batchable_sum` and `settled_sum`: the sums of its payment
  outputs at those depths, recomputed from chain position;
- `price_reserve`: the purchase price once the order holds a fulfillment
  reservation (below);
- refund obligation groups (see Refunds). Each group is one refund the order
  owes and holds every attempt ever made for it. Each attempt records
  `to_buyer`, its fee, and `charged`, the part of `to_buyer + fee` drawn
  from the order's funds;
- `reserved`: the sum, over the order's open groups, of each group's
  reservation, which is the largest `charged` among its attempts;
- `refunded_total`: the sum, over closed groups, of the `charged` amount of
  the attempt that settled;
- `refunded_to_buyer`: the sum of `to_buyer` of those settled attempts, for
  display;
- the payment shortfall and refund exposure, computed and never stored as
  balances (see "Authorization, obligations and exposure").

`price_reserve` is zero until the order holds a fulfillment reservation, as a
converted fixed-price order or a converted auction winner. From then on it
equals the price, and it stays equal to the price after the order is
fulfilled, permanently. It returns to zero only when the order is
cancelled. Before `issuing`, cancellation is allowed directly. After
`issuing`, it is allowed only once the order's fulfillment is safely
superseded (see Cancellation).

Network fees are paid by the store's refund wallet, not deducted invisibly.
An attempt's `charged` is `to_buyer` plus whatever part of the fee is taken
from the buyer's funds. With refunds sent net of fee, which checkout
discloses, the whole fee is charged, so `charged = to_buyer + fee`. For the
pilot that is a buyer's cancellation, an excess refund or a lost pay-first
race, up to the buyer's fee ceiling; a refund the store caused is sent in
full and the store pays the fee (pilot decisions, 2026-11-10).
Any fee the store absorbs beyond that, for example on a fee bump, is a store
cost. It is recorded separately and never charged to the order.

## Authorization, obligations and exposure

These are separate on purpose. Depth can fall after a reorg, so no balance
check can hold after every event.

Two sufficiency rules apply to the same funds, at different depths:
- Issuance needs batchable funds. An order may convert, enter a batch, and
  stay eligible for issuance while `batchable_sum >= price_reserve`. That is
  the three-confirmation issuance policy, and it doesn't wait for settled
  depth.
- Refunds need settled funds above the price reserve. A refund may only spend
  `settled_sum` beyond what `price_reserve` holds back.

Spending authorization. In one database transaction, compute:

    available = settled_sum - refunded_total - reserved - price_reserve

Then:
- a new obligation group may open with its first attempt only if
  `charged <= available`;
- a further attempt in an open group, whether a fee bump within a family or
  an exclusive replacement family, needs only
  `max(0, charged - group_reservation) <= available`.

Replacing a 10,000-sat attempt with an exclusive 10,000-sat attempt needs no
capacity, and raising it to 10,500 needs 500. If `available` is negative,
nothing new is refundable. The batch-entry conditions are in "Batch entry and
the binding pre-broadcast check".

Obligations. Reservations, recorded refunds and fulfillment reservations are
obligations. A reorg never shrinks them. They change only through the
evidence rules below.

Shortfall and exposure. After any change in chain position, the store
computes two values for each order:
- `payment_shortfall = price_reserve - batchable_sum`, for every order with
  `price_reserve > 0`, in every state: before `issuing`, during issuance and
  after fulfillment;
- `refund_exposure = refunded_total + reserved - max(0, settled_sum - price_reserve)`.

An order whose funds are only three confirmations deep has a positive gap
between `price_reserve` and `settled_sum`. That is normal, and neither value
flags it, because a price that isn't settled yet blocks refunds by
authorization, not by exposure.

`reconciling` carries one or more reasons, and each reason blocks only its
own path:
- issuance: `payment_shortfall > 0` and the order isn't yet `issuing`. The
  order keeps its fulfillment reservation and stays out of batches until the
  shortfall clears.
- post-issuance deficit: `payment_shortfall > 0` and the order is
  `issuing`, broadcast, mined or fulfilled, so a transaction may have escaped
  or delivery has completed. The store records the deficit and alerts the
  owner. It never cancels, refunds or reallocates the name automatically. A
  commitment that may have escaped is never rebuilt, replaced or rolled back
  because of a payment shortfall. Removing a name from such a commitment
  needs the owner's explicit decision and the safe-supersession conditions in
  Cancellation, and the shortfall alone never authorizes it. After
  fulfillment the name stays with the buyer.
- refunds: `refund_exposure > 0`. No new refund is authorized for the order.
  Existing reservations stay, and issuance continues while the issuance rule
  holds.
- retired generation: an auction payment qualified after its generation was
  retired. See Dutch auction.

Each reason alerts the owner once, with its amount. A reason clears when its
condition clears, or when the owner records that deficit as a merchant loss.

A recorded loss covers its amount. Evaluating the same deficit again raises
neither the reason nor the alert. Only a deficit larger than the recorded
loss raises the reason again, and only for the difference. If the condition
later clears, the recorded loss stays in the order's history.

Property tests run generated event sequences, including reorgs of any depth
and restarts, and check that:
- every authorization satisfied its inequality when it was made;
- no output contributed twice to any sum;
- no reservation was released without evidence;
- an ordinary three-confirmation purchase never enters `reconciling`;
- every positive shortfall or exposure set its reason, in every order state;
- `reserved` always equals the sum of the open groups' maxima, recomputed
  from the journaled attempts;
- no two members of one refund obligation group could both confirm on any
  chain the simulator can produce.

## Sale modes, eligibility and availability

These are three independent settings for each name.

Sale mode is how the price is set. v1 has two:
- fixed price;
- Dutch auction, where the price falls in steps by block height.

A name has one sale mode at a time. Rising-bid (English) auctions are
deferred to keep v1's scope small, not because they are impossible without a
contract. They need extra rules: binding bids, collected through deposits or
full payment up front; what happens when a winner defaults; and refunds for
every outbid bidder.

Settlement. v1 doesn't implement escrow or contract-enforced settlement.
Buyers pay the owner directly and rely on the owner to deliver or refund, and
the store's terms say so. Escrow wouldn't inherently need another chain or
wallet. Bitcoin scripts and PSBTs, which Spaces itself uses for some auction
and transfer mechanisms, could protect payment or refund conditions, though
that wouldn't by itself make an operator issue a name. It is deferred.

Eligibility is who may buy. It applies to either sale mode:
- public: anyone;
- proof-gated: a proof bound to the order, such as a ZKPassport nationality
  check, with a quota per policy (see `ELIGIBILITY.md`);
- allowlist: the owner approves a specific public request, meaning that
  exact `handle` and `script_pubkey`, before checkout can proceed. Fresh
  recipient keys don't prevent this, because the owner approves the request
  itself rather than a key known in advance;
- voucher: a single-use bearer code, scoped to one name or one tier. It
  grants access to whoever holds it, not to a particular person. It is
  stored hashed and redeemed in the same database transaction that binds it
  to an order.

Availability is whether the name can be bought at all:
- available;
- reserved: not offered. The owner may issue a reserved name through an
  owner order to a specific request, which goes through the normal batch and
  certificate flow;
- in fulfillment;
- issued.

## Recipient requests

A recipient request nominates who receives a name. It is public data: Nacho
exports it as unsigned JSON with no private key, signature, nonce or expiry,
and anyone may have seen it. Holding a request proves nothing, so the store
treats it only as a nomination. These rules apply wherever the store accepts
a request, before any order, quote or eligibility check exists for it.

Shape. A request is a JSON object with exactly two members, `handle` and
`script_pubkey`, both strings. A request with any other member, a repeated
member or a missing one is refused whole; the store never strips a field
and carries on. Upstream's `HandleRequest` type has an optional
`dev_private_key` testing field, so a request carrying it, or anything else
that might be a secret, is refused like any other extra member, and the
refusal never stores, logs or echoes the request.

Handle. `handle` is canonical `name@space`: two labels joined by `@`, each 1
to 63 characters from `a` to `z`, `0` to `9` and `-`, neither starting nor
ending with `-`, the space in punycode. Nothing is normalized: uppercase,
surrounding whitespace, a trailing newline, a leading `@` or Unicode is
refused, not corrected. The handle must also equal a name the store lists,
or the request gets "not for sale".

Recipient script. `script_pubkey` is lowercase hex of exactly 34 bytes: `51
20` (witness version 1 and a 32-byte push) and then a 32-byte x-only key that
is a valid BIP340 public key, meaning the coordinate is below the field size
and `lift_x` finds a point on secp256k1. Any other script type or length,
uppercase hex, or a key off the curve is refused. The store can't check that
the buyer holds the key; the buyer gate tests that.

Who may claim a script. A request is unsigned, so it carries no authority
over its script: anyone who has seen a public request, or the script on the
chain, can submit it for any handle. Submitting it, or quoting it, therefore
claims nothing. Only a paid order claims a script.
- Claim. An order claims its script for its handle while it is
  `converted`, `issuing`, `ready` or `fulfilled`, that is, from the moment
  its payment converts the hold. The claim is derived from the order's
  status, not stored on its own, so it can't drift from the order.
- Lifecycle. A claim ends when its order leaves those states without
  issuance, by cancellation, including after a safe supersession. A
  `fulfilled` order's claim never ends, because the name is on the chain
  under that key.
- Refusal. A request or a quote whose script another handle claims is
  refused, including a quote asked again for an order already quoted, and so is a request whose script is one of the store's own
  destination scripts. The refusal says only that the script is already
  used, never which handle or order holds it. It still tells the caller
  that some paid order here carries the script.
- Unpaid orders don't conflict. Orders for different handles may carry one
  script until one of them converts.
- Conflict. Two orders for different handles can both convert on one script
  if both were quoted before either converted. Then neither enters a batch,
  the owner is alerted once for each, and nothing else changes until the
  owner cancels one. An order already `issuing` keeps its script: a later
  conflicting order is refused at batch entry, and the issuing order's
  recheck still passes. Two issuing orders on one script, possible only in
  records from before these rules, both fail the recheck.
- Retry. A request for the same handle with the same script creates a new
  order with a new order link. It never returns, reveals or reuses an
  earlier order's link, because a public request is no proof of holding
  that order.

The rule protects buyers from reusing a key across names, which would tie
those names together and undermine independent transfers. Blocking someone
else's script now costs the full price of a name, and that name then goes to
the blocked script's owner. The store can't know whether a script is used
elsewhere, so fresh keys from Nacho and the buyer gate's two-name test stay
essential.

Nothing on refusal. A refused request creates no order, order link, hold,
alert or journal entry. A malformed request is refused before any state is
read. A request refused for reuse is a conflict with stored state.

Stored orders. Orders stored before these rules, or by a faulty version,
may break them. At every start, before it serves anything, the store checks
each stored order's recipient against the handle and script rules above,
and against its own destination scripts. An order that fails is flagged
with the reason, and the owner is alerted once. Its record is kept as it
is: nothing is deleted, and no status, reservation or refund changes. A
flagged order gets no quote, not even again for a quote it already has, and
its order link shows no payment address. Once converted it fails batch entry and the
issuing recheck, can't be put in the frozen batch, and is never served by
`/pending`, even from a batch frozen before the start. Script conflicts
among stored orders are alerted at the same check and follow the conflict
rule. The owner resolves each one, usually by cancelling and refunding.

## Fixed-price sales

A fixed-price name has at most one temporary hold and at most one
fulfillment reservation at a time, enforced by uniqueness constraints in one
database transaction.

Quote and temporary hold. A quote fixes the price and takes the name's
temporary hold. The hold has `quote_expires_at`, 15 minutes after the quote
by the server's clock (pilot decisions, 2026-11-10). A second buyer who asks for a held name
gets "taken for now" and no quote.

Payment instructions. The quote's address is given to the buyer, by the
quote or by the order link, only once the order entry carrying it is
acknowledged off-host. Payment instructions are an effect that leaves the
store, and a host loss forgets an unacknowledged quote: an address shown
before the acknowledgment could be paid and then belong to no order. While
the journal is known to be down, a quote is refused and takes no destination
and no hold. If the acknowledgment doesn't arrive after the quote is
recorded, the answer says so and gives no address, and the order link shows
none, until it arrives; asking again then returns the same quote while its
hold lasts. The hold's clock runs from the quote either way (J11, H8, H9).

Open: hold abuse. A request and a quote cost nothing and need no account, so
one caller can keep a name "taken for now" indefinitely by quoting again as
each hold ends. A reproduction against the service's API over a simulated
chain showed this on 2026-11-07; no committed test covers it. It is an open
design issue and blocks any public pilot. A fix has to limit repeated
acquisition, not only concurrent holds: a per-passport quota that counts
active holds still lets the same holder take the name again after every
expiry. Proof-gated names need a rule on how often one nullifier may hold a
name. Public names have no identity to count, so they need an admission
policy of their own. The design below is the one for them: the
workspace_owner adopted it for the first pilot on 2026-11-10, with the
values and changes in the pilot decisions at the top of this file. It
is modeled in `PILOT-SPEC.md` (K1–K9, K18), but is not implemented in the production store.

Hold admission for public names, with the exposure limit (draft
2026-11-10, revised after review; adopted for the pilot with the changes at
the top of this file, 2026-11-10; not implemented).
Without an identity, the one thing a caller can't repeat for free is a
payment. So free reservations are rationed per name and store-wide, and
nothing a caller can do for free may stop sales: at worst it removes the
reservation, and the name is still sold to whoever pays first. Only money
that has actually arrived can stop new quotes.
1. Reservations are rationed per name, whoever asks. Every hold counts
   against its name's ration unless its order converted while the hold
   lasted. A payment seen in the mempool exempts nothing: one that never
   confirms costs nothing at all, since it pays no miner fee and its coins
   can be spent elsewhere. A name may have at most
   `free_holds_per_name` counted holds (pilot: 2) among the quotes made
   for it in the last `free_hold_window` (pilot: a rolling 24 hours). The ration
   counts by name, not by request, link or script, so fresh requests with
   fresh scripts draw on the same ration.
2. Store-wide, at most `holds_open` holds (pilot: 10) are active at
   once, counted the same way.
3. Admission reads only confirmed money. Confirmed funds are every
   output at `confirmed` depth or deeper paying an order's address, less
   what refunds have charged. Reserved funds are the remainder of every
   active hold: its price less what is confirmed paying it, so a partial
   payment, seen or confirmed, releases nothing, and an active hold counts
   at its full price. Pending payments, seen but not confirmed, count in
   neither: they are reported to the owner, but no admission decision
   reads them, because they cost nothing to make or withdraw.
4. A quote takes a hold only if the name's ration and the store-wide cap
   allow it, and confirmed plus reserved funds plus the price stay within
   `exposure_limit_sats`. Otherwise the quote is pay-first, not refused.
   A pay-first quote fixes the price and gives an address but takes no
   hold and reserves nothing, and the name still shows as available.
5. A pay-first order wins the name only with the full price: the first
   whose `confirmed_sum` reaches its quoted price while the name has no
   hold and no fulfillment reservation takes the hold at that price and
   proceeds. That holds whenever the payment confirms, before or after the
   quote's `hold_seconds`. A partial confirmed payment never takes the
   hold: the late-payment rule's acceptance of any positive confirmed
   amount doesn't apply to pay-first orders. Any pay-first order that
   doesn't win is refund due for its settled funds, net of the refund
   fee. Before showing the address, checkout says plainly that another
   buyer may pay first, and that the payment then comes back less the fee.
   When pay-first payments of two orders qualify in the same block, the
   earlier quote wins, and between quotes made at the same moment the
   order created first, by its sequence number (pilot decisions,
   2026-11-10).
6. Quotes are refused outright only while sales are paused, or when
   confirmed funds alone plus the price would pass the limit. Neither
   unpaid invoices nor mempool payments can bring that about.
7. Pay-first waits for `confirmed`, not seen, because a mempool payment
   can be replaced or withdrawn for nothing. A pay-first quote's price
   holds for `hold_seconds`, like any quote. A full payment confirming
   later wins at the quoted price only if the current price is no higher,
   as for a late payment, and anything above the price is excess.
8. The ration and the cap are journaled with the names and orders they
   count, so a restore doesn't hand out a fresh ration.

What this design leaves possible:
- A hold lasts 15 minutes, or, if any payment to it is seen before then,
  until six blocks after that payment was seen (Extension, below,
  unchanged). Six blocks is about an hour on average and can be much
  longer. So a caller who broadcasts a small payment, even one that later
  disappears, keeps a hold for about 15 minutes plus six blocks. If that
  payment never confirms it costs them nothing; if it confirms, they pay
  its fee and get the payment back only above the excess minimum. Each
  name can be held that way at most twice in 24 hours, and at most 10
  names at once across the store.
- A caller can spend every name's ration, or fill the store-wide cap or
  the reserved part of the limit, for free or for fees. Honest buyers then
  get pay-first quotes: no reservation, a race risk, and, if they lose,
  a refund less the fee. Sales go on.
- The limit bounds confirmed money and the invoices that hold a name. It
  doesn't bound what is in flight: pending payments and pay-first
  payments count only once they confirm. So the wallet can pass the limit
  by every payment already broadcast, plus whatever pay-first buyers pay
  before the stop takes effect; a pay-first payment that doesn't win is
  refunded once it settles. Counting pending payments or unpaid pay-first
  invoices would let anyone trip the stop for free, by broadcasting
  payments they then withdraw or by asking for quotes, and stop all
  sales, which is what this design rules out. The owner sees pending
  payments, and can pause sales by hand.
- The frozen Python baseline's late-payment rule, for an order whose own
  hold ended, lets any positive confirmed amount take a new hold when the
  name is free. A
  small confirmed payment can therefore take a name back for six blocks
  and more. Under this design that new hold counts against the name's
  ration. For public names in the pilot a late payment takes the name
  only with the full price too (pilot decisions, 2026-11-10). That change
  belongs to the TypeScript pilot model and store; the Python owner-only
  test retains its baseline rule as set out in `PORT-PLAN.md`.
- Two honest buyers can pay the same pay-first name before either
  confirms. The one who confirms second is refunded less the refund fee,
  and checkout says so before it shows the address (pilot decisions,
  2026-11-10).
- Requests and quotes still create orders and fresh addresses for free.
  That costs database rows and, for recovery, wallet look-ahead: a payment
  wallet restored from its backup looks ahead a fixed number of addresses
  (Bitcoin Core's keypool, 1,000 by default), and misses payments beyond
  them until that is raised. The proposed mitigations are rate limiting
  per client address at the HTTPS proxy, an owner alert past a count of
  open quotes, and a restore procedure that raises the look-ahead to the
  number of addresses the journal shows given out.

Extension. If one of the order's outputs is first seen before
`quote_expires_at`, the store records `seen_height`, the tip height at that
moment, and the hold lasts until `tip_height > seen_height + 6`. If by then the
order's `confirmed_sum` has reached the price, the hold continues while
`confirmed_sum` stays at or above the price.

Conversion. In the database transaction in which `batchable_sum` first
reaches the price with the hold active, the hold becomes a fulfillment
reservation. The name is then reserved for this order until it is fulfilled,
or until the order's fulfillment is safely superseded and the order is
cancelled. The end of the temporary hold never releases a name that has a
fulfillment reservation.

End without conversion. The hold ends at `quote_expires_at` if nothing was
seen before it, or when the extension lapses without conversion. A seen
output that was dropped or replaced by a transaction not paying the order's
script leaves the order unpaid. It creates no refund, because nothing
confirmed.

Late payment. A payment that first reaches `confirmed` after the hold ended
is evaluated once, then. If the name has no hold and no fulfillment
reservation, and the current price is no higher than the quoted one, the
order takes a new temporary hold at the current price and proceeds (P12).
Anything above the current price is excess. Otherwise the order becomes
refund due.
Late payers are never queued.

Several outputs, underpayment and overpayment. All the order's outputs add
up, in one transaction or several. The buyer may top up while the hold
lasts. A hold that ends short of the price makes the order refund due for its
settled funds. Funds above the price are excess and are refundable once
settled, because `price_reserve` keeps the price back. An excess smaller than
its refund fee plus 546 sats is not refunded, and checkout discloses that
minimum (pilot decisions, 2026-11-10).

Sales pause and exposure limit, as implemented (S1 to S5). Both stop new
quotes and nothing else. While either applies, a quote is refused before
anything is taken: no destination, no hold. The buy page says sales are
paused. Requests, existing quotes and holds, payments, late payments,
conversion, issuance, cancellation and refunds go on as before. Prices are
set per name by the owner (`/operator/names`), and a quote fixes the price
as above.
- The owner pauses and resumes sales through the operator API. The switch
  takes effect at once. The answer says whether the journal acknowledged
  it; until it does, a host loss forgets it, and setting it again confirms
  it, as with a cancellation. A restore from the journal always comes
  back with sales paused, marked as paused by the restore, so a pause the
  journal never acknowledged can't silently reopen sales. The owner
  resumes them once the recovery is checked (S1, S5).
- `exposure_limit_sats` (optional) bounds what new quotes can add.
  Exposure is held funds (every output seen or mined paying an order's
  address, less what refunds have charged) plus reserved funds (the
  unpaid remainder of every quoted order holding its name: its price less
  what is seen paying it). A partial payment therefore releases nothing
  (S4). A quote that would bring exposure above the limit is refused, and
  the owner is alerted once until a quote is made again (S2). A refund
  lowers exposure, and an expired unpaid hold no longer counts (S3).
- As implemented, unpaid invoices count toward the limit, so anyone can
  fill it with free quotes and stop all sales until their holds end. The
  admission design above replaces that refusal with a pay-first quote; a
  public pilot needs that design, or no limit, not this refusal alone.
- The limit stops new invoices; it isn't a cap on the wallet's balance.
  Addresses already given out can still be paid, late or in excess, and a
  paid order's funds stay in the wallet, so the balance can exceed the
  limit. Nothing sweeps funds out: the refund builder spends each order's
  own payment outputs, so moving them would leave that order's refund
  unbuildable.
- For the pilot (workspace_owner, 2026-11-10): the smaller of ten times
  the highest listed price and the pilot risk budget. Its value in sats
  waits on the prices and that budget. Reaching it pauses new quotes
  until the owner raises it on purpose.

## Dutch auction

There is one model for v1: a stepped percentage decay over block height,
down to a floor. All values below are proposals.

Parameters. Each auction stores:
- start price `S` and floor `F`, in whole sats, with `1 <= F <= S`;
- start height `H0`;
- step interval `I`, in blocks, at least 1;
- number of steps `N`, at least 1, so prices fall for at most `N * I`
  blocks;
- payment window `W`, in blocks, at least 1;
- rounding unit `U`, in sats, defaulting to 1, with coarser rounding set
  explicitly;
- floor behaviour: stay at the floor (default) or end at the floor;
- the eligibility policy and its version;
- a quote cap per order.

Presets supply defaults, and each name can override any of them (proposal):
- Standard: `I = 6`, `N = 168` (about 7 days), `F = max(1, floor(S / 100))`;
- Short: `I = 6`, `N = 48` (about 2 days), `F = max(1, floor(S / 10))`.

Both use `W = 6` and `U = 1`, stay at the floor, and cap each order at 1,000
quotes. With an explicit `U > 1`, a preset floor is rounded down to a
multiple of `U`, never below `U`. The drop interval `I` and the payment window
`W` are independent.

Generations. Each run of an auction on a name is a generation, numbered per
name. Its configuration is frozen when it is created: every parameter above,
the stored schedule's digest, the generation number, and the configuration
format version. The SHA-256 of the canonical encoding is published before
`H0`. A configuration can't change after the first quote. Changing it means
ending the generation and creating a new one.

Schedule. When a generation is created, the store computes the price for
every step `k` from 0 to `N` once, and stores the result:
- `p[0] = S` and `p[N] = F`, exactly;
- for `0 < k < N`, `p[k] = max(F, U * floor(S * (F / S)^(k / N) / U))`,
  computed in decimal arithmetic with at least 40 significant digits;
- each step is then clamped so that `p[k] <= p[k - 1]`.

The stored integers are authoritative, and the store publishes them. Each step
lowers the price by `1 - (F / S)^(1 / N)` before rounding.

The schedule reaches the floor by step `N`, not necessarily at step `N`.
Rounding can bring it there earlier, and it can leave consecutive steps at
the same price. The floor step `kF` is the first `k` with `p[k] = F`. The
store computes it, displays the floor time from it, and warns the owner when
`kF < N`. For example, `S = 1,001`, `F = 1,000` and `N = 168` reach the floor
at step 1, with `U = 1` or `U = 100`.

Price at a height. Before `H0` the auction is listed with its start height and
an estimated start time, and no quotes are issued. At a tip height `h >= H0`,
the step is `k(h) = min(N, floor((h - H0) / I))` and the price is `p[k(h)]`.

Display. The buyer sees the current price, the next lower price and its
block, and the floor and when it is reached. Times are estimated from the
remaining blocks at 10 minutes each and labelled as estimates.

Worked schedule for the Standard preset with `S = 10,000,000` and
`F = 100,000`. It drops 2.704% per step, has no plateaus, and reaches the floor
at `kF = 168`. Its SHA-256, taken over the comma-joined integers, is
`ccb7e51746d468a8063870d5597e36c1b74e2c6415b5eed196d4e3edd733d846`:

| Step `k` | From height | About | Price (sats) |
| --- | --- | --- | --- |
| 0 | `H0` | start | 10,000,000 |
| 1 | `H0 + 6` | 1 hour | 9,729,605 |
| 2 | `H0 + 12` | 2 hours | 9,466,522 |
| 24 | `H0 + 144` | 1 day | 5,179,474 |
| 84 | `H0 + 504` | 3.5 days | 1,000,000 |
| 167 | `H0 + 1,002` | 7 days less 1 hour | 102,779 |
| 168 | `H0 + 1,008` | 7 days | 100,000 (floor) |

Quotes. A quote issued at tip height `h` locks `p[k(h)]` for payments mined at
heights `h + 1` to `h + W`. It has its own destination script and belongs to
one order and one generation. It is open until its window closes. A later
drop never changes an issued quote. A buyer who pays a quote after a drop pays
its locked price and gets no rebate (proposal).

New quotes. A buyer may get a new quote on the same order, keeping the order
link, recipient and eligibility evidence, in either case:
- the current price is lower than every open quote's price, which is a
  refresh after a drop;
- the order has no open quote, which is a renewal at the current price, even
  if that is unchanged. That covers the floor, rounding plateaus, and a
  payment window shorter than the drop interval.

Each new quote has a new destination script. Every quote ever issued is kept
and watched indefinitely, and a payment to an older quote within its own
window still qualifies at its older price. New quotes stop at the quote cap,
and the buyer then starts a new order. No new quote is issued once the
generation has ended.

Qualification. Order the outputs paying one quote by chain position: height,
then transaction index, then `vout`. The quote qualifies at the first output
where the running sum of its outputs mined within its window reaches its
locked price. An order qualifies at the earliest qualifying position among its
quotes. Outputs mined outside a quote's window, or that never complete a
quote, don't count toward qualification. They are excess, refundable once
settled. Only the mined height counts, not when a payment was seen in the
mempool.

Winner. While the generation has no converted winner, the provisional winner
is the qualifying order whose qualifying position is earliest on the chain,
compared by height, then transaction index, then `vout`. That is the earliest
qualifying on-chain payment under this tie-break, not the highest price and
not whoever sent first. `vout` settles one transaction paying two competing
orders. Cancelled orders and orders the owner has removed never qualify. Every
reorg recomputes the provisional winner, including one that moves a payment
across a window's last block. Other qualifying orders are outbid and keep
their funds untouched until conversion.

Conversion. When the provisional winner's qualifying output becomes
batchable, in one transaction:
- the winner gets the name's fulfillment reservation, with `price_reserve`
  equal to the locked price of its qualifying quote, and its other funds
  become excess;
- the name's availability becomes "in fulfillment", and no fixed-price
  listing opens;
- every outbid order is cancelled and becomes refund due;
- the generation becomes `won`.

In a `won` generation, any order that qualifies later becomes refund due and
can never win. A cancelled order can't win after any reorg.

Winner losing depth. If the converted winner's qualifying output later loses
batchable depth, the winner keeps its fulfillment reservation and enters
`reconciling`. It is held out of batches until the output is batchable
again. No other order is promoted automatically. The owner may resolve it by
cancelling the order under the cancellation rules, and then a new generation
may start. After `issuing`, the cancellation rules apply as written.

Ending, retirement and cutover. A generation ends when a winner converts,
when the owner ends it, or, with "end at the floor", when the floor height is
reached. From then on no new quotes are issued. Outstanding quotes stay
payable until their windows close, and the winner rules still apply until
retirement. A generation that ends without a winner is retired once the tip
is at least six blocks past its latest window's end with no qualifying
payment. That threshold is a confirmation policy, not proof.

Retirement is recorded durably. A retired generation never produces a
winner. Only after retirement may the name change sale mode or availability,
for example to fixed price, to reserved, or to a new auction generation. If a
deeper reorg later makes a payment to a retired generation qualify, the order
enters `reconciling` and becomes refund due, and the owner is alerted. It
creates no winner and doesn't touch any later allocation of the name.

## Evidence and what it proves

Which evidence becomes public is open decision 5. This section states what
each piece supports, who receives it, and what still rests on trusting the
operator. Every element is a proposal.

Quote receipts. When it issues a quote, the store signs a receipt with a quote
key, whose public key is part of the generation's committed configuration.
The receipt covers the generation's configuration digest, a hash of the order
identifier, the quote height, the locked price, the last window height and
the destination script. The order page offers it to save. A saved receipt
proves what the store promised, independently of the store's later records.
Without one, the buyer relies on the operator's quote history, because an
order page can change.

| Claim | Evidence | Who can check it | Still trusted |
| --- | --- | --- | --- |
| The configuration was fixed before the auction started | configuration SHA-256 published before `H0` | anyone | the publication time |
| The price at height `h` was `p[k(h)]` | published configuration and schedule | anyone | nothing |
| My quote's price, window and script were as promised | the buyer's saved signed receipt, checked against the published configuration | the buyer | nothing, if saved; the operator's quote history otherwise |
| My payment qualified, or didn't | the buyer's own output on chain, against their quote window | the buyer | nothing |
| The winner qualified before me | the winner's qualifying position, disclosed to participants as below | each recipient | that the winning quote was genuine and its eligibility honest |
| No earlier qualifying payment was ignored | not provable from this evidence | nobody | the operator |
| Eligibility and cancellations were applied correctly | eligibility evidence, where policy publishes it | depends on policy | the operator for unpublished parts |

Disclosure of the winner's position. After conversion, every order in the
generation that had a quote receives the winner's qualifying block height.
An order whose own qualifying output is in the same block also receives the
transaction index and `vout`, which it needs to check the tie-break.

This is access-controlled disclosure, not privacy. Anyone eligible can
become a participant cheaply by opening an order, and recipients can pass the
information on. A block height narrows the winning payment, and a full
position identifies it, which can link the wallet that paid to the name.
Auction checkout says so before payment, in plain words such as: "If you
win, other bidders may be able to see which Bitcoin transaction paid." The
operator always knows the full position. Stronger public verification would
need commitments to issued quotes published as they are issued, which is
deferred.

## Batch entry and the binding pre-broadcast check

An order joins a batch only if all of these hold:
- it holds the name's fulfillment reservation;
- its `batchable_sum` covers `price_reserve`;
- no cancellation is recorded, and it isn't `reconciling` for issuance or
  for a retired generation. A refunds reason alone doesn't block issuance;
- its eligibility evidence still verifies under its recorded policy version
  and quota scope;
- its recipient isn't flagged by the stored-order audit, and no conflicting
  claim holds its script (see "Recipient requests"). The model has no
  recipients, so this condition is the service's alone.

Immediately before the batch is marked `issuing`, after proving, local
verification and the checkpoint, the controller checks every member again
against the same conditions, using depths from its own node. The check is
binding. If any member fails, the controller pauses the batch and rebuilds it
without that member, following the controller design: roll back, park, read
back, commit again, re-prove, verify, checkpoint, and check again. After
three rebuilds in a row it waits one block and alerts the owner. Broadcasting
despite a failed check is a merchant-risk policy that only the owner can
choose.

A member removed this way keeps its fulfillment reservation, enters
`reconciling`, and is batched again once it passes. It is never cancelled or
replaced automatically.

One commitment per space is in flight. No batch is frozen while another is
open, from `frozen` up to `final`, and only a rebuild replaces an open batch
before `issuing`. The delegate output a commitment spends is read from
`spaced` when the batch is marked `issuing`, not when it is frozen (B6, B7).

## Cancellation

An order is cancellable until its issuance transaction can escape. The
controller marks every member of a batch `issuing` in the same serialized
database transaction that records the broadcast intent, immediately before
calling `/broadcast`. A cancellation takes the same lock and succeeds only if
the order is not `issuing`, not fulfilled, and not a member of a commitment
whose issuance transaction may exist. The two transactions are serialized,
so exactly one wins.

The `issuing` marks and the broadcast intent are acknowledged off-host
together before `/broadcast` is called, and the call checks both immediately
before it is made. If either is missing, nothing is sent and the batch waits
in `issuing`. After a restore, every member of a batch with a journaled
intent, a `txid` or a later state is marked `issuing` again before any
cancellation is accepted, even if the store's own journal lagged behind
(J3, J4).

Reporting. A cancellation is reported final only once the order's cancelled
state is acknowledged off-host. Until then the answer says it is
unconfirmed, and doesn't give the cancelled status: the cancellation is
recorded here only, and a host loss before the acknowledgment undoes it.
The buyer's order link says the same: it shows the order's last
acknowledged status with the cancellation marked unconfirmed, and shows
`cancelled` only once that is acknowledged. Cancelling again once the
journal is back confirms it (J12, H10). Provenance: adopted in draft 14 on a
reviewer's recommendation of 2026-11-08, and confirmed by the
workspace_owner on 2026-11-10 (pilot decisions).

A cancellation is committed before any refund is built. A cancelled order
never enters a batch again. If it is in a batch that hasn't reached
`issuing`, that batch is rebuilt without it.

After `issuing`, the order stays non-cancellable until one of these:
- it is fulfilled, and then it is never cancellation-refunded;
- its fulfillment is safely superseded, as defined below, and then it
  returns to paid and may be cancelled or batched again;
- its batch is known never to have been sent, and the member fails the
  binding check that is repeated before the first transmission. The batch
  is journaled as rebuilt first, and then its members return to paid (J9).

A batch is known never to have been sent when this host never attempted the
call, or when its broadcast intent never reached the off-host journal, since
no call is made without it. Once a call may have been made, only the
uncertainty path applies.

Safely superseded means one of these is true on the best chain, at settled
depth, and `spaced` reports a commitment state that does not include the
batch's root:
- a different transaction spending the same delegate output as the issuance
  transaction has confirmed, so the issuance transaction can never confirm;
- the mined commitment was rolled back, or replaced by a newer commitment
  from the same delegate, before protocol finality.

Mempool absence, a reorg that unconfirms the commitment, a "dropped" label,
or time passing are not supersession. A rollback or replacement is an
on-chain action, and the controller never takes one by itself; it needs the
owner's explicit decision.

Safe supersession rests on settled depth, so a deeper reorg can undo it. If
the superseding spend leaves the best chain, the batch is live again,
because its own commitment can confirm. It returns to `broadcast`, the owner
is alerted, and its members that are still paid are marked `issuing` again.
A member already cancelled, refunded or in another live batch keeps its
status and gets a recovery incident. No commitment is issued from a delegate
output that an earlier attempted commitment also spends, unless that one is
safely superseded (X10).

## Refunds

A refund goes to an address the buyer supplies through the order link, never
to an input address.

Never to one of the store's payment addresses either: not the order's own
and not another order's, whatever that order's status. Every output paying
an order's address counts as a payment to that order, so a refund sent
there would move funds from one order to another, could make a cancelled
order refundable again, and could cycle between orders, losing a fee each
time. The exclusion holds both ways across the store. The refund address
is refused if any order holds it as its payment address, and a quote never
takes a payment address that any order holds as its refund address; the
store asks its wallet again, as for an address another order holds (T1 to
T3). The refund address is fixed once a refund for the order is built
(T4). The reference model has no refund addresses; these are rules of the
service.

Kinds. A cancellation refund returns the order's settled funds net of fee,
after the cancellation is committed. In the Python behavioral baseline, an
excess refund returns only funds above `price_reserve` and is allowed in
any state, including `issuing`, broadcast and fulfilled. The TypeScript
public pilot applies K21 from `PILOT-SPEC.md`: an unconverted checkout is
cancelled or refund due before returning its partial payment, and a
subsequent purchase uses a new checkout. Converted orders keep the normal
excess-refund rule. This does not amend the frozen Python baseline.

Causes of refund due: not eligible, a late payment that lost the name, an
outbid auction order, an `already_*_different_spk` outcome, underpayment when
the hold ends, and an owner-approved cancellation. A buyer may cancel before
the order enters issuance, serialized against issuance (pilot decisions,
2026-11-10); that isn't built yet, and today only the owner cancels.

Obligation groups. Each refund the order owes is one obligation group, for
example an excess refund and a later cancellation refund. A group holds every
attempt ever made for it:
- its first attempt;
- fee bumps within a family, each of which spends every input of the
  family's first attempt;
- exclusive replacement families, built under the release rules below.

Every attempt in a group must be mutually exclusive on-chain with every other
attempt, so at most one can confirm.

This is the one authoritative calculation. A group's reservation is the
largest `charged` among all its attempts, counted once. It is a maximum over
every attempt ever made, not only those still live, so an attempt revived by
a reorg is always covered. A replacement with a lower amount therefore frees
nothing until the group closes.

A group closes when one of its attempts reaches settled depth. That attempt's
`charged` moves into `refunded_total`, and the group's reservation leaves
`reserved`. If a deeper reorg unconfirms it, the group reopens:
`refunded_total` loses that amount, and the reservation returns to the
maximum over all attempts. Every figure is recomputed from the journaled
attempts, so a restart reproduces the same totals.

Lifecycle of an attempt:
1. Reserve, in one transaction under the authorization rule: the full
   `charged` for a new group's first attempt, or only the increase over the
   group's reservation for a further attempt. Journal the attempt and the
   group's new reservation off-host before anything leaves the store.
2. Build. With a capped hot wallet, sign and store the raw transaction and
   its `txid`. With an owner-signed PSBT, store the PSBT. Journal it off-host
   before it is exported.
3. Broadcast. Record the attempt as broadcast before calling the node and
   record the answer after. A rebroadcast of the same transaction needs the
   same acknowledged journal entry, checked immediately before the call (J5).
4. Reconcile on every block and restart, by looking every family member up
   in the mempool and the chain.

Release rules:
- An attempt at settled depth closes its group, as above. If a deeper reorg
  later unconfirms it, the group reopens, the order enters `reconciling`
  (refunds) if exposure appears, and nothing new is authorized for that
  amount.
- A conflicting spend of any input of the family at settled depth marks it
  "needs rebuild", and the group's reservation stays. A fresh family may be
  built only while that conflict is settled, and only if the fresh family is
  mutually exclusive on-chain with every earlier member of the group:
  - it spends an input that an earlier member also spends and that is still
    unspent; or
  - it spends an output of the conflicting transaction that invalidated the
    earlier member, so if a reorg removes that conflict, the fresh family
    becomes invalid too.

  If neither is possible, the controller pauses the obligation and alerts the
  owner. It never builds an independent payment, because an independent
  payment could confirm alongside the original after a deep reorg. Settled
  depth alone is not enough. Accepting that risk is a merchant-risk policy
  that only the owner can choose.
- An exported PSBT counts as possibly signed and broadcast from the moment it
  leaves the store, whatever the store's own copy shows. To abandon one, the
  owner spends one of its inputs to the refund wallet. The replacement can
  then depend on that transaction's output.
- An unacknowledged broadcast, a lost response or a refund dropping out of the
  mempool never releases a reservation. The controller rebroadcasts the same
  transaction or replaces it within the family.

## Host loss and restore

The store's database can be lost with its host. This section is the store's
own recovery from its off-host journal alone. The controller's recovery, the
`subs` data and the coordinated snapshot are in `CONTROLLER-DESIGN.md`, and a
restore from a snapshot plus the journal since it is later work.

What the journal holds. Every change to a name, an order, a refund group
with its attempts, an alert or a refund authorization is journaled as that
record's whole state. The latest acknowledged entry of each record is the
store's acknowledged state. An order's entry carries the SHA-256 of its
order link token, never the token, so a restored link still opens its order
and nobody can derive a link from the journal. Payment outputs are not
journaled: balances always come from the chain, so a restore recomputes
them, and only the history of an output that had already left the chain is
lost. The frozen batch and `subs`' committed roots belong to the
controller's recovery and are not restored here.

One entry per write. Every record changed since the last acknowledgment is
written in a single journal entry, which is acknowledged whole or not at
all. Records that didn't change keep their earlier acknowledged state, so
the acknowledged state is always a state the store was really in, as in the
model, where the off-host copy is the whole durable state.

Restore is an explicit operator step, into a path where no database exists.
It never overwrites a database. It refuses a journal with no records, which
is what a wrong or unmounted journal directory looks like, and one whose
latest state is inconsistent: an entry of an unknown kind, a record with a field the store
doesn't have, an order without its link hash or whose name has no entry, a
refund group whose order has none, or an alert or authorization that names
a missing order or group. It builds the database beside the target
and moves it into place only once it is complete, so a refused or
interrupted restore leaves nothing behind. Every restored attempt counts as
journaled, since its group's entry was acknowledged.

After a restore the store starts as it does after any restart: it reconciles
every refund attempt against the chain, rebroadcasts an attempted one that
the node doesn't know as the same signed bytes, and evaluates against the
chain before it serves anything (J1).

What a host loss undoes. A change that was never acknowledged is lost. A
payment seen meanwhile is a fact on the chain and is found again. A refund
group that was never acknowledged was never exported or broadcast, since
both wait for the acknowledgment (J2, J5). A cancellation that was never
acknowledged is undone, and the order returns to its last acknowledged
state; it was reported unconfirmed, never final (H10). A quote that was
never acknowledged is undone too, and its address was never given out, so
no payment can be stranded by it (H9).

A restored payment wallet can be behind the journal. The store's payment
and refund wallet is backed up at onboarding, and a wallet restored from
that backup has seen only the addresses that were paid since. It can give
out again an address that a restored, unpaid quote still holds. A quote
never takes an address an order holds, for its payment or as its refund
address: the store asks its wallet again, which advances it, and alerts the
owner once for the quote, saying how many it skipped. If the wallet gives
out only held addresses, more times than orders hold one, the quote is
refused and nothing is taken (H11, T3).

No empty start over a history. A start that finds no database, or one with
no names and no orders, while the journal has entries refuses to serve and
writes nothing. An empty store started over an existing journal would hand
out order ids again and could sell held or reserved names twice.

## Store process ownership (Python baseline safety amendment)

H12 adds a lifetime ownership lock to the Python store without changing its
payment rules. A start or restore must own the canonical database path
before journal construction/access, database initialization or startup
reconciliation. A second process refuses without modifying them. The lock
file remains in place and only the operating system releases ownership on
close or process death. Direct database close and failed startup release
it too. Canonical path aliases must contend for the same lock. This does
not replace the controller lock or the maintenance protocol for broadcasts.

## Checkout and the attended runner

Status (2026-11-09): requirements for the regtest checkout milestone.
Nothing here authorizes mainnet.

Checkout. The buyer pages are served by the store service, beside its
JSON API, and are plain HTML forms with no scripts. They add no rule: every
step goes through the same ledger call as the JSON API, with the same
refusals.
- The names page lists each listed name with its fixed price and whether
  it is free now. It shows nothing about orders.
- A name's page takes a public recipient request, such as a Nacho export,
  pasted whole. It is checked exactly as `POST /requests` checks a body,
  and its handle must also be the page's name. A refused request is never
  echoed, and the refusal names no member. An accepted one redirects to
  the private order page, at the order link's token.
- The order page shows only its own order: its status, its progress, and
  the invoice once quoted. The invoice is the fixed price, the address,
  and a BIP21 URI, `bitcoin:<address>?amount=<BTC>`, shown only under the
  same journal rule as `/quote`. A buyer asks for the invoice with a
  button. While the quote isn't acknowledged off-host the page says to try
  again and shows no address. The refund address is given on the same
  page, under the order link's rules.
- The page asks for payment only while paying can still buy the name: the
  order is quoted and holds the name, its hold hasn't run out, no
  cancellation is pending, the store's node sees no payment to the order's
  address, and its payment history is known to hold none. Only then does
  it show the
  amount to pay and the BIP21 link. In every other state the invoice is
  history: the price and address that were asked, with no link, and a
  plain statement not to pay. That covers a payment detected, converted,
  issuing, ready, fulfilled, cancelled, a cancellation being recorded,
  refund due, and expired unpaid.
- A payment the store's node sees, in the mempool or mined, is shown with
  its amount as "Payment detected, awaiting confirmation" until the order
  converts. One below the price is described as partial, and the page
  doesn't ask for the rest. Showing it changes nothing: only `confirmed`
  and deeper count toward conversion, settlement or a refund, and the hold
  runs by the Extension rule alone. The order link gives the same amount
  as `detected_sats`.
- A payment detected earlier that the node no longer sees may have been
  dropped or replaced, or the node may have missed it, and it can still
  confirm. The page says so and never asks for another payment because of
  its absence. After the hold ends unpaid, the page still says that it can
  confirm, and that it is then a late payment.
- Each order's payment history is `none`, `detected` or `unknown`, kept
  in the order's journaled state. It becomes `detected` the first time the
  node sees a payment to the order's address, and never goes back. A
  restore from the journal alone can't establish that no payment was seen
  after an order's last acknowledged entry, during a journal outage, or
  before the journal held the history. So every order that was given an
  address and isn't journaled as `detected` is restored as `unknown`; only
  an order never given an address is restored as `none`. An `unknown`
  invoice is never asked for: the page says the store can't tell whether
  a payment was sent before the outage, says not to pay, and after the
  hold ends still warns that one may confirm as a late payment. A payment
  the node sees later makes the history `detected`.
- A database from before the history is upgraded by the same rule. Its
  payment outputs aren't a complete history, since one restored from the
  journal holds none. An order with a recorded payment output becomes
  `detected`, any other order given an address `unknown`, and only an
  order never given one `none`. The column and its values are added in
  one transaction, so an interrupted upgrade leaves the database as it was
  and runs again at the next start.
- The certificate is downloaded from the order page. It is offered and
  served only while the order is `ready` or `fulfilled`, and only the
  certificate message the runner delivered for that order after verifying
  it. A certificate delivery has its own bound, 1 MiB of certificate,
  because a later batch's certificate carries a proof and is far larger
  than a request. Every other body keeps the 65,536-byte bound. The store
  doesn't verify certificates itself, and a buyer should
  verify a downloaded one before relying on it. Delivered certificates
  aren't journaled: after a restore the runner delivers them again from
  `subs`, with `certify`, for a ready or fulfilled order as for one being
  issued. `subs` builds a certificate on the space's latest commitment
  when it is fetched, so after a later batch of the same space it proves
  inclusion in that later root, not the batch's. `certify` accepts either:
  the batch's own root at its mined height, or a root at a greater height
  that `spaced` shows as a commitment of the space at the height the
  certificate states, on the active chain, at `d >= 150` and covered by a
  root anchor, while the batch's own root is still on the chain. Either
  way the certificate must verify with libveritas, name the order's handle
  and `script_pubkey`, and be sovereign. A later root on the chain that
  isn't final or covered yet means waiting, if the certificate is
  otherwise sound and libveritas reports it sovereign or pending: nothing
  is delivered or alerted, and `certify` runs again later. A dependent
  certificate is a failure, not waiting, whatever the root's depth. Any
  other failure delivers nothing and alerts the owner (A19).
- Every page is sent with `Cache-Control: no-store`,
  `Referrer-Policy: no-referrer` and a content security policy that
  allows no scripts and no framing. All text is HTML-escaped.

The attended runner. The operator carries orders through issuance with one
command-line tool, one step per command, attended. It drives the
controller (`CONTROLLER-DESIGN.md`) through the store's operator API.
Steps with no on-chain effect run on the command alone: preparing a batch,
watching it, verifying certificates and delivering them to the store,
publishing to the relay and confirming delivery, cancelling, and building
a refund. A step that sends a transaction needs the operator's
confirmation naming the object it sends. For a commitment that is the
batch id, and for a refund the refund group id, typed at the prompt or
given as `--confirm`. Without it nothing changes. Certificates are
delivered to the store only after libveritas verified them with every
check of the controller's step 11.

The runner builds the controller (`controller/`) from a host
configuration alone: addresses, cookie files, the store's operator token
file, the operator wallet's name, the commands that stop and start
`subs`, and what the running `subs` can do. It imports nothing from the
regtest harness, and the harness runs the same implementation through an
adapter over its stack. At this checkpoint the runner refuses every
network but regtest; the interfaces don't depend on the network.
- The configuration's network label proves nothing. Before every command
  but `status`, which reports it, the runner asks `bitcoind`, `spaced`
  and the store which network they are on, and asks each `subs` endpoint
  it uses, the one it writes to (which broadcasts) and the one it reads
  from, through that endpoint itself, for the network and tip hash of the
  `spaced` behind it. All must report the configured network. Chain
  identity is by block hash, never by height: `spaced`'s tip, each `subs`
  endpoint's `spaced` tip and the store node's best block must be on the
  controller's `bitcoind` best chain. Each `subs` endpoint must use the
  configured operator wallet. Otherwise nothing runs. A component that
  doesn't answer stops everything too.
- Every configuration value is checked before anything is created:
  paths and names non-empty, URLs `http` or `https` with a host and no
  credentials, commands argument lists, and timeouts positive numbers of
  seconds.
- A coordinated snapshot copies nothing while `subs` runs. The configured
  stop command must return only once `subs` has exited, and a connection
  to `subs` must then be refused. Any HTTP answer, even an error, shows
  that something still runs, and a timeout leaves the shutdown uncertain:
  either way nothing is copied. After the start command the controller
  waits until `subs` answers `/status` with a status before anything
  resumes. Otherwise the batch isn't checkpointed.
- The configuration states whether the running `subs` has the U1(b)
  route that attaches an adopted `txid` (`CONTROLLER-DESIGN.md`, "What
  this requires"). Without it the controller refuses the attach, saying
  that continued issuance needs that capability or another reviewed
  recovery procedure. Chain readback and adopting the transaction into
  the controller's journal work either way.

After a host loss the runner carries the controller's part of the
recovery (`CONTROLLER-DESIGN.md`, "Restore and reconciliation"), one
command per step, on a fresh host whose store has already been restored
from its journal and started:
- `restore` refuses a controller database that holds batches and a `subs`
  data directory that isn't empty, so it never overwrites. It takes the
  latest coordinated snapshot by its sequence number, and checks every
  `subs` file in it against the snapshot's manifest: a changed, missing or
  extra file refuses the restore, and nothing is copied. It copies only
  once a connection to `subs` is refused, starts `subs` and waits until it
  answers, as a snapshot does, and runs the network check of every other
  command first without `subs` and then with it. It then rebuilds the
  controller's batches from its journal and reconciles them (A12, A13).
  Snapshots are numbered after every snapshot already there, so the latest
  is well defined whichever process took them.
- `readback` reads an uncertain broadcast back from the operator wallet,
  the node's mempool and the chain, and adopts a `txid` only when a
  transaction carrying the batch's root is found. Finding nothing changes
  nothing. `attach-txid` tells `subs` an adopted `txid`, only with the
  U1(b) capability (A9). Neither sends anything.
- `resume` sends a batch left `issuing` and never sent, after the binding
  check again, and `rebroadcast` sends a commitment's identical journaled
  bytes to a node that has it on neither its chain nor its mempool. Each
  sends a transaction, so each needs the batch id confirmed like `issue`
  (A11).
- A commitment is often funded from the operator wallet's unconfirmed
  change, which can be another space's commitment still in flight
  (regtest R26). A fresh node knows none of them, and refuses the
  commitment's own bytes for a missing input. So the controller journals
  the bytes of every unconfirmed ancestor the node holds when it first
  journals a commitment's bytes, parents first, and `rebroadcast` sends
  each one the node lacks, as journaled, before the commitment itself.
  Ancestors that aren't the journaled ones refuse the rebroadcast with
  nothing sent (A15).
- After a restore, `issue` and `resume` are refused until the restore is
  reconciled: every batch closed, reconciled or paused for the owner;
  every commitment with a known `txid` on the node's chain or in its
  mempool; each space's restored `subs` root equal to the chain's, or one
  local commitment of an unsent or pending batch ahead of it; every
  adopted `txid` that `subs` lacks attached, or the space paused for want
  of the U1(b) capability; and the store started, which reconciles its
  refund attempts before serving (H6). A wallet restored from its backup
  doesn't know a transaction that this host hasn't seen again, so a new
  send could spend the same inputs. `status` and `restore` say what still
  waits. Readback, attach, rebroadcast and refunds aren't held up (A14).
- A controller database that lacks a batch its journal holds, a fresh
  one beside an existing journal included, needs a restore. That is
  recorded in the database when it is opened, before anything writes, so
  a restart doesn't forget it, and only a restore clears it. Until the
  restore has replayed and reconciled, the controller refuses every
  write and send, freezing a batch included, so no batch id is given out
  twice, and the runner refuses every command but `status` and `restore`
  (A16).
- The replay writes every journaled batch in one database transaction,
  together with the record that it was replayed, so an interruption
  leaves all of it or none. `restore` records each phase and resumes an
  interrupted restore when run again: `subs`' files, copied beside its
  data directory and moved into place whole, aren't copied twice, and a
  data directory holding exactly the snapshot's files counts as copied; a
  replay that didn't commit runs again and one that did doesn't; and the
  reconciliation, which is idempotent, runs again. A restore is found
  ready only once reconciled (A17).
- A controller database from an earlier schema gets the columns it lacks
  when it is opened, with its rows kept (A18).

## Acceptance gates

Paid sales stay closed until both gates pass. They are independent:
neither substitutes for the other, and each passes only on verified
evidence. A record counts when a verifying client accepts it against the
name's certificate, never when it is only seen in a relay's `/peek` output.
These definitions were brought from the operator's 2026-11-06 staging
handoff into this file on 2026-11-08, unchanged except for the timing
measurements.

Buyer gate, on a throwaway space, with Nacho as the client. Its plan is
`docs/BUYER-GATE.md`.
1. Issue two names to one buyer, each to its own script.
2. Import each certificate and verify it in the client: one by scanning a
   QR code shown on another device, the other from a file on the phone
   itself.
3. Sign a record update on each from the client, and verify it.
4. Transfer one, and confirm that the other stays under its holder's
   independent control.
5. With the store unavailable, recover on a clean install and control the
   remaining name: verify its certificate, sign a verified record update,
   and transfer it.

Operator gate: restore the store's database, the tree, `subs`' state and
the operator wallet consistently from the off-host recovery set onto a
fresh host. Reconcile every uncertain operation against the chain,
including an unacknowledged broadcast, a pending commitment and a pending
refund. Then issue another test batch successfully and verify its
certificates. The rehearsal is in `CONTROLLER-DESIGN.md`. It measures two
times, the store's replay from its journal and the complete recovery until
issuance and refunds can safely resume, and records the history size each
was measured on. Their targets are open points. Issuing another batch
after the recovery depends on `subs` being told the `txid` of a later
commitment restored without it: with the pinned `subs` that commitment
blocks the space's next local commit (R17), and the gate can't pass. It
needs `subs` with the U1(b) capability or another reviewed recovery
procedure. Pausing safely when recovery can't continue is right, but it
doesn't pass the gate.

Status (2026-11-09): rehearsed on regtest, not passed. Scenario 11
(`regtest/run-recovery.sh`) ran the rehearsal of `CONTROLLER-DESIGN.md`
on a fresh host, with the world on a separate node, `subs` with U1(b),
and the runner for every operator step it has a command for.
`regtest/REPORT.md` records what it showed, its two times with their
history, and what it didn't cover: an owner-signed PSBT refund family,
which the API can't export, a separate off-host store with its own
credentials, and anything off regtest. Passing the gate needs at least a
separate off-host store, the workspace_owner's recovery-time targets, a
reviewed recovery procedure for the deployment's `subs`, and a rehearsal
of the refund funding method the launch uses. For the pilot that is
attended hot-wallet refunds (pilot decisions, 2026-11-10). A reviewer
recommended one complete operating method for
launch: if v1 uses capped hot-wallet refunds, rehearse that method, which
the regtest run covered, and defer owner-signed PSBTs. If v1 uses
owner-signed PSBTs, the gate also needs a PSBT refund family rehearsed.

A second buyer client is future compatibility work, not a launch
prerequisite.

Finish line for the first launch: a reviewer recommendation of
2026-11-09, adopted by the workspace_owner on 2026-11-10 (the pilot
decisions at the top of this file). The first space launches once four
demonstrations pass and the workspace_owner then authorizes opening
sales:
1. Nacho works for an actual buyer. This is the buyer gate above. Its
   recovery step passes with a working, documented backup-and-restore
   procedure, without working out Nacho's key derivation.
2. The complete sale works. One public space, fixed prices, a public
   Nacho request, a Bitcoin invoice, the private progress link, and
   verified certificate delivery, all through the real service. A
   cancellation with its refund is shown through the same service too.
   This needs the checkout and the attended operator runner. Both exist
   on regtest (scenario 10). The runner builds the controller from a host
   configuration, and runs on regtest only.
3. A small public pilot can be operated. That means one chosen
   hold-admission policy (chosen on 2026-11-10, still to build), bounded
   operator-wallet
   funding, and a way to pause sales and handle alerts. Attended
   operation is enough; neither a general abuse-prevention system nor an
   elaborate admin interface is needed.
4. Recovery works once, end to end. This is the operator gate above, with
   one supported recovery method. Its next batch needs `subs` with the
   U1(b) capability or another reviewed recovery procedure.

The port handoff in `PORT-PLAN.md` adds the production coverage gate and
places the essential seller commands before this launch gate. One native
Linux/systemd installer and one recovery method are required. Open catalog,
bulk import, space archiving, ZK eligibility, auctions, more clients,
additional deployment packages and more recovery methods wait until after
the launch.

## Executable cases

Each case runs against a simulated chain and mempool with controllable reorgs
of any depth, a simulated node that can lose responses, an off-host journal
that can lag, and restarts at every durable step. A case is a requirement;
its executed tests establish the evidence for each implementation, as
distinguished in `PORT-PLAN.md`. Amounts are in sats. Unless a case says
otherwise, the price is 10,000 and the refund fee is 300.

Issuance and refund sufficiency:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| N1 | fixed-price quote at 10,000 | one 10,000 output reaches 3 conf | converts; enters a batch; not `reconciling` while `settled_sum = 0` |
| N2 | N1 at 3 conf | owner cancels and a refund is requested | nothing refundable until the 10,000 settles; then 9,700 to buyer and 300 fee |
| N3 | order paid 13,000 at 3 conf, converted | excess refund requested | refused until settled; issuance unaffected |
| N4 | N1 converted | a reorg drops the payment to 2 conf before `issuing` | `reconciling` (issuance); kept out of batches; reservation kept |
| N5 | order fulfilled at price 10,000 | any refund is requested | `price_reserve` stays 10,000; only excess is ever refundable |
| N6 | auction winner converted at 3 conf | normal progress | same as N1; not `reconciling` |
| N7 | order `issuing`, broadcast answer lost, no refunds | a reorg removes its payment | `reconciling` (post-issuance deficit); owner alerted; no cancellation, refund or reallocation; the uncertain-broadcast rule still applies |
| N8 | order in a mined batch, no refunds | payment falls below 3 conf | `reconciling` (post-issuance deficit); owner alerted; the commitment is not rebuilt, replaced or rolled back; the name stays in it |
| N12 | N8 | a replacement commitment is proposed for an unrelated reason | not built automatically; needs the owner's decision and safe-supersession conditions; the shortfall gives no authority |
| N9 | order fulfilled, no refunds | a deep reorg removes its payment | `reconciling` (post-issuance deficit); deficit recorded; name stays with the buyer |
| N10 | N9 | the payment is re-mined and reaches 3 conf | the reason clears |
| N11 | N9 | owner records a merchant loss | the reason clears; loss recorded |
| N13 | N11 done | the same deficit is evaluated on later blocks, then a further reorg deepens it by 2,000 | no new alert for the recorded amount; the reason is raised again, for the 2,000 difference only |

Refund arithmetic counterexamples:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| F1 | fixed-price order paid 13,000, settled, fulfillment reservation, not yet batched | excess refund requested | at most 3,000 reserved (2,700 to buyer + 300 fee); a request for 12,700 is refused |
| F2 | F1 setup | a second excess refund group is requested while the first is open | refused: open reservations already use the excess |
| F3 | order refund due with 10,000 settled | cancellation refund built | 9,700 to buyer, 300 fee, 10,000 reserved; recorded separately |
| F4 | F1 setup, excess group open | owner cancels the order | cancellation group limited to 10,000 (the price reserve is freed by cancellation), total reserved never above 13,000 |
| F5 | paid 10,400 | excess of 400 is below fee + 546 | no excess refund; minimum disclosed |

Payments and holds:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| P1 | quote | one 10,000 output reaches 3 conf in the hold | hold becomes fulfillment reservation |
| P2 | quote | one transaction pays 6,000 and 4,000 to the script | both outputs counted; conversion at 3 conf |
| P3 | quote | two transactions pay 5,000 each within the hold | conversion when both are batchable |
| P4 | P1 complete, not yet `issuing`, no refunds | the paying block is reorged out and the transaction re-mined two blocks later | same `txid:vout`, counted once; contribution drops to 0 while unmined; `reconciling` (issuance) and out of batches until it is batchable again, while `refund_exposure` stays 0; reservation kept |
| P5 | quote | 4,000 confirms and the hold ends | refund due for 4,000 once settled |
| P6 | P5 setup | 6,000 top-up confirms before the hold ends | conversion |
| P7 | seen output | replaced by a transaction not paying the script | unpaid when hold ends; no refund |
| P8 | output seen before expiry | 9 blocks pass without confirmation | hold ends at `seen_height + 6`; a later confirmation is a late payment |
| P9 | hold ended, name free, same price | late payment confirms | new hold; conversion at 3 conf |
| P10 | hold ended, another buyer holds the name | late payment confirms | refund due |
| P11 | hold ended, price raised | late payment confirms | refund due |
| P12 | hold ended, price lowered | late payment confirms, name free | proceeds; difference is excess |
| P13 | fulfillment reservation exists | 15-minute timer and extension both pass | reservation kept; name not released |
| Q1 | name free | two quote requests race | one hold; the other gets "taken for now" |

Dutch auction (Standard preset with the worked schedule, `W = 6`, unless
stated):

| Case | Given | When | Then |
| --- | --- | --- | --- |
| D1 | tip `H0 - 1` | quote requested | refused; listing shows start block and estimated time |
| D2 | stored schedule | prices read at `H0`, `H0 + 5`, `H0 + 6`, `H0 + 1,008`, `H0 + 2,000` | 10,000,000; 10,000,000; 9,729,605; 100,000; 100,000 |
| D3 | stored schedule | integrity check | `p[0] = S`, `p[N] = F`, non-increasing, `kF = 168`, digest matches |
| D4 | `S = 1,001`, `F = 1,000`, `N = 168`, `U = 1` | schedule created | `kF = 1`; floor time shown from step 1; owner warned |
| D5 | same as D4 with explicit `U = 100` | schedule created | `kF = 1`; same display and warning |
| D6 | Standard preset with `S = 12,345` | floor computed | `F = 123`; with explicit `U = 100`, `F = 100` |
| D7 | quote at `H0 + 5` locks 10,000,000 | drop at `H0 + 6`; 10,000,000 mined at `H0 + 8` | qualifies at the locked price; no rebate |
| D8 | D7 quote | buyer pays 9,729,605 to it | doesn't qualify; a top-up in the window qualifies; otherwise excess |
| D9 | open quote at step 1 | buyer asks again at step 2 | refresh: new quote and script on the same order |
| D10 | D9 done | payment to the step-1 quote mined in its window | order qualifies at the step-1 price |
| D11 | D9 done | both quotes paid in their windows | qualifies at the earlier position; the other payment is excess |
| D12 | open quote at step 2 | buyer asks again still at step 2 | refused; a quote is still open |
| D13 | at the floor, quote window closed unpaid | buyer asks again | renewal at 100,000 with a new script |
| D14 | `kF < N` plateau, quote window closed | buyer asks again at the same price | renewal allowed |
| D15 | `W = 3`, `I = 6`, window closed before the next drop | buyer asks again | renewal at the same price |
| D16 | order at the quote cap | buyer asks again | refused; buyer directed to a new order |
| D17 | quote at `h` | payment seen at `h + 6`, mined at `h + 7` | doesn't qualify; excess |
| D18 | payment mined at `h + 6` | reorg re-mines it at `h + 7` | qualification lost; provisional winner recomputed |
| D19 | payment mined at `h + 7` | reorg re-mines it at `h + 6` | qualifies; provisional winner recomputed |
| D20 | two orders qualify in one block | block mined | lower transaction index wins |
| D21 | one transaction pays X at `vout` 1 and Y at `vout` 0, both qualifying | block mined | Y wins |
| D22 | X quoted at step 1, Y quoted lower at step 2 | Y's payment mined in an earlier block | Y wins; position decides, not price |
| D23 | 6,000,000 and 4,000,000 on a 10,000,000 quote, both in its window | second output mined | qualifies at the second output's position |
| D24 | provisional winner X, outbid Y | reorg moves Y earlier before X is batchable | Y provisional winner; no refunds yet |
| D25 | provisional winner batchable | conversion | fulfillment reservation; name "in fulfillment"; outbid orders cancelled and refund due; no fixed-price listing |
| D26 | generation `won` | another order's in-window payment qualifies later | refund due; never a winner |
| D27 | outbid Y cancelled and refunded | reorg would make Y earliest | Y can't win |
| D28 | converted winner, not yet `issuing` | its output falls below 3 conf | winner keeps reservation, `reconciling` (issuance), held out of batches; nobody promoted |
| D29 | at the floor, default behaviour | new quotes requested | issued at 100,000 under the same rules |
| D30 | quotes outstanding | owner ends the generation and asks for fixed price | no new quotes; fixed price only after retirement; a qualifying in-window payment wins instead |
| D31 | "end at the floor", quotes outstanding | floor height reached | same as D30 |
| D32 | ended, no qualifying payment | tip reaches the latest window end + 6 | generation retired; mode change allowed |
| D33 | retired generation; name now fixed price with a buyer's reservation | a deep reorg makes a retired-generation payment qualify | order `reconciling` (retired generation) and refund due; no winner; fixed-price reservation untouched |
| D34 | generation with one issued quote | owner edits the floor | refused; end and create a new generation |
| D35 | generation created | configuration digest checked | matches the value published before `H0` |

Batch entry and the binding check:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| B1 | batch proved and checkpointed | one member's payment drops below 3 conf | batch rebuilt without it; member keeps reservation, `reconciling` (issuance); others proceed |
| B2 | batch proved | a member's eligibility quota conflict appears | same as B1 |
| B3 | every member passes | check runs | members marked `issuing` |
| B4 | restart between checkpoint and `issuing` | controller resumes | check runs again first |
| B5 | three rebuilds in a row fail | chain keeps reorganizing | wait one block; owner alerted; nothing broadcast |
| B6 | a batch is open, not yet broadcast, and another order converts | a second batch is frozen | refused until the first is final, rebuilt or superseded; no two commitments spend one delegate output |
| B7 | batch frozen; a safe supersession then settles and moves the delegate output | batch marked `issuing` | the intent records the delegate output read then, and the commitment spends it |

Cancellation against issuance:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| X1 | order cancelled | next batch built | excluded |
| X2 | order in a batch not yet `issuing` | cancellation lands during proving | batch rebuilt without it; refund proceeds |
| X3 | controller marking a batch `issuing` | cancellation races it | exactly one succeeds; if `issuing` won, the cancellation is refused |
| X4 | order `issuing`, broadcast response lost | cancellation requested | refused |
| X5 | order `issuing`, issuance transaction absent from every mempool for days | cancellation requested | refused; not superseded |
| X6 | commitment mined, then reorged out | cancellation requested | refused; a reorg is not supersession |
| X7 | a conflicting spend of the delegate output settles and `spaced` shows no commitment with the root | cancellation requested | allowed; order back to paid first |
| X8 | order fulfilled | cancellation requested | refused |
| X9 | order `issuing` with excess | excess refund requested | allowed; price reserve stays |
| X10 | X7 done, the member paid again, or cancelled | a reorg deeper than settled depth removes the superseding spend | batch `broadcast` again; owner alerted; a paid member `issuing` again and a new batch refused for that delegate output; a cancelled member keeps its status with a recovery incident |
| X11 | order `issuing`; the controller stops after attempting the broadcast and before recording its answer, whether or not the transaction reached the network | the controller restarts; cancellation requested | the batch `broadcast_uncertain`, journaled; cancellation refused; `resume` refused; readback adopts the commitment if it reached the network; never a second send |

Refund obligation groups:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| G1 | group with one attempt charged 10,000; `available = 0` | exclusive replacement charged 10,000 | allowed; `reserved` stays 10,000 |
| G2 | G1 setup with `available = 300` | replacement charged 10,500 | refused; it needs 500 |
| G3 | G1 setup with `available = 600` | replacement charged 10,500 | allowed; `reserved` 10,500; `available` 100 |
| G4 | attempt 9,700 to buyer plus 300 fee, net of fee | fee bump within the family to 600 | 9,400 to buyer; charged 10,000; no capacity used |
| G5 | G4 setup, the store absorbs the bump | fee bump to 600 | 9,700 to buyer; charged 10,000; 300 recorded as store cost |
| G6 | first attempt, an in-family bump and an exclusive replacement | none confirmed | `reserved` is the largest charged, counted once |
| G7 | G6 | the replacement settles | group closes; `refunded_total` gains its charged; `reserved` loses the group maximum |
| G8 | G7 | a deep reorg unconfirms it | group reopens; `refunded_total` reduced; `reserved` back to the maximum; `reconciling` (refunds) if exposure |
| G9 | G6 journaled | restart | recomputed `reserved` equals the value before restart |
| G10 | an excess group and a cancellation group open | totals evaluated | `reserved` is the sum of the two group maxima |
| G11 | group with an attempt charged 10,000 | replacement charged 9,000 | allowed; `reserved` stays 10,000 until the group closes |

Refund reconciliation:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| R1 | refund due | two refund requests race | one group reserved; the second fails authorization |
| R2 | refund signed | broadcast succeeds, response lost, restart | found by `txid`; no new family; reservation kept |
| R3 | refund signed | send failed silently; transaction in no mempool | same transaction rebroadcast; reservation kept |
| R4 | refund in mempool | evicted | reservation kept; rebroadcast or in-family replacement |
| R5 | refund fee-bumped | either member confirms | exactly one pays; recorded at settled depth |
| R6 | refund settled at 6 conf | a 7-block reorg unconfirms it | group reopens with its reservation; no new group; `reconciling` (refunds) if exposure |
| R7 | owner spends an input elsewhere, settles | reconcile | "needs rebuild"; group reservation kept |
| R8 | R7 done, fresh family not yet built | conflict reorged below settled | stays "needs rebuild"; fresh family not built |
| R9 | R7 done, fresh family built from a still-unspent old input | old refund and fresh one both broadcast | at most one can confirm |
| R12 | signed refund spends only input A; a conflicting transaction spends A and reaches 6 conf; no output of it is available | fresh refund would spend unrelated input B | refused; obligation paused; owner alerted; no independent payment |
| R13 | R12 setup, but the conflicting transaction pays the refund wallet | fresh refund spends that output | built; then a deep reorg removes the conflict, so the fresh refund becomes invalid; at most one of the two pays |
| R14 | R13 setup | old refund confirms after the reorg | group recorded as refunded once; fresh refund can't confirm |
| R10 | PSBT exported, store copy unsigned | owner asks to release it | refused; release only by a settled conflicting spend |
| R11 | payment settled, excess group reserved | payment falls to 5 conf after a reorg | reservation kept; `reconciling` (refunds); no new authorization; issuance continues while 3 conf hold |
| R15 | R11 | the payment returns to 6 conf | the refunds reason clears; the reservation is unchanged; authorization resumes with the same `available` as before the reorg |
| R16 | refund attempt settled at 6 conf, group closed | it falls to 5, then returns to 6 | group reopens, then closes again; `refunded_total` counts it once; `reserved` returns to its earlier value; no new attempt in between |

Refund destinations ("Refunds"). The model has no refund addresses; these
are service API tests over a simulated chain, not model results. The price
is 10,000.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| T1 | `one` quoted with payment address D; `two` requested | D given as `two`'s refund address, and as `one`'s | both refused "a refund never goes to one of the store's payment addresses"; neither order has a refund address |
| T2 | `one`'s hold ended unpaid, with payment address D1; `two` quoted and cancelled, with D2; `three` requested | D1, then D2, given as `three`'s refund address | both refused as in T1: a payment address stays the store's whatever its order's status |
| T3 | `one` requested, with refund address R given before its quote; `two` requested | `one` quoted while the wallet's next address is R; then `two` quoted while it is R again | each quote skips R and takes the next address, and the owner is alerted once for each, one skipped; neither order's payment address is R |
| T4 | `one` paid 13,000 and settled, with a refund address, and an excess refund built | another refund address given | refused "a refund has been built; its destination is fixed"; the refund address unchanged |

Recipient requests. The model has no recipient requests: its orders start
at the quote. These cases are rules of the service's boundary, and their
tests are the service's API tests over a simulated chain, not model results.
"Malformed" means refused before any state is read, with nothing created.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| V1 | listed name | a request with exactly `handle` and `script_pubkey`, canonical, with a valid P2TR key | order created; a new private order link returned; the request claims nothing, so the script stays open to other handles until an order on it converts |
| V2 | listed name | the request also carries `dev_private_key`, with a placeholder value | refused whole as malformed; no order, link, hold or journal entry; the value appears nowhere in the database or the journal |
| V3 | listed name | the request has any other extra member, repeats a member, lacks one, or has a member that isn't a string | refused as malformed; nothing created |
| V4 | listed name | the handle isn't canonical: uppercase, surrounding whitespace, a trailing newline, a label starting or ending with `-`, a leading `@`, Unicode, or no `@` | refused as malformed, never corrected; nothing created |
| V5 | a canonical handle the store doesn't list | request | "not for sale"; nothing created |
| V6 | listed name | the script isn't 34-byte P2TR: P2WPKH, OP_RETURN, 33 or 35 bytes, another witness version, or uppercase hex | refused as malformed; nothing created |
| V7 | listed name | a P2TR script whose key is off the curve: the coordinate at or above the field size, or `x^3 + 7` not a square | refused as malformed; nothing created |
| V8 | an order for `one` with script S has converted | a request for `two` with S, or a quote for an earlier `three` order with S | refused "script already used", naming no handle; nothing created or held |
| V9 | orders for `two` (quoted, hold active, unpaid) and `three` (requested) carry S first | `one` requests, quotes and pays with S | accepted and converted, and `one` passes batch entry: an unsigned request or an unpaid quote claims nothing |
| V10 | an order for `one` with script S | a second request for `one` with S | accepted as a retry: a new order and a new link; the first link still shows the first order and is never returned |
| V11 | a quoted order whose destination script is D | a request with D as its recipient | refused "script already used"; nothing created |
| V12 | `one` and `two` quoted on S; `one` converts and is frozen into `/pending`; then `two` converts | batch entry, marking `issuing`, setting the frozen batch, `/pending` | neither enters a batch; `/pending` stops serving `one`; the owner alerted once for each; cancelling `two` lets `one` enter |
| V13 | `one` and `two` quoted on S; `one` converts and is `issuing`; then `two` converts | batch entry for `two`, issuing recheck for `one` | `two` refused and alerted; `one`'s recheck passes |
| V14 | `one` converted on S | `one` cancelled, then `two` requests S; separately, an order on S2 fulfilled and the service restarted | `two` refused before the cancellation and accepted after it; a request for another handle on S2 refused after the restart |
| V15 | orders stored with an OP_RETURN recipient (one converted and already frozen, one already `issuing`, one requested) and one whose recipient is a store destination script, from a database without the audit column | the service starts | each flagged and alerted once, also across a second start; records unchanged; no quote; the converted one fails batch entry and the recheck, can't be marked `issuing` or frozen, and isn't served by `/pending`; the `issuing` one fails the issuing recheck |
| V16 | two converted orders for different handles, stored on one script | the service starts | both alerted; neither passes batch entry; records unchanged |
| V17 | a quoted order whose hold is active, on a script that another handle's order then converts on; separately, a quoted order with an active hold stored with an OP_RETURN recipient, from a database without the audit column | the quote is asked again; the service starts and the quote is asked again | the first refused "script already used"; the second flagged and alerted once, refused "recipient not accepted", and its order link shows no address; its record and hold unchanged |


Sales pause and exposure limit ("Fixed-price sales"). Service API tests
over a simulated chain, not model results. The price is 10,000.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| S1 | `one` quoted; the owner pauses sales; a request for `two` | `two`'s quote is asked; `one` is paid; the host is lost and restored from the journal; the owner resumes sales | `two` refused "sales are paused", with no destination and no hold, and the pages say sales are paused; `one` converts; the restored store is still paused and refuses again; after resuming, `two` is quoted; a non-boolean switch is refused |
| S2 | limit 25,000; `one` converted (10,000 received); `two` quoted with nothing seen | a quote for `three`, twice; then `two` is paid 30,000 | exposure 20,000; both quotes refused at the exposure limit, with no destination and the name still available; the owner alerted once; after the payment, exposure 40,000, above the limit |
| S3 | limit 25,000; `one` paid and settled; `two` quoted and unpaid; `three`'s quote refused | `two`'s hold expires; `three` quotes; a new `two` quote; `one` is cancelled and its 10,000-charge refund settles | exposure 10,000 after the expiry and `three` quoted; the new `two` quote refused and alerted again; after the refund, exposure 10,000 and the `two` quote made |
| S4 | limit 25,000; `one` and `two` quoted | 1,000 seen paying each; a quote for `three`; then each paid in full | exposure stays 20,000: each active invoice reserves its unpaid remainder; `three` refused; after full payment, still 20,000, and `three` still refused |
| S5 | the journal down | the owner pauses sales; the host is lost before the journal acknowledges it and restored; the owner resumes; then the host is lost again and restored | the pause answered 202, in effect but unacknowledged; the restored store paused, by the restore, and refuses a quote; after the acknowledged resume a quote is made; the second restore comes back paused too |
| S6 | a fresh store, paused before any name is listed: its database holds only the setting | restart; then the host is lost and restored from the journal; restart again | the restart opens it; with the database gone, startup still refuses until a restore; the restored store starts, paused by the restore, and after a resume quotes again |
Service restore ("Host loss and restore"). The model restores whole from its
journal (J1 and its generated host losses); these are the service's own
restore. H1 to H6 and H8 to H11 are service API tests over a simulated
chain. H7 runs the service beside the model and is a model-twin result.
None is regtest evidence.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| H1 | a converted order with a refund address, a cancelled order with a hot-wallet refund group, and their alerts and authorizations, all acknowledged; then the host's database is lost | restored from the journal alone into a fresh path, and started | names, orders, groups, attempts, alerts and authorizations as acknowledged; each attempt journaled; both order links open their orders; balances recomputed from the chain |
| H2 | the store's journal is down while a payment converts an order, another order is cancelled and a refund group is built for a third; then the host is lost | restored and started | the payment is found again and the order converts; the cancellation, reported unconfirmed, is undone; the refund group is absent and was never broadcast |
| H3 | the journal has entries, and the database is missing or has no names and no orders | the service starts | refused before serving; no database file is created and nothing is written |
| H4 | a database already exists at the restore target | restore | refused; the existing database unchanged |
| H5 | a journal with no records, an entry of an unknown kind, a record with an unknown field, an order without its link hash or whose name has no entry, or a refund group whose order has none | restore, and separately a restore killed partway | refused naming the record; no database created at the target or beside it; the killed restore leaves no database at the target, and a later restore succeeds |
| H6 | two acknowledged hot-wallet refund groups: one attempt mined, the other attempted but unknown to the node; the host is lost | restored and started | both reconciled before anything is served; only the unknown attempt is rebroadcast, as the same signed bytes; reservations and refunded totals as before the loss |
| H7 | the model's generated sequences, with host losses | at each loss the service is restored from its own journal | after every step it agrees with the model's restore on every name, order, group, attempt, authorization and alert, on the payment address each order shows, and on whether each cancellation is final |
| H8 | a requested order, and the store's journal down | the buyer asks for a quote; then the host is lost and restored | 503, no address; no destination taken, no hold, the order still `requested` and the name available; after the restore the quote succeeds and the link shows its address |
| H9 | two requested orders; the journal looks up but acknowledges nothing | each is quoted; the journal recovers between the two, and the host is lost after the second; then a database from before the journaled status restarts | 503 and no address from `/quote`, and none on the order link, for each while unacknowledged; after the recovery the first quote returns its recorded address; after the loss the second order is `requested` with no address and its name available, the first keeps its address; the old database takes the acknowledged statuses from the journal |
| H10 | two converted orders | one cancelled with the journal down, which then recovers; the other cancelled twice with it down; then the host is lost and restored | the first 202 "unconfirmed", its order link `converted` with the cancellation unconfirmed, then `cancelled` and final once the journal recovers, and still after the loss; the second 202 "unconfirmed" both times, without the cancelled status, its link `converted` and unconfirmed, and undone by the loss: converted with its fulfillment reservation, the link showing no cancellation; cancelled again after the restore, it is final on both |
| H11 | a paid order and an unpaid quote, then a host loss and a restore with a payment wallet that gives out the unpaid quote's address, then the paid one's, then a fresh one; separately, a wallet that gives out only held addresses | a new order is quoted after the restore | the quote takes the fresh address after asking three times; no two orders share a destination, the held ones unchanged; one `destination_held` alert for the quote, with 2 skipped; with the second wallet, 409, the order still `requested` and the name available |
| H12 | a live store owns its database, including through a canonical path alias | another process starts or restores; separately the owner closes, fails at startup or dies | second process refuses before database/journal access and changes neither; normal exit, failed startup, direct database close and process death release ownership; the lock file remains |

Checkout and the attended runner ("Checkout and the attended runner").
These are the service's and the runner's own rules. C1 to C11 are service
API tests over a simulated chain. A1 to A5 are runner tests against a
recording stand-in for the store and the controller, and A6 to A19 run
the runner and the controller against stand-ins for `subs`, `spaced`,
`bitcoind` and the store. None is a model result or regtest evidence; the
regtest demonstrations are scenario 10 (`regtest/run-checkout.sh`) and,
for the recovery commands, scenario 11 (`regtest/run-recovery.sh`).

| Case | Given | When | Then |
| --- | --- | --- | --- |
| C1 | two listed names, one held by a quote | the names page | both listed with their prices; the held one not available; no order data on the page |
| C2 | a listed name | a valid request for it is pasted on its page | an order created, as by `POST /requests`; a 303 redirect to the order page at the new link's token |
| C3 | a listed name | the pasted request breaks a recipient-request rule, carries a placeholder secret member, or names another handle | 400; nothing created; the page echoes none of the pasted text |
| C4 | a requested order | the buyer asks for the invoice with the journal acknowledging | the page shows the price, the address and `bitcoin:<address>?amount=<BTC>` with the amount in BTC |
| C5 | a requested order, and the journal looking up but acknowledging nothing | the buyer asks for the invoice | the page says to try again and shows no address; once the journal acknowledges, asking again shows the same address |
| C6 | an order | its page is opened with another token, an unknown token, or a malformed one | 404 with no detail; a known token shows its own order only |
| C7 | a converted order | the runner delivers a certificate for it | refused, nothing stored; once the order is `ready` the delivery is stored, and the page offers the download and serves exactly those bytes |
| C8 | a ready order with a delivered certificate | the order loses `ready` (finality lost) | the download is withdrawn: not offered and 404, until it is `ready` again |
| C9 | any page | it is served | `no-store`, `no-referrer`, a policy with `script-src 'none'` and `frame-ancestors 'none'`, and HTML-escaped text |
| C10 | a ready order, and a later batch's certificate of 226,511 bytes from kept regtest evidence | the runner delivers it | stored and served byte for byte; a certificate over 1 MiB, or a delivery body declared over its bound, refused and the delivered one kept; the larger bound only for the authenticated delivery: unauthenticated 401, and other operator bodies, `POST /requests` and the request form still refused over 65,536 bytes with nothing created |
| C11 | orders: quoted and holding with nothing confirmed; a payment at 1 confirmation, below the 3 that convert; converted, issuing, ready, fulfilled; cancelled; a cancellation unacknowledged; expired unpaid; expired with too little paid | each order page | only the first shows the amount to pay and a BIP21 link; every other shows the invoice as history, with no link and a note not to pay; an expiry not yet evaluated counts, because the page evaluates first |
| C12 | quoted orders: the full price entering the mempool, then confirming; too little in the mempool; a payment dropped from the mempool, then the hold ending; a payment replaced by a smaller one to the address, then by one not paying it. After a host loss and a journal-only restore: a payment detected with the journal healthy, then gone; one detected during an outage lasting until the loss, then gone; an invoice never paid; an order never given an address; a journal from before the payment history; a database from before it, upgraded directly, restored by the older code, and interrupted mid-upgrade | each order page, and the order link | no amount to pay and no BIP21 link once a payment is detected; the detected amount shown as awaiting confirmation, partial when below the price; nothing counted, converted or extended by the page; a dropped or replaced payment reported as possibly still confirming, never as a reason to pay again, also after the hold ends. After the restore, the journaled detection still reported; every other invoice `unknown`, with no payment request, also after the hold ends; the order without an address still offered an invoice; the older journal's invoices `unknown`; the older database's recorded payment `detected`, its other invoices `unknown`, its order without an address `none`; the interrupted upgrade leaving no column behind and completing at the next start |
| A1 | a checkpointed batch | `issue` without the batch id confirmed, or with another id | refused; the batch stays checkpointed, no order is marked issuing, and nothing is sent |
| A2 | a built refund group | `broadcast-refund` without its group id confirmed, or with another id | refused; nothing is sent |
| A3 | a final batch with two members, one failing a certificate check | `certify` | only the verified member's certificate is delivered to the store; the other is reported failed and not delivered |
| A4 | a checkpointed batch | `issue` with the batch id confirmed | the controller's issue step runs once, for that batch, at the given fee rate |
| A5 | a built refund group | `broadcast-refund` with its id confirmed | the store's broadcast is called once, for that group |
| A6 | a complete host configuration; separately, ones naming another network or none, missing the subs stop command, the stated capability, the operator wallet or the relay, giving a shell string or an empty argument as a command, a capability that isn't true or false, a null, empty or numeric path, an empty wallet name, a URL without a scheme, of another scheme, with credentials or with a bad port, or a timeout that is negative, text or `true` | the runner is built from it | built without importing any regtest harness module, with the configured wallet and capability; each faulty one refused before anything is created |
| A7 | a proved batch; after the stop command, `subs` still answering, answering HTTP 503, or not answering in time; separately, `subs` not answering again after its start command | `checkpoint` | refused; nothing is copied unless a connection to `subs` is refused, and the batch stays proved |
| A8 | a proved batch | `checkpoint` | `subs` stopped, then its data copied, then started and answering, then the batch checkpointed, with `subs`' files in the snapshot's manifest |
| A9 | a final batch with an adopted txid; `subs` with and without the stated U1(b) capability | attach the adopted txid, and a given one | without it, both refused, saying continued issuance needs the capability or another reviewed recovery procedure, and nothing is sent to `subs`; with it, one attach call each |
| A10 | a regtest configuration; `bitcoind`, `spaced` or the store on another network; the `subs` endpoint for writes, or the one for reads, backed by a `spaced` on mainnet, or on another regtest chain at a lower height with the same wallet name, or using another wallet; `spaced`'s tip or the store's best block on another chain; a store that reports no chain; or a component that doesn't answer | `issue` and `broadcast-refund`, each confirmed | refused before anything is called or written to `subs`, saying the network check failed; with every component on one regtest chain, the command runs |
| A11 | a batch `issuing` and never sent; a batch `broadcast` with journaled bytes | `resume` and `rebroadcast` without the batch id confirmed, with another id, or with an empty or differently cased one; `resume` for a batch whose broadcast was attempted, and `rebroadcast` for one with no `txid` | refused, nothing sent, the latter two before anything is asked; with the id confirmed, at the prompt or as `--confirm`, the controller's resume and rebroadcast each run once |
| A12 | a fresh host | `restore` with a controller database that holds batches, a `subs` data directory that isn't empty, no snapshot, a snapshot whose `subs` file changed, is missing or has an extra file beside its manifest; separately, `subs` still answering after its stop | refused naming the reason; nothing copied, written or recorded, and `subs` neither stopped nor started for the first five; nothing copied for the last |
| A13 | journaled batches `final`, `checkpointed` (held by the snapshot), `issuing` with its intent (no answer), `broadcast` with its bytes, and `committed_local` after the snapshot; snapshots 009 and 010 | `restore` | the network check without `subs`, the stop, the copy of snapshot 010 only once `subs` refuses connections, the start, the network check with `subs`; the `committed_local` batch rebuilt and journaled, its member still paid; the `issuing` one `broadcast_uncertain`, read back, nothing adopted, sent or rolled back; the others as journaled; the next snapshot numbered 011 |
| A14 | A13 restored: one uncertain broadcast, one commitment the node doesn't have, attaches needed; separately, the store not reconciled, and a `subs` without U1(b) | `issue` and `status` after each recovery step | `issue` refused, saying what waits, until the rebroadcast, a readback that adopts the uncertain one, and both attaches; then it runs once; a store not reconciled waits; without U1(b) the space is paused, not waiting |
| A15 | a commitment spending from two unconfirmed transactions in a chain and a confirmed one | its bytes captured; then `rebroadcast` to a node that has none of them, to one that has the first, and with ancestors that aren't the journaled ones | the two ancestors journaled with it, parents first, the confirmed one not; sent parents first, then the commitment; one the node has isn't sent again; the last refused, nothing sent |
| A16 | a journal holding five batches, one an uncertain broadcast; a fresh, empty controller database beside it, and separately one holding only the first | the controller is opened, closed and opened again; then a freeze, an issue, a resume, a watch, a rebroadcast, an attach, a certificate check, a checkpoint and a local rollback; and every runner command but `status` and `restore` | "restore required" recorded once and kept across the restart, naming the missing batches; each refused, no batch created, nothing sent or written to `subs`; the runner exits 3 for every command; the readiness report not ready; after `restore` every journaled batch is present |
| A17 | the A16 journal and a snapshot | the replay killed after its second insert; `restore` stopped after its first insert, after `subs`' files were moved in; stopped again during reconciliation; then run again; and separately a `subs` directory already holding exactly the snapshot's files | after each stop, on reopening: no batch, then no batch, then all five; "required", "required", then "incomplete"; never ready, `issue` refused and every command refused; `subs` not copied again and the journal not replayed again; the last run reconciles, and the batches are as A13 has them; the exact directory taken as copied |
| A18 | a controller database with the schema of commit `5226810` holding a broadcast batch and an alert, and the batch's journal entry from before `ancestors` | opened, its bytes captured as after a broadcast, opened again and replayed | `ancestors` and the recovery columns added, the rows unchanged, no restore required; the bytes and their ancestor journaled; nothing changed by the second opening; the older entry replayed into the migrated table |
| A19 | a final batch whose root is at height 1,000, a fulfilled member, and the space's commitments at 900, 1,000 and 1,200 on the chain | `certify`, with the certificate built on the batch's own root; on the root at 1,200, final and covered; on it at `d = 149`, and with the newest anchor 132 past it; failing libveritas, naming another handle or recipient, not sovereign, dependent on the batch's root or on the later root whether final and covered, at `d = 149` or uncovered; on a root not on the chain, at another height, on the earlier root, or on the batch's root at another height; and on the later root after the batch's own root left the chain | delivered on its own root and on the later final, covered root, the fulfilled order kept fulfilled and an issuing one made ready; waiting, with nothing delivered or alerted, until the later root is final and covered, then delivered, unless the certificate is dependent; every other case refused, nothing delivered, the owner alerted once each |
| A20 | a batch `issuing`, its intent and its members' marks acknowledged | `/broadcast` answers with a body that isn't JSON, an empty body, an object without a `txid`, a `txid` that isn't 64 hex digits, or an HTTP error, or its answer is cut short partway through | each time the batch becomes `broadcast_uncertain`, with the answer's body recorded as it came, cut at 2,000 characters with a note of its length, and the owner alerted; `resume` is refused and readback runs; `/broadcast` was called once |
| A21 | A20's batch; separately, a database missing a batch the journal holds, with a stale row `issuing` and attempted for a batch the journal holds as `broadcast` with its txid and bytes | the controller stops after attempting `/broadcast` and before recording any answer, and is opened again, once with the journal down and then with it back; separately, it stops inside the opening's transaction, and after it, before the journal entry; separately, the stale database is opened and restored | the batch is `broadcast_uncertain` before anything else runs, and the owner alerted once, the state and its alert written together or not at all; with the journal down that is local only, and the next opening journals it, without another alert or a send; `resume` is refused, readback runs, and `/broadcast` is never called again; the stale row is left as it is until the replay, which restores the txid and bytes from the journal |
| A22 | a database holding every batch its journal holds, with one batch `issuing` and attempted and another `broadcast_uncertain`, where the journal holds both `broadcast` with their txids and bytes | the controller is opened, then opened again | each batch takes the journal's copy, its state, txid and bytes, and the owner is alerted once for each that the database was behind its journal; no restore is needed, nothing is sent, and `resume` is refused |
| A23 | one controller owns its database, with a broadcast still waiting for an answer | another process runs `status`; separately, the owner exits normally, fails during startup or is killed after recording an attempt | the second process refuses with `controller busy`, changes no state or journal and raises no alert; the live send records its answer once; ownership is released on close, failed startup or process death, and only then does reopening settle a genuinely interrupted attempt once |

Evidence:

| Case | Given | When | Then |
| --- | --- | --- | --- |
| E1 | saved quote receipt | buyer verifies it against the published configuration and quote key | signature and fields check out without the store |
| E2 | no saved receipt | buyer disputes a quote | the store's quote history is the only evidence, and the spec says so |
| E3 | conversion | disclosure runs | every participant gets the winning block height; only same-block participants get the index and `vout` |
| E4 | auction checkout | before payment | the disclosure consequence is shown |

Restore against reservations (with `CONTROLLER-DESIGN.md`):

| Case | Given | When | Then |
| --- | --- | --- | --- |
| J1 | refund family journaled off-host, host lost before broadcast | restore and reconcile | family and reservation present; transaction looked up before anything is rebroadcast |
| J2 | journal acknowledgment missing | refund export or broadcast attempted | blocked until the journal acknowledges |
| J3 | store's journal unavailable, controller's available | batch marked `issuing` | nothing broadcast; batch stays `issuing`; one broadcast after both journals acknowledge |
| J4 | J3 setup, intent journaled by the controller; the store's journal still shows the members paid | host lost and restored | members `issuing` again before anything else; cancellation refused |
| J5 | refund attempt not acknowledged off-host | rebroadcast requested | refused; nothing sent |
| J6 | members' `issuing` marks journaled, broadcast intent not (controller's journal down) | host lost, restored and resumed | intent acknowledged before the one send; `/rollback-local` refused afterwards |
| J7 | intent not acknowledged when `issuing` was entered; the journal later recovers; no restart | resumed | sent once; a second resume is refused as uncertain |
| J8 | broadcast answer lost; readback adopted the `txid` but the controller's journal missed it; batch final, member ready in the store's journal | host lost and restored | chain read back first; `txid` adopted; batch final and member ready; a member is never ready while its batch isn't final |
| J9 | batch `issuing`, broadcast never attempted (journal outage, with or without a host loss); a member's payment is then reorged out | resumed | binding check repeated with fresh depths, eligibility and delegate output; nothing sent; batch rebuilt without the member, which is paid again and `reconciling` (issuance) |
| J10 | the controller's journal is stale at `broadcast` while the store's shows the member ready; the commitment is then reorged out and the owner's supersession settles | host lost and restored | batch superseded; member back to paid, never ready |
| J11 | a quote asked while the store's journal is down; separately, a quote recorded whose acknowledgment doesn't arrive | the host is lost | the first refused, with no order and no hold; the second gives no payment instructions, and the loss removes it and its hold; a quote acknowledged before a loss keeps its instructions and hold |
| J12 | two converted orders | one cancelled with the store's journal up, the other twice with it down; the host is lost | the first reported final and still cancelled; the second reported unconfirmed both times and undone, its reservation back; cancelled again with the journal up, it is final |

Finality, publication and delivery (with `CONTROLLER-DESIGN.md`):

| Case | Given | When | Then |
| --- | --- | --- | --- |
| L1 | batch final, members ready | a reorg takes the commitment below `d >= 150` or off the chain | batch `mined` or `broadcast`; owner alerted; members `issuing` and non-cancellable; publish and delivery refused |
| L2 | L1 | the commitment returns to `d >= 150` | batch final again; members ready; publish and delivery proceed |
| L3 | batch final, a member not yet published | its delivery is confirmed | refused until its handle is published |
| L4 | member fulfilled; a reorg then takes the commitment off the chain | the owner's supersession settles | batch superseded; member stays fulfilled; nothing unissued or refunded; the order's recovery incident is open and the owner alerted |
| L5 | L4 | the certificate is queried, then the operator resolves | not current while the batch isn't final; the incident stays open until a resolution is recorded, and resolving changes no status, refund or reservation |
| L6 | batch final at `d >= 150`, newest root anchor 138 blocks past the commitment | certificate verified | pending: member stays `issuing`, waiting for anchor coverage; nothing paused; publish and delivery refused; ready once an anchor is 144 past the commitment |
| L7 | final commitment, its signed bytes journaled; a reorg takes it off the chain and it is in no mempool | recovery | identical bytes rebroadcast after the journal check; never `/broadcast`; final and ready again once mined to `d >= 150` and covered |
| L8 | broadcast answer lost and the transaction evicted before any readback, so no bytes were journaled | recovery | refused; recovery paused and owner alerted; members `issuing` and non-cancellable; with U1(c), bytes journaled before the send make the same case recoverable |
| L9 | batch final and covered, a member published; a later commitment of the same space is mined, at `d = 149` | the member's delivery is confirmed | waits: the relay serves the certificate under the later root, so delivery is refused while that root is below `d >= 150` or no anchor covers it; nothing paused; confirmed once both hold (regtest R24) |

Eligibility has no cases here yet. `ELIGIBILITY.md` names the tests it
requires: an altered name, an altered recipient, the wrong scope, a replay,
and a quota race between two orders with the same nullifier, run with
ZKPassport's `verifierMode: "local"`. None of them exists, and the coverage
gate doesn't count them.

## Open points for the owner

Decided on 2026-11-10 for the first pilot (the pilot decisions at the top
of this file): the finish line and the stack the pilot ships on; the size
of the first pilot, reviewed at ten paid orders; the hold-admission policy
for public names, with its numbers, full payment for a late
reacquisition, same-block ties to the earlier quote, and a race loser
refunded less the refund fee; the 15-minute hold; refund funding,
attended hot-wallet refunds with owner-signed PSBTs deferred; how the
exposure limit is set; and the recovery-time targets. Each is still to
build or to demonstrate.

Deferred with the features they belong to, so not decisions for the
first launch: the hold-abuse rule for proof-gated names (how often one
nullifier may hold a name), since the first launch has no ZK eligibility
(launch scope, 2026-11-08); and the auction presets, since auctions wait
until after the MVP (MVP scope, 2026-11-06).

Also decided on 2026-11-10, in the further pilot decisions: buyer
cancellation before issuance; the cancellation reporting rule; the refund
deadline; refund fees and their split; the excess minimum; the delivery
target; and which evidence is published.

These stay open, and are the workspace_owner's to set:
- the price of each name;
- the pilot risk budget, and so the exposure limit's value in sats;
- the buyer's refund fee ceiling, and the operator's fee limits for
  refunds;
- the buyer gate's amounts and fee limits (`docs/BUYER-GATE.md`,
  "Transaction plan").

The auction presets, for when auctions are taken up: start-to-floor
ratio, step interval, duration, payment window, rounding unit, floor
behaviour, quote cap, and no rebate after a drop.

The recovery-time targets are to be measured, each with the history it
was measured on: the sales period, order count, and journal entries and
bytes. A fast database replay alone doesn't show that issuance and
refunds can resume, and a small rehearsal alone doesn't show that a full
replay is fast enough for a representative history. Restoring from a
snapshot plus the journal since it is needed only if replay misses its
target. Both were measured once on regtest, and the replay on generated
journals sized for assumed pilot periods (`regtest/REPORT.md`, scenario
11); those numbers inform the targets and don't set them.
