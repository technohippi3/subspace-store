# Offline controller verifier boundary

This first bounded controller port adds an offline TypeScript/Effect adapter in
`ts/src/controller/libveritas.ts`. It imports the official
`@spacesprotocol/libveritas` package exactly at 0.4.4, matching the native verifier.
Node 24.14.0 selects the package's own Node export. The published WASM and bindings
are used directly, with production `VERIFY_DEFAULT()` equal to zero. No custom
bindings, development receipts, SNARK option or alternative verifier fallback is
supplied. Existing controller entrypoints continue to use Python.

`verifyCertificateMessage` takes nonempty Message bytes of at most one MiB and a
trusted anchor JSON string of at most one MiB containing one to 512 anchors. The
caller must obtain anchors independently from its configured trusted source.
The Message never supplies its own anchors. Official libveritas decoding and
verification decide cryptographic acceptance. Invalid, excessive or rejected
inputs fail the Effect with a controller error; they produce no verified result.
All official WASM objects are disposed on both success and failure. Returned
certificate bytes are owned copies that survive disposal.

The result contains the verifier's newest anchor height, each verified zone's
handle, canonical name, script, sovereignty and commitment, and serialized
certificate bytes. Commitment keeps exists/root/height, empty and unknown distinct.
It never turns an error into an absent commitment. These are offline facts, not
permission to mark an order ready, accept a later root, mutate a journal, acquire
an arm, send a transaction or submit a proof. Active-chain identity/freshness,
reorgs, coverage/finality, exact recipient/root policy and acknowledged store
readiness remain their existing independent gates. This slice wires no runtime
entrypoint, HTTP handler or Python replacement.

The source comparison uses the existing pinned native exporter as an independent
oracle with public saved initial and later commitment fixtures. Each fixture has
valid, malformed, trailing-byte, altered-recipient, substituted-anchor and empty-
anchor variants. Successful comparisons include the public zone facts and exact
SCRT certificate-chain bytes constructed with the official package. The fixture
leaves are unknown and roots exist; assertions retain that distinction. The
native oracle collapses empty/unknown to null, so its equality projection cannot
establish parity between those states. Empty commitments, pending/dependent
sovereignty, other proof/record variants, live chain/reorg and full native lifecycle
scenarios remain unqualified. Saved-fixture comparison is not complete parity,
installed-package acceptance or buyer acceptance.

Effectful follow-on slices still require the
[recovery contracts](CONTROLLER-RECOVERY-CONTRACT.md), their separate exact store
journal-format prerequisite and executable ownership/concurrency/restore evidence.
Python stays as the reference until the corresponding native scenarios pass.
Bootstrap remains a separate decision and PR.
