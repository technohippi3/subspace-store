# Regtest report

Label: regtest. Every result here comes from Bitcoin Core 26.0, the pin until
2026-11-11, except the section "Bitcoin Core 31.2", which ran on 31.2, the
pin since. All of them ran `spaced` v0.5.0 and `subs` at `4dcc923` on a local regtest network, driven
by the harness in this directory. None of it is model, integration, mainnet
or buyer-acceptance evidence. The harness's registry and controller are
harness code, not the product. Findings are in `FINDINGS.md`, and the full
step tables, with the model's expectation beside each regtest result, are in
`runs/`.

Handle labels. The harness names test handles `one`, `two` and so on. The
runs before that change used personal first names as labels. Those labels
are replaced word for word in the committed copies of their reports and
logs, and nothing else in those files is changed. Hashes, roots, txids and
scripts are as recorded.

## Milestone: the first bounded regtest purchase (run fp4)

What run fp4 demonstrates, on regtest: a public recipient request, a
fixed-price quote, a regtest payment, issuance through the real `subs` and
`spaced`, finality at d >= 150, and a certificate verified with libveritas,
all the way to the member being ready.

What it doesn't demonstrate:
- relay publication (R6);
- buyer import, in Nacho or any other client;
- completed delivery: no member reached "fulfilled";
- proving: the initial commitment skips it, so no proof was made or
  verified in fp4;
- automatic recovery: the L2 resubmission of the commitment was a harness
  action, standing in for a peer (R10).

fp4 ran before the harness was tightened. It ran outside a network
namespace, while `subs` listened on every interface (R7). It had no
required or informational split and no exit-status verdict. Its run
directory is still kept locally, uncommitted, and its report is copied into
`runs/`. The directories of attempts 1 to 4 (fp1 to fp3) were deleted
between runs, before the rule never to delete one, and only their console
logs, plus attempt 4's JSON report, are kept in `runs/`. The stopped
all-scenario run all1 is kept too. It reached b2's local commit and was
stopped unisolated, before any proof. Runs after it use the tightened harness described below.

## First purchase (run fp4, 2026-11-07)

Script: `regtest/run-first-purchase.sh`. Full table:
`runs/first-purchase-fp4.md` and `.json`.

Each step and its regtest result:

1. Public recipient request for `one@test10000` with the buyer's taproot
   script: accepted as order o1.
2. Fixed-price quote: 10,000 sats to a fresh store address, temporary hold
   taken. A second quote for the held name was refused "taken for now"
   (Q1, as the model expects).
3. Regtest payment from the buyer's wallet: at 1 confirmation the order
   stays quoted. At 3 it converts to a fulfillment reservation (P1, as the
   model expects).
4. Freeze, then stage through `subs`' `/registry/sync` with the registry
   serving exactly the batch member, read back as staged with the buyer's
   script.
5. Local commit through `subs`: initial commitment, root read back on the
   member. Proving was skipped by `subs`, as it is for an initial commitment.
6. Checkpoint: `subs` stopped, its data directory and both databases copied
   and checked by SHA-256, `subs` restarted.
7. Binding check passed. The member was marked `issuing` and its mark and
   the broadcast intent were both acknowledged in the off-host journals
   before the one `/broadcast` (B3, as the model expects). A cancellation
   afterwards was refused (X3, as the model expects).
8. The commitment was mined, was not final at d = 149 and was final at
   d = 150. `subs` reported `finalized`.
9. Certificate: the message `subs` builds for the handle, verified with
   libveritas 0.4.4 against root anchors read from `spaced` directly. The
   handle, the buyer's script_pubkey, the batch root and its mined height
   and sovereignty all checked. The member became ready, as the model
   expects.

The same run then exercised lost finality:
- L1: a 151-block reorg took the commitment off the best chain. The batch
  returned to `broadcast`, the member to `issuing`, and cancellation and
  certificate verification were refused, all as the model expects.
- The model expects the commitment back in the mempool, and it was not
  (finding R10, a recorded disagreement). The harness resubmitted the
  identical signed bytes, standing in for a peer that kept them.
- L2: mined again, final again at d = 150, as the model expects.
- The certificate check then failed on sovereignty alone, because the
  newest root anchor lagged the tip (finding R11, a recorded disagreement
  with the d >= 150 rule). After mining to the next anchor it passed, and
  the member was ready again.

## How the first purchase got there

Earlier attempts, kept so their failures stay on record:
- Attempt 1 (fp1): the harness's staging readback compared full handle names
  with `subs`' label-only readback and parked its own member. That was a
  harness bug (R8 records the shape). The run stopped at staging.
- Attempt 2 (fp1, `runs/attempt-2-first-purchase.log`): the certificate
  verified, but the harness read the commitment root from the handle's zone,
  where libveritas never puts it (R9). That was a harness bug: the root was
  on the space's zone and matched. The run then stopped, because a test
  reorg to a shorter chain, which can't happen on a real network, left
  `spaced` at its old tip. The run's JSON report was deleted when its
  directory was cleared, and only the console log is kept.
- Attempt 3 (fp2, `runs/attempt-3-first-purchase.log`): the root check
  passed, and R10 appeared. The run stopped because nothing returned the
  commitment to the chain.
- Attempt 4 (fp3, `runs/attempt-4-first-purchase.*`): R11 appeared after L2.
  This run's `testmempoolaccept` result is not meaningful, because the
  harness's negative fee delta was still applied.
- Attempt 5 (fp4): the run above.

## All scenarios (run all-20261107T075846Z-ff80d4, 2026-11-07)

Script: `regtest/run-all.sh`. Full table: `runs/all-20261107T075846Z-ff80d4.md`
and `.json`. Isolated in a network namespace, after `main` (e0fa5ee, with
L6 to L8 and X10) was merged. Verdict: pass, exit 0, all four scenarios
completed. 98 required steps all agree with the model. 16 steps are
informational. Five of those 98 rows were weaker than their label in this
run. The quote row checked only that the model accepted a quote. The
freeze row checked only that the model's freeze succeeded, without
comparing members. The local-commit row was hardcoded to agree. The L1 and
L6 refusal rows compared with a constant instead of asking the model. All
five now compare the actual fields (`harness/compare.py`), and
`tests/test_regtest_compare.py` shows that a mismatch on any field fails
the run with exit status 1. The corrected comparisons haven't been rerun
against the live stack yet. One `getrootanchors` read hit the half-written file (R15)
and was retried. Proving took 79 s for b2 and 125 s for b3 in this run.
The run before it, `all-20261107T075152Z-248f89`, gave the same verdict
with the same counts, before the labels were changed. Its relabelled
report is also in `runs/`, and its proving times (about 35 s and 141 s)
appear below. Cases compared: P1, Q1, B3, B6, X3, X4, J3, J4, L1, L2, L6,
L7.

1. First purchase: as in fp4, now with the two gates for ready. L6 at
   d = 150 was "verified" the first time, because the anchor at 3600 covers
   3454. After the reorg it was "awaiting_anchor": verification was refused
   and the member stayed `issuing` until the anchor at 3780. For L7, the
   node did not have the commitment after the reorg (R10, informational).
   `/broadcast` was refused, the controller rebroadcast the identical
   signed bytes it had journaled when it first saw the transaction, and a
   second rebroadcast was refused while the transaction was in the
   mempool.
2. Second commitment with a proof (b2, o3 and o4): the controller pushed
   one step proof to `subs-prover` (R12), and CPU proving took about 35 s.
   B6: no second batch while b2 was open. J3: with the store's journal down,
   nothing was sent and b2 waited in `issuing`. A resume was refused while
   the journal was down, and once both journals acknowledged, exactly one
   commitment was sent. Both certificates, which carry the proof's receipt,
   verified with libveritas, and o3 and o4 became ready.
3. Host loss and restore (b3, o5): a step and a fold proof took about 141 s.
   The host's databases and the `subs` data directory were deleted after
   the broadcast, then restored from the checkpoint snapshot, which
   predates the broadcast, plus both journals. J4: o5 was `issuing` and its
   cancellation was refused. The restored tree root equals the chain's
   root, but `subs` has no txid, and its pipeline offers "Ready to
   broadcast" for a mined commitment (R13). b3 reached final, and o5 became
   ready.
4. Lost broadcast response (b4, o6, on `@test9999`): `spaced`'s answer to
   `subs` was dropped. `subs` answered HTTP 500 and stored no txid, and the
   batch became `broadcast_uncertain`. X4: cancellation, `/broadcast` again
   and `/rollback-local` were all refused. The readback found the
   transaction in the node's mempool and in the operator wallet, and the
   controller adopted the txid in its journal alone, with neither U1(b) nor
   a manual repair (R14). The batch reached final and o6 became ready. With
   a further order (o7) staged, `subs` allowed a dry run of the next local
   commit, although it holds no txid for the initial commitment (R16).

