# Registry entry and frozen pending sets

This ports the store side of batch entry for unrestricted public sales.
It uses the existing Effect application queue, SQLite owner and journal.
Eligibility-restricted modes remain unavailable. This does not implement
the controller's root/delegate checks, commitment callbacks, finality,
certificate delivery or whole-application recovery. Those remain release
requirements.

## Atomic entry and acknowledgment

Every member must be converted, paid to at least three confirmations and
have an accepted, unconflicted recipient. Validate all members before
changing any status. One local transaction marks the complete set issuing;
the journal acknowledgment is checked afterward. Refusal leaves every
issuing status unchanged, although fresh payment observations and alerts
may have committed. Buyer cancellation uses that same queue, so it either
wins before entry or refuses after it. A reorg never makes an issuing order
cancellable; its issuing recheck fails until sufficient payment returns.

Batch requests contain one to 1,000 distinct canonical order IDs from
one space. Empty membership is allowed only to clear the pending set.
The 1,000-member bound is an API bound, not an automatic batch selector.

An unacknowledged local mark is still issuing locally. It returns no
acknowledged member and is not authorization to broadcast. Normal restart
replays the outbox and preserves these locks. The journal check confirms
the exact current order, with live off-host readback, rather than merely
trusting an earlier SQLite acknowledgment. Returning an issuing status
in inspection remains historical information, not a live send guard.

The Python runner now checks its existing per-order journal endpoint
before returning an acknowledged status to the controller's send gate.
That is a runner safety amendment, not a change to the frozen Python
store's payment rules. Both controller intent and current store locks
must be confirmed before a send. This qualification uses a recording subs
stand-in; it is not evidence of a real commitment broadcast. Bound entry
identity and interrupted responses are now qualified separately in
`ENTRY-RECOVERY.md`. No unknown response proves that a lock was absent,
nor automatically releases an issuing order. Safe release/rebuild and
whole-application recovery remain unqualified.

## Recipients and pending visibility

Two converted orders for different handles on the same recipient both
wait, including if one was already frozen. An issuing order keeps priority
over a later conversion; the later order waits. Each affected order gets
one durable recipient-conflict notice, also across restart. Its zero
amount denotes a nonmonetary notice. Cancellation of the competing
converted order can unblock entry; the notice remains in history.
V12 and V13 retain their definitions in `PAYMENT-SPEC.md`.

The pending set is explicitly selected and journaled. It never expands to
the catalog or to newly converted orders. Only a currently acknowledged
set is served, and only for the exact requested space. Conflicted,
cancelled or no-longer-batchable members are withheld. An unavailable
journal withholds the set. The controller still compares the complete
staged set and repeats its binding check before sending.

The pending record is a versioned singleton containing order IDs. Existing
TypeScript records without one initialize with an empty set. Unknown
versions, duplicate or unknown IDs and cross-space relationships refuse
startup without rewriting the evidence. This is an additive application
record; no Python schema conversion is performed.

## HTTP boundary

The operator listener adds the routes below, with its existing credential
and lifetime rules. The order-list response is `{"orders":["o1", ...]}`,
matching the Python runner. Individual summaries remain on the per-order
route. The earlier inspection-only summary-list shape was not released.

| Method and path | Behavior |
| --- | --- |
| `POST /operator/orders/<oid>/batch-entry` | Fresh observation; return `batch_entry` and `issuing_recheck`. Empty body or `{}` only. |
| Bound entry creation | `ENTRY-RECOVERY.md` replaces the earlier anonymous issuing HTTP route with an exact entry/root/member binding. |
| `POST /operator/orders/<oid>/journal` | Flush pending entries and confirm the current order against its live journal receipt. Empty body or `{}` only. |
| `POST /operator/pending` | Exactly `{"oids":[...]}`; select or clear the frozen set and report acknowledgment. |

A separate authenticated loopback listener, with its own injected subs
credential, serves `GET /pending?space=@space` and `GET /health`. Its
health response is transport health, not controller-reconciled readiness.
It accepts no operator or callback writes. Operator, subs and buyer
listeners never expose each other's routes. Unknown/duplicate body
members, duplicate IDs and invalid query shapes refuse before mutation.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O5 | multiple converted orders | enter all, with a missing/duplicate ID, cross-space set or one payment below three confirmations | reject the invalid set without partial issuing marks; a valid set marks all and acknowledges all |
| O6 | converted orders and an unavailable journal | mark issuing, restart, recover the journal, then lose it after acknowledgment | local locks survive and cancellation refuses; acknowledgment requires exact current state and live journal availability |
| O7 | a multi-member batch and buyer cancellation | race both operations through the application queue | exactly one wins; cancellation never leaves the other member partly locked |
| O8 | converted orders and a selected pending set | inspect, change during an outage, restart and clear | serve only the acknowledged frozen set for the exact space; never include other converted names or stale acknowledgments |
| O9 | buyer, operator and subs listeners | use another role's credential/route or malformed batch/query shapes | reject before mutation, keep callbacks and financial sends absent, and expose only the frozen public handle/script pairs to subs |
| O10 | the actual Python runner HTTP client, TypeScript store and controller send guard | lose either journal, then recover | no attempted send while either guard is unavailable; one recording-stand-in send after both are confirmed |
| O11 | an invalid pending record in the journal | start the application | refuse without erasing the record and release ownership for inspection |
