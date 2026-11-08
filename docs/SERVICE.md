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
  order, refund group, attempt, authorization and alert, and on which calls
  were refused. The service is closed and reopened from its database every
  17 steps. This is a model-twin result.
- `tests/test_service_api.py` exercises the HTTP boundaries and a restart
  over a simulated chain. Its `test_V*` tests are the recipient-request
  cases V1 to V16 of `spec/PAYMENT-SPEC.md`, and its `test_H1` to
  `test_H6` are the restore cases H1 to H6. They are service API results,
  not model results: the model has neither recipient requests nor the
  service's database.
- The twin test also runs the generator's host losses (case H7). At each
  one the model keeps what its off-host journal acknowledged, and the
  service's database is dropped and rebuilt from its journal alone; the
  two must then agree as before. This is a model-twin result.
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
- Restore. After a host loss, `python3 -m service restore <config.json>`
  rebuilds the database from the journal alone, into the configured path,
  which must hold no database. It refuses an empty or inconsistent journal,
  builds beside the target and moves the result into place only when
  complete. Payment outputs, the frozen batch and `subs`' committed roots
  aren't restored: balances come from the chain, and the other two belong
  to the controller's recovery. A start that finds no store database, or
  one with no names and no orders, while the journal has entries refuses to
  serve and writes nothing.
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

## Not in this milestone

- Restore from a snapshot plus the journal since it, and the operator
  gate's full restoration with the controller and `subs`. The service
  restores only its own database, from its journal alone, and not yet on
  regtest.
- A cancellation is reported before it is acknowledged off-host, so a host
  loss in between undoes it (an open point in `spec/PAYMENT-SPEC.md`).
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
- A checkout page, an installer and buyer import in Nacho.
- The controller is still the harness's.
