# Buyer gate plan (draft, 2026-11-08)

Status: preparation may proceed; nothing on mainnet has run. This is the
repository's reviewed version of the operator's 2026-11-06 staging draft,
so that the launch requirements no longer depend on an external document.
It applies the launch scope of 2026-11-08 (`spec/PAYMENT-SPEC.md`, top) and
what the regtest harness has since established (`regtest/FINDINGS.md`).

Authority. The preparation steps are local and may proceed now. Every step
marked "mainnet" or "wallet" moves funds or changes on-chain state. Each
needs the workspace_owner's explicit authorization of the concrete
transaction plan below, filled in, before it runs. The workspace_owner
performs every wallet action personally. No seed phrase or private key is
ever shown to an agent session or written into evidence. The 2026-11-08
scope agreement authorizes none of these steps.

## The gate

From "Acceptance gates" in `spec/PAYMENT-SPEC.md`. On a throwaway space,
with Nacho as the client:
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

A record counts only when a verifying client accepts it against the name's
certificate. A record seen only in a relay's `/peek` output doesn't count.

The throwaway space is not the first commercial space. It must be none of
the spaces meant for sale, and its renewal must not fall due during the
test. Which space it is gets decided in the transaction plan, not here.

## Why this shape

The first commitment of a space needs no proof at the pinned `subs`
commit: only later commitments create a proving request. One initial
commitment carrying two names therefore exercises issuance, certificates,
import, record signing and independent control without the prover or the
store. Names are added through `subs`' own `POST /requests`. The store's
later batches do need the Spaces protocol's issuance proofs; those have
worked on regtest (`regtest/REPORT.md`) and are not part of this gate.

## What has changed since the staging draft

- A request format checker exists: `tools/check_request.py` checks a
  request's form as `POST /requests` does (size limit, members, types,
  canonical handle, P2TR script with a valid key), and never echoes a
  refused request. It doesn't run the store's stateful checks: name
  availability, the store's own destination scripts, or a script claimed
  by a paid order. Those need the store, and this gate issues through
  `subs` directly.
- A certificate verifier exists: `regtest/verifier` verifies the binary
  certificate message from `subs`' `/certs/:handle/message` offline with
  libveritas, against root anchors read from `spaced`. It prints the
  verified zones; whether they match is a separate comparison, as the
  harness makes it (`regtest/harness/controller.py`). The same call
  verifies signed records (P3).
- A certificate can be "pending" at `d >= 150` until a root anchor covers
  the commitment, up to 35 blocks later (R11, case L6). M4 waits for both.
- With no store, nothing calls `subs`' publication: the background loop at
  the pinned commit stays idle without a registry. Certificates reach the
  relays only through an explicit `/spaces/:space/publish` (M6).
- `subs` at the pinned commit binds every interface (R7). The test operator
  needs a firewall rule or a network namespace so that only localhost
  reaches it.
- A `subs` built without `test-rig` publishes to the public relays with
  their default seeds (R6, R19). On mainnet that is intended: whether
  Nacho finds the certificates there is part of what M7 observes, once M6
  has shown they are there.
- `spaced` v0.5.0 sends the cookie file's contents as credentials (R5); the
  test operator uses the same configuration the harness uses.

## Preparation (local, no mainnet effect)

P1. Re-export the two Nacho requests from the workspace_owner's phone, for
two names under the throwaway space, and check them:

    python3 tools/check_request.py request-1.json request-2.json

Both must pass and their scripts must differ. The requests are public data,
but they identify the workspace_owner's keys and spaces, so they stay in the
operator's private records, not in this repository. The 2026-11-06 staging
draft recorded the shape of two such exports, which passes the checker, but
not the scripts themselves, so they can't be rechecked from it.

Checked on 2026-11-08: the two requests Nacho has held since 2026-11-06,
for two names under one of the workspace_owner's spaces, were copied from
the phone with Nacho's "Copy request" and pass the checker, with distinct
scripts. Nacho exports a request only through that button, as
pretty-printed JSON with the same two members; its menu for a request
offers only "Import certificate" and "Remove handle". The throwaway
space chosen in the transaction plan is another space, so P1 was repeated
for it.

Repeated on 2026-11-08: two fresh Nacho requests for two names under the
chosen space pass the checker, with distinct scripts, neither of them one
of the earlier requests'. They are kept in the operator's private records
with the other transaction plan choices.

P2. Set up a test operator on the workspace_owner's own machine, never on
the production operator host: `spaced` v0.5.0 with a fresh data directory,
a new operator wallet, and `subs` at `4dcc923`, reachable from localhost
only (R7).

