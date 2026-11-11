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
