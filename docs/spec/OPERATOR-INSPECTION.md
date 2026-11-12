# Operator inspection boundary

This implements an Effect-scoped inspection listener, separate from the
buyer listener and bound only to loopback. It supplies the read portion
needed by the registry/runner bridge. `REGISTRY-ENTRY.md` adds atomic
issuing marks, live journal confirmation and frozen pending sets through
the same operator listener. It is not yet a complete runner interface:
recovery transitions, commitment callbacks, certificates, cancellation by
operator ID and refund-write routes remain unimplemented. No signing or
broadcasting route is exposed here.

`ENTRY-RECOVERY.md` now requires bound entry identities for HTTP issuance
and qualifies lost-response/restart handling. The former anonymous
issuing route is not served.

## Authentication and lifetime

The caller injects an Effect that retrieves the operator bearer credential.
It is evaluated at startup and again for each well-formed authenticated
request. This supports runtime credential retrieval and rotation without
putting values in configuration outputs or Alchemy state. The component
does not provision Infisical, create credentials or cache them on disk.
Infisical integration remains installer work.

Empty, short or nonprintable configured credentials refuse startup before
opening a listener. Missing, malformed, duplicate or wrong Authorization
headers are rejected before a store method is called. A digest comparison
uses `timingSafeEqual`. Credential-provider failures are replaced with a
constant error; their messages and values are not returned. The buyer
listener serves none of these routes, even with an operator credential.
All responses retain no-store and no-referrer headers.

Effect scope shutdown aborts active requests, closes connections, waits
for handlers and releases the port. The store still owns its existing
single application queue and database lock. This listener creates no
second writer and does not change the deployment/restart contract.

## Routes

| Method and path | Behavior |
| --- | --- |
| `GET /operator/status` | Advance persisted clocks and return monitoring state with journal acknowledgment. It does not infer chain state or send transactions. |
| `GET /operator/alerts` | Return durable alerts through that same inspection path. |
| `GET /operator/orders` | List persisted order IDs as the runner expects, optionally with one valid `status` query parameter. |
| `GET /operator/orders/<oid>` | Return one summary, including local and last acknowledged status separately. |
| `POST /operator/observe` | Observe the chain using existing adapters; accept only an empty body or `{}`. No signing or send occurs. |

Orders expose canonical identifiers, handles, recipient scripts, price
reserve, gross payment sums and refund balances. The payment address and
`journaled_status` come from the acknowledged order record. Buyer bearer
links, token hashes, raw transactions and intermediate wallet data are
absent. Inspection reads do not automatically refresh the chain; the
runner's existing observe-then-list sequence is explicit. A local
cancellation can therefore appear with an older acknowledged status,
without claiming the cancellation is final.

Filters accept the existing lifecycle vocabulary. Ready/fulfilled lists
are empty until those transitions are ported. This is not evidence that
fulfillment works. The additional entry routes are specified in
`REGISTRY-ENTRY.md`. Other unknown routes and writes return not found.
A controller must not be configured to issue against
this incomplete interface. Full binding checks and recovery remain gates.

The pinned Core regtest now performs authenticated observation and order
inspection over this listener after a real payment converts. Default
tests separately exercise authorization, duplicates, credential rotation
and outage, response redaction, journal lag, unsupported writes and port
release. Neither evidence set qualifies a full controller sale.

## Runtime cases

| Case | Given | When | Then |
| --- | --- | --- | --- |
| O1 | separate buyer/operator listeners and a live credential provider | omit, duplicate or change a bearer header; rotate or lose the credential | reject before store access as appropriate, reload credentials, scrub provider failures and keep operator routes absent from the buyer listener |
| O2 | current and journal-acknowledged order states | inspect individual/filtered orders while the journal lags | return local and acknowledged status separately, withhold unacknowledged addresses and never return buyer links, hashes or signed data |
| O3 | a valid operator credential | observe with valid/invalid bodies or attempt an unsupported financial/certificate write | validate the body before observation, expose no financial send or certificate mutation and preserve order state |
| O4 | invalid startup credentials or an acquired listener | start, close its Effect scope and bind the port again | failed credentials open no listener; normal scoped close releases the port |
