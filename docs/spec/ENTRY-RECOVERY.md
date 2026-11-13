# Issuance entry identity and interrupted responses

An entry ID identifies one controller batch's store locks. It is public
metadata, not a credential. The controller assigns a random 32-digit hex
ID once, persists it with the checkpointed batch and confirms that copy
in its journal before requesting or looking up a store entry. Root and exact member IDs
are bound to it. The store also preserves each member's handle and
recipient script. All locks and that entry record commit atomically.

An exact retry returns the existing result, including when the first HTTP
response was lost. Reusing the ID for another root, subset or superset
refuses. A new ID cannot adopt an anonymous lock or another entry's
orders. Member order is canonicalized; duplicates and unknown fields
refuse. The entry receipt requires its own record and every current
order record to be acknowledged and readable from the live journal.
Unacknowledged entries are found-but-unconfirmed, never missing or free.

The independent `ts/model/entry.ts` checks identity, atomic ownership,
retry, cancellation refusal and snapshot continuity without production
imports. It does not model HTTP, journal availability or chain evidence;
those require the integration tests below.

## Controller recovery boundaries

A controller still checkpointed after a lost store response looks up that
exact ID/root/member association. An existing entry is not marked again.
An absent entry can be requested idempotently with the same ID after a
fresh entry check. This repeats only a store operation, never a commitment
broadcast. The controller reads the live delegate, records its send
intent and confirms both journals before the first commitment call.

A normal restart with intact local attempted-send evidence distinguishes
entry and send boundaries. Stopping after entry can recover the binding;
stopping after the journaled intent but before the local attempted flag
can resume after fresh checks. Once that flag is written, a stop is an
uncertain broadcast even if no call reached subs. It never permits a new
commitment send. An explicit guard rejects a second `_send` as well as
the public issue/resume guards. Previously journaled signed-byte recovery
retains its own rules; this component adds no replacement broadcast path.

An older checkpointed controller database must recover the entry ID from
the newer journal when immutable batch identity agrees. If that journal
already records an issuing intent, the older database has lost the local
attempted-send evidence: the outcome is uncertain. A journaled later sent
state is adopted. Conflicting batch/root/member identity refuses startup.
This is not a claim that an arbitrary host snapshot is ready to serve.

The controller's send guard also checks live controller-journal
availability. A previously acknowledged intent does not bypass an outage.
The TypeScript entry receipt supplies live store-journal confirmation and
a fresh payment/recipient recheck for the first send. A payment deficit
after an already attempted send cannot by itself authorize another call,
unlock an order or erase the obligation.

## Explicit protocol and remaining work

The runner chooses `store.implementation: "typescript"` for this protocol.
The Python owner-only baseline defaults to `"python"`; unknown values
refuse before setup. No server probing or failure fallback chooses a
protocol. The TypeScript HTTP server no longer accepts the earlier
anonymous `POST /operator/issuing` route. A misconfigured older driver
therefore cannot enter orders without a root/entry binding.

The authenticated operator routes are `POST /operator/issuance-entries`
and `POST /operator/issuance-entries/lookup`. Both accept exactly
`{"entry":"<32 lowercase hex>","root":"<64 lowercase hex>","oids":[...]}`.
Found replies return those fields plus boolean `found`, `acknowledged`
and `batchable`, a `phase` and nullable `delegate`, as extended by
`ENTRY-RELEASE.md`; absence is exactly `{"found":false}`. The client rejects
malformed, mismatched or ambiguous replies and never falls back to an
anonymous mark. These supersede that pre-release route in
`REGISTRY-ENTRY.md`; the single-member library helper remains a component
test interface, not the shipped controller protocol.

`ENTRY-RELEASE.md` now extends this protocol with permanent closure and
exclusive one-use broadcast permission. A recovered, unarmed entry whose
payment recheck fails can close and rebuild after both journals confirm
the release. Armed entries remain locked. `COMMITMENT-TRACKING.md` now
adds bound commitment observations and finality tracking. Certificate transitions and TypeScript whole-host
reconciliation remain unported. The pilot release
gate remains blocked. Normal-process restart evidence does not qualify
whole-host recovery or a complete sale.

## Cases

HTTP/controller tests use a real TypeScript listener, SQLite and journals,
the shipped Python HTTP client/controller, and a recording subs stand-in.
They are not Spaces commitment-broadcast evidence. The Core scenario
separately qualifies real payment/reorg behavior with a public mock root;
the store does not itself verify that root on chain.

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O12 | converted members and one entry identity | enter, repeat with reordered members, restart and repeat | one durable exact binding; issuing locks persist; no second entry |
| O13 | a root/member binding or foreign anonymous locks | reuse its ID with changed membership/root, overlap another ID, or send malformed/duplicate fields | refuse without adopting or changing another binding |
| O14 | a locally written entry and an unavailable journal | inspect, restart and recover, then lose the journal after acknowledgment | found-but-unconfirmed during outage, locks retained, exact retry confirmed after recovery |
| O15 | a real controller and TypeScript listener | drop the entry HTTP reply before forwarding or after store commit; restart the controller | recover the same journaled ID, one upstream entry and one stand-in commitment call |
| O16 | entry, intent and attempted-send boundaries | stop the process at each boundary and restart | safe entry/unsent-intent recovery; attempted outcomes become uncertain and are never sent again |
| O17 | a recovered unarmed entry whose payment loses depth | retry through the release protocol, request whole-host reconciliation and continue the paid successor | close before rollback, exclude failed member, one successor; whole-host reconciliation still refuses |
| O18 | an invalid stored entry version, root shape or member binding | start the application | refuse and retain the evidence while releasing process ownership |
| O19 | an older checkpointed controller database and a newer entry/intent/sent journal | restart | recover the entry ID; a newer intent means uncertain; later sent state adopted; no duplicate call |
| A24 | explicit Python/TypeScript protocol selection | choose an invalid mode or return malformed/mismatched entry replies | refuse without setup or anonymous fallback |
| A25 | a checkpointed batch | lose the controller journal, recover it, lose an entry response and restart | entry identity acknowledged before entry lookup/creation, retained across restart, one entry creation and one stand-in send |
| A26 | an acknowledged intent or an already attempted commitment | lose the controller journal, recover it, then repeat `_send` | outage prevents the attempt; recovery permits one call; a second call refuses |