What the full run does not show: relay publication, buyer import,
completed delivery, X10 (a supersession undone by a reorg deeper than 6),
L8 (no journaled bytes, recovery paused), a controller-side lost answer
from `subs` (only `spaced`'s answer to `subs` was dropped), refunds, late
payments, hold extensions, eligibility proofs, auctions, and a natural
competing-chain reorg. Bitcoin Core and `spaced` stayed up through the
"host loss", standing in for the network and for an operator wallet
restored from its onboarding backup.

Earlier all-scenario runs, kept for the record:
- `all1`: stopped unisolated at b2's local commit, before the namespace.
- `all-20261107T070251Z-80b727`: ended in error, a race between the new tip
  and its anchor in the harness.
- `all-20261107T070452Z-f3a757`: stopped, because proving never started
  (R12). Its saved report predates the "did not finish" marker and wrongly
  reads "pass". It did not finish.
- `all-20261107T072937Z-12277c`: passed against the model before the merge.
- `all-20261107T075023Z-f6dfd6`: ended in error, `getrootanchors` reading
  a half-written file (R15).

## Corrected comparisons (run all-20261107T083353Z-06a396, 2026-11-07)

Script: `regtest/run-all.sh`, from `main` at `8c20619`, isolated. Verdict:
pass, exit 0, all four scenarios completed. All 98 required steps agree
with the model, now including the quote, freeze, local-commit, L1 and L6
rows with their actual comparisons. 16 steps are informational. Proving
took 40 s for b2 and 110 s for b3. Report: `runs/all-20261107T083353Z-06a396.*`,
certificates in `evidence/`.

## Continued operation after recovery (2026-11-07)

Script: `regtest/run-continued.sh [pinned|u1b]`. It runs the first
purchase, the second commitment and the host restore, then scenario 5: the
first space's last commitment (b3, `idx 2`) is final, the controller
adopted its txid, and `subs` holds none (R13). One more order is bought, and
the controller tries to issue another batch.

- With the pinned `subs`, run `continued-pinned-20261107T085046Z-cc9a7a`:
  verdict fail, exit 1. 80 of 81 required steps agree. The one that
  disagrees is the blocker: `subs` refused the next local commit, "previous
  commit not yet submitted on-chain" (R17). The model allows it. The
  pinned `subs` has no route to attach the txid (HTTP 404).
- With `subs` patched for U1(b), run `continued-u1b-20261107T085107Z-645ce5`:
  verdict pass, exit 0, all 94 required steps agree. A wrong txid (b2's) was
  refused. The adopted txid was attached. The next batch (b4, `idx 3`)
  committed, was proved with a step and a fold (110 s), broadcast and
  finalized, waited for anchor coverage, and its certificate verified. The
  order became ready.

So recovery restores continued operation only with U1(b). The patch is in
`upstream/` (R17, R18).

Those two runs used the patch's second draft, which review found too weak:
it matched the root's bytes anywhere in a raw transaction, and the
wallet's record without its space. The patch now binds the txid to the
space's delegate output in chain state (R18). It was rerun with scenario 4
first, so that another space has a commitment, and with three impostor
txids tried before the real one:
- `continued-pinned-20261107T101052Z-049497`: verdict fail, exit 1. 104 of
  105 required steps agree. The impostors are refused, because the pinned
  `subs` has no route. The local commit is refused at the blocker (R17).
- `continued-u1b-20261107T101924Z-2f11b7`: verdict pass, exit 0. All 119
  required steps agree, and 20 are informational. Each impostor was refused
  because it didn't make this space's delegate output: a transaction
  carrying the root's bytes, `@test9999`'s commitment, and an earlier
  commitment of `@test10000`. The adopted txid was attached. The next batch
  (b6, `idx 3`) committed, was proved with a step and a fold (100 s),
  broadcast and finalized, and after anchor coverage its certificate
  verified. The order became ready.

Three runs in between ended in harness bugs and aren't kept.
`continued-pinned-20261107T100339Z-dda7d3` and
`continued-u1b-20261107T100411Z-4a4807` ended in error: the miner wallet had
no spendable funds for the impostor transaction, and the buyer's wallet is
used now. `continued-u1b-20261107T101124Z-e6bcf7` failed at L6, because the
model's mirror of `@test10000` wasn't advanced for the blocks mined during
scenario 4. Scenario 5 now brings the mirror to the real tip first, and
records it (it was 183 blocks behind).

## Publication and delivery through a local relay (run publication-20261107T094250Z-76605c, 2026-11-07)

Script: `regtest/run-publication.sh`. Full table:
`runs/publication-20261107T094250Z-76605c.md` and `.json`. Verdict pass,
exit 0. All 62 required steps agree with the model, 30 of them in
scenario 6.

The run uses `subs` with `upstream/subs-fabric-seed.patch` (built as
`.cache/bin/subs-relay` by `build-relay.sh`) and the pinned `certrelay` at
`fb44648`, the commit `subs` locks. Both run inside the run's namespace.
`subs` logged "Using fabric seeds: http://127.0.0.1:18950", the relay had
no seeds and no peers, and nothing in the namespace can reach the public
relay network (R19). The pinned `subs` can't be isolated this way, because
it has no option to name its relays.

After the first purchase (scenario 1, unchanged), scenario 6 follows the
publication procedure for b1, then issues b2 and does the same:
1. The outstanding set for the batch is the member whose certificate
   verified, journaled in the controller's journal.
2. Before publication, a lookup of `one@test10000` through the relay
   answered with a message that verified but held no zone for the handle,
   so delivery was not confirmed. The model refuses delivery of an
   unpublished handle too (L3, R21).
3. Immediately before the call, the live chain carried b1's root at
   `d = 174`, covered by the anchor at 3780. `/publish` with the one-handle
   chunk `["one"]` answered `handles_published: 1, remaining: 0`, and the
   handle's `publish_status` read "final". The model allowed and counted
   the same chunk.
4. The live check ran again, then the relay's `/query` answer was verified
   with libveritas against `spaced`'s anchors. Handle, buyer script, root
   `326b921a...` at 3606 and `sovereign` all matched. The order went from
   ready to fulfilled, and the model fulfilled it too.
5. A second pass with nothing outstanding made no call, as the model
   expects for an empty set.
6. For b2 (order o3, `two@test10000`, a commitment that needed a 50 s step
   proof), publication was refused at `d = 149` (L1) and at `d = 150` while
   the newest anchor was 140 blocks past the commitment (L6), as in the
   model. After mining to the anchor at 3960, the certificate verified,
   publication and delivery went as for b1, and o3 became fulfilled.

In this run the L3 row's regtest side was the constant "not confirmed",
not the result of the delivery path. It now calls the controller's
`confirm_delivery`, which refuses an unpublished handle, and compares that.
The kept run predates the correction and hasn't been rerun.

So two orders reached "fulfilled" on regtest: request, quote, payment,
issuance, finality, anchor coverage, publication to a relay and a verified
lookup through it. The relay messages are kept as evidence and verify
offline. The one-handle message after the proved commitment was 226,260
bytes, 43.2% of the relay's 512 KB limit (R20).

## Recovery, continued issuance and delivery together (2026-11-07)

Script: `regtest/run-combined.sh`. `subs` is built with both upstream
patches (`build-combined.sh`): U1(b), taking its evidence from `spaced`'s
nums block index (R18, R22), and `--fabric-seed`. The relay is `certrelay`
at `fb44648`, inside the namespace. The run executes scenarios 1 to 6 in
order: the first purchase, the second commitment, the host restore, the
lost broadcast answer, another batch after the recovery, and publication
with delivery. Scenario 6 now ends with case L9 (R24).

Run `combined-20261107T150906Z-8270f6`, from `main` at `78c55b7` plus this
round's changes: verdict pass, exit 0. All 193 required steps agree with
the model, and 26 are informational.
- Scenario 5 refused three impostor txids and attached b3's adopted txid.
  The next batch (b6, order o8) committed, was proved, broadcast and
  finalized, and its certificate verified.
- Scenario 6 published every final batch of `@test10000` to the local
  relay and confirmed delivery: o1, o3, o4, o5 (the restored batch) and o8
  (the batch after the recovery). Their lookups came back under b6's root,
  at height 4328 (R23).
- b7 (order o9) waited for finality and anchor coverage before publication.
  Its member was then published while b8 (order o10), the next commitment,
  was at `d = 149`. `subs` built the certificate on b8's root, at height
  4684, and libveritas answered "pending". Delivery waited at `d = 149`
  and again at `d = 150` before an anchor covered b8, with no alert, and
  the model (L9) refused both times too. Once an anchor covered b8, the
  lookup verified as sovereign and o9 was fulfilled. o10 followed.
- Seven orders reached "fulfilled" by libveritas-verified lookups through
  the relay. The corrected L3 check refused every unpublished handle.

Two earlier combined runs are kept. `combined-20261107T113909Z-345992` is
R23's evidence: delivery of o1 to o5 failed at the root check, because the
harness compared the issuing batch's root.
`combined-20261107T145828Z-92636d` is R24's: it reproduced the young
certificate root live, and the harness refused delivery correctly, but
counted libveritas's "pending" as a mismatch and alerted, so those two rows
disagreed with the model. `combined-20261107T114800Z-d17683` passed before
L9 existed, with 169 required steps, and the U1(b) draft cites it.

## The store service (run service-20261107T160513Z-6da944, 2026-11-07)

Script: `regtest/run-service.sh`, from `main` at `7a28645` plus the
service. The store service (`service/`, see `docs/SERVICE.md`) runs as its
own process in place of the harness registry. The harness controller, the
publication procedure and the model mirror are unchanged. The controller
reaches the service through its operator API, `subs` polls its `/pending`
with the registry token, and the buyer acts only through the public request
and the private order link. `subs` is the `subs-relay` build. The service
was killed with SIGKILL and started again six times.

Verdict pass, exit 0. All 43 required steps agree with the model, and 10
are informational.
- Scenario 7, a purchase through the service. A second buyer got "taken
  for now" (Q1). The service was killed with the payment at 1 conf and
  came back with the order quoted and the hold kept. At 3 conf it
  converted, and the order link showed it. The batch was issued, and a
  cancellation after `issuing` was refused (X3). The service was killed
  again while the member was `issuing` and while it was ready, and came
  back in the same state each time. The handle was published to the local
  relay, delivery was confirmed by a libveritas-verified lookup, and the
  order reached "fulfilled". It was still fulfilled after a fourth kill.
- Scenario 8, a cancellation refund. After the owner's cancellation and the
  buyer's refund address through the order link, a refund at 3 conf was
  refused, because nothing was settled (N2). At 6 conf it was built: 9,700
  to the buyer, a 300 fee and 10,000 reserved. The store's off-host journal
  was down while it was built, so broadcast was refused (J5) and nothing
  reached the mempool. The service was killed then and came back with one
  backlogged journal entry, which it wrote once the journal returned; then
  the broadcast went out. After a further kill the attempt was found in the
  mempool and not resent. The refund's group closed at 6 conf with 10,000
  refunded, and the buyer's wallet received 9,700 at the address it gave.

An earlier attempt, `service-20261107T160343Z-a53a79`, stopped with an
error at the first checkpoint: the controller's coordinated snapshot backs
up the registry's database, and the service client had none to give. The
client now gives a read-only connection to the service's database. That
run isn't kept.

`service-20261107T185629Z-196ad6` is the same script rerun after the
recipient-request rules of draft 12: strict request validation, script
claims only by paid orders, and the audit of stored recipients at every
start. Verdict pass, exit 0. All 43 required steps agree with the model, 10
are informational, and the service was killed and started again six times.
Both buyers' requests used fresh P2TR scripts from the buyer wallet and
passed the new checks. The run shows that the purchase and refund paths
still work with the new code. It doesn't exercise the new rules: cases V1 to
V16 are tested by the service's API tests over a simulated chain, not on
regtest.

`service-20261108T102328Z-fef5b8` is the same script rerun after draft 13
changed how the service writes its off-host journal: one entry per write,
acknowledged whole, now also carrying alerts, authorizations and each
order link's hash. Verdict pass, exit 0. All 43 required steps agree with
the model, 10 are informational, and the service was killed and started
again six times, including scenario 8's J5 step, a broadcast refused while
the journal is down. The run shows that the purchase and refund paths work
with the new journal. It doesn't exercise a restore from the journal: cases
H1 to H7 are tested over a simulated chain and beside the model, not on
regtest.

`service-20261108T125955Z-8a921f` is the same script rerun after draft 14,
under which an address is given out, and a cancellation reported final, only
once acknowledged off-host, and a quote asked again rechecks its recipient
(J11, J12, H8 to H10, V17). Verdict pass, exit 0. All 43 required steps
agree with the model, 10 are informational, and the service was killed and
started again six times, J5 included. The scenarios quote and cancel with
the journal up, so the run shows that purchase, cancellation and refund
still work with the new gates. It doesn't exercise them: no step quotes or
cancels during an outage, and none restores from the journal. Those cases
are tested over a simulated chain and beside the model, not on regtest.

## Signed records through a local relay (run records-20261108T161951Z-0c9721, 2026-11-08)

Script: `regtest/run-records.sh`, from `main` at `7d1614c` plus the
uncommitted buyer-gate preparation. It runs the first purchase, then
scenario 9, with the `subs-relay` build and the local relay. Verdict pass,
exit 0. All 63 required steps agree, with the model where the model has an
expectation and otherwise with the record rule stated in the step, and 11
are informational.

Scenario 9 sells `two@test10000` to a P2TR script whose output key is a
fresh key the run made (`subspace-regtest-records keygen`). It issues the
name in b2, publishes it and confirms delivery through the relay as
scenario 6 does. The harness then acts as the client. It builds messages
for the handle from the relay's verified answer, with records signed by the
handle's key or by a second fresh key, sends them to the relay's
`/message`, and reads the handle back from `/query`. Each answer was
verified with the pinned libveritas against root anchors read from
`spaced`, and its verified records compared with the ones signed:
- before any record was sent, the answer verified with no records;
- a set signed with the other key verified offline with the set dropped.
  The relay answered `200 ok` to it, and its next answer carried no
  records;
- the owner's set with seq 1 verified, offline and in the relay's next
  answer, equal to what was signed, with its signature record for the
  handle;
- the owner's seq 2 replaced it;
- seq 1 sent again, and a seq 3 signed with the other key, each answered
  `200 ok`, and left seq 2 in place.

The two keys were kept in the run directory, outside the kept evidence,
and deleted when the scenario ended; a required step checks that. Finding
R25 records what this shows about the relay.

The run shows that libveritas 0.4.4 verifies signed records offline,
against the zone's current key and with anchors from the operator's own
node, and that in this run the relay kept the newest owner-signed set and
passed on nothing that didn't verify. It doesn't show any of that for Nacho: the harness signed with
libveritas's own builder, and no client from the buyer gate took part. It
doesn't cover a transferred name, a delegate's records or a relay that
withholds the newest set.

## Checkout pages and the attended runner (run checkout-20261109T141954Z-1d9c65, 2026-11-09)

Script: `regtest/run-checkout.sh`, from `main` at `58925e6` plus the
checkout milestone. The store service runs as its own process, as in
scenarios 7 and 8. The buyer used only the checkout pages, over HTTP. A
regtest wallet stood in for the buyer's client: the request pasted on the
name's page is in the public request format a Nacho export has, built from
that wallet's script. After the operator listed each name through the
operator API, every operator step was a command of the attended runner
(`python3 -m runner`). Each command ran as its own process with no
terminal, and with its own controller database and journal. The harness
only listed names, mined blocks and read the chain. `subs` is the
`subs-relay` build.

Verdict pass, exit 0. All 30 required steps agree with the checkout and
runner rules (not the model), and 4 are informational.
- 10a, a purchase. The names page listed the name as available (C1). The
  pasted request redirected to a private order page (C2). The invoice
  showed the order's own address and `bitcoin:<address>?amount=0.0001`
  (C4). The buyer paid that URI's address and amount. At 3 blocks the page
  showed the order converted and no longer asked for payment (C11).
  `prepare` froze, staged, committed, proved and checkpointed the batch.
  `issue` without its confirmation was refused, and the order stayed
  converted (A1). With the batch id confirmed it broadcast, the commitment
  was in the mempool, and the page showed `issuing` (A4). `watch` reported
  mined at d = 0 and d = 149 and final at d = 150. `certify` verified the
  certificate with libveritas and delivered it (A3). The page offered it
  and served it (C7). The buyer's download verified with libveritas
  against root anchors read from `spaced`: the handle, the buyer's own
  script, sovereign. `publish` confirmed delivery by a verified lookup
  through the local relay, and the page then showed `fulfilled` and still
  served the same bytes.
- 10b, a cancellation and refund. The order page asked for no payment
  once the order converted, nor once it was cancelled (C11). After
  `cancel` the page showed the cancellation as final, and the buyer gave
  a refund address on the page. `refund` at 3 blocks was refused, because
  nothing had settled (N2). At 6 blocks it built 9,700 to the buyer with a
  300 fee. `broadcast-refund` without its confirmation was refused, and
  nothing reached the mempool (A2). With the group id confirmed it was
  broadcast (A5). At 6 blocks the page showed the refund settled, and the
  buyer's wallet had received 9,700 at the address it gave.

The certificate in this run was a first commitment's, 2,077 bytes (2,148
in `checkout-20261109T140545Z-3fc2e0`). A later batch's certificate
carries a proof and is about 226,500 bytes. Delivering one is case C10,
tested over a simulated chain with a certificate from kept evidence, not
on regtest.

`checkout-20261109T140438Z-7d58f0`, the first attempt, failed. The
scenario mined one block too few: the controller counts depth from 0 in
the block that mines the commitment, so the batch was at d = 149 where the
scenario expected d = 150. `watch` reported it mined, not final, and every
later step of 10a failed for that reason, starting with `certify` refusing
"not final". The runner's `watch` output also printed depth one too high.
Both were fixed. 10b passed in that run. It isn't kept.

`checkout-20261109T140545Z-3fc2e0` is the same scenario after those fixes,
with the order pages as they were before the review of 2026-11-09. Verdict
pass, exit 0, 30 required steps agreeing and 4 informational. That review
found two faults its steps didn't check. A certificate over 65,536 bytes
couldn't be delivered. And the page kept showing "Pay exactly" and the
BIP21 link after conversion, fulfilment and cancellation. Both were fixed
(C10, C11), and `checkout-20261109T141954Z-1d9c65` is the rerun with those
fixes, its steps also checking that the converted and cancelled pages ask
for no payment. Both passing runs are kept.

## The controller outside the harness (2026-11-09)

The controller, its publisher, the journals and the clients moved from
`regtest/harness/` into `controller/`. The runner now builds them from a
host configuration alone (`controller/host.py`), and the harness runs the
same implementation through an adapter over its stack
(`regtest/harness/controller.py`). Two runs, from `main` at `d044b39` plus
the extraction, check that nothing the scenarios see changed:
- `combined-20261109T171321Z-326449`: first purchase, second commitment,
  host restore, lost broadcast answer, another batch after the recovery
  (scenario 5) and publication with delivery (scenario 6), with the
  `subs-combined` build. Verdict pass, exit 0, 193 required steps
  agreeing and 26 informational. It took about 10 minutes.
- `checkout-20261109T172316Z-856621`: scenario 10, the runner as its own
  process, now with the host configuration the harness writes for it,
  stopping and starting `subs` around its snapshot with the configured
  commands. Verdict pass, exit 0, 30 required steps agreeing and 4
  informational.

Each run has the same steps as the last kept run of its scenario
(`combined-20261107T150906Z-8270f6` and
`checkout-20261109T141954Z-1d9c65`), compared by scenario, case, step,
kind and agreement: none is missing and none is new. In scenario 5 the
`subs-combined` build has the U1(b) route, the harness states that
capability, and the three wrong txids were refused, the adopted one
attached, and the next local commit allowed, as before. Both runs are
kept.

A review of those two runs found three faults the scenarios didn't
reach. The runner trusted the configuration's network label. The snapshot
took an HTTP error or a timeout from a stopped `subs` as proof it had
stopped. And a configuration with a null path got as far as creating
directories. After the fixes (A6, A7, A10), the runner asks `bitcoind`,
`spaced`, `subs` and the store which network and chain they are on before
every command, a snapshot copies only once a connection to `subs` is
refused, and every value is checked first. Both scenarios ran again:
`checkout-20261109T180948Z-38c0f8`, whose every runner command passed the
network check against the real stack, and
`combined-20261109T181028Z-68167e`, whose snapshots passed the stricter
shutdown check. Both pass, with 30 and 4, and 193 and 26, required and
informational steps, and again match their predecessors step for step.
They are kept too.

A second review found the network check still had two gaps: it asked only
the `subs` endpoint the controller reads from, not the one it writes to,
which broadcasts, and it took a lower height as the same chain. Now each
`subs` endpoint is asked, through itself, for the network and tip hash of
the `spaced` behind it, and that hash must be on the controller's best
chain (A10). `checkout-20261109T185521Z-addb39` ran with that check: its
13 runner commands all passed it against the real stack, through the
fault proxy for writes and directly for reads. The other outcomes were
the two refusals without a confirmation (A1, A2) and the refund refused
at 3 blocks (N2), as before. Verdict pass, 30 required steps agreeing and
4 informational, matching its predecessors step for step; it is kept. The
combined scenario doesn't use the runner, so it wasn't run again.

Not rerun after the extraction: the pinned `subs` variant of scenario 5
(`run-continued.sh pinned`), and the publication, records and service
scenarios on their own. With the pinned build the controller now refuses
the attach itself, stating the missing capability, where `subs` used to
answer that it has no such route. Those steps are informational, and the
next local commit is still refused by `subs` (R17).

## The operator gate's recovery rehearsal (scenario 11, 2026-11-09)

Script: `regtest/run-recovery.sh`, from `main` at `5226810` plus this
round's changes. `subs` is the `subs-combined` build (U1(b) and
`--fabric-seed`). Full table: `runs/recovery-20261109T194227Z-a5f2e7.md`
and `.json`. Verdict pass, exit 0. All 65 required steps agree with the
recovery rules of `CONTROLLER-DESIGN.md` and `PAYMENT-SPEC.md` (not the
model), and 14 are informational. This is the rehearsal of
`CONTROLLER-DESIGN.md`, "Operator gate rehearsal", on regtest. It isn't the
operator gate passed: see what it doesn't cover, below.

The world and the host. A separate "network" bitcoind holds the preset
chain, the buyers' and the miner's wallets, a `spaced` of its own and the
relay, which reads from that `spaced`. They stand for the world and are
never touched by the loss. The host is its own bitcoind, which starts
empty and syncs from the network node as its one peer, `spaced`, `subs`,
the prover, the store service, the fault proxies and the attended runner.
Off the host are the store's journal, the runner's journal, the
coordinated snapshots and two backups taken at onboarding: the operator
wallet exported from `spaced` (`walletexport`) and the store's payment and
refund wallet backed up by Bitcoin Core (`backupwallet`). The backups hold
regtest key material; they stay in the run directory, mode 0600, and
aren't kept in the repository.

In flight when the host was lost, one state per space, so that every
state of the rehearsal's step 1 coexists:
- `@test10000`: b1 fulfilled, through `prepare`, `issue`, `watch`,
  `certify` and `publish`; then b4 `broadcast`, sent after the latest
  snapshot, with its txid known;
- `@test9999`: b2 `checkpointed`;
- `@test9998`: b3 `issuing`. Its broadcast went out, and the fault proxy
  in front of `subs` withheld the answer from the runner, which was still
  waiting when the host was lost. The runner's journal had b3 `issuing`
  with its intent, and no txid;
- `@test9997`: b5 `committed_local`, after the latest snapshot. No runner
  command stops there, so the harness built the runner's controller from
  the same host configuration (`controller.host.build`) and took the
  first three steps;
- a cancellation refund of 9,700 from the store's hot wallet, built by
  `runner refund` and sent by `runner broadcast-refund` with its group id
  confirmed;
- an unpaid quote, the newest address the store's wallet had given out.

The wallet funded b4 from b3's unconfirmed change (R26). The world's node
had b3, b4 and the refund in its mempool when the host was lost. Nothing
was mined while the host was down.

The loss. Every host process was killed with SIGKILL, the waiting runner
among them, and every host path deleted: the host node's and `spaced`'s
data, `subs`' data, the store's and the controller's databases, the
runner's directory, the service's configuration and tokens, and the
credential files. Left were the two journals, four snapshots
(`001-b1` to `004-b4`) and the two backups.

The fresh host, in order, each step timed:
1. Its bitcoind started empty and synced from the network node. Its
   mempool was empty: a node learns no earlier mempool from its peers.
2. `spaced` started empty and synced.
3. The operator wallet was imported from its backup and synced; it owns
   the four spaces.
4. The store's wallet was restored from its backup (`restorewallet`).
5. `python3 -m service restore` rebuilt the store's database from its
   journal alone: 7 names, 7 orders, 1 refund group, 1 authorization.
6. The store started. Before serving, it reconciled the refund attempt,
   which the fresh node didn't know, and sent the same signed bytes again
   (H6).
7. `runner restore` checked the latest snapshot, `004-b4`, against its
   manifest (13 files of `subs`), copied it into `subs`' empty data
   directory while `subs` was down, started `subs`, rebuilt the
   controller's five batches from its journal and reconciled them. b5 was
   rebuilt, because the restored `subs` didn't hold its local commitment;
   its order stayed paid. b3, an intent with no answer, became
   `broadcast_uncertain`, and its readback found nothing. b4 waited for
   its bytes to be sent again, b2 was reconciled, and b1 was closed.
8. The fresh host's tokens are new, so `subs` was given the store's new
   registry token. That is host provisioning, not part of the recovery
   set.
9. `runner issue b2` was refused, saying what the restore still waited
   for (A14).
10. `runner readback b3` found nothing on this host: the commitment was in
    the world's mempool only.