`buyer-gate/operator.sh` does this. It runs the pinned builds from
`regtest/.cache/bin` inside an unprivileged user, network and mount
namespace, with slirp4netns giving it outbound access only: nothing
outside can connect in, it can't reach the host's loopback, and no port
is forwarded. No host firewall, system or security setting changes. Its
state, including the Bitcoin RPC URL, sits in a private directory outside
the repository, and the URL reaches `spaced` through its environment, not
its command line.

The namespace has no PID namespace of its own, so the launcher's
processes share the host's process list, and it never finds one by name.
When it starts the namespace and slirp4netns it records each one's pid,
start time and executable, with the network namespace or the namespace
pid it serves. It enters or signals them only while they match that
record, and `spaced` and `subs` only as the pinned binaries inside the
recorded network namespace. A missing or mismatched record leaves every
process untouched. The instance started on 2026-11-08 predates these
records; `buyer-gate/operator.sh adopt` recorded it once, without a
restart, after checking that its namespace's only child is the pinned
`spaced` with the launcher's exact command line and that slirp4netns has
the launcher's exact command line for that namespace. Every `cli` call runs with one
wallet: the one named in `SUBSPACE_TEST_OPERATOR_WALLET` (default
`operator-2`) when the arguments name none. The launcher refuses the
wallet named `operator`, wherever it is given.

Started on 2026-11-08. `spaced` v0.5.0 began syncing mainnet from a fresh
data directory, through a remote Bitcoin RPC, at about 1.5 blocks a
second, so it reaches the tip about 19 hours later. The checks then
showed no listener on the host and none reachable from it, and no route
from the namespace to the host's own services.

The operator wallet is `operator-2`, which the workspace_owner created in
a terminal outside the Claude app. `createwallet` is always run that way,
because it prints the recovery phrase, and anything shown in an agent
session, the app's shell input or its Terminal panel becomes part of that
session. `buyer-gate/operator.sh cli createwallet` creates the configured
wallet. A first wallet, `operator`, was created through the app's shell
input on 2026-11-08, and its phrase was shown in the session. It is
treated as exposed: it is never funded or used, and the launcher refuses
it.

Still to do, in order:
- once `spaced` is at the tip, `buyer-gate/operator.sh start-subs`, and a
  check that `subs` answers inside the namespace only;
- the chain check of the throwaway space, from this node, immediately
  before M1.

P3. Find a client or library call that verifies a signed record against a
certificate without trusting a relay (client question 5).

Found on 2026-11-08, and exercised on regtest. libveritas 0.4.4, the
version `subs` locks, verifies a handle's signed records in the same call
that verifies its certificate message. It attaches a record set to the
handle's zone only if the set's BIP-340 signature verifies against the
zone's current `script_pubkey`, for the zone's canonical name. A set that
fails is dropped without failing the message. `regtest/verifier` now
prints, for each zone, the verified records and whether the message
carried a set that was dropped. So a record is verified when the relay's
`/query` answer for the handle verifies against root anchors read from the
test operator's own `spaced`, the zone has the expected `script_pubkey`,
and its verified records equal the ones published, with a signature
record for the handle. Neither the relay's word nor a verified message
with no records counts.

Run `records-20261108T161951Z-0c9721` (`regtest/REPORT.md`, scenario 9)
exercised it with the harness as the client: a set signed with the
handle's key was verified and equal to what was signed, a set signed with
another key was dropped, a later set replaced an earlier one, and the
earlier one sent again didn't bring it back. The relay answered `200 ok`
to every message, those that were dropped too (R25). That is a regtest
result. It doesn't show that Nacho's records verify: Nacho's record format
and signing key are what M9 observes (client questions 1 and 4).

P4. Settle the client questions below that the test depends on, or record
that the test will observe them.

P5. Fill in the transaction plan below, and have the workspace_owner
authorize it.

## Steps

Every check below compares what was verified with what was expected. A
verifier that accepts a message establishes only that the message is
valid, not that it is the right handle, script or root. The comparisons
are those the harness makes: the handle's zone exists; its `script_pubkey`
equals the request's; the space's zone carries the commitment root read
back in M3, at the height where M3's commitment was mined; and the handle's
sovereignty is `sovereign`.

M1 (mainnet, workspace_owner). Run `space-cli operate` on the throwaway
space with v0.5.0. Wait for an anchor, then delegate to the test operator's
address. Confirm that the operator can operate. Evidence: the two `txid`s
and the operator's check.

