# The store service: first milestone

`service/` is the first implementation of the persistent fixed-price
store. It holds durable orders, quotes, recipient locking, holds and
fulfillment reservations, payment accounting, cancellation and refund
obligations, behind an HTTP API. It is regtest only. Nothing here
authorizes mainnet, real funds or a production deployment, and paid sales
stay closed until the buyer and operator gates in `spec/PAYMENT-SPEC.md`
pass.

## How it is checked

- `tests/test_service_twin.py` runs the service's ledger beside the
  reference model, on the model's own seeded generated sequences, over the
  same simulated chain. After every step the two must agree on every name,
  order, refund group, attempt, authorization and alert, on the payment
  address each order shows, on whether each cancellation is final, and on
  which calls were refused. The service is closed and reopened from its database every
  17 steps. This is a model-twin result.
- `tests/test_service_api.py` exercises the HTTP boundaries and a restart
  over a simulated chain. Its `test_V*` tests are the recipient-request
  cases V1 to V17 of `spec/PAYMENT-SPEC.md`, and its `test_H*` tests are
  the restore and acknowledgment cases H1 to H6 and H8 to H11. They are
  service API results, not model results: the model has neither recipient
  requests nor the service's database.
- The twin test also runs the generator's host losses (case H7). At each
  one the model keeps what its off-host journal acknowledged, and the
  service's database is dropped and rebuilt from its journal alone; the
  two must then agree as before. This is a model-twin result.
- `tests/test_checkout.py` exercises the checkout pages over a simulated
  chain (cases C1 to C12), and `tests/test_runner.py` the attended runner
  against recording stand-ins (cases A1 to A5). `tests/test_controller_host.py`,
  `tests/test_runner_recovery.py` and `tests/test_certificates.py` run the
  runner and the controller against stand-ins for `subs`, `spaced`,
  `bitcoind` and the store (cases A6 to A19, among them the recovery
  commands and certificate re-delivery). They are service and runner
  results, not model results.
- `regtest/run-recovery.sh` runs scenario 11, the operator gate's recovery
  rehearsal: the host lost whole with batches in flight on four spaces and
  a refund broadcast, a fresh host brought up from the off-host recovery
  set alone, reconciled through the runner, and issuing again to
  fulfilled. Its results are regtest results. `tools/replay_timing.py`
  times the store's replay on a generated journal; those results are
  labelled generated.
- `regtest/run-checkout.sh` runs scenario 10: a buyer using only the
  checkout pages, and every operator step after listing a name done by the
  attended runner as its own process, through issuance, certificate
  delivery, publication, and a cancellation refund. Its results are
  regtest results.
- `regtest/run-service.sh` runs the service as its own process against
  Bitcoin Core, `spaced` and `subs` on regtest, restarting it with SIGKILL
  along the way (scenarios 7 and 8 in `regtest/harness/service.py`). Its
  results are regtest results.

## Implementation choices

These are this milestone's choices, recorded so that they can be changed.

- Standard-library Python and SQLite, like the model and the harness. WAL
  mode with `synchronous = full`; every operation is one or more `BEGIN
  IMMEDIATE` transactions, serialized by one lock in the HTTP server.
- The ledger is written separately from `model/store.py` rather than
  wrapping it, so that agreement between the two is evidence. It follows
  the model's evaluation order exactly: evaluate, run the operation's own
  transaction, evaluate again.
- Balances are never stored. Every sum is derived from the chain position
  of each payment output when it is evaluated. Payment outputs ever seen
  are also recorded, for the order's history only.
- No-account checkout. A recipient request carries the public handle and
  the buyer's `script_pubkey` and nothing else, and returns a private order
  link, a 32-character random token. Any other member, including
  `dev_private_key`, refuses the request with 400 and nothing stored. So
  does a handle that isn't canonical, or a script that isn't 34-byte P2TR
  with a valid BIP340 key. An unlisted handle gets 404. A request carries
  no authority over its script, so only a paid order (converted onwards)
  claims one. A request or quote on a script that a paid order for another
  handle claims, or on a store destination script, gets 409. Two paid
  orders on one script both stay out of batches, and the owner is alerted.
  A retry with the same handle and script makes a new order and link. Only
  the token's SHA-256 is stored. The order
  link shows only its own order, and the refund address is given through
  it. Orders have internal ids (`o1`, `o2`, ...) that buyers never see.
- Recipient locking. The handle and `script_pubkey` are fixed when the
  order is created. Nothing changes them, and `/pending` serves exactly
  those two fields for the frozen batch's members.
