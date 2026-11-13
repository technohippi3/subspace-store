# Known-unsent entry release and rebuild

This extends `ENTRY-RECOVERY.md` for the TypeScript pilot protocol. It
supersedes that component's temporary refusal of all bound-entry releases.
The frozen Python store's payment rules are unchanged. The Python controller
and runner implement this protocol when explicitly configured for TypeScript.

## Exclusive close or broadcast permission

An entry has three phases: `open`, `closed` and `armed`. Its ID, root and
exact member IDs remain immutable. Closure and arming share the store's
serialized queue with entry creation and cancellation. Only one can win.
Both markers commit atomically to SQLite and require live off-host journal
confirmation before an acknowledgment permits further controller work.

Closing an open entry returns its own issuing orders to `converted` and
removes its members from frozen pending sets in the same transaction. Payment
addresses, reservations, history and the immutable entry binding survive.
Fresh observations can make those converted orders unbatchable; closure
does not promise that they still qualify. Cancellation is allowed after
closure under its ordinary rules.

Closure is permanent and idempotent. Repeating close or create for that ID
returns the closed receipt without changing any order again. It cannot undo
a later cancellation or unlock a successor entry. Closing an absent ID is
allowed for known, single-space members; this prevents a delayed create
from acquiring locks after release. It does not unlock another entry that
owns those members. Changed roots or member sets refuse even after closure.
Closed historical bindings still validate their immutable handles/scripts.

Before a commitment call the controller must acquire one-use broadcast
permission for the exact entry/root/members and delegate outpoint. Arming
requires an open, currently acknowledged, batchable entry. The first durable
grant returns `granted: true`. Every retry returns `granted: false`, even
after restart or a lost reply. A different delegate refuses. An armed entry
cannot close, and a closed entry cannot arm. Permission means a send may
have occurred; it does not prove that any transaction was broadcast.

The controller first persists its local attempted flag, then requests the
grant, then rechecks both live journals before calling subs. A missing,
unconfirmed or nonexclusive answer makes the outcome uncertain and forbids
a new commitment call. A crash at any boundary is conservative, including
after arming but before a network call. Losing the grant costs availability;
it never creates a second grant. Signed-byte recovery of an already
attempted commitment still follows its existing readback rules and requires
the matching armed delegate. A later payment deficit cannot authorize
unlocking or another first-send call.

This store-side barrier is necessary even with a controller process lock:
restoring an older controller database and journal can lose its attempted
flag. Those older copies cannot close an armed store entry or obtain a
second permission. A possible send in the current controller journal also
refuses known-unsent release before contacting the store. Conflicting
journal identity refuses even when an older local batch has no root yet.

## Resumable local release

The controller records the entry identity and failed member IDs in phase
`releasing`, then confirms that intent before asking the store to close.
No local rollback occurs until closure is live-acknowledged. It persists and
confirms `rebuilding` before changing subs. Store or controller journal
outages withhold the next action. An interrupted close is retried by exact
identity. If the store reports armed, the outcome becomes uncertain and
local rollback is forbidden.

Read every member back from subs and compare its exact recipient script.
Rollback is allowed only when every member has the original root; journal
the rollback intent first. If all members are already staged with no root,
skip rollback. Mixed or foreign roots and changed scripts refuse. A lost
rollback response is resolved by this same readback, never a blind second
rollback. The single issuance writer remains a prerequisite.

After rollback, observe the store again. The failed set can only grow;
cancellation and payment loss during release exclude more members. Persist
and confirm any growth, park failed handles and verify every member's parked
state. Atomically retire the parent and insert its sole frozen successor
containing the remaining members and the correct digest, space and prior
root. If none remain, retire without a successor and record one alert.
Journal the successor and parent before reporting completion. A local crash
after this transaction resumes completion without another rollback, another
successor or another alert. Repeating the original failed-set request is
allowed when the persisted set has since grown. Conflicting successor
metadata refuses.

If no local root, entry or intent exists and no local commit was requested,
a precommit rebuild retires the batch without rolling back a prior commitment.
A journaled local-commit request without a confirmed root requires
reconciliation; a missing reply does not prove no commit occurred.
Restart merges persisted
failed sets monotonically and never downgrades closed progress to an older
release intent. A journaled successor missing from the local database still
requires recovery; this component does not qualify whole-host restore.