M2 (workspace_owner's phone). The two requests from P1, checked again if
they were exported again. Evidence: the checker's output.

M3 (mainnet, operator). Fund the operator wallet with the authorized
amount. Add both requests through `POST /requests`. Commit locally, read
back both handles' roots and scripts by label (R8), then call `/broadcast`
once. Evidence: the root, the `txid` and the handle readback. If the answer
is lost, an error, or anything but a `txid`, the broadcast is uncertain:
stop, keep the evidence, and never call `/broadcast` or `/rollback-local`
for that commitment again (`CONTROLLER-DESIGN.md`, uncertain broadcasts).
Read the chain back for a transaction spending the delegate output and
carrying the root, in the mempool and in blocks (R13, R14, R18, R22). If
the readback positively identifies it, adopt its `txid` and continue.
Otherwise the space stays paused: finding nothing proves nothing, because
the original transaction may exist elsewhere and appear later, and a new
authorization doesn't change that. The only ways on are rebroadcasting the
identical signed bytes, if they were preserved (the pinned `subs` doesn't
journal them before sending, U1(c); the operator wallet may still hold
them), or safe supersession (`PAYMENT-SPEC.md`,
"Cancellation"), an on-chain action that follows its own reviewed procedure
and the workspace_owner's decision.

M4. Wait until the commitment is at `d >= 150` (about 25 hours) and a root
anchor covers it (R11). Evidence: the tip, the commitment height and the
newest anchor's height.

M5. For each handle, fetch `/certs/:handle/message` from `subs` and verify
it with `regtest/verifier` against anchors read from `spaced`, then make the
comparisons above. Evidence: each message file (public), the anchors, the
verifier's output and each comparison's result. `/certs/:handle`, a JSON
document carrying base64 certificates, is a candidate format for the import
in M8, not the verifier's input. Which formats Nacho accepts is still open
(client question 2).

M6 (operator). Publish both handles with one explicit call to
`/spaces/:space/publish`, by label, and read back each handle's
`publish_status`; both must be `final`, not `temp`. Then look both up on a
public relay named in the transaction plan, with the `/query` request the
harness makes of its local relay (`regtest/harness/publication.py`), and
verify each answer as in M5, with the same comparisons. Evidence: the call,
its answer, the statuses, and each relay answer with its verification.

M7. Before importing anything, note whether Nacho shows either name by
itself. Only now, with both certificates shown to be on a public relay, does
"Nacho shows nothing" say something about Nacho's discovery.

M8 (workspace_owner's phone). Import the first certificate by scanning a QR
code shown on another device. Import the second on the same phone, from the
file. Evidence: what Nacho accepted and showed, step by step.

M9 (workspace_owner's phone). Publish a record on each name from Nacho.
Verify each signed record against its certificate as P3 describes: read
the handle from the public relay's `/query`, verify the answer with
`regtest/verifier` against root anchors from the test operator's
`spaced`, and compare the zone's `script_pubkey` with the request's and
its verified records with what Nacho showed as published. Nacho's or the
relay's confirmation alone doesn't count.

M10 (mainnet, workspace_owner's phone). Transfer the first name to a fresh
recipient, then publish another record on the second name and verify it.
Evidence: the transfer, and the verified record on the untouched name.

M11 (mainnet, blocked). Recover the second name on a clean install with the
test operator stopped: verify its certificate, sign a verified record and
transfer it. The transfer is a mainnet transaction in the plan below. This
waits for an answer on Nacho's key derivation and backup (client question
1) and isn't attempted before then. It is the gate's largest open external
dependency: without it the gate can't pass.

What Nacho 0.1.1 says about recovery, read on 2026-11-08 from the
interface text in its Android package, by a static search of the
package's strings pulled with adb from the workspace_owner's phone
(nothing was run, and no phrase or key was read). The package is not kept
here. This is Nacho's own copy, not evidence of what it does:
- a keystore has a 12-word seed phrase, and handles are derived from it:
  a handle added with "Import a private key" is described as "not derived
  from your seed phrase", and a handle removed from a keystore as one the
  seed phrase "can re-derive";
- the app asks the holder to save both the seed phrase "and a backup
  file", and its restore takes that file, a Nacho `.sqlite` backup, to
  restore "your public key, handles, and certificates";
- a handle can be moved to a new key by a transaction the holder
  broadcasts from a wallet, effective once seen on chain.

The derivation path doesn't appear as text in the package: the app builds
it when it runs. So the path, how a handle's index is chosen, and whether
a seed phrase alone restores a handle without the backup file stay open
(client question 1). M11 therefore records which route it used, on which
Nacho version: the seed phrase with the backup file, or the seed phrase
alone with the certificate imported again. Only a route that verifies the
certificate, signs a verified record and transfers the name counts.

## Stop conditions

The test stops, with the evidence kept, if any of these happens:
- a request fails the checker, or the two scripts are equal;
- the readback differs from the requests;
- any broadcast or wallet transaction is uncertain: an answer lost, an
  error, or a result that isn't a `txid`. It is never sent again as a new
  transaction. A transaction the chain readback positively identifies is
  adopted; otherwise the step stays paused, since a negative search
  proves nothing. Only identical preserved signed bytes may be sent again,
  or a separately reviewed safe-supersession procedure followed;
- a certificate fails verification or any comparison once an anchor covers
  the commitment;
- a handle's `publish_status` isn't `final`, or a relay answer fails
  verification or a comparison;
- a record set Nacho published is dropped by the verifier, or never
  appears in a verified relay answer;
- Nacho rejects an import;
- any amount or fee would exceed what the transaction plan authorizes;
- any step would need a seed phrase or private key in a session.

## Client questions

From the staging draft's questions for the Spaces maintainers, with what
the repository knows now. None has a maintainer answer recorded here.

| # | Question | State |
| --- | --- | --- |
| 1 | Nacho's key derivation and backup, and whether it changed between versions | open; blocks M11. The workspace_owner's phone runs Nacho 0.1.1 for Android (`com.impervious.nacho`, versionCode 18, updated 2026-11-06), read with adb on 2026-11-08; the evidence for M11 names the version it ran on. Its interface text says handles are derived from the 12-word seed phrase and restored with a `.sqlite` backup file; the path isn't in the package's text (M11) |
| 2 | whether Nacho finds a third-party operator's certificates by itself, and which import formats it accepts, on the same phone too | open; M7 and M8 observe it, after M6 shows the certificates on a public relay. On 2026-11-08 a waiting request's page said the certificate "will appear once it's issued" and offered "Import certificate"; that is Nacho's copy, not evidence of discovery |
| 3 | whether Nacho always makes a fresh key per request | open; P1 shows two distinct scripts, not the rule |
| 4 | how a holder transfers a name and signs records in Nacho | open; M9 and M10 observe it |
| 5 | which client or library verifies a certificate and a signed record without a relay | libveritas 0.4.4, as in `regtest/verifier`, for both; signed records exercised on regtest with the harness as the client (P3). Whether Nacho's records verify is what M9 observes |
| 6 | `subs` broadcast idempotency | open upstream; candidate patches on regtest (`CONTROLLER-DESIGN.md`, U1). It matters here too: M3's one call can lose its answer. An uncertain broadcast stops the test; only a positively identified transaction is adopted, and otherwise the space stays paused (M3) |
| 7 | the supported operator restore from the `.sdb` file and certificates | exercised on regtest with patches (R13 to R18); belongs to the operator gate |
| 8 | the finality margin | the store uses `d >= 150` and anchor coverage (L1 to L9); M4 waits for both |
| 9 | temporary certificates for a handle removed before commit | not reached by this gate, which commits both handles at once |

## Transaction plan (to fill in and authorize)

Nothing below runs until the workspace_owner fills in each blank and
authorizes the plan as a whole. Amounts and fee limits are the
workspace_owner's decision; none is proposed here.

Chosen on 2026-11-08. The workspace_owner delegated the choice of
throwaway space ("whatever is easiest/correct/best to proceed with"). The
space chosen has no commitment and no delegation, so the test makes its
first commitment, which needs no proof. No other project's record
reserves it, and its expiry was about 294 days away at the check. Three
other candidates were ruled out:
- the space the 2026-11-06 requests are under already carries a
  commitment from an earlier pilot, so a further one needs a proof and
  that pilot's `subs` state;
- one space is reserved for another project's production pilot;
- one disposable staging space already has later commitments under
  another project's operator.

The space, the wallet that holds it, the operator machine (the
workspace_owner's workstation, P2) and where the evidence is kept are
recorded in the operator's private records, because they identify the
workspace_owner's spaces. The handles are the two from the repeated P1.
The M10 and M11 recipients are fresh Nacho requests made at each step.
The public relay is the one the M6 lookup used, as its evidence records. Still blank: the latest date for
M1, every amount and every fee limit. The workspace_owner is asked before
each step that spends sats, and the chain check is repeated immediately
before M1.

| Step | Transaction | Signed by | Amount | Fee limit |
| --- | --- | --- | --- | --- |
| M1 | operate the throwaway space | workspace_owner | ____ | ____ sat/vB |
| M1 | delegate to the test operator | workspace_owner | ____ | ____ sat/vB |
| M3 | fund the operator wallet | workspace_owner | ____ | ____ sat/vB |
| M3 | the initial commitment of both names | test operator | from the funding | ____ sat/vB |
| M10 | transfer the first name | workspace_owner's phone | ____ | ____ sat/vB |
| M11 | transfer the recovered second name, from the clean install | workspace_owner's phone | ____ | ____ sat/vB |

Also to fill in: the throwaway space, the two handles, the machine that
runs the test operator, the public relay used in M6, the fresh recipient
for M10 and the one for M11, the latest date for M1, and where the evidence
is kept. M11 runs only after client question 1 is answered, and the
workspace_owner may authorize it separately then. Funds left in the operator wallet after the test are returned to the
workspace_owner's wallet by a transaction the workspace_owner authorizes
then.
