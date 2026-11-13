# Nacho device test

Run this test only after the release candidate's source, installed-host and
isolated native/browser qualifications have passing receipts. Record the exact
candidate manifest hash and receipt locations in the private session record
before starting.
The candidate uses disposable test signing trust. Production installation and
paid sales require their separate release and acceptance gates.

## Identify the client

Record Nacho's version, build identifier, phone OS and supported network. Match
that build's certificate decoder and verifier to a supported export before
claiming compatibility. The historical public client at commit
32a1d438438de959ab7ce2b83d789d48057d373d expects a different JSON schema and
does not accept these native formats. Its opaque fields have no reviewed
conversion.

The inspected Android build on 2026-11-13 is Nacho 0.1.1, versionCode 18,
running on Android 17. Its waiting-request file picker requests
`application/json`. Static inspection of the installed bundle traces both
file and QR import through JSON parsing and the legacy certificate shape
check. The bundled native library supports SCRT, but this screen does not
call its binary parser, verifier or native certificate persistence path.
The disassembler does not formally support this bytecode version; direct
opcode inspection and the observed file-picker MIME support the finding,
but no successful import or cryptographic acceptance is claimed.

This build's manual-import path is a compatibility blocker for the current
native exports. A JSON wrapper that merely satisfies the legacy shape does
not establish verified ownership. A client fix needs native decoding,
verification against trusted client anchors, exact handle and recipient
checks, and native certificate persistence. The workspace_owner confirms
this is the latest Google Play release and that matching current source or
a newer build is unavailable. The store cannot repair this client screen.
Recheck these paths if the installed build changes; do not fund a test
solely to confirm the known format mismatch.

Separate installed-bundle inspection identifies an existing relay discovery
path, reachable through resolution refresh and a `Check now` action. It
queries native messages, verifies them, checks the recipient and can save a
native certificate. This is a possible route for the existing build, subject
to the same static-inspection limitation above. Its availability for the
waiting requests and successful persistence/control have not been demonstrated
on the phone. Positive relay discovery would not satisfy the separate file
and QR import requirements. No relay publication or funded test is authorized
by this observation.

The store offers `certificate.spacecert` (official SCRT CertificateChain v1),
`certificate.spacemsg` (official libveritas 0.4.4 Message) and the original
`certificate.message`. Its JSON manifest records format and digests; it is
metadata. A certificate QR encodes an expiring certificate-only download URL.
Check whether the identified client can fetch that URL and decode its exact
format. Generic URL scanning establishes only that the link opens.

## Prepare two buyer requests

Use an operator-supplied HTTPS storefront reachable from the phone, with its
trusted origin fixed in the generated profile. Isolated fixture QR URLs use
loopback addresses and cannot establish cross-device access. Retain downloads
locally when testing file decoding; enable a reachable test host only within
the separately reviewed test setup.

Use a dedicated test wallet and two independently controlled recipient scripts,
created by the owner in the identified client. Keep recovery material outside
agent sessions and test evidence. Use fresh requests for two names under the
chosen throwaway space. Check each public request with
`python3 tools/check_request.py request-1.json request-2.json` and retain the
validated handle/script bindings privately.

The retained isolated regtest certificates demonstrate native format handling;
their recipient keys belong to disposable fixtures. Fresh owner requests are
required to demonstrate control from the owner's client. If that client only
supports mainnet, complete the transaction plan in [BUYER-GATE.md](BUYER-GATE.md)
and obtain its required concrete authorization before any funded action. Include
the browser invoice amount, its payment transaction and the payment/refund fee
budgets in that plan; the historical direct-issuance plan alone does not
authorize an additional checkout payment.

## Run the owner acceptance sequence

1. Complete the browser checkout for both approved test requests. Keep the
   private order links private. Check each displayed handle, recipient and
   payment state against its request, then wait for fresh verified delivery.
2. Create the selected native certificate export for each order. Download one
   on the phone and scan the other's certificate-only QR from another screen.
   Record the exact filename, SHA256, format and what the client accepts.
3. Verify both names and their independent recipient scripts in the client.
   Sign one record update for each. Independently verify the resulting signed
   records against the corresponding certificate and trusted Spaces anchors.
4. Transfer one name through the client. Independently verify its new holder
   and verify that the second name remains controlled by its original holder.
5. Make the store unavailable. On a clean client installation, restore using
   the client's documented recovery procedure, verify the remaining name,
   sign another independently verified record and transfer it.

Record a result and evidence for every step. An unsupported import is a client
compatibility failure with an exact build and format, rather than a completed
buyer gate. Preserve the files and error text so a supported adapter or client
change can be reviewed against the real decoder. Do not fabricate a legacy
certificate wrapper.

## Passing result

The buyer gate passes when both import paths, independent recipient control,
verified records, transfer and recovery with the store unavailable succeed in
the identified client. [BUYER-GATE.md](BUYER-GATE.md) retains the complete gate
and transaction-plan requirements. Operator recovery, official release signing
and authorization to open the first commercial pilot remain separate gates.