- Three callers, three boundaries: buyers by order link, the operator and
  controller by a bearer token, and `subs` by the registry token on
  `/health`, `/pending`, `/ack` and `/committed`. Bearer tokens are
  compared with `hmac.compare_digest`. Tokens live in files
  outside the repository, mode 0600; the configuration names their paths.
- Refund funding. On regtest the store's Bitcoin Core wallet receives the
  payments and signs refunds, as the capped hot wallet of the
  specification's two options, with `hot_wallet_cap_sats`. A refund spends
  the order's own settled, unspent payment outputs, pays `to_buyer` net of
  the fee to the buyer's address, and returns change to the store's wallet.
  A change below dust goes to the fee, as a store cost, never charged to
  the order.
- A refund is built, signed and reserved in one call, and broadcast in
  another. The broadcast is refused until the group's journal entry is
  acknowledged off-host.
- The off-host journal is a directory that the operator puts on another
  volume. Each append is fsynced and read back. Every write is one entry
  holding the whole current state of every record changed since the last
  acknowledgment: names, orders (with the order link's SHA-256, never the
  link), refund groups with their attempts, alerts and authorizations. While
  the journal is down, changes are backlogged and written again at the next
  evaluation.
- What callers are told waits for the journal too. A quote's address is
  given out, by `/quote` or the order link, only once the order entry
  carrying it is acknowledged; each order keeps `journaled_status`, its
  status in its latest acknowledged entry. With the journal known to be
  down, `/quote` answers 503 and takes nothing. If the acknowledgment
  doesn't arrive, `/quote` answers 503 with no address, the link shows
  `address_pending`, and asking again returns the same quote once it does.
  A cancellation answers 200 and "final" only once acknowledged, otherwise
  202 and "unconfirmed"; until then the buyer's order link shows the last
  acknowledged status with `cancellation: "unconfirmed"`. Cancelling again
  confirms it. A quote asked again goes through the same recipient checks
  as a first quote, and a flagged order's link shows no address.
- Restore. After a host loss, `python3 -m service restore <config.json>`
  rebuilds the database from the journal alone, into the configured path,
  which must hold no database. It refuses an empty or inconsistent journal,
  builds beside the target and moves the result into place only when
  complete. Payment outputs, the frozen batch and `subs`' committed roots
  aren't restored: balances come from the chain, and the other two belong
  to the controller's recovery. Each order's payment history is restored
  conservatively. An order journaled as `detected` stays so, one never
  given an address stays `none`, and every other is restored as `unknown`,
  whose page asks for no payment (PAYMENT-SPEC.md, "Checkout"). A
  database from before the payment history is upgraded at start by the
  same rule, in one transaction. A start that finds no store database, or
  one with no names and no orders, while the journal has entries refuses to
  serve and writes nothing.
- The payment and refund wallet is backed up at onboarding. Restored from
  that backup, it has seen only the addresses that were paid since, so it
  can give out again an address a restored, unpaid quote holds. A quote
  never takes an address an order holds, for its payment or as its refund
  address: the store asks the wallet again and alerts the owner once
  (`destination_held`, with the number skipped). Scenario 11 showed the
  skip of an address held for payment on regtest (H11). A refund address
  is refused if any order holds it as its payment address, and a quote
  skips an address held as a refund address; both are service API tests
  over a simulated chain (T1 to T3), not regtest evidence.
- Start-up reconciles every refund attempt against the chain before
  serving anything, and rebroadcasts an attempted one that the node doesn't
  know as the same signed transaction.
- Policies that the specification marks as proposals are configuration:
  the hold (15 minutes), the excess minimum (546 sats over the fee), the
  refund fee (300 sats, refunds net of fee) and the hot wallet cap.
- `subs`' `already_*_different_spk` staging outcome is recorded on the
  order and alerts the owner. The order isn't moved automatically.
- Every start audits the stored orders' recipients before serving. An order
  that breaks the request rules gets `recipient_problem` and one
  `recipient_invalid` alert. Its record is otherwise unchanged; it gets no
  quote and never reaches batch entry, the frozen batch or `/pending`. A
  database from before the audit gets the column added at open.
- The service refuses to start on any network but regtest, and listens on
  loopback only.
- Checkout pages (`service/checkout.py`): plain HTML forms with no scripts,
  served beside the JSON API. The order page is at `/o/<token>`, with the
  order link's token. Every step is the JSON API's ledger call, with its
  refusals. A pasted request is checked as `POST /requests` checks a body,
  and must name the page's name. The invoice carries a BIP21 URI. There
  is no QR code yet, because drawing one needs either a script or a
  library outside the standard library.