Runtime amendment, 2026-11-13: a controller restored before entry-ID
persistence can invent a new ID whose absent-entry close succeeds while
another armed entry still owns the orders. That receipt must not authorize
local rollback or retirement. Both the active Python controller and the
TypeScript kernel freshly inspect every member before first retirement,
rollback and parking, including dropped members and the rootless precommit
path. Status must be one of `requested`, `quoted`, `unpaid`, `converted`,
`cancelled` or `refund_due`; issuing, ready, fulfilled, missing, malformed
and unknown statuses refuse. Exact recipient/root checks still apply.
An already retired parent's completion retry may observe its legitimate
successor's later issuing status; it validates the existing successor
without repeating retirement or native mutations. This lifecycle repair
changes no payment rule and does not qualify arbitrary host restoration.
The Python entry-release tests and real TypeScript HTTP controller fixtures
cover the forgotten-identity and rootless refusals.

## HTTP contract and scope

The authenticated routes `/operator/issuance-entries`, `/lookup` and
`/close` beneath that entry path accept exactly
`{"entry":"<32 lowercase hex>","root":"<64 lowercase hex>","oids":[...]}`.
The `/arm` route additionally requires `delegate`, a canonical lowercase
transaction ID and decimal uint32 output index separated by `:`.

Found replies contain exactly `found`, `entry`, `root`, `oids`, `phase`,
`delegate`, `acknowledged` and `batchable`. Delegate is null unless armed;
closed entries are never batchable. Arm replies also contain boolean
`granted`. Missing lookup remains exactly `{"found":false}`. Malformed or
mismatched replies refuse without fallback. Earlier pre-release drivers
must update with the server; they fail closed on this changed receipt.

The independent entry model checks closure, foreign ownership, cancellation,
one-use grants and snapshot continuity without production imports. Tests of
real process exits, journals and HTTP use the shipped controller against a
recording subs stand-in. Core regtest separately qualifies the store records
with real paid orders, using mock roots and a mock delegate. Neither is
evidence of a Spaces commitment. `COMMITMENT-TRACKING.md` now adds bound
commitment observations and finality tracking. Certificate callbacks,
supersession of armed entries and whole-application recovery remain unported.
Sales remain closed and the public-pilot release gate remains blocked.

## Cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O20 | an open entry | close, cancel an order, restart and retry; bind a remaining order to a successor and retry old close | release only once, retain reservation/address history, preserve cancellation and successor ownership |
| O21 | a missing entry ID and a foreign entry owning its members | close missing ID then deliver its delayed create | permanent closed identity, no foreign unlock or resurrected locks |
| O22 | an open entry | race close against arm, repeat permission and use another delegate | one exclusive outcome, at most one grant, closed cannot arm and armed cannot close |
| O23 | closure/arm journal outage or an arm reply lost before/after forwarding | inspect, restart and retry after recovery | unconfirmed marker remains durable; no rollback on unconfirmed close; a lost arm reply means uncertain, no send or second grant |
| O24 | release in progress and a store-journal outage | cancel while close is unconfirmed, recover and resume | withhold rollback until acknowledgment, preserve cancellation and retire all-failed batch without a child |
| O25 | a known-unsent entry | lose close/rollback replies or exit after rollback, parking or atomic completion | read back effects, one rollback and one successor, idempotent completion |
| O26 | a commitment was armed and sent once | restore older controller database and journal, request release or retry | uncertain outcome, no unlock, local rollback or second permission/send |
| O27 | invalid marker version, root, delegate or simultaneous close/arm | open application | refuse without erasing evidence or retaining process ownership |
| A27 | release intent, roots and scripts | lose controller journal, change a script/root or restore an older precommit identity | no store close during journal outage or identity conflict; no rollback or successor with foreign or mixed local evidence |
| A28 | rollback happened but its answer was lost | restart and resume repeatedly, then corrupt successor digest | readback avoids another rollback; one successor; corrupt successor refuses |
| A29 | no local root/entry/intent, an unresolved local-commit request or legacy mode | rebuild before commit or after a lost commit reply, then use legacy rollback | typed path never rolls back prior root or assumes a lost commit reply means no commit; legacy preparing-state guard still works |
| A30 | another member fails during release | complete then retry original request | failed set grows, no successor when all fail, one retirement alert |
| A31 | local release progress and an older or newer same-phase journal | restart and resume | union failed sets, never downgrade rebuilding to releasing, preserve exclusions |
| A32 | an all-failed batch at issue or release completion | invoke the attended runner with wrong and correct batch confirmation | refuse wrong confirmation before changes; report retired parent without looking up a nonexistent successor; repeat completion safely |