11. `runner rebroadcast b4` without its confirmation was refused, and
    nothing reached the mempool (A11). Confirmed, it sent b3's bytes,
    journaled as b4's unconfirmed ancestor, then b4's own (A15).
12. `runner readback b3` again adopted b3's txid, now in this node's
    mempool, before any block.
13. A block arrived (the world mined one), and `runner attach-txid` told
    `subs` the txids of b4 and b3 (U1(b)).
14. `runner status` reported the restore reconciled, with nothing waiting.

Checks against the state before the loss, all required and all passing:
- every order's status as before;
- every order's reservation, available amount, refunded total, sums
  (recomputed from the chain), destination, recipient and refund groups
  as before, so no reservation disappeared. The refund had one
  confirmation then, so its group stayed open and its reservation with
  it;
- every name's fulfillment reservation as before, and the unpaid quote's
  hold kept;
- no name issued twice: each handle committed once in `subs`, and each
  order in one batch that wasn't rebuilt;
- each space's restored tree root against the chain: on `@test10000` and
  `@test9998`, `subs`' root equal to the chain's, with the txid attached;
  on `@test9999`, one local commitment ahead, b2 never sent; on
  `@test9997`, no commitment on either side;
- no refund paid twice: one group with one attempt, and one transaction
  paying the buyer's refund address, 9,700 sats;
- every buyer's order link, kept by the buyer, opening its own order with
  the status it had (H1, on regtest).

Then issuance and refunds resumed:
- `runner issue b2`, with the binding check again, and `runner prepare`
  on `@test9997`, which redid b5's order as b6 from staging; both sent;
- b4, b3, b2 and b6 mined to d >= 150 and an anchor that covers them,
  certified, published and confirmed by verified lookups through the
  relay: their four orders fulfilled;
- the first quote after the restore: the restored wallet's next address
  was the unpaid quote's, and the store skipped it, with one
  `destination_held` alert (H11);
- another batch on `@test10000`, b7, after the recovery: prepared, proved
  with a step and a fold (107 s; b4's step proof had taken 36 s), issued,
  finalized, certified and delivered, its order fulfilled. The fresh
  host's runner numbered its snapshots on from the restored ones,
  `005-b6` and `006-b7`;
- a new cancellation refund after the recovery, built and sent through
  the runner; both refunds settled at 6 confirmations, each paid once.

The two times, with the history they were measured on (regtest, one run):

| Measure | Seconds | History |
| --- | --- | --- |
| Store replay, `python3 -m service restore` | 0.15 | store journal of 41 entries, 34,908 bytes; 7 orders, 1 refund group, no alert |
| Complete recovery, until issuance and refunds can safely resume | 28.2 | the above, and the runner's journal of 41 entries, 21,288 bytes; five batches; four spaces |

The complete recovery runs from starting the fresh host's bitcoind to
`runner status` reporting the restore reconciled. Of it, 13.7 s went to
the host node's sync from the network node and 4.4 s to `spaced`'s,
over a regtest chain of about 3,640 blocks; the operator wallet's import
and sync took 3.1 s, `runner restore` 0.55 s and each other runner
command under half a second. One block was needed before the
attaches; on regtest the harness mined it at once, so the time holds no
wait for a block, which on mainnet would add one block interval or more.
The rehearsal stands for no sales period: its 7 orders were placed over
180 blocks mined at once. The targets for both times are open
points for the workspace_owner, and these numbers don't set them.

The replay on generated journals. A rehearsal's few orders can't show
whether a whole sales period replays fast enough, so `tools/replay_timing.py`
writes journals with the service's own ledger over the model's simulated
chain and times `python3 -m service restore` on them. Each order is a name
listed, a request and a quote; every tenth expires unpaid, every twentieth
paid one is cancelled and refunded from a hot-wallet group that settles,
and every fiftieth issued one gets an owner alert and stays issuing; the
rest are fulfilled. These results are labelled generated: not regtest,
and no real sales history. The sales periods are assumptions, not the
workspace_owner's. The replay is the timed step; generating the journal
isn't. A profile of the 1,000-order generation put most of its time in the
ledger's database queries and the journal's fsync per entry, and the time
per order grew with the history: 20 s for 1,000 orders, 69 s for 3,000
and 357 s for 10,000. That growth in the store's own operations wasn't
investigated further.

| Orders (assumed sales period) | Outcomes | Journal | Replay |
| --- | --- | --- | --- |
| 1,000 (a three-month pilot at about 11 orders a day) | 830 fulfilled, 100 expired, 50 refunded, 20 alerted | 5,040 entries, 4,746,237 bytes | 0.23 s |
| 3,000 (three times that, as headroom) | 2,490 fulfilled, 300 expired, 150 refunded, 60 alerted | 15,120 entries, 14,335,342 bytes | 0.52 s |
| 10,000 (ten times that, as headroom) | 8,300 fulfilled, 1,000 expired, 500 refunded, 200 alerted | 50,400 entries, 47,950,396 bytes | 1.39 s |

Each replay restored every record the generation built, and was timed
once, on the same machine as the rehearsal, with Python 3.12.

What the rehearsal doesn't cover:
- the refund family with an exported, owner-signed PSBT: the API can't
  export one, so it wasn't opened. The gate needs it only if the launch
  uses owner-signed PSBTs; refund funding is undecided;
- a separate off-host store with its own credentials and the provider's
  per-object checksums. The journals, snapshots and backups are a
  directory of the run, written with read-back;
- U1(a) and U1(c). Without U1(c) the controller reads a commitment's bytes
  only after the send; b3's own bytes were never read, and only b4's
  ancestry saved them (R26). A commitment whose parent the controller
  never saw can't be rebroadcast;
- the snapshot's copies of the store's and the controller's databases.
  The store and the controller were each restored from their own journal
  alone, as the rehearsal asks; restoring from a snapshot plus the journal
  since it isn't built;
- the certificate of b1's order on its order page. Certificates aren't
  journaled, and `runner certify` then verified a member's certificate
  only on its own batch's root, while `subs` builds it on b4's later root,
  so in this run the order page for b1's order offered no certificate
  after the restore. The buyer's copy and the relay's were unaffected.
  Closed since: "Certificate re-delivery after the restore", below;
- the publisher's outstanding sets, which were lost with the host and
  started empty; batches published after the restore were enrolled again
  from their ready members;
- a mainnet host, a real operator wallet, a host with a pruned or `yuki`
  node, and recovery times over a long chain.

Earlier attempts:
- `probe-recovery-20261109T192504Z-dc4d1f`, the first attempt, is kept as
  R26's evidence. Verdict fail, 2 of 61 required steps disagreeing. b4's
  rebroadcast was refused by the fresh node for a missing input, its
  parent b3, which the controller hadn't journaled; that is R26, and the
  ancestors rule (A15) followed. The other was a harness slip: it read
  the new refund before the store's next evaluation and found it not yet
  closed. Its recovery took 29.5 s, with the store's replay 0.16 s, on a
  history of the same size. It also showed that each runner process
  numbered its snapshots from 1 (`001-b1` to `001-b4`), so which one was
  latest rested on the batch label alone; snapshots are now numbered after
  every one already there.
- `recovery-20261109T193541Z-b9c69e` ended in error, a harness bug: it
  read b4 from the world's node before the commitment had reached it. Not
  kept.
- `recovery-20261109T193734Z-832b65` passed, 64 required steps agreeing,
  with a complete recovery of 29.0 s and a replay of 0.16 s. Its recorded
  history counted the alerts after the recovery, not before the loss, so
  it was rerun with that corrected, and with the checks on the buyers'
  order links and on b1's certificate added. Not kept.

## Review of the recovery rehearsal (2026-11-10)

A review of the scenario 11 work found two faults that the rehearsal
didn't reach, because its fresh host always ran `runner restore` first
and its controller databases were all new. Both are fixed, and neither
fix is regtest evidence on its own: they are tested against stand-ins
(cases A16 to A18 in `PAYMENT-SPEC.md`).

1. A restore could be skipped or left half done. The recovery gate
   applied only once `restore` had recorded a restore. A fresh controller
   database beside an existing journal ran normally, so the reviewer
   froze a new b1 while the journal held an uncertain b1. And the replay
   inserted batches one by one: interrupted between inserts and reopened,
   the readiness check reported ready, cleared the marker and allowed
   issuance without the uncertain batch, and `restore` then refused,
   because the database held a batch. Now a controller database that
   lacks a batch its journal holds records that a restore is required
   when it is opened, before anything writes. Until a restore has
   replayed and reconciled, the controller refuses every write and send,
   and the runner every command but `status` and `restore` (A16). The
   replay is one transaction, recorded with it, and `restore` records its
   phases and resumes an interrupted restore without copying `subs` or
   replaying twice (A17). The tests kill a process in the middle of the
   replay, and stop `restore` during the replay and during
   reconciliation, then reopen the database each time.
2. An existing controller database wasn't migrated. One with the schema
   of commit `5226810` opened, then capturing a commitment's bytes, which
   issuance does right after its broadcast, failed for want of the
   `ancestors` column. Now the columns a database lacks are added when
   it is opened, with its rows kept (A18).

The restore path changed, so the rehearsal ran again:
`recovery-20261110T043551Z-402374`, verdict pass, exit 0, all 67 required
steps agreeing and 14 informational. It adds two required steps on the
fresh host before the restore: `runner prepare` refused with "restore
required", and `runner status` reporting the restore required with every
journaled batch missing and no batch in the database. Its `runner
restore` recorded that it resumed from "required", copied `subs` and
replayed. Everything else matched `recovery-20261109T194227Z-a5f2e7` step
for step. The complete recovery took 28.0 s and the store's replay 0.14 s,
on the same history: a store journal of 41 entries and 34,903 bytes, a
runner journal of 41 entries and 21,288 bytes, 7 orders, 1 refund group
and no alert. Both runs are kept. The interruptions themselves weren't
run on regtest.

The missing certificate download on b1's order page after the restore
stayed open after this review; the next section closes it.

## Certificate re-delivery after the restore (2026-11-10)

`runner certify` now accepts a certificate built on a later root of the
same space, as "Certificate verification" in `CONTROLLER-DESIGN.md`
already said it should (case A19 in `PAYMENT-SPEC.md`). The root must be
at a greater height than the batch's, shown by `spaced` as a commitment
of the space at the height the certificate states, at `d >= 150` and
covered by a root anchor, with the batch's own root still on the chain.
The certificate must still verify with libveritas for the order's handle
and recipient, as sovereign. A later root that is on the chain but not
yet final or covered is waiting, not a failure. Delivery's root check
(L9) and this one are now the same code. `tests/test_certificates.py`
covers the same-root and later-root paths, the waiting, and the refusals
against stand-ins; it isn't regtest evidence.

Run `recovery-20261110T050046Z-f7c0fa`, scenario 11 extended: verdict
pass, exit 0, all 70 required steps agreeing and 13 informational.
Against `recovery-20261110T043551Z-402374`, the earlier step showing b1's
order page with no certificate after the restore is now required (404,
as expected: certificates aren't journaled), and two required steps are
new. After b4 was final and covered, `runner certify b1` verified the
certificate of b1's order, which `subs` built on b4's root, and delivered
it to the store. The order page, still `fulfilled`, offered it again, and
the buyer's download verified with libveritas against root anchors read
from `spaced`: the handle, the buyer's own script, sovereign, under b4's
root rather than b1's. That download is kept in the run's evidence, under
`buyer-after-restore/`. Every other step matched the earlier run.

This run's complete recovery took 36.4 s and the store's replay 0.15 s,
on the same history (the store's journal had 42 entries, 35,885 bytes;
it has had 41 or 42 across these runs). Every step of the
recovery was slower than in the earlier runs in about the same
proportion, the host node's sync from the network node (16.1 s against
13.7 s) and `spaced`'s (6.2 s against 4.4 s) included, which this change
doesn't touch; the machine's five-minute load average was about 7 just
after the run. The times are recorded as measured and aren't a
measurement of the change.

## Sales pause after a restore (2026-11-10)

The store's sales pause and exposure limit (cases S1 to S6 in
`PAYMENT-SPEC.md`) are service API tests over a simulated chain, not
regtest evidence. One of their rules changes what a restore does: `python3
-m service restore` now always brings the store back with sales paused,
marked as paused by the restore, so a pause the journal never acknowledged
can't silently reopen sales. Scenario 11 buys names after its restore, so
it gained two required steps, checked against the real stack.

Run `recovery-20261110T063824Z-59ce82`, scenario 11: verdict pass, exit 0,
all 72 required steps agreeing and 13 informational. The two new steps,
both S5: the restored store reported sales paused by the restore, and the
owner's resume answered paused false, acknowledged by the journal. Every
other step matched `recovery-20261110T050046Z-f7c0fa`, including A19's
re-delivered certificate and the next batch on `@test10000` reaching
`fulfilled`. The complete recovery took 29.7 s and the store's replay
0.16 s.

## Bitcoin Core 31.2 (2026-11-11)

Bitcoin Core 26.0 reached end of life on 2025-04-14, and the store's own
node runs 31.2. Before the pin moved, every scenario set ran again on 31.2,
chosen with `SUBSPACE_BITCOIND_BIN`; each report records the binary and the
version it ran (`bitcoind_version`). The tarball matched the release
checksum, and eight builders' signatures on the checksum file verified.
The preset chain's wallets are SQLite descriptor wallets, so 31.2 loads them
despite version 30's removal of legacy wallets.

| Scenario set | Run | Required checks matched |
| --- | --- | ---: |
| Service purchase and refund | `core31-service-20261111T052258Z-e83822` | 43 of 43 |
| Checkout purchase and refund | `core31-checkout-20261111T052358Z-41305d` | 30 of 30 |
| Recovery rehearsal | `core31-recovery-20261111T052444Z-de932f` | 75 of 75 |
| First purchase, second commitment with a proof, restore, lost broadcast | `core31-all-20261111T052854Z-1dcace` | 98 of 98 |
| Private preflight with the loopback `subs`, and the private checkout | `core31-private-loopback-20261111T053258Z-636873` | 22 of 22 |
| Private refund | `core31-private-refund-20261111T053334Z-4f7174` | 2 of 2 |

None failed. The private refund matched the 26.0 run exactly: 111 vbytes, a
222-sat fee at 2 sat/vB and 778 sats to the buyer. After the 151-block
`invalidateblock` reorg, 31.2 behaved as 26.0 did (R10): the disconnected
commitment wasn't in the mempool, and `testmempoolaccept` still accepted
its bytes. The kept report of that run still says "Bitcoin Core 26.0" in
the note on that step: the note was fixed text then, and the run predates
the change that makes it name the version a run used. Its version field,
`bitcoind_version`, says 31.2, and the step's recorded observations are
31.2's. The kept report is left as it was recorded. `regtest/fetch.sh` now replaces a cached `bitcoind` whose version
isn't the pinned one, so the pin change alone moves a checkout to it.

## The tightened harness

Since fp4:
- Every run executes inside an unprivileged user and network namespace
  (`unshare -rn`, `in-netns.sh`) with loopback only. That confines `subs`'
  every-interface listener (R7) and keeps the stack off the network,
  without changing any host firewall, system or security setting. The
  harness refuses to start outside such a namespace.
- Each step is "required" or "informational". A required step that
  disagrees with the model gives the verdict "fail" and exit status 1. An
  error gives "error" and 2. A refusal to run gives 3. The informational
  steps are the R11 anchor-coverage observation and the R10 check for the
  commitment back in the node's mempool, which records a known
  disagreement until the model's L6 to L8 land.
- A member becomes ready only after a root anchor covers its commitment
  (R11). The harness mines to that anchor, then verifies.
- Run ids are unique (`run-id.sh`), and the harness never deletes a run
  directory or reuses one.
- Each certificate verification keeps its own directory under
  `.run/<run id>/certs/`, with the certificate message, the anchors and
  the libveritas output.

## Not exercised

Not exercised on regtest:
- a restore from a snapshot plus the journal since it (scenario 11
  restores the store and the controller from their journals alone, and
  `subs` from the snapshot);
- publication beyond one local relay: propagation between relays, the
  public relay network, chunks of more than one handle, an oversized chunk
  and its halving, temp certificates, a reorg between the live check
  and a `/publish` call, and a reorg of a later root that a published
  certificate was built on (scenario 6 uses one relay and one-handle
  chunks);
