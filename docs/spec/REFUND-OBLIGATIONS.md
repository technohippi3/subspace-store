# Cancellation deadlines and operator deficits

This implements the cancellation/refund-due portion of the pilot's
24-hour broadcast target and the fixed-price deficit/loss rules. It does
not complete K11/K12 production coverage: excess deadlines still require
a read-only estimated fee and the excess minimum before eligibility can
be established. The independent pilot model remains authoritative for
that policy. No price, risk budget or deployment is selected here.

## Amounts and time

A cancellation or refund-due amount becomes due when it is settled at six
confirmations and the order has a validated refund destination. Creating a
refund group, funding its fee or signing it is not a prerequisite for the
clock. A tiny amount, missing merchant fee funding or a hot-wallet limit
does not hide a missed target. Issuing orders cannot become cancelled by
this mechanism. Existing financial authorization checks remain in force.

Each newly due amount has its own immutable start time. Later payments
start later clocks; they do not postpone earlier ones. A reorg or removal
of another prerequisite does not restart or erase an existing clock. The
clock covers principal, including a permitted buyer fee. Exactly 86,400
seconds meets the target; exceeding it with principal still unbroadcast
records one permanent incident and alert with the remaining amount. A
late broadcast can complete that amount but cannot clear its incident.

Broadcast evidence is a successful send RPC response, or the first actual
observation of the signed member in the node's mempool or chain. An intent,
a lost answer, a transaction ID or mere elapsed time is insufficient. Time
is recorded when the store learns the evidence, never backdated to intent
or inferred from a block timestamp. This can report a conservative missed
target after downtime. The store must not invent earlier knowledge.

A group receives service credit only up to the largest charge of its
members actually known broadcast. Repeated observations, rebroadcasts and
equal-charge replacements do not service the amount twice. Newly credited
principal services the order's oldest remaining clocks first. Surplus
credit is consumed immediately and cannot cover future payments or a later
cancellation. Open group capacity not yet serviced is included when
determining newly due principal, so reserving money does not reset a clock.
If a smaller member settles, principal never known broadcast keeps its old
deadline. A difference previously known broadcast and later released by a
smaller settlement becomes newly due at that observation. The group still
reserves its historical maximum and settles at the actual winner's charge.

All clocks, receipts, credit watermarks, incidents and alerts use the
existing atomic SQLite/journal records. Reopening preserves them. Older
pre-alpha databases without these records start tracking from the first
current qualifying observation; they make no claim about historical
timeliness. Full application restore still requires the separate recovery
work. A journal outage makes new monitoring records local until flushed;
operator status reports whether the complete local state is acknowledged.

The operator inspection method advances existing clocks without Core.
It creates no new debt from stale facts and never signs or sends. It must
be polled by the future operator runner; no background scheduler, external
notifications or operator HTTP endpoint ships in this increment.

## Deficits and losses

The store derives issuance and post-issuance shortfalls from the price
reserve minus three-confirmation receipts, and refund exposure from settled
receipts minus the price reserve, actual refunds and open group maxima.
It records an alert when an uncovered reason becomes active. Repeated
reads do not duplicate it. A reason clears when its condition clears or
the operator records the current deficit as a merchant loss. Loss records
remain when the chain recovers. A later larger deficit alerts only for
the amount above that recorded loss. An active reason does not emit a new
alert on every change of amount; this retains the baseline rule.

Recording a loss changes reporting only. It provides no refund credit,
releases no reservation and bypasses no three/six-confirmation check.
Post-issuance deficits never automatically cancel or reallocate a name.
Operator alerts and loss amounts are absent from buyer order responses;
buyers see their own deadline state and currently uncovered reasons.

## Named cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| Z42 | cancellation/refund-due money with one prerequisite absent | settle funds, provide a destination, lose and regain settlement, then restart | start only with all prerequisites, preserve the original clock, and never require a prepared refund |
| Z43 | an unpaid cancellation clock, an open group and later money | observe a broadcast, repeat it or replace at the same charge; settle a smaller charge | credit each group amount once, keep separate later clocks and retain deadlines for principal never broadcast |
| Z44 | a cancellation clock and an uncertain send | learn accepted/observed broadcast at exactly 24 hours or one second later | intent alone never completes; boundary meets target; late completion leaves one permanent incident |
| Z45 | a saved cancellation clock and unavailable Core or journal | inspect after its target and reopen after recovery | no signing/send, one incident, original time retained, journal acknowledgment reported honestly |
| Z46 | persisted monitoring records | corrupt keys, future times, relationships, service credit or incident/alert consistency | startup refuses without overwriting the records |

| Z47 | converted, issuing and refund-exposure deficits | record a loss, recover and lose funds again, then exceed the recorded amount | suppress the covered reason, preserve the loss and alert only on the new difference; financial checks remain binding |

This covers loss arithmetic needed by N11/N13. Their fulfilled-order
scenarios remain unqualified until the registry lifecycle is ported.