- The order page asks for payment (amount and BIP21 link) only while the
  order is quoted, holds its name, its hold hasn't run out, nothing is
  confirmed and no cancellation is pending. Otherwise the invoice is shown
  as history with a note not to pay.
- Certificates reach the order page through `POST
  /operator/orders/<oid>/certificate`, accepted only while the order is
  `ready` or `fulfilled`, and served only while it still is. That one
  authenticated route takes up to 1 MiB of certificate, because a later
  batch's certificate carries a proof (about 226,500 bytes on regtest).
  Every other body keeps the 65,536-byte bound. The store
  doesn't verify them; the runner does before delivering. They aren't
  journaled, so after a restore the runner delivers them again with
  `certify`, which accepts a certificate built on a later root of the
  same space once that root is final and covered (A19).
- The attended runner (`runner/`, `python3 -m runner <config> <command>`)
  is the operator's tool: one command per step, JSON out. It sends a
  commitment or a refund only with the batch id or refund group id
  confirmed. It drives the controller of `CONTROLLER-DESIGN.md`
  (`controller/`), built from a host configuration alone by
  `controller/host.py`: the keys are in `deploy/runner.example.json`. The
  regtest harness runs the same controller through an adapter over its
  stack. The runner refuses every network but regtest, and before every
  command but `status` it asks `bitcoind`, `spaced`, the store
  (`/operator/status`, whose `chain` gives its node's network and best
  block) and each `subs` endpoint, for writes and for reads, which network
  and chain they are on. A `subs` endpoint answers for the `spaced` behind
  it, through its own `/rpc/spaced` and `/rpc/endpoints`. Chains are
  compared by block hash, and nothing runs unless all agree with the
  configuration.
  Before a snapshot
  it runs the configured stop command for `subs`, which must return once
  `subs` has exited, checks that a connection to `subs` is refused (an
  HTTP answer or a timeout isn't enough), copies, runs
  the start command and waits until `subs` answers again. The
  configuration states whether `subs` has the U1(b) route; without it the
  attach of an adopted txid is refused, and continued issuance after such
  a recovery needs that capability or another reviewed procedure.
- After a host loss the runner carries the controller's recovery:
  `restore` (the latest coordinated snapshot's `subs` files, checked
  against its manifest and copied only into an empty data directory while
  `subs` is down, then the controller's batches from its journal,
  reconciled), `readback`, `attach-txid`, and `resume` and `rebroadcast`,
  which send and so need the batch id confirmed. Until the restore is
  reconciled, `issue` and `resume` are refused, and `status` says what
  waits. The store is restored first, with `python3 -m service restore`,
  and started. A controller database that lacks batches its journal
  holds, a fresh one included, records that a restore is required when it
  is opened, and nothing but `status` and `restore` runs until a restore
  has replayed the journal, in one transaction, and reconciled. An
  interrupted `restore` resumes when run again. A database from an earlier
  schema is migrated when it is opened.

## Not in this milestone

- Restore from a snapshot plus the journal since it. The store restores
  from its journal alone; the operator gate's rehearsal (scenario 11)
  restored it that way on regtest, with `subs` from the snapshot and the
  controller from its journal, and didn't use the snapshot's copies of
  the store's and the controller's databases.
- An off-host store that is separate, with its own credentials and
  per-object confirmation from the provider. The journals and snapshots
  are a directory written with read-back.
- An owner-signed PSBT for refunds, fee bumps and replacement families
  through the API (the ledger implements both rules, and the twin tests
  them), and a refund after an earlier refund spent the order's payment
  outputs.
- Late payments, hold extensions and excess refunds on regtest. The ledger
  implements them and the twin covers them; the regtest scenarios don't.
- Eligibility proofs, allowlists and vouchers; auctions. A proof-gated name
  must not be quoted before its proof and quota reservation pass
  (`spec/ELIGIBILITY.md`); today every order is created eligible.
- Any limit on hold abuse. One caller can keep a name "taken for now"
  indefinitely by quoting again as each hold ends ("Open: hold abuse" in
  `spec/PAYMENT-SPEC.md`).
- An installer, and buyer import in Nacho, which the buyer gate tests.
- A deployment. `deploy/` holds credential-free examples of the store's
  and the runner's configuration and of systemd units for the store and
  `subs`; nothing installs them, and nothing has run from them.
- The pilot's operating needs: a hold-admission policy, bounded wallet
  funding, and a way to pause sales and handle alerts (the proposed finish
  line's third demonstration).
