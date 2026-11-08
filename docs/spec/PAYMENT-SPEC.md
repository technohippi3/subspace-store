# Subspace store payment specification (draft 12, 2026-11-07)

MVP scope (workspace_owner, 2026-11-06): fixed-price sales first. The Dutch
auction section, its cases D1 to D35, case N6, and the auction evidence
cases E1 to E4 are kept but deferred until after the MVP.

Status: draft specification under review. Every rule below is a
requirement until its cases are implemented and pass as executable tests.
Nothing here has been built or tested, and a reviewed specification is not an
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
every start audits stored recipients.

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
discloses (proposal), the whole fee is charged, so `charged = to_buyer + fee`.
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
  refused, and so is a request whose script is one of the store's own
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
flagged order gets no quote. Once converted it fails batch entry and the
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
by the server's clock (proposal). A second buyer who asks for a held name
gets "taken for now" and no quote.

Open: hold abuse. A request and a quote cost nothing and need no account, so
one caller can keep a name "taken for now" indefinitely by quoting again as
each hold ends. A reproduction against the service's API over a simulated
chain showed this on 2026-11-07; no committed test covers it. It is an open
design issue and blocks any public pilot. A fix has to limit repeated
acquisition, not only concurrent holds: a per-passport quota that counts
active holds still lets the same holder take the name again after every
expiry. Proof-gated names need a rule on how often one nullifier may hold a
name. Public names have no identity to count, so they need an admission
policy of their own. No case covers this yet, because the rule isn't
decided.

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
order takes a new temporary hold at the quoted price and proceeds. Anything
above the current price is excess. Otherwise the order becomes refund due.
Late payers are never queued.

Several outputs, underpayment and overpayment. All the order's outputs add
up, in one transaction or several. The buyer may top up while the hold
lasts. A hold that ends short of the price makes the order refund due for its
settled funds. Funds above the price are excess and are refundable once
settled, because `price_reserve` keeps the price back. An excess smaller than
its refund fee plus 546 sats is not refunded, and checkout discloses that
minimum (proposal).

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

Kinds. A cancellation refund returns the order's settled funds net of fee,
after the cancellation is committed. An excess refund returns only funds above
`price_reserve` and is allowed in any state, including `issuing`, broadcast and
fulfilled.

Causes of refund due: not eligible, a late payment that lost the name, an
outbid auction order, an `already_*_different_spk` outcome, underpayment when
the hold ends, and an owner-approved cancellation. Voluntary cancellation by
the buyer of a deliverable paid order is not offered in v1 (proposal).

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

## Executable cases

Each case runs against a simulated chain and mempool with controllable reorgs
of any depth, a simulated node that can lose responses, an off-host journal
that can lag, and restarts at every durable step. Status for every case:
requirement, not yet implemented. Amounts are in sats. Unless a case says
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

These stay proposals until decided:
- the hold-abuse rule under "Fixed-price sales", for proof-gated and for
  public names; it blocks any public pilot;
- refund funding (an owner-signed PSBT or a capped hot wallet) and the refund
  deadline;
- the 15-minute hold, the excess minimum, and refunds net of fee;
- whether v1 offers voluntary cancellation;
- the auction presets: start-to-floor ratio, step interval, duration, payment
  window, rounding unit, floor behaviour, quote cap, and no rebate after a
  drop;
- which evidence is published.