- buyer import, in Nacho or any other client, and the buyer gate's
  verifying client (delivery was confirmed by the harness's own lookup:
  the relay's answer verified with the pinned libveritas);
- records signed by a client other than the harness, records after a
  transfer or by a delegate, and a relay that withholds a newer record set
  (scenario 9 signs with libveritas's builder for an untransferred handle);
- a fulfilled order whose commitment then loses finality or is superseded
  (L4, L5);
- refunds other than cancellation refunds through the store service
  (excess refunds, fee bumps, replacement families, PSBT export), late
  payments, hold extensions and eligibility proofs;
- a lost answer between `subs` and the controller (only `spaced`'s answer to
  `subs` was dropped);
- X10, a supersession undone by a reorg deeper than settled depth, and L8,
  a lost commitment with no journaled bytes;
- continued operation after a lost answer on a later commitment, rather
  than a restore (scenario 5 covers the restore case, and only with the
  U1(b) patch);
- auctions, and a natural competing-chain reorg as opposed to
  `invalidateblock`.

The restore scenario (scenario 3) isn't the operator gate. Bitcoin Core
and `spaced` stayed up through its "host loss", and the operator wallet
wasn't restored from its backup. Scenario 11 is the rehearsal on a fresh
host, with the world on its own node and both wallets restored from their
onboarding backups. In both, the "off-host" journals and snapshots are a
directory of the run, not a separate store with its own credentials and
the provider's checksums.

## Evidence kept

The run directories under `.run/` are ignored by git. `keep-run.sh` copies
a run's report into `runs/` and its certificate verifications into
`evidence/<run id>/`, with the repository's absolute path made relative. It
never replaces or removes anything already kept: a run id that is already
kept is refused, the copies are checked in a temporary directory before
they're published, and a run id must be a plain name.
`tests/test_regtest_keep_run.py` covers this. The kept runs are the two
full runs, four continued runs and `publication-20261107T094250Z-76605c`.
Four of the publication run's verifications, in its `-relay` directories,
are the relay's `/query` answers from scenario 6: two from before
publication and two from the delivery lookups. The six combined runs, the
service runs and `records-20261108T161951Z-0c9721` are kept as well, and so
are the five passing checkout runs, whose runner verifications are under
`runner/`, and the five recovery runs of scenario 11, whose lost host's
runner verifications are under `lost-host-runner/`, and the last two runs'
buyer downloads under `buyer-after-restore/`: 284 messages in all.
Each message is kept with its root anchors and libveritas output.
`verify-evidence.sh` verifies them all offline, and `evidence/README.md`
says how. fp4's certificate isn't kept in the repository, because its
handle label was a personal name and is part of the signed message.


## TypeScript payment adapter, Core 31.2

Local regtest run `core-adapter-2026-11-11T14-56-15-058Z-41ab657c` passed through
`cd ts && npm run test:core`. It used a fresh data directory, generated
regtest-only wallets and a loopback-only network namespace. No existing
node or wallet was used. The retained `qualification.json` binds the source
files below and records the completed checks; CI runs this same test and
publishes only that credential-free qualification file.

The TypeScript store allocated a real bech32m address, detected the payment
in the mempool, counted it at one confirmation and converted at three.
Invalidating its paying block preserved the fulfillment reservation and
marked issuance reconciling. Re-mining the same transaction cleared that
reason without counting another payment. Spending the original receipt did
not remove it from historical receipts. A fee replacement on a second
invoice still counted the payment once.

A separate watch-only wallet imported the merchant's public descriptors.
It owned a paid change address with no address-book label entry. Core's
address-book receipt RPC omitted that address, while the adapter's full
`listsinceblock` read with change included found its receipt. This qualifies
the reader's independence from address-book entries; it is not full
application or signing-wallet recovery.

Normal node restart retained the pending transaction's original mempool
entry time, even with the test node's clock advanced by 600 seconds. Entry
height was reconstructed at the newer tip, not preserved. Restart with
mempool persistence and wallet rebroadcast both disabled removed the
payment from current observations; the store retained its detected-history
marker and eventually released its unpaid hold. No automatic recovery rule
based on mempool time or height was adopted.

Earlier attempts found a two-second mining timeout
(`Bitcoin RPC generatetoaddress failed (transport)`) and an incorrect test
assumption that disabling mempool persistence alone would leave the mempool
empty (`1000 !== 0`). The test now allows mining time and explicitly
controls wallet rebroadcast for its absence case. Descriptor import also
showed that external receiving addresses can regain an empty label entry;
the missing-address-book regression therefore uses a genuinely unlabelled
change address. All run directories, including failed ones, remain under
`regtest/.run/` locally.

The first hosted-CI attempt failed before the test with
`unshare: write failed /proc/self/uid_map: Operation not permitted`.
Hosted CI therefore creates the network namespace with sudo, then drops
back to the original unprivileged UID/GID before running Node and Core.
The next attempt exposed an inherited root home directory in Core's
version probe (`Permission denied [/root/.bitcoin/bitcoin.conf]`). The
launcher now resets its environment when dropping privileges, and version
probes/test nodes explicitly use an empty configuration.

This run did not issue through subs/spaced, deliver a certificate, execute
the store's refund protocol, restore the complete host or use a buyer's
client. It does not pass either public-pilot acceptance gate.

Qualified SHA-256 source digests:

```text
17be795f1f023076d896a7b2acb3f639031b040f86a4c4eea0b81e530f5e7f50  ts/src/bitcoin/rpc.ts
14d00f28153abafe8940f72abdb8aebc7031bb27eebacba8bcc1f06b30318548  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
7ef9b9f5072629566d2172383ff561e47ec5af9733b8cf7d00c3761a1b4c970f  ts/src/application/store.ts
82a9f70dcd35f64892658e63006294e188ccc1b1a3e1866ad0e27f54e8986f0f  ts/src/application/sales.ts
d7b29b627e0601e2747009e0f42eb5fa30a9118a191df1ca95d870ab284ecde3  ts/src/application/records.ts
86627ddab761bdc9e178e7878e95e9bc3e49b157117c4eef7c0e1230ec0a3390  ts/regtest/core.test.ts
```

## TypeScript refund preparation, 2026-11-11

Run `core-adapter-2026-11-11T15-40-43-266Z-64edbff9` passed on the checksum-pinned
Core 31.2 binary through `npm run test:core`, in a loopback-only network
namespace with fresh merchant, buyer and miner wallets. The earlier Core
observation checks above still passed. The retained qualification JSON
binds the source digests below and twelve completed checks.

The application journaled an excess refund reservation before signing,
built the signed transaction with the buyer fee capped at the disclosed
200-sat test ceiling and the remainder paid from an explicit merchant fee
pool, and returned no raw transaction in its public view. Its transaction
was absent from the mempool until the isolated test operator read the
private test database and broadcast it. After six blocks the order was
cancelled, and preparation of its remaining 10,000-sat principal spent
proven order change from that excess refund. The test operator broadcast
and settled that transaction too. Rates, amounts and limits are fixtures,
not deployment choices.

The application has no refund sender, settled-group reconciliation, fee
bump/rebuild or deadline lifecycle yet. Both built groups remain reserved
in its conservative accounting. These manual regtest sends do not qualify
uncertain-send recovery, the complete refund protocol, host recovery,
subs/spaced integration or either public-pilot acceptance gate.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
7ecc08b49053b284dd07b6d8552aae71d7288b4aa6daac89e4bfdc4029905b10  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
b6116157c59833747e65b6c7a987673c6e034c11519d436cf47d2583f1affa47  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
0ae035a869008f553f80bfa0ba8be927ddc12fef0ba5e9f09cdfe54d9f11ea7c  ts/src/refunds/types.ts
ec5384f2cf4cd0564fcb8f2ebf8c0be0c3ed81f45fbcb65a48b4135cb33323c8  ts/src/refunds/book.ts
6d8a67eb3b75ba6d2b4ce427c78e9a4081abc401a4c21635b1c3e9c7ff213109  ts/src/application/store.ts
82a9f70dcd35f64892658e63006294e188ccc1b1a3e1866ad0e27f54e8986f0f  ts/src/application/sales.ts
6a06658708e2360afcc537f01b9f4a2130519a3a8873a5c273971bde0c38b40d  ts/src/application/records.ts
d65b07206ce7fc3edf3ab986fa724bc2110b6c0b67a4804f4a2088af7e795eef  ts/regtest/core.test.ts
ec737eb6ab075c5e38e0572bb00f820d9e9bd0bb95512d70a47fbfc1206674fe  ts/test/production/application-fixture.ts
```

## TypeScript refund sending, 2026-11-11

Run `core-adapter-2026-11-11T16-15-18-469Z-de0ce9e5` passed on the checksum-pinned
Core 31.2 binary through `npm run test:core`, with fresh isolated regtest
wallets. It retains the earlier payment and signing checks while replacing
the earlier manual refund sends with the application sender. Its
qualification JSON binds sixteen source digests and fifteen checks.

The first send reached Core, then an injected lost reply left the
application intent uncertain. Closing and reopening the store reconciled
the same transaction in the mempool; explicit reconciliation sent nothing
else. Six confirmations moved its charge from reserved to refunded.
Invalidating and reconsidering the last block exercised 6–5–6 accounting.
Removing the refund block and building seven empty alternative blocks
reopened the same reservation; re-mining closed it again. A later
cancellation refund used proven order change and settled through the
application sender. Core preflight also requires the observation tip to remain unchanged
before the final journal gate. Exactly two application sends paid the two groups,
with 13,000 sats charged to the order once. The buyer fee ceiling and
other amounts remain test inputs, not deployment choices.

Separate production process tests kill a writer with SIGKILL after the
acknowledged send gate, then reopen its SQLite/journal and retry the same
signed bytes. That test caught and now verifies a reused journal backend
refreshing its append cursor after another owner advanced the journal.
No process-death claim is inferred from the Core restart alone.

This qualifies one attempt per group. Exclusive fee bumps/rebuilds,
full host recovery, deadline/incident lifecycle, durable operator alerts,
registry integration, buyer-client acceptance and the pilot gates remain.
The live sender is a programmatic operator building block; there is no
operator HTTP route, automatic service launcher or production deployment.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
b6116157c59833747e65b6c7a987673c6e034c11519d436cf47d2583f1affa47  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
5de1bf129f5bb0592c7c78229da0adf0e14c6162e3cc55a5d12552b74c12fba6  ts/src/refunds/types.ts
bd793bd8acc5d4deeb13ea83396b0606fb63372321af09bfbbe11ca23d76775b  ts/src/refunds/book.ts
cb67e6bf416c004d761f723d3f915fc3ad7ef82a703532a15f9e6baa7ea7fb17  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
d37a9028e871682ad426df364579cd037ae287d95c7674b8d468f737c375717e  ts/src/application/records.ts
6bf16bef51ce55a1a2e6790b3682fec83a49be9bea4acbcb63c339c03cf4f0ad  ts/regtest/core.test.ts
ec737eb6ab075c5e38e0572bb00f820d9e9bd0bb95512d70a47fbfc1206674fe  ts/test/production/application-fixture.ts
b39841e6cbf4bd0ac9c249415d8d6c84377792efe1c1836bd791250677dd9e13  ts/src/bitcoin/refund-sender.ts
8564b8a289505aa5b7a50ce8284ba4766c1db45fcdd10498b9683b32317d6fe3  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
```

## TypeScript exclusive refund families, 2026-11-11

Run `core-adapter-2026-11-11T16-55-17-598Z-ca99fe3a` passed on the checksum-pinned
Core 31.2 binary with fresh isolated regtest wallets. The qualification
JSON binds twenty runtime/test source digests and nineteen completed checks.
All prior payment, uncertainty, restart and settlement observations passed.

A pending excess refund was replaced by a higher-fee signed member that
retained its inputs and buyer output. Core accepted the replacement and
removed the old member from the mempool. Store restart preserved both
signed attempts and their one maximum reservation. After settlement and a
deep reorg, the test miner included the original member instead; the group
was refunded once, and a later cancellation used the winning member's
proven change. These are three application send calls for two obligations,
with only the canonical winners charged to the ledger.

A separate cancelled order had a one-input refund, using an explicit
1,000-sat/kvB regtest fee-rate input. The test operator spent that input
into an owned output, and the conflict reached six confirmations. The
application built an exclusive replacement from that output, preserved the
30,000-sat historical maximum and settled the chosen 28,000-sat charge.
A deep reorg then removed the conflict and its descendant; mining the old
refund instead settled the group at 30,000 once. The descendant could not
remain valid without its ancestor. Amounts/rates are test inputs, not
deployment choices.

An early run refused a valid required input because identity comparison
used JSON member order. Input identity now compares outpoint, script, sats
and owner explicitly. The final source-bound run above supersedes that
intermediate failure; its retained run directory was not removed.

Separate production RPC tests cover surviving shared-input anchors,
forged ancestor input metadata, missing funding, mixed ownership and loss
of settled conflict evidence. SQLite/journal tests cover maximum charges,
restarts, unacknowledged preparation, paused rebuild notices, and either
older or newer family winners. A separate independent ledger/graph model
checks fixed cases and 300 seeded history/replay steps; those are model
results, not Core or full-host recovery evidence.

The planner supports direct conflicting ancestors and proven order
funding; more complex or ambiguous recovery remains paused. Refund
deadlines, general alerts/losses, unconverted excess, merchant principal
advances, PSBT export, full host recovery, registry/installer/seller setup
and buyer acceptance remain. No deployed service, existing wallet,
credential or mainnet state changed. Paid sales remain closed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
cd36b03ef35fef3f93a0df1cf866e58ac121fc9b501c183803f6f73294022682  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
57aeb4073da934a327a17f53d9680519d40685feddb9010eda3493b9c90cb12d  ts/src/refunds/types.ts
3a5af8f22082157a172d21dcba7b3e8bf8bad15681c1147f370979dbe18fb7ad  ts/src/refunds/book.ts
9acc2297b63b3020a19707e94d54f2bf92fe4fb3c4cec9ff4c60e201385a2212  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
0964a83c3c3706d69b017df1476e25cff0f217775afbef562bebff673b62feea  ts/src/application/records.ts
5afe7ce06f24c35f5ee16f3ef48ddd189e267240e43ae7a3370bc3daae50fe35  ts/regtest/core.test.ts
ec737eb6ab075c5e38e0572bb00f820d9e9bd0bb95512d70a47fbfc1206674fe  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
```


## TypeScript cancellation clocks and deficits, 2026-11-11

Isolated Core 31.2 run `core-adapter-2026-11-11T17-29-11-074Z-fae76355` passed all 20
checks, bound to the 21 source digests below. This used fresh isolated
regtest wallets and retained local artifacts under `regtest/.run/`.
Only `qualification.json` is eligible for the CI artifact; wallets,
cookies, raw transactions and node logs remain local.

After an earlier excess refund and its replacement/reorg history,
cancellation starts a new 10,000-sat clock at time 20. The earlier
broadcast does not service it. The cancellation spends proven order
change, records its actual broadcast at time 21, settles once and leaves
no remaining clock principal or missed-target incident. This is real Core
evidence for that path, with a controlled application clock.

The default TypeScript suite separately exercises delayed/lost replies,
the exact 24-hour boundary, later payments, smaller winners, reorgs,
restart, Core/journal outages, corrupt journaled monitoring records and
recorded merchant losses. It passes 185 tests; the unchanged Python suite
passes 273. Development coverage reports 246 fixed-price cases with no
gaps and 40 deferred cases. The pilot production gate still refuses for
114 cases, including K11/K12 and fulfilled-order loss cases. Excess clocks
need read-only fee assessment; fulfilled-order cases need the registry lifecycle.
Operator polling, registry integration, application recovery, installation
and public-pilot acceptance remain.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
cd36b03ef35fef3f93a0df1cf866e58ac121fc9b501c183803f6f73294022682  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
57aeb4073da934a327a17f53d9680519d40685feddb9010eda3493b9c90cb12d  ts/src/refunds/types.ts
3a5af8f22082157a172d21dcba7b3e8bf8bad15681c1147f370979dbe18fb7ad  ts/src/refunds/book.ts
0e427dc61ffa5f2f042fe9a0cc7432731696bb2208fb0b18abc91a21eb21074e  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
56d48e21f6d8e752bdca66095cdfd33d5cdaf87c03e64d08220acb233f163749  ts/src/application/records.ts
1ca4bfc1d213dd3494e373632e4e1a09f40cab4c67c1147fb81b67cb68ed5407  ts/regtest/core.test.ts
ec737eb6ab075c5e38e0572bb00f820d9e9bd0bb95512d70a47fbfc1206674fe  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
be97a0efce8e11d3b3d8454be45e7a2faa6fd5bc546f8f85b8e578cb078dac32  ts/src/application/monitor.ts
```


## Unsigned Core refund template assessment, 2026-11-11

Core 31.2 run `core-adapter-2026-11-11T17-43-37-875Z-dddf1729` passes 23 checks
bound to the 22 source digests below. It uses fresh isolated regtest
wallets. The unsigned assessment explicitly disables signing and
finalization, binds previous-output metadata to the supplied claims,
and checks a coherent ready tip before returning size and a fee.

For a one-input/one-output Taproot key-path shape, Core's unsigned
estimate bounds an independently signed transaction's measured size
within one vbyte. Wallet information, UTXOs and input locks are unchanged
around assessment. The same wallet receipt remains measurable after its
spend confirms; this does not assert spendability or authorize a refund.
Only estimated size, fee at the supplied rate and tip are returned.

Runtime cases Z48/Z49 separately cover upward fee rounding, explicit
no-sign/no-finalize RPC flags, parent metadata, malformed templates,
changed outputs/UTXOs, signature material, missing/invalid sizes, failed
RPCs and tip changes. This is a measurement primitive. Coin/change
planning, excess minimum/deadline integration and K11/K12 production
coverage remain unfinished. The pilot gate still refuses for 114 cases;
no complete application recovery or public-pilot acceptance is claimed.
CI may upload only qualification JSON; wallet data, cookies and logs
remain local.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
e0b0af3363a1179c1250cc7b9ff9b2f46a7c9061773fc1aac16581a55698d2e2  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
8c0ee69eb806f0e56460f859d24a0e4c72ad331b21fd8189dd30dd85cccd5757  ts/src/refunds/types.ts
3a5af8f22082157a172d21dcba7b3e8bf8bad15681c1147f370979dbe18fb7ad  ts/src/refunds/book.ts
0e427dc61ffa5f2f042fe9a0cc7432731696bb2208fb0b18abc91a21eb21074e  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
56d48e21f6d8e752bdca66095cdfd33d5cdaf87c03e64d08220acb233f163749  ts/src/application/records.ts
30e7a3b142b31fac5e265ca315a8a8642b426f0d9f012cdd849dd943b9f76e12  ts/regtest/core.test.ts
ec737eb6ab075c5e38e0572bb00f820d9e9bd0bb95512d70a47fbfc1206674fe  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
be97a0efce8e11d3b3d8454be45e7a2faa6fd5bc546f8f85b8e578cb078dac32  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
```


## Converted excess deadlines, 2026-11-11

Core 31.2 run `core-adapter-2026-11-11T18-15-15-921Z-92965e22` passes 25 checks
bound to the 24 source digests below. This uses fresh isolated regtest
wallets and controlled application time. The earlier unsigned size,
refund send, family/reorg and cancellation qualification remains in the
run; the new store adapter now assesses excess eligibility too.

The only configured merchant fee funding is locked before admitting a
3,000-sat excess. Its estimated fee exceeds the disclosed buyer ceiling,
yet admission starts the excess clock before preparation. Wallet
information and the input locks remain unchanged by assessment. The
funding is then unlocked for preparation/send. The actual
broadcast services that excess once. A later cancellation starts a
separate 10,000-sat clock and completes it at the later broadcast time.

Default suites separately exercise the exact fee-plus-546 boundary,
later amounts, rising/missing estimates, explicit fallback policy, invalid
rates/tips, journal outages, restart, corrupt acknowledged assessments,
and a slow unrelated fee RPC crossing the deadline boundary. A captured
on-time observation stays on time and admission of newly refund-due money
keeps the original observation time. Those are model/simulated-RPC
application tests; they are not claims about real network RPC durations.

Local TypeScript tests pass 199 cases. Development coverage reports 254
fixed-price cases with no gaps and 40 deferred cases. The pilot production
gate still refuses for 114 cases, including complete K11/K12 coverage.
Unconverted outgoing-spend accounting, registry lifecycle and full
application recovery remain. Signing still independently enforces actual
funding, fees and the measured minimum; canonical eligibility authorizes
no spend. No public-pilot or whole-host acceptance is claimed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
3a5af8f22082157a172d21dcba7b3e8bf8bad15681c1147f370979dbe18fb7ad  ts/src/refunds/book.ts
6b3a98e6a66fae8e6c29b9bce56b40f5044ec10a114f6cc8b400fda8c86b8b9f  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
eac4aa3cf8aeff83b5c6ffb9d00e5361b51e4c692bfd936b5e48ea24acb36f4f  ts/src/application/records.ts
e0b0669aa6ad9cf63838a62f4fc7895eaedba9dc52312fcb875fc8109a344ab8  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
32052a787beb10de9d8c2b0f97aa9734d6cad43402e4312ee72a29a5644d5c7f  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
```


## Operator inspection and cancel-first partial refunds, 2026-11-11

Core 31.2 run `core-adapter-2026-11-11T19-01-52-893Z-08d4c4bd` passes
28 checks bound to the 26 source digests below. It uses fresh isolated
regtest wallets. The earlier payment, unsigned estimate, refund send and
family/reorg scenarios remain in the same run. Application time is
controlled; this is not a claim about production timing.

An authenticated operator listener observes a real converted payment over
HTTP and returns its acknowledged order status and batchable amount,
without a buyer token. It runs on a separate loopback port and closes
before the store lifetime ends. Default tests separately cover duplicate
authorization headers, rotation, provider failure, response redaction,
journal lag, unsupported writes and scoped port release.

K21 chooses cancel-first for the first release. A settled 6,000-sat
partial payment on a 10,000-sat invoice refuses excess preparation before
cancellation. After cancellation it is returned by a real transaction.
The store restarts, creates a new checkout for the same handle, and
retains the old address and refund history. A later 10,000-sat payment
to the old address stays refund-only; it contributes nothing to the new
checkout. Only a payment to the new address converts that checkout.
Continuing an invoice after a partial withdrawal is outside pilot scope.

Local checks pass 273 Python tests and 205 TypeScript tests. Development
coverage reports 259 fixed-price cases with no gaps and 40 deferred
cases. The pilot production gate still refuses for 114 cases. Registry
write callbacks, complete lifecycle views, full application recovery and
buyer/host acceptance remain; this listener is not a complete runner
interface and must not be configured as one. No deployment occurred.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
9731e27e1907c2c54d03fe9878bb4b5ca157a0bd3ea70fbe630ec8ce35ebf5eb  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
eac4aa3cf8aeff83b5c6ffb9d00e5361b51e4c692bfd936b5e48ea24acb36f4f  ts/src/application/records.ts
191be8361559658702eede3d20f01dc507516f17b6768ca0c1ea75e46bce6988  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
32052a787beb10de9d8c2b0f97aa9734d6cad43402e4312ee72a29a5644d5c7f  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
767476ffe8c7461970b19404f1fde150001d3396c6c7e2f5e649dff79ca18052  ts/src/application/http.ts
3c4644dd2baa65ffd5c801a9a6c53af4333a90c5dbaf3c7780b37e3ca9eba881  ts/src/application/operator-http.ts
```


## Atomic registry entry and frozen pending sets, 2026-11-11

Core 31.2 run `core-adapter-2026-11-11T19-26-54-940Z-4599181e` passes
31 checks bound to the 30 source digests below. It uses fresh isolated
regtest wallets and controlled application time. The earlier payment,
refund, family, excess deadline and cancel-first scenarios remain.

Two real converted orders are frozen through the authenticated operator
API. A separately authenticated subs listener serves exactly their public
handle/script pairs. The operator API marks both issuing and acknowledges
both; buyer cancellation then refuses. Invalidating the new payment's
block makes its issuing recheck fail while preserving the issuing lock.
Reconsidering the block restores its eligibility for issuance. No actual
Spaces commitment is broadcast by this scenario.

Default integration tests separately exercise multi-member atomic refusal,
cancellation races, journal loss before and after acknowledgment, restart,
frozen-set changes during an outage, malformed records and requests, and
role separation. V12/V13 cover converted recipient conflicts and an
issuing order's priority, with notices retained once across restart.

The shipped Python runner HTTP client talks to the TypeScript listener
and reads its SQLite acknowledged position. The actual controller send
guard is exercised with a recording subs stand-in: either unavailable
journal prevents even an attempted send; both confirmed permits one
stand-in call. This is HTTP/client/controller-gate integration evidence,
not real commitment-broadcast evidence. The runner now asks for live
current-order journal confirmation before reporting an acknowledged
status. The frozen Python store's payment rules do not change.

Local checks pass 273 Python tests and 214 TypeScript tests. Development
coverage reports 266 fixed-price cases with no gaps, 40 deferred cases,
and TypeScript model/store coverage of 36/120. The pilot production gate
still refuses for 112 cases. Lost HTTP answers during entry, controller
recovery transitions, commitment callbacks, finality/certificate delivery
and whole-application recovery remain unqualified. This is not a complete
runner interface, and no public-pilot or host acceptance is claimed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
67e320f37429030a3d33d2c319cafd656e6d96d8354234fe032ea5c7947a18f3  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
3d0ca929eaa1be2b68a2c822ea490b243c91461c0c460eb02dde5904f72c9d5a  ts/src/application/records.ts
7e3302b7be22c0f8a7598b1a4b4e56d13dad9fee798ec2fb2f55345ec00a46f9  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
a232f7d62cf57390b4b5b617c85d4427240a887e13cad987aca3dac3095b6f52  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
767476ffe8c7461970b19404f1fde150001d3396c6c7e2f5e649dff79ca18052  ts/src/application/http.ts
51e0cc3f0eb5e969f7a9d45d7fd0aba1541357bc371ea08742d9c7317f2910c3  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
227fc72491795cb4cd3b193860048635706f09f36d54b5d632c2f29e8d855310  ts/src/application/entry.ts
0ffb6e6409161684bf8bd1a1cd554fa036b4d1563077383f081d01accdb721ed  ts/src/application/registry.ts
```


## Bound entry identity and interrupted responses, 2026-11-12

Core 31.2 run `core-adapter-2026-11-12T04-33-10-912Z-78d548f8` passes
34 checks bound to the 32 source digests below. It uses fresh isolated
regtest wallets and controlled application time. Its entry root is a
public mock identity: this is payment/registry qualification, not evidence
that the store verifies a Spaces commitment root on chain.

Two real paid orders enter through the authenticated bound-entry API.
Repeating the same entry returns the same receipt; a different root for
that identity refuses. A real payment reorg blocks the issuing recheck
without releasing the locks; reconsidering the block restores it. Store
restart retains the exact ID/root/member association. Earlier payment,
refund, family, fee, pending-set and cancel-first scenarios remain.

The default suite separately runs the shipped Python controller/client
against a real TypeScript HTTP listener, SQLite and journals, with a
recording subs stand-in. Entry replies are dropped before forwarding and
after store commit. Process exits occur after entry, intent, attempted
flag and stand-in send. Exact entry retries create one upstream binding;
attempted outcomes remain uncertain and are never called again. An older
controller database adopts its newer journal identity, treating a newer
issuing intent conservatively as uncertain; conflicting identity refuses.
No actual Spaces commitment is broadcast by those tests.

The controller journals a stable entry ID before entry lookup/creation.
The TypeScript HTTP API rejects anonymous issuing marks. Runner protocol
selection is explicit, and malformed/mismatched replies never fall back.
The controller send guard also refuses a live journal outage despite a
previous acknowledgment, and rejects a second private send call. Issuance
methods were extracted from the large controller module while keeping
its existing public imports; the new controller field is nullable.
The frozen Python store's payment rules are unchanged.

An independent deterministic entry model tests identity, retry and atomic
ownership. It makes no HTTP/journal/chain claims. The coverage checker now
rejects duplicate spec definitions so a passing old case cannot silently
cover another rule. Final local checks pass 277 Python tests and 224
TypeScript tests, pinned installation, type checking and whitespace.
Development coverage reports 277 fixed-price cases with no gaps and 40
deferred cases; TypeScript model/store coverage is 38/128 and Python
controller coverage is 26. The pilot production gate still refuses for
112 cases. Safe entry release/rebuild, commitment/finality/certificate
callbacks and whole-application recovery remain. None of these results
opens sales or qualifies whole-host recovery.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
67e320f37429030a3d33d2c319cafd656e6d96d8354234fe032ea5c7947a18f3  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
85fad46f13f52260b8f4bf01676c34ff468b579c1e190bb894d6ee4294f8102c  ts/src/application/records.ts
7811ea62259d9db2937f722baf0ed5c12ae0e7038f8b2e8209a154ca1bfb1ddd  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
a232f7d62cf57390b4b5b617c85d4427240a887e13cad987aca3dac3095b6f52  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
767476ffe8c7461970b19404f1fde150001d3396c6c7e2f5e649dff79ca18052  ts/src/application/http.ts
d32fca31fa8afda1cf9a8155d9ccd99891290330b744a6e27759a7464c974709  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
227fc72491795cb4cd3b193860048635706f09f36d54b5d632c2f29e8d855310  ts/src/application/entry.ts
4b5a13349eb2b125e6b94d2d544f7df2ca8e06bc991d8bbd00306f97f7367617  ts/src/application/registry.ts
394c5367498567633739fe020ac320db3c9f3206502c22468696d38699062c48  ts/src/application/bound-entries.ts
c848237a3e79f623158b00beb1daac4983f98f4fe7d0e468bfd6f6609cc6087a  ts/src/application/bound-records.ts
```


## TypeScript known-unsent entry release, 2026-11-12

Core run `core-adapter-2026-11-12T05-28-19-850Z-c6cb119c` passes
39 checks bound to 33 source hashes. Real paid orders pass through closure,
return to converted, and enter a new bound entry. Retrying the retired entry
cannot recreate or release locks. The new entry grants broadcast permission
once, refuses closure after arming, and retains both markers and the consumed
grant across store restart. Roots and delegate are public mock identities;
this is not a Spaces commitment or proof. The earlier real payment/reorg,
refund-family, fee assessment and pending-set scenarios remain in this run.
Only fresh isolated regtest wallets were used.

Separate HTTP/controller tests run the shipped controller and client against
the TypeScript listener, SQLite and journals with a recording subs stand-in.
Closure and arming are exclusive. A stale controller database and journal
cannot release an armed entry or obtain another grant. Lost close replies,
lost rollback replies and actual process exits after rollback, parking and
atomic successor creation resume with one rollback and one successor.
Cancellation during an unconfirmed close survives recovery. A crash after
arming is uncertain even when no network call happened. The independent
entry model checks closure, foreign ownership, cancellation, one-use grants
and snapshot continuity without production imports.

The controller checks exact scripts and roots before local rollback, retains
monotonically growing failed membership, and verifies the successor digest.
Retirement and successor creation share one local transaction. All-failed
batches retire without a successor or repeated alert. Legacy rollback remains
covered. The Python store's frozen payment rules are unchanged. The
TypeScript receipt shape has changed; pre-release server and driver updates
must be coordinated and older replies fail closed.

The named additions are O20–O27 and A27–A32. Development coverage reports
291 fixed-price cases with no gaps, plus 40 deferred cases. TypeScript
model/store and Python controller coverage is 41/136/32. The pilot production
gate still refuses for 112 cases. Commitment/finality/certificate callbacks,
supersession of armed entries and whole-application recovery remain. These
component results do not open sales or qualify a complete sale, host recovery
or the installer. No existing wallet, managed credential, deployed service
or mainnet state changed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
67e320f37429030a3d33d2c319cafd656e6d96d8354234fe032ea5c7947a18f3  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
a3fa7976137b5a91e4c5b6cfde6bd92ade819394e3f1938eed3573d9d6527682  ts/src/application/records.ts
6ecbe6e66987ab2a402be91a5da898264cd15cf258a32790f08505291013bac4  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
a232f7d62cf57390b4b5b617c85d4427240a887e13cad987aca3dac3095b6f52  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
767476ffe8c7461970b19404f1fde150001d3396c6c7e2f5e649dff79ca18052  ts/src/application/http.ts
0800a9ae085f7e5e6877c30a0541fc0f53e9b6ce391662a13627e90225c623eb  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
227fc72491795cb4cd3b193860048635706f09f36d54b5d632c2f29e8d855310  ts/src/application/entry.ts
4b5a13349eb2b125e6b94d2d544f7df2ca8e06bc991d8bbd00306f97f7367617  ts/src/application/registry.ts
f1e0ba998513d08d745b215c1343b3805e464ce28b15139c5e8bbe52273c4e73  ts/src/application/bound-entries.ts
74f161f1914f0a3cf68d493a6572468bad5981026723595a78d711d115cc55ae  ts/src/application/bound-records.ts
8d77f6124e99851cb63fd59f0d18605fe01cd2df7ceee47464cdc46613d8b55a  ts/regtest/entry-lifecycle.ts
```


## TypeScript bound commitment observations, 2026-11-12

Core run `core-adapter-2026-11-12T05-49-30-475Z-cf931e11` passes
43 checks bound to 36 source hashes. A newly mined regtest coinbase supplies
an actual transaction and active-chain mining height. Mining and invalidating
an empty tip block exercise depth 150 to 149 and back to 150. Root and
anchor facts are explicit controller mocks; this is not a Spaces commitment,
root proof, certificate verification or complete sale.

The store derives finality only with depth at least 150 and the matching
root height. Anchor coverage is a separate 144-block condition. A report's
tip must match the store's coherent payment snapshot. The scenario verifies
idempotent retry, stale-tip refusal, stale-revision refusal after reorg and
a return to the same earlier tip, and revision/facts surviving store restart.
Orders keep issuing locks and their price reservations. The earlier real
payment/reorg, refund-family, fee assessment and entry lifecycle scenarios
remain in this run. Only fresh isolated regtest wallets were used.

Separate HTTP/controller tests use the shipped controller and client with
recording Core/spaced/subs RPCs and the actual TypeScript listener, SQLite
and journals. The controller reports fresh observations after mining,
finality, root loss and reorgs without another send. Dropped replies before
and after forwarding, and a process exit after the store commit, resume by
reading the revision and collecting fresh facts. Controller progress waits
for live store acknowledgment; controller-journal outage withholds a report.
The legacy watch path is extracted unchanged into a focused module. The
Python store's frozen payment rules are unchanged.

Named cases O28–O35 and A33–A35 accompany the component. The independent
TypeScript model checks revision ordering, finality, anchor coverage and
snapshot continuity without production imports. Development coverage reports
302 fixed-price cases with no gaps, plus 40 deferred cases; TypeScript
model/store and Python controller coverage is 43/144/35. The pilot production
gate still refuses for 112 cases. Certificate readiness/delivery callbacks,
supersession and whole-application recovery remain unported. TypeScript
certificate work refuses before fetching messages, and covered finality
reports `awaiting_certificate_verification`. No deployment, existing wallet,
managed credential or mainnet state changed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
f64968a714d684b3c119d7287589b224fa107fc8218364aa088a7ef54f10c0f1  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
67e320f37429030a3d33d2c319cafd656e6d96d8354234fe032ea5c7947a18f3  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
30bc2181fbae8a3193179a4b2f8a7bafa57d34a3c016313799a32e0d937006e4  ts/src/application/records.ts
7b86440f175178f88e35adb7ba9cbb7243c4d6ddcab5ad218d29b060e94458ce  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
a232f7d62cf57390b4b5b617c85d4427240a887e13cad987aca3dac3095b6f52  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
767476ffe8c7461970b19404f1fde150001d3396c6c7e2f5e649dff79ca18052  ts/src/application/http.ts
eb038772382083a86c7a7bee03c31de0b3626735f8cedcaaa21d64fe87fcb9c4  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
227fc72491795cb4cd3b193860048635706f09f36d54b5d632c2f29e8d855310  ts/src/application/entry.ts
9191714dcc2cec8a65f6f391b8026708991e58c08d011d49272446b38dcb93c0  ts/src/application/registry.ts
f1e0ba998513d08d745b215c1343b3805e464ce28b15139c5e8bbe52273c4e73  ts/src/application/bound-entries.ts
74f161f1914f0a3cf68d493a6572468bad5981026723595a78d711d115cc55ae  ts/src/application/bound-records.ts
8d77f6124e99851cb63fd59f0d18605fe01cd2df7ceee47464cdc46613d8b55a  ts/regtest/entry-lifecycle.ts
c7aca7cdd3b88784bea311b56643bf85d46d4bf4ee5e3d5e8f07d7d70043b84c  ts/src/application/commitments.ts
1650655adfafb57a05c1014e68a636d76ccae77a2aad4e44b0fef5c9cec2f00e  ts/src/application/commitment-records.ts
4f202525da1cb5acd90b60531d898db51928be25deba8e36eb697e73d1517e22  ts/regtest/commitments.ts
```


## TypeScript bound certificate readiness and download, 2026-11-12

Core run `core-adapter-2026-11-12T06-39-20-824Z-a6b40686` passes
48 checks bound to 42 source hashes. Certificate bytes and Spaces root/
anchor facts are explicit mocks. Core supplies real checkpoint ancestry:
a descendant tip preserves availability, invalidating the verification tip
withdraws the certificate and returns ready to issuing, and returning the
old chain does not revive it. A newer observation and fresh callback restore
availability. Restart retains the verified digest and cache, and price
reservation remains allocated. This is not real Spaces certificate
verification, buyer acceptance or a complete sale.

Separate HTTP/controller tests run the shipped verification loop, client
and runner against the TypeScript listener, SQLite and journals. Core,
spaced, subs and the verifier executable are recording stand-ins. Own-root
and later-root callbacks recover after replies lost before/after forwarding
and process death after acceptance. Changed chain evidence, wrong recipient,
dependent status, nonzero verifier exit and nonboolean verification refuse
readiness. The runner does not repeat an anonymous delivery after a bound
callback. Controller journal confirmation precedes the callback; live store
confirmation gates the receipt and buyer download.

Certificate metadata, digest and invalidation are journaled. Bytes are
private reconstructible cache, atomically written and verified on read.
Missing/corrupt bytes are withheld and exact verified redelivery repairs
them. Only certificate upload has the larger base64 transport allowance;
messages remain bounded to 1 MiB and other bodies to 65,536 bytes. Buyer
responses are exact binary attachments with no-store/no-referrer/nosniff.
A ready order keeps its name, recipient and price reserve, cannot cancel,
and retains post-issuance deficit and excess-refund accounting.

The independent certificate model imports no production code. Named
additions O36–O45 and A36–A39 accompany the specification. All existing
certificate tests are retained. Development coverage reports 316 fixed-price
cases without gaps and 40 deferred cases; TypeScript model/store and Python
controller counts are 46/154/39. Final local checks pass 291 Python tests,
261 TypeScript tests, pinned dependency installation, type checking and
whitespace. The pilot production gate still refuses for 112 cases.

A development Core launch failed before node startup with
`ERR_MODULE_NOT_FOUND` because dependency installation ran concurrently.
Qualification was rerun after installation. The first full TypeScript run
also found `EISDIR: illegal operation on a directory, read`: a checkout
privacy test assumed that every data-directory entry was a file. It now
checks every file recursively, including the certificate cache; final full
suites pass. A test-file name collision was corrected before publication,
restoring the original A19 tests unchanged and adding bound tests separately.

The earlier payment/reorg, refund-family, fee, entry and commitment scenarios
remain. Only fresh isolated regtest wallets were used. The frozen Python
store's payment rules are unchanged. Verified relay fulfillment, sticky
fulfilled recovery incidents, supersession, a complete TypeScript sale
through the real Spaces stack and whole-application recovery remain. No
existing wallet, managed credential, deployment or mainnet state changed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
9aec8bd7f33982b2df7de63fa463e0a83ee27ce459a15ef062e9af9828868119  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
e076813cfe0a9e09d0100e709c14e0c4b1e6f5bb74a5bb11744d1ef817c2816e  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
38e5738a63aa4e2c8151e850231bf9b69bbddbce69a99ce02d0a3fd52ca8229b  ts/src/application/records.ts
f010da60edf07a79c9d5a26b219e5bbc25bd29b9c06c253cce3db7a6ed7d8350  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
c0eb3c38fb6a8fdab80a8e52a282e289706ed5f1164c64cb44f24972cb35cc13  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
c5f04aaba4706dc0b1dd1e710dc9e7648c10f978b1c2e2f955ff68adc5c1bd9d  ts/src/application/http.ts
54af8c89b93910c734cdc1fcd7f42585198ede2042b1185c5695403e965ee09f  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
57bc3a4b9283abc046dec320eee171a1f558d7de5b134cd28c8ffda8b2d86661  ts/src/application/entry.ts
45ebc4dddf81d3dd4066c9b9a72d6b590cf3e520fb93d89a82bc17631db2e745  ts/src/application/registry.ts
f1e0ba998513d08d745b215c1343b3805e464ce28b15139c5e8bbe52273c4e73  ts/src/application/bound-entries.ts
8ad1cc8fd2671416e1dd6dd7a621a0169436c03abf4239ab556ec764675cdc1e  ts/src/application/bound-records.ts
8d77f6124e99851cb63fd59f0d18605fe01cd2df7ceee47464cdc46613d8b55a  ts/regtest/entry-lifecycle.ts
e6d7c49bb416aa17b89a293fbd6f2f410dbedad74c2adbf8e6dd3e08f6ee1931  ts/src/application/commitments.ts
1650655adfafb57a05c1014e68a636d76ccae77a2aad4e44b0fef5c9cec2f00e  ts/src/application/commitment-records.ts
4f202525da1cb5acd90b60531d898db51928be25deba8e36eb697e73d1517e22  ts/regtest/commitments.ts
cc420b4301f03a4a570d1f375359e58b56a32dc10909943456044bab0daf0a52  ts/src/application/certificate-cache.ts
e20289bf357408e8701dc542a2633ceea2011ec910650c1565e4f79e2caaa7f3  ts/src/application/certificate-records.ts
a8051965295a2a8f6b3ae814e6c1f71416f5bfc9c976ae74c7d55aff54d08e05  ts/src/application/certificates.ts
d5ff3084d0a67647524d023123c7fcb478a06eb687c83a12542d0e3cfd028bd3  ts/src/application/certificate-http.ts
a7dea4d9dec77177d2f7ef85faf40a3023a769a8bcf40389a129056ff57c4b42  ts/regtest/certificates.ts
e3de042392aa21c877903f2d0bc00d181bc83e904f6dad9cf33b83505568ba2e  ts/regtest/qualification.ts
```


## TypeScript verified-delivery fulfillment and incidents, 2026-11-12

Core run `core-adapter-2026-11-12T07-08-36-283Z-123dad72` passes
53 checks bound to 46 source hashes. Real Core ancestry/reorgs exercise
sticky fulfilled state: checkpoint loss withholds the certificate but
preserves the sale, name and price reservation and opens a recovery incident.
Restoring and re-verifying the certificate does not resolve that incident
or overwrite first delivery. Operator resolution changes no refund or
reservation. Restart retains the receipt and resolved history. Spaces root,
certificate and relay-proof metadata are mocks; this is not real verified
relay delivery or a complete Spaces-stack sale.

Separate HTTP tests run the shipped publisher, controller, client and
runner with the actual TypeScript listener, SQLite and journals. External
subs/relay/spaced RPCs and the verifier are recording stand-ins. Final
per-handle publication and verified sovereign lookup precede the bound
callback. The controller confirms publication and delivery intent in its
journal; local delivered status follows the store's acknowledgment. Lost
fulfillment replies before/after forwarding and process exits after store
receipt or local completion recover with one original commitment send and
one already-recorded publication call. Temporary publication, immature
relay roots, wrong recipients, dependent zones, failed/nonboolean verifier
results and changed chain facts never fulfill.

The store binds delivery to the exact armed entry, order, current
certificate, observation revision and coherent tip. First delivery is
immutable and retries are idempotent. Fulfilled ownership and price reserve
survive invalidation, payment deficit and incident resolution. A certificate
loss creates one alert per new reason; reads do not repeat it. Unconfirmed
fulfillment/resolution withholds final buyer status. Buyer incident views
omit internal identifiers; operator views retain the full history. Invalid
fulfillment/incident relationships refuse startup and preserve evidence.

Named additions O46–O54 and A40–A43 land with their specification and
passing tests. The independent model imports no production code. Final
local checks pass 295 Python tests, 273 TypeScript tests, pinned dependency
installation, type checking and whitespace. Development coverage reports
329 fixed-price cases without gaps and 40 deferred cases; TypeScript
model/store and Python controller coverage is 49/163/43. The pilot
production gate still refuses for 112 cases. An early focused Python
invocation from the TypeScript directory failed with
`ModuleNotFoundError: No module named 'tests'`; the root-directory rerun
and final full suite pass.

The earlier payment, refund, entry, commitment and certificate scenarios
remain. Only fresh isolated regtest wallets were used. The Python store's
frozen payment rules and legacy publication protocol are unchanged. A full
TypeScript sale through the real Spaces stack, relay and libveritas,
supersession, complete lifecycle views and whole-application recovery remain.
No existing wallet, managed credential, deployed service or mainnet state
changed. No sales or deployment authorization is claimed.

Qualified SHA-256 source digests:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
9aec8bd7f33982b2df7de63fa463e0a83ee27ce459a15ef062e9af9828868119  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
3a4908e0cac9b6a9f87f683510ae79eb3a6ee25de969ec4fd40f13df45a89335  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
bcc7565f645caf5b95a1d9190f69e50fda39cde460e6a5f300832220040c1af9  ts/src/application/records.ts
6ad9ea0ba70036a5b836ea288ff741e63bffc36292137ca924f58c8d805b3b56  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
5aba74aeadcc8c692e840ebd98a293eedb39476427d750e1b85895e3e70869d8  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
c5f04aaba4706dc0b1dd1e710dc9e7648c10f978b1c2e2f955ff68adc5c1bd9d  ts/src/application/http.ts
7c9ae4a43a9d60467db19dff6d4c2bfe5360245876e8021cc88c6c26dd3fac65  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
57bc3a4b9283abc046dec320eee171a1f558d7de5b134cd28c8ffda8b2d86661  ts/src/application/entry.ts
74833a7470ef060d76bd223b5feee0b17ee5b256940317adbd7bb50a1e66f89e  ts/src/application/registry.ts
f1e0ba998513d08d745b215c1343b3805e464ce28b15139c5e8bbe52273c4e73  ts/src/application/bound-entries.ts
8ad1cc8fd2671416e1dd6dd7a621a0169436c03abf4239ab556ec764675cdc1e  ts/src/application/bound-records.ts
8d77f6124e99851cb63fd59f0d18605fe01cd2df7ceee47464cdc46613d8b55a  ts/regtest/entry-lifecycle.ts
e6d7c49bb416aa17b89a293fbd6f2f410dbedad74c2adbf8e6dd3e08f6ee1931  ts/src/application/commitments.ts
1650655adfafb57a05c1014e68a636d76ccae77a2aad4e44b0fef5c9cec2f00e  ts/src/application/commitment-records.ts
4f202525da1cb5acd90b60531d898db51928be25deba8e36eb697e73d1517e22  ts/regtest/commitments.ts
cc420b4301f03a4a570d1f375359e58b56a32dc10909943456044bab0daf0a52  ts/src/application/certificate-cache.ts
039e4f53df0e143606d1bdab5cead3563033a1908ebb6aa58789899ae72f6de8  ts/src/application/certificate-records.ts
336eeb766bf6729f50865a585614757ee76f400172403982b649a868b9e87658  ts/src/application/certificates.ts
d5ff3084d0a67647524d023123c7fcb478a06eb687c83a12542d0e3cfd028bd3  ts/src/application/certificate-http.ts
a7dea4d9dec77177d2f7ef85faf40a3023a769a8bcf40389a129056ff57c4b42  ts/regtest/certificates.ts
56189ab7115b0e48c0003637e7595aa9ef6ff4e3a20a2db9baad9cfd8c6a577e  ts/regtest/qualification.ts
51b0ffa3edaffe866bd1911c82280c350f38925763e672e914ebc03da1e3a6b1  ts/src/application/deliveries.ts
948c3a7378c3b8a6edde65bbe76288292a71d471fc0b4ea7b79d0a065677d1fe  ts/src/application/delivery-records.ts
05edcbcd2d2deb6a59c767af4731469c4b57699d495f8eadea73c18c060c38f8  ts/src/application/delivery-http.ts
79f02d192562ce3370a85d4e65c0544d1d7849b6b3f72e1f5929051605e52afc  ts/regtest/fulfillment.ts
```


## Standalone TypeScript runtime and real Spaces-stack sale, 2026-11-12

The Effect-scoped entry point now composes the existing store and Core
adapters, three loopback roles and one sequential payment observer. New
stores start paused. Explicit injected credential files are reread per
request; roles require distinct values. Startup reconciles before exposing
listeners. Signals and failed partial acquisition release listeners,
polling and store ownership. Polling observes and advances known deadlines
through node outages; it never signs or broadcasts a refund. Live Core
network status lets the shipped runner perform its existing chain checks.
Authenticated listing-price and global-pause routes acknowledge durable
journal writes. This is a regtest command, not an installer or production
update path. Infisical retrieval and Alchemy remain installer work.

Production cases O55–O60 cover strict configuration, role isolation and
credential rotation, polling/outage recovery, live chain status, journaled
operator settings, actual child-process ownership and startup/shutdown
cleanup. The default suite passes 279 TypeScript tests; type checking and
pinned installation pass. Python's 295 tests pass in 108.669 seconds. The
development gate reports 335 fixed-price cases without gaps, 40 deferred
cases, 49 TypeScript model and 169 TypeScript store cases. The pilot
production gate still refuses for 112 cases. The first focused polling
test used a recording RPC receipt address that differed from its allocated
address; correcting that fixture made the test pass.

Core run `core-adapter-2026-11-12T07-32-47-965Z-5df73ff7` passes 57 checks
bound to 52 source hashes. The standalone process receives a real payment,
converts it through background observation and preserves it through restart,
with a live network/block report and explicit journaled admission. Previous
Core payment/refund, checkpoint and recovery checks still pass. Spaces and
relay metadata in that narrower Core qualification remain mocks.

The separate full-stack harness first failed twice: run
`typescript-sale-20261112T072857Z-8869b5` used the wrong entry-point path,
and `typescript-sale-20261112T073144Z-a62aef` referenced the HTTP client's
wrong property. Both retained reports record errors. After correction,
`typescript-sale-20261112T073236Z-054378` passes all 13 required checks
against 74 source hashes. The buyer JSON request, quote, real payment,
three-block conversion, real subs proof and coordinated snapshot, confirmed
commitment, certificate verification with libveritas, independent download
verification and verified local-relay delivery all succeed. Store crashes
after payment, issuance, readiness and fulfillment preserve the purchase
and immutable first receipt. The bootstrap registry only sets up throwaway
chain fixtures; no purchase touches it. The sale itself uses the shipped
TypeScript process and attended Python runner, real spaced/subs/libveritas
and a real isolated relay, with no verifier/RPC stand-ins.

After improving harness failure cleanup and readiness diagnostics, final run
`typescript-sale-20261112T073618Z-255271` repeats all 13 required checks
successfully. Its 74 source hashes match the final runtime, controller,
runner and harness files. Both successful reports and their independent
certificate evidence are retained, along with the two failed attempts.

No browser checkout or buyer-client import is established. The TypeScript
refund-stack, supersession, whole-application/host restore, installer, safe
updates and seller CLI remain separate work. Only fresh isolated fixture
wallets were used. No existing wallet, managed credential, deployed service
or mainnet state changed. Paid sales remain closed.

The Core qualification's source hashes are:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
9aec8bd7f33982b2df7de63fa463e0a83ee27ce459a15ef062e9af9828868119  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
150a881f7892824b11342610accec83ac303780e3e869d1565c1c4625552a78c  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
bcc7565f645caf5b95a1d9190f69e50fda39cde460e6a5f300832220040c1af9  ts/src/application/records.ts
24fa858863ac6d2c079f6e764aa08ab4cd1685efa46e11981d773ed1a715f082  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
5aba74aeadcc8c692e840ebd98a293eedb39476427d750e1b85895e3e70869d8  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
c5f04aaba4706dc0b1dd1e710dc9e7648c10f978b1c2e2f955ff68adc5c1bd9d  ts/src/application/http.ts
45bd751c483ad4ad7eccaa5ecafcc4f24a67b63cd31876363d66ff57d389ddc7  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
57bc3a4b9283abc046dec320eee171a1f558d7de5b134cd28c8ffda8b2d86661  ts/src/application/entry.ts
74833a7470ef060d76bd223b5feee0b17ee5b256940317adbd7bb50a1e66f89e  ts/src/application/registry.ts
f1e0ba998513d08d745b215c1343b3805e464ce28b15139c5e8bbe52273c4e73  ts/src/application/bound-entries.ts
8ad1cc8fd2671416e1dd6dd7a621a0169436c03abf4239ab556ec764675cdc1e  ts/src/application/bound-records.ts
8d77f6124e99851cb63fd59f0d18605fe01cd2df7ceee47464cdc46613d8b55a  ts/regtest/entry-lifecycle.ts
e6d7c49bb416aa17b89a293fbd6f2f410dbedad74c2adbf8e6dd3e08f6ee1931  ts/src/application/commitments.ts
1650655adfafb57a05c1014e68a636d76ccae77a2aad4e44b0fef5c9cec2f00e  ts/src/application/commitment-records.ts
4f202525da1cb5acd90b60531d898db51928be25deba8e36eb697e73d1517e22  ts/regtest/commitments.ts
cc420b4301f03a4a570d1f375359e58b56a32dc10909943456044bab0daf0a52  ts/src/application/certificate-cache.ts
039e4f53df0e143606d1bdab5cead3563033a1908ebb6aa58789899ae72f6de8  ts/src/application/certificate-records.ts
336eeb766bf6729f50865a585614757ee76f400172403982b649a868b9e87658  ts/src/application/certificates.ts
d5ff3084d0a67647524d023123c7fcb478a06eb687c83a12542d0e3cfd028bd3  ts/src/application/certificate-http.ts
a7dea4d9dec77177d2f7ef85faf40a3023a769a8bcf40389a129056ff57c4b42  ts/regtest/certificates.ts
457e28d922e32e6d7956512039ef8c522c4681c13ab3f5aa3bcd08ba070e9c87  ts/regtest/qualification.ts
51b0ffa3edaffe866bd1911c82280c350f38925763e672e914ebc03da1e3a6b1  ts/src/application/deliveries.ts
948c3a7378c3b8a6edde65bbe76288292a71d471fc0b4ea7b79d0a065677d1fe  ts/src/application/delivery-records.ts
05edcbcd2d2deb6a59c767af4731469c4b57699d495f8eadea73c18c060c38f8  ts/src/application/delivery-http.ts
79f02d192562ce3370a85d4e65c0544d1d7849b6b3f72e1f5929051605e52afc  ts/regtest/fulfillment.ts
25afecbca606ec82080e0e21c3dc686697bc5228f12ae4baf3e6fdf5d9628e64  ts/src/main.ts
d6a0de204d208983cc436212cdc30cc6876708a0d92de5c4f00de4719bd525d8  ts/src/runtime/config.ts
0f14ac2cc563975f485e4ac1f618d591289f6a79d500bf9ade74daa95f62996e  ts/src/runtime/credentials.ts
002f19805f0966f5befe177e919261f01e6cdcf7d169d45d2d017acffe1a9aba  ts/src/runtime/server.ts
f6a5885bb410726878c8eae19fa6858e1090b6e1c40d3a4870387d9cffbf767a  ts/src/application/catalog-http.ts
102cf9e74e7be4c5060d23cea8c758f15e1c8a9b41bc4c71ccdef30e248d5b35  ts/regtest/runtime.ts
```


## Attended TypeScript refund API and runner, 2026-11-12

The operator API now connects existing reservation, signing and sending
components to the shipped attended runner. Preparation requires exact kind
and cause; a pending group of the same kind/cause resumes after interrupted
HTTP or signing. Extra credit never creates a second outstanding group on
a retry. Receipt inspection refreshes facts without signing or sending.
Broadcast requires the exact group confirmation and reviewed transaction;
a stale preferred member refuses before intent or send. No transaction is
silently replaced by a newer fee bump. Existing live journal, settled-credit
and exclusivity guards remain in force. The selected member's charge is
reported separately from the family's historical maximum. No raw signed
bytes or funding proofs leave these routes. Runtime polling never sends.

The TypeScript runner requires `--cause buyer` or `--cause merchant`,
provides `refund-status`, and requires both `--txid` and `--confirm` for
broadcast. Its explicit client validates bounded receipts and refuses
changed or unacknowledged transactions without a legacy fallback. The
Python store's baseline commands and payment rules are unchanged. Buyer
cancellation uses its opaque checkout link; operator-ID cancellation and
fee-bump/rebuild CLI commands remain separate work.

Local checks pass 298 Python tests in 108.175 seconds and 285 TypeScript
tests, pinned installation, type checking and whitespace. Cases O61–O66
and A44–A46 cover real HTTP/SQLite/journals and shipped runner/client
behavior with recording wallet adapters. They exercise dropped preparation
and broadcast replies, restart, journal outage, strict roles/bodies, stale
confirmation, fee/charge conservation and an older winning family member.
These default-suite results are not real Bitcoin transactions. Development
coverage reports 344 fixed-price cases without gaps, with 40 deferred;
TypeScript model/store and Python controller counts are 49/175/46. The
pilot production gate still refuses for 112 cases.

Core run `core-adapter-2026-11-12T09-22-32-904Z-4361d3ff` passes 66 checks
bound to 54 source hashes. Its actual standalone process uses a fresh
separate payment wallet and explicit funded merchant fee destination. It
refuses preparation before six confirmations, recovers the same prepared
group, restarts without sending unattempted bytes, sends the confirmed
transaction, observes a repeated send request and settles the refund into
the real buyer wallet. A 1,000-sat refund charges the buyer at most the
200-sat ceiling, with the remaining network fee merchant-funded. Later
payment to the cancelled address gets a new group after the first settles.
A merchant-caused return pays the full additional 1,000 sats to the buyer.
Prior Core payment/refund/reorg cases still pass. Spaces and relay facts
in this narrower Core qualification remain mocked.

Full-stack run `typescript-sale-20261112T090721Z-7c2e92` passes 24 required
checks against 78 source hashes before the report-label correction. It repeats the real Spaces sale
and then buyer cancellation, insufficient-settlement refusal, explicit
cause selection, replay-safe preparation, `refund-status`, missing-confirmation
refusal, the exact confirmed send, restart/retry and settled receipt. The
buyer receives 9,778 sats from the 10,000-sat cancellation; actual network
fee is 222 sats, below its 300-sat ceiling. Neither a missing confirmation
nor restarting with built unattempted bytes sends anything. A repeated
confirmed send after restart retains one intent. Settlement clears the
10,000-sat reservation, and the buyer wallet confirms the receipt. Earlier
run `typescript-sale-20261112T090359Z-6a7ef2` passed 23 checks before adding
explicit refund-status inspection; both reports and certificate/relay
evidence are retained. All four newly retained messages independently
reverify offline with libveritas.

The final evidence-label run `typescript-sale-20261112T091658Z-91951d`
passes all 24 checks against 79 current source hashes, including the report
renderer. Its metadata says fixed_spec, its JSON uses expected rather than
model, and Markdown says fixed spec expects with no independent model
executed. Earlier reports used the generic legacy model column for these
fixed expectations; they are retained unchanged and must not be read as
model-comparison evidence. The actual sale/refund checks and outcomes are
unchanged. The new run's two certificate/relay messages reverify offline,
for six newly retained messages across these three successful runs.

Actions run 43190401602 exposed a receiving-wallet notification race in
an existing replacement assertion: 0 !== 1000. The sender's bumpfee reply
can precede discovery in the merchant wallet. The qualification now waits
for that wallet to discover the actual replacement transaction before
asserting its complete receipt view. No runtime accounting rule changed.
The corrected local Core run above and repeated Python/TypeScript suites
pass. The report-label correction and this test barrier land as separate
follow-up commits; earlier failures and reports remain recorded.

Only fresh isolated fixture wallets were used. No existing wallet, managed
credential, deployed service or mainnet state changed. This does not pass
browser/buyer-client, supersession or whole-host restore gates. Remaining
refund recovery and maintenance, installer/Alchemy, safe updates and seller
CLI remain separate work. Paid sales stay closed.

The Core qualification's source hashes are:

```text
b9ad3f81e2e8f138593750e5f921738eb8899448f3d438338676942037a1ee0d  ts/src/bitcoin/rpc.ts
9aec8bd7f33982b2df7de63fa463e0a83ee27ce459a15ef062e9af9828868119  ts/src/bitcoin/core.ts
542694e560832fac7719621a8d690f9de1609ad82e635d586a84fb12fd623ae0  ts/src/bitcoin/validation.ts
9fb2512bba7c820ebcab8c11ab7745fe63979bde2cbeed1c8f07e381574e0646  ts/src/bitcoin/refunds.ts
06ae15356688f8eef52dc6a32153a3f2632080b75486346231aad2e7e90319bf  ts/src/refunds/policy.ts
1e7cc14102da6bec499cf2da8a45e1a49abd42cc360236066da89bb5261130cd  ts/src/refunds/records.ts
ebeef8313e0b5cdabd431902543f9f4c0ac66dd849262eb0b2a61aca5774478a  ts/src/refunds/types.ts
9023af566c4978d910bd776cb3a9038dc2002f4eeb17a82a751c6f8ff8556d2a  ts/src/refunds/book.ts
c4b8b82cb5bffb2a3732e29035b4044ad817f36a2c1c139b04617baccc23fee7  ts/src/application/store.ts
10ef86822e4f7fec491e7435b49f244878feb34057b334528bdd69507999a2c5  ts/src/application/sales.ts
bcc7565f645caf5b95a1d9190f69e50fda39cde460e6a5f300832220040c1af9  ts/src/application/records.ts
667d0fb234aeb28edd49a0cecea35d6ca4db5df4beabe189c670077b61cb7ade  ts/regtest/core.test.ts
7d10c5be62c77a6915c9b5212364c93203cbc90eb01e69b02ecb2939c5a8a5c1  ts/test/production/application-fixture.ts
c43c024487aea742813e8f74b48672ad1a5a8b1c00ce878675214f42e939db60  ts/src/bitcoin/refund-sender.ts
995ba9cb1b389db1ec5f182b63f5bc4e65c0f85bdbaeca3eebb512c0f20d7394  ts/src/refunds/observations.ts
5293a7b6b0164d67097dbf68698e943469df8bbfa8cdfdd07ecbf5e08e787056  ts/src/storage/journal.ts
93e8179d988cad4285257fbda538e3e5ca367735a86f0a78e0c353fe80a62d0c  ts/src/refunds/families.ts
d28319774819485136f16b9479f49adf2eee116b2281b3ab1e32d1df85398f44  ts/src/refunds/attempts.ts
e92827192a6f71286999b9a3338001458c8be22e4946413afc39d46ba589ca89  ts/src/bitcoin/exclusivity.ts
3d25a61e14ce2346c1fcdb7d08ae81e387f4ba13381db707f527debf6e556715  ts/src/bitcoin/rebuild-funding.ts
5aba74aeadcc8c692e840ebd98a293eedb39476427d750e1b85895e3e70869d8  ts/src/application/monitor.ts
0cfe2a66516d8c804a2169670cf58138801ef3bd3ad429472e6220e2378080ac  ts/src/bitcoin/refund-estimate.ts
d4a935465e22a97568e004e95e27f3b7565cb7f7b79886bc7277c3faf23dfc8e  ts/src/bitcoin/excess-fee.ts
09b370f90a1a01df03398faf05bd9a879fe129f31aa2c383e3b2ba68604b55e0  ts/src/application/assessments.ts
c5f04aaba4706dc0b1dd1e710dc9e7648c10f978b1c2e2f955ff68adc5c1bd9d  ts/src/application/http.ts
c78983a5d7223a3ed440e3c67fb2b4b28b78adfe61e102fe4c7e91ad263073a3  ts/src/application/operator-http.ts
205663367370e64521a8aad08d442ee1b9a5c3afa50837bf32660dd05b5996e1  ts/src/application/authenticated-http.ts
8cd0b89fbf629272935bfff87fbfdb91701dd2cfe8caa63b02338387e475378c  ts/src/application/pending-http.ts
57bc3a4b9283abc046dec320eee171a1f558d7de5b134cd28c8ffda8b2d86661  ts/src/application/entry.ts
74833a7470ef060d76bd223b5feee0b17ee5b256940317adbd7bb50a1e66f89e  ts/src/application/registry.ts
f1e0ba998513d08d745b215c1343b3805e464ce28b15139c5e8bbe52273c4e73  ts/src/application/bound-entries.ts
8ad1cc8fd2671416e1dd6dd7a621a0169436c03abf4239ab556ec764675cdc1e  ts/src/application/bound-records.ts
8d77f6124e99851cb63fd59f0d18605fe01cd2df7ceee47464cdc46613d8b55a  ts/regtest/entry-lifecycle.ts
e6d7c49bb416aa17b89a293fbd6f2f410dbedad74c2adbf8e6dd3e08f6ee1931  ts/src/application/commitments.ts
1650655adfafb57a05c1014e68a636d76ccae77a2aad4e44b0fef5c9cec2f00e  ts/src/application/commitment-records.ts
4f202525da1cb5acd90b60531d898db51928be25deba8e36eb697e73d1517e22  ts/regtest/commitments.ts
cc420b4301f03a4a570d1f375359e58b56a32dc10909943456044bab0daf0a52  ts/src/application/certificate-cache.ts
039e4f53df0e143606d1bdab5cead3563033a1908ebb6aa58789899ae72f6de8  ts/src/application/certificate-records.ts
336eeb766bf6729f50865a585614757ee76f400172403982b649a868b9e87658  ts/src/application/certificates.ts
d5ff3084d0a67647524d023123c7fcb478a06eb687c83a12542d0e3cfd028bd3  ts/src/application/certificate-http.ts
a7dea4d9dec77177d2f7ef85faf40a3023a769a8bcf40389a129056ff57c4b42  ts/regtest/certificates.ts
cba0d3439437276147e7cbc5227fcb3428c1255e979ab27a6ea682af37721845  ts/regtest/qualification.ts
51b0ffa3edaffe866bd1911c82280c350f38925763e672e914ebc03da1e3a6b1  ts/src/application/deliveries.ts
948c3a7378c3b8a6edde65bbe76288292a71d471fc0b4ea7b79d0a065677d1fe  ts/src/application/delivery-records.ts
05edcbcd2d2deb6a59c767af4731469c4b57699d495f8eadea73c18c060c38f8  ts/src/application/delivery-http.ts
79f02d192562ce3370a85d4e65c0544d1d7849b6b3f72e1f5929051605e52afc  ts/regtest/fulfillment.ts
25afecbca606ec82080e0e21c3dc686697bc5228f12ae4baf3e6fdf5d9628e64  ts/src/main.ts
d6a0de204d208983cc436212cdc30cc6876708a0d92de5c4f00de4719bd525d8  ts/src/runtime/config.ts
0f14ac2cc563975f485e4ac1f618d591289f6a79d500bf9ade74daa95f62996e  ts/src/runtime/credentials.ts
002f19805f0966f5befe177e919261f01e6cdcf7d169d45d2d017acffe1a9aba  ts/src/runtime/server.ts
f6a5885bb410726878c8eae19fa6858e1090b6e1c40d3a4870387d9cffbf767a  ts/src/application/catalog-http.ts
a251019fb5a8963264b3743966ac8e0f59fba848e4ce537b1a33c9ec112497f8  ts/regtest/runtime.ts
eceb07730de094c4cff3139be1e90fbe30f0b9f220a1fbacdcc61f0d856daeb9  ts/src/application/refund-http.ts
c9631a41dc072be68e099d73013f865b4eb5c712d6dabe2423026f9df525aafb  ts/src/application/refund-receipt.ts
```


## TypeScript confirmed delegate-conflict supersession, 2026-11-12

The explicit protocol in `docs/spec/SUPERSESSION.md` now has independent
model, production store, shipped controller/client and Core coverage. It
observes an already-confirmed conflicting spend of the exact bound delegate;
it does not create or send that transaction. Spaces root exclusion remains
the authenticated controller's attestation. Unknown original transactions
or signed bytes, alternative supersession proofs, actual Spaces tree repair
and conflicting-history resolution remain manual or unported.

Final local Core run `core-adapter-2026-11-12T10-06-50-967Z-68f47ce5`
passes 73 checks bound to 59 current source hashes. Its complete safe
qualification JSON is retained under `regtest/runs/` with that run ID.
A separate fresh wallet signs two real transactions spending one delegate;
the original contains the bound root and the higher-fee conflict mines six
deep. The store independently verifies both identities, the root/input,
active block and checkpoint before releasing paid undelivered orders. It
retains the price reserve, survives restart, revokes the proof after actual
checkpoint loss, relocks a paid order and preserves a cancelled order with
an incident. Reconsidering the block and retrying old proof never reactivates
it, including after another restart. Spaces root absence is a fixture fact
in this narrower qualification, not a real Spaces rollback.

Two initial Core attempts failed in the new fixture: run
`core-adapter-2026-11-12T09-58-39-101Z-3e31dbfc` rejected full signed bytes
through a hash-only validator (`invalid Core hash`), and run
`core-adapter-2026-11-12T10-00-42-347Z-004b0197` reused one recipient script
for two orders (`not batchable`). The helper now validates raw hex and uses
distinct recipients. Run `core-adapter-2026-11-12T10-02-41-473Z-63a58392`
then passed, before the additional handle-level recovery guard. The final
run above is the one bound to current source. Failed runs retain their
private logs but have no successful qualification JSON.

Review also found that a cancelled old order's name could have a new order
ID when its proof reverses. O77 now blocks entry, commitment and certificate
progress by handle across order IDs; cancelling and reordering cannot evade
the revived old issuance lock. An independent model and production tests
cover both an unentered checkout and an already-armed replacement. A lost
controller journal acknowledgment during reversal is retried before further
progress, without repeating its alert.

Final full-stack run `typescript-sale-20261112T100650Z-8544da` passes all
24 required checks against 85 current source hashes. Core, spaced, subs,
libveritas and the isolated relay complete the normal sale with store
crashes/restarts and the attended cancellation refund. The buyer receives
9,778 sats from its 10,000-sat principal with the 222-sat fee below the
300-sat ceiling. This run qualifies the normal bridge after the new guards;
it does not exercise real Spaces supersession. It compares fixed spec
expectations and executes no independent model.

The earlier passing full-stack run `typescript-sale-20261112T100350Z-655924`
is also retained, but predates the final handle guard in two source files.
Both reports and all four certificate/relay messages are retained. Each
message independently reverified offline with the real libveritas verifier.

Pinned installation, type checking, 300 TypeScript tests, 302 Python tests
and whitespace checks pass. Development coverage reports 359 fixed-price
cases with no gaps and 40 deferred cases; TypeScript model/store and Python
controller coverage counts are 53/186/50. The pilot release gate still
refuses for 112 missing production cases. Model evidence is separate from
recording-adapter tests, actual Core transactions and full-stack evidence.

Only fresh isolated fixture wallets were used. No deployed service, existing
wallet, managed credential or mainnet state changed. Complete Spaces
supersession, browser/buyer-client and application/host restore gates remain,
followed by installer/Alchemy, safe updates and essential seller commands.
Paid sales stay closed.


## Journal-only TypeScript application restore and inspection, 2026-11-12

`docs/spec/APPLICATION-RESTORE.md` now defines the explicit restore and
read-only recover commands. Restore validates the full domain projection
before publishing a fresh database, preserves acknowledged financial and
issuance history, marks invoices without durable detection unknown,
invalidates certificate verification and journals quarantine plus a global
pause. The commands never release controller quarantine or open listeners.
A pending normalization append returns an unacknowledged receipt and exit 2;
process death and lost acknowledgment resume through recover without another
normalization transition or wallet effect.

The recovery marker follows the journal into older database copies. A live
permission also refuses a newer/conflicting journal head or missing
acknowledged tail. Tests cover old matching prefixes, stale live writers,
old coherent databases and clearing only the local restore bit. These
consistency checks supplement fencing the old instance; they are not a
cross-host lease or a whole-host recovery protocol.

Core run `core-adapter-2026-11-12T10-36-34-723Z-9bc6f898` passes 79
checks bound to 64 current source hashes. Its safe qualification JSON is
retained under `regtest/runs/` with that run ID. The standalone process
first completes the earlier attended refund checks, then stops with a
second unpaid invoice. The buyer pays while the store is stopped. The
shipped restore command rebuilds a new database from the journal alone,
marks that invoice unknown and withholds current settlement claims. The
recover command finds the actual three-confirmation payment and converts
its order, rereads both settled refunds, and still reports ready false
with controller reconciliation required. Repeated inspection and a normal
startup attempt retain quarantine. Wallet descriptors, balances, coin locks
and the mempool remain exactly unchanged by recovery. Core and its payment
wallet stay live; no wallet onboarding-backup restore is claimed.

Full-stack run `typescript-sale-20261112T104027Z-e77f23` passes all 24
normal-sale/refund checks against 88 current source hashes. Real Core,
spaced, subs, libveritas and the isolated relay complete issuance, verified
delivery, store crashes/restarts and an attended cancellation refund. The
buyer receives 9,778 sats from its 10,000-sat principal with the 222-sat fee
below its 300-sat ceiling. The report and both certificate/relay messages
are retained, and both messages independently reverify offline. This run
checks the normal bridge after the new persistence/permission guards; it
does not restore the full stack. It compares fixed spec expectations and
executes no independent model.

Pinned dependency installation, type checking, 313 TypeScript tests,
302 Python tests, development coverage and whitespace pass. O78–O87 have
executable production tests, including killed processes and the shipped
commands; O78 and O82 also have independent model cases. Coverage reports
369 fixed-price cases without gaps, 40 deferred cases, and TypeScript
model/store plus Python controller case counts of 55/196/50. The pilot
production gate still refuses for 112 cases. Recorded-adapter tests,
independent models, actual Core transactions and the full-stack normal
sale remain distinct evidence.

Only fresh isolated fixture wallets were used. No deployed service,
existing wallet, managed credential or mainnet state changed. Remaining
work includes controller/subs reconciliation and an explicit durable
quarantine-completion protocol, wallet/whole-host restore, remaining
supersession paths and browser/buyer-client gates. Installer/Alchemy,
signed updates and essential seller commands follow. Paid sales stay closed.


## Offline TypeScript/controller reconciliation, 2026-11-12

`docs/spec/RECONCILIATION.md` defines completion for known issuance histories.
The store-owned offline command holds store ownership while the shipped
Python subprocess locks the controller, restores the coordinated subs set
when needed and journals a statement bound to the store UUID, journal
prefix and tip. Exact entries/spaces, recipients, operator-wallet history,
known Core transactions and Spaces/subs roots are checked. The TypeScript
parent independently rereads transaction/input/root/block facts and wallet/
root/pipeline state before publishing completion. Both live journals must
acknowledge it before the local startup latch clears. Startup remains
paused; certificates need fresh verification. Unknown sends, missing
bindings and unsupported tree states retain quarantine without a send,
rollback, release or new arm.

Final run `typescript-sale-20261112T112933Z-202ad9` passes all 35 required
checks against 99 current source hashes. The report also records the
combined U1(b)/relay-seed subs binary's name and SHA-256. After real issuance,
verified relay delivery and a settled cancellation refund, it replaces the
application/controller/subs paths, restores their journals/snapshot and
completes recovery. The first delivery receipt and settled refund remain;
the original certificate requires and passes real libveritas verification.
The normal runner then prepares, sends, certifies and publishes another
batch on the restored tree. Its report and five original/reverified/new
certificate and relay messages are retained. All five independently
reverify offline using real libveritas.

Two initial runs, `typescript-sale-20261112T111746Z-2583e4` and
`typescript-sale-20261112T112146Z-320a29`, stopped at reconciliation because
the normal-sale subs build lacks U1(b). Recovery correctly refused the
required transaction attachment. The second used temporary private
failure diagnostics, subsequently removed. Both error reports and their
four pre-restore certificate/relay messages are retained; none is successful
recovery evidence. Run `typescript-sale-20261112T112427Z-31aaf8` then passed
35 checks against 97 hashes with the combined build. It predates the final
binary metadata and harness-launcher hashes; its report and two pre-restore
messages are retained. All eleven retained messages from these four runs
independently reverify offline. Only the final run binds all 99 current
source hashes.

Core run `core-adapter-2026-11-12T11-27-52-039Z-e8cce85b` passes its 79
existing checks against 67 current source hashes. Its safe qualification
JSON is retained under `regtest/runs/`. This narrower Core scenario still
ends with controller quarantine and does not execute the Spaces/controller
completion scenario. Default CI runs it and the recording-adapter suites;
the full Spaces-stack evidence is recorded separately.

Pinned installation, type checking, 324 TypeScript tests, 308 Python tests,
development coverage, shell syntax and whitespace checks pass. O88–O96 and
A51–A56 land with executable production cases; O88/O90 also have independent
model cases. Coverage reports 384 fixed-price cases without gaps, 40
deferred cases and TypeScript model/store plus Python controller case
counts of 57/205/56. The pilot production gate still refuses for 112 cases.
The workspace register validates 1,371 records with 369 existing warnings.
Its script checker reports two unrelated binary-size advisories; it does
not qualify this external repository. Shellcheck/shfmt are unavailable;
no unpinned checker was installed.

Core and both wallets remain live throughout this recovery fixture. It does
not establish wallet onboarding-backup restore, whole-host loss, unknown
transaction recovery, browser checkout or buyer-client acceptance. Those
remain before installer/Alchemy, signed updates and essential seller
commands. Only fresh isolated fixture wallets were used. No existing wallet,
managed credential, deployed service or mainnet state changed. Paid sales
stay closed.


## TypeScript known-history whole-host recovery, 2026-11-12

`docs/spec/HOST-RECOVERY.md` records the recovery procedure and its limits.
The new `run-typescript-recovery.sh` mode reuses the existing independent
network-node fixture. A fulfilled sale and settled cancellation refund use
the real TypeScript process and attended runner. Two more invoices are
acknowledged but unseen. Every seller process is killed and seller data
paths, including Core, Spaces, subs, controller, application, caches and
runtime credentials, are moved aside. They remain private failure evidence,
not inputs to the replacement. The network, its buyer/miner wallets, world
Spaces instance and isolated relay survive.

Run `typescript-recovery-20261112T121422Z-14ce0d` passes all 43 required
checks against 103 current source hashes. It restores the payment and
operator wallets from their original onboarding backups on a fresh seller
node, rescans against the surviving chain, replays the application journal
and reconciles controller/subs through the shipped commands. Replacement
runtime credentials are supplied independently; the attended workflow
reconfigures subs and verifies its authenticated health connection before
enabling admission. No old snapshot credential is treated as the current
secret source. This does not implement Infisical integration.

A payment sent and confirmed during the host's absence is found, attributed
to its original invoice and fulfilled in the next batch. The other historical
invoice stays unknown with no displayed payment address. The first new
quote skips all historical destinations, including the unpaid one. The
store UUID, first fulfilled receipt and settled refund survive. Missing
certificate cache is rebuilt with fresh real verification, and the restored
tree issues again through local relay delivery. The five retained
reverified/new certificate and relay messages independently verify offline
with real libveritas. The measured replacement/recovery portion is 66.99
seconds on this small regtest chain; it is not a production sync estimate
or evidence of the four-hour target.

The first two runs, `typescript-recovery-20261112T120919Z-e8027f` and
`typescript-recovery-20261112T121134Z-beecae`, refused reconciliation while
Spaces had reached its tip but its anchor file was not yet created. Their
error reports are retained, with no success claim. Temporary private
diagnostics in the second run were removed before final qualification.
The controller now retries that known file-open condition under the same
finite bound as its existing truncated-file read retry. A57 checks both
conditions, exhaustion and immediate refusal for unrelated errors. No send,
release or new payment rule is introduced; Python's frozen store baseline
is unchanged.

The normal live-wallet scenario still passes all 35 checks in
`typescript-sale-20261112T121841Z-4bdc49`, bound to 99 current source hashes.
All five of its retained certificate/relay messages independently verify
offline too. Both passing reports record the combined U1(b)/relay-seed subs
binary digest. Core run `core-adapter-2026-11-12T12-18-43-235Z-8802758c`
passes its existing 79 checks against 67 current source hashes. Its safe
qualification JSON is retained. That narrower Core scenario does not
execute whole-host recovery; default CI and the separate full-stack
qualification remain distinct evidence.

Pinned installation, type checking, 324 TypeScript tests, 309 Python tests
in 103.683 seconds, shell syntax and whitespace pass. Development coverage
reports 385 fixed-price cases without gaps and 40 deferred cases, with
TypeScript model/store and Python controller counts of 57/205/57. The pilot
production gate still refuses for 112 missing cases. Whole-host checks use
fixed expectations; no independent model executes inside that scenario.
The workspace register validates 1,371 records with 369 warnings. Its script
checker reports two unrelated binary-size advisories and does not qualify
this external product repository.

This qualifies known mined history with intact recovery material. It does
not pass the complete operator gate: simultaneous multi-space in-flight/
unknown sends, mempool loss, damaged backups, independent secret recovery,
the packaged replacement host and remaining production cases still need
qualification. Browser/buyer-client acceptance also remains. No deployed
service, existing wallet, managed secret or mainnet state changed. Only
fresh isolated fixture wallets were used. Installer/Alchemy, Infisical,
signed updates and essential seller commands remain planned. Paid sales
stay closed.


## Explicit installation identity qualification, 2026-11-12

Core run `core-adapter-2026-11-12T13-47-08-029Z-f9e6d572` passed the isolated
Core 31.2 adapter/runtime/refund/recovery scenario in 50.918 seconds. Its
qualification manifest now includes the identity and read-only observation
sources. It adds actual genesis/public descriptor identity observation,
stability across keypool advancement and refusal of a configured fingerprint
that differs before address allocation. The retained qualification receipt
contains source hashes and check names, not descriptors or wallet credentials.

This is regtest evidence with fresh isolated fixture wallets. Main network
configuration and mismatch refusal have recording-peer coverage; no mainnet
payment, wallet creation or send was attempted. The public runner's new
configuration, indexed-node/peer checks, fee bounds and recovery-only capability
are production component tests, not a Spaces sale or buyer acceptance result.
Packaging's host fence, maintenance and full replacement rehearsal need their
own integrated qualification before packaged readiness can be claimed.


After integrating the raw-entrypoint maintenance fence, final Core run
`core-adapter-2026-11-12T13-55-47-368Z-80b8186a` passed the same 82 checks
against 71 matching source hashes in 67.555 seconds. The safe qualification
receipt is retained under `regtest/runs/`. The default suites pass 416
TypeScript tests and 313 Python tests, the latter in 99.808 seconds. Clean
installation with scripts disabled, type checking, development case coverage
and whitespace checks pass. O126–O128 exercise actual cross-language Linux
ownership and raw-entrypoint/latch refusal. These checks establish neither a
complete installer nor a completed pilot production gate; 75 production cases
remain absent at this increment, and complete package and buyer acceptance
qualification remains separate.


## Complete production case discovery and restore provenance, 2026-11-12

The strict TypeScript recovery increment now executes all remaining H/S/J
cases with real SQLite, journal-only restore, paused controller reconciliation
and recording adapters. H7 runs the independent Seller, RefundFamilies,
refundPlan and Deficits oracle through three seeds, 102 operations and fifteen
host losses. It includes six groups, three replacement attempts, three owner
authorizations, twelve deficit alerts and three undone unacknowledged
cancellations. This is model comparison, not native-chain recovery evidence.

H5 exposed a staging provenance counterexample. Restore now refuses dangling
targets and sidecars, symlinks, multiple links and writable or foreign stages
before SQLite can touch them. It proves lineage through a private inspection
copy, preserves foreign WAL/SHM bytes, removes only a newly created disposable
staging inode and resumes valid same-journal stages after real process death.
Ambiguous preexisting evidence remains for inspection. The strict-format
applicability is recorded in `PILOT-SPEC.md` and `APPLICATION-RESTORE.md`.

Final default checks pass 491 TypeScript tests in 57.196 seconds and 314 Python
tests in 104.663 seconds, plus clean installation with scripts disabled, type
checking, development coverage and whitespace checks. The pilot discovery gate
reports 400 required production cases with no gaps. It is still discovery plus
executed component/model suites, not the buyer or whole-host acceptance gate.

Core run `core-adapter-2026-11-12T14-27-41-698Z-51fad090` passes its 82 checks
against 71 matching source hashes in 68.913 seconds. Its safe receipt is retained
under `regtest/runs/`. The prior attempt
`core-adapter-2026-11-12T14-22-16-357Z-2de9c20a` failed at runtime startup while
an incomplete overlapping module integration changed the source. No application
database, lock or journal entries existed for that runtime; the harness had
ignored its stderr. The foreign changes were preserved and removed, and all
mandatory checks and Core qualification were repeated against the frozen source.
The failed attempt is retained without a qualification claim.

These checks used fresh isolated fixture wallets or recording peers. No
production service, managed secret or mainnet wallet changed. Native Spaces
sale/whole-host acceptance, packaged maintenance and buyer-client acceptance
remain separately qualified work.

## Native export and service startup source qualification, 2026-11-12

The TypeScript source now adds owned pinned libveritas native exports,
certificate-only QR capabilities in the primary journal, scriptless browser
views, durable observed expiry and revocation, verified systemd credential
permissions, paused version 2 startup and same-database maintenance proof.
The scoped native formats are not a legacy Nacho JSON conversion or an
installed-client compatibility claim.

Mandatory source checks passed 532 TypeScript tests and 314 Python tests
without skips, pinned npm installation, strict type checking and the production
coverage gate for 423 required cases. The owned remapped exporter build uses
Rust 1.94.1, libveritas 0.4.4 and spaces_nums 0.4.2; its binary digest is
f4307e4f48473a5972ec3857ac68a32fdc7ff95540c843529e43c3031b295d5e.
Initial and later kept proofs round-trip through the native formats, with
independent verifier facts preserved and negative bindings refused.

Core run `core-adapter-2026-11-12T15-05-16-886Z-fc4aa1a0` passes 82 checks
with 71 listed source hashes matching this implementation. It qualifies the
Core/runtime behavior listed in its report, rather than every export or
package path. The separate native proof, HTTP, journal and browser tests cover
those export boundaries. Package composition, outages with the complete kit,
final artifact recovery and the owner's phone acceptance remain separate.
