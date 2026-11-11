# TypeScript refund families

This implements the existing obligation-group and replacement rules in
`PAYMENT-SPEC.md`, extending `REFUND-SENDING.md`. The original group record
remains its first attempt. Further attempts are separate journaled records;
old signed bytes, charges and broadcast history are never overwritten.
Paid sales remain closed pending the full pilot gates.

## Authorization and accounting

A group's open reservation is the maximum charge over its first and all
further non-void attempts. Adding an exclusive attempt needs only its
increase above that maximum, checked against current available credit in
the same serialized store command. Negative availability authorizes nothing.
A lower charge releases no historical capacity. A settled member closes
the group at that member's actual charge; loss of settlement restores the
historical maximum. Two members reported mined on the same active chain
are rejected before changing persisted observations.

An independent TypeScript ledger and transaction-graph model now checks
these unchanged rules, alongside the frozen Python baseline. Its fixed
cases and 300-step seeded history/replay test import no production code.
Model results remain separate from SQLite/RPC and real Core evidence.

`bumpRefund` and `rebuildRefund` are programmatic operator commands. They
reserve the new attempt and acknowledge it off-host before signing. Failed
or interrupted work retains the reservation; `buildRefundAttempt` resumes
it, and only an unbuilt attempt can be discarded. There can be only one
unbuilt attempt per group. Mined or settled members block new preparation.
There is still no operator HTTP route or automatic fee escalation.

Buyer-caused fees remain within the ceiling disclosed at quote. An
explicit choice to absorb the increase preserves the previous buyer fee
deduction; the merchant funds the rest. Merchant-caused refunds remain
fully merchant-funded for fees. All previous rate, transaction-fee and
refund limits remain binding. The builder measures signed virtual size
and checks Core acceptance; a selected rate that cannot satisfy replacement
policy refuses rather than escalating automatically.

## Exclusivity evidence

A bump retains every input of its parent, and therefore the family's first
attempt. Each new attempt additionally carries a proof against every prior
signed member of the group, including members of earlier families. A proof
requires a shared input or an input that spends an output of a conflicting
ancestor. Core decodes saved signed bytes to bind transaction IDs and input
lists before signing and again before broadcasting a replacement. A child
of an earlier refund is not an exclusive replacement and is refused.

A new family requires a currently settled external input conflict. Its
funding planner can select surviving old inputs, or owned, settled, unspent
outputs of that conflict. A conflict output is assigned to the order only
when every conflict input already has proven ownership by that order.
Mixed ownership, unrelated inputs, unavailable outputs or missing ancestry
evidence never authorize an independent payment. This conservative planner
supports direct conflicting ancestors; more complex recovery paths stay
reserved rather than being guessed.

If no exclusive funding exists, the obligation is durably paused with one
operator notice, including first/last occurrence times. Repeated evaluation
does not create repeated notices. A valid explicitly requested rebuild
resolves the pause. Ordinary RPC uncertainty does not invent a definitive
funding failure. These are narrow rebuild notices, not the still-unfinished
general operator-alert/loss subsystem.

The maximum reservation remains while a conflict reorgs below settlement.
An unbuilt family cannot continue until its conflict is settled again.
Once a signed replacement depends on the conflict's output, removing that
ancestor invalidates the replacement, so the old refund can return without
both paying. All historical members remain observed after restart/reorg.
The reconciler retries only the latest previously attempted member per
group, never an unattempted replacement or several competing members.

Observation and intent records are now distinguished per transaction. The
first attempt retains its existing record keys; additional members use
their transaction IDs. There is no database reset or general migration
framework. Views expose each member's phase, transaction ID, observed
position, actual charge and intent count, plus the group's maximum and
settled charge. Signed bytes and ancestor proofs are not public responses.

## Boundaries and evidence

The actual Core regtest bumps a pending refund while preserving its buyer
output, then mines the older member after a deep reorg. It also rebuilds
through a settled conflict's output, settles the new member, removes the
conflict, and mines the old refund. Each obligation pays once. This uses
fresh isolated regtest wallets and does not qualify complete host recovery.

Cancellation/refund-due deadlines and durable deficit/loss reporting follow
in `REFUND-OBLIGATIONS.md`. Excess clocks, unconverted excess, merchant
principal advances, PSBT export, full application restore, registry
integration, installer/Alchemy and seller setup remain. Recovery may pause
when available order funding cannot cover a chosen charge; it does not
silently borrow another buyer's money. A smaller chosen replacement charge
does not erase the remaining order credit after it settles.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z36 | an earlier signed refund and a child spending its output | propose that child as an exclusive member | refuse; the two transactions could confirm together |
| Z37 | a further attempt reserved while the journal is unavailable | retry, build or discard | sign only after acknowledgment; retain earlier maxima; only an unbuilt attempt can be discarded |
| Z38 | coherent saved family observations | two family members are reported mined simultaneously | fail closed without overwriting the last coherent records |
| Z39 | a direct conflicting ancestor with saved raw bytes and input metadata | plan and verify a replacement | bind the selected output to the actual ancestor ID and inputs; mismatched bytes refuse |
| Z40 | spent, unowned, mixed-ownership or insufficiently confirmed conflict funding | plan a rebuild | refuse rather than substitute unrelated wallet money |
| Z41 | a settled conflict spends one family input while another survives | plan a rebuild | prove exclusivity with the surviving input and retain explicit settled-conflict evidence |

RPC policy is checked against Core 31.2's
[replacement source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/policy/rbf.cpp)
and [raw transaction source](https://github.com/bitcoin/bitcoin/blob/v31.2/src/rpc/rawtransaction.cpp),
with real signatures and conflicting transactions on the pinned binary.
