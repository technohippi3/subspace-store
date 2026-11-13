# Loopback binding for the private test

The pinned `subs` binds its unauthenticated API to `0.0.0.0` (finding R7).
`subs-loopback.patch` changes that one bind address to `127.0.0.1` in the
common server startup path. It adds no flag, authentication or firewall
rule. Local processes can still use the API. Use IPv4 loopback in clients.

`regtest/build-private.sh` builds the pin with this patch, U1(b) and the
explicit relay-seed patch as `regtest/.cache/bin/subs-private`. It uses a
separate source worktree and preserves the previous binaries. It builds
offline from the cached dependencies fetched by `regtest/fetch.sh`.
Publication checks also need `certrelay` from `regtest/build-relay.sh`.
The relay-seed and loopback patches affect different hunks of `main.rs`.

From the repository root, check the private build with:

```sh
regtest/build-private.sh
SUBSPACE_SUBS_BIN="$PWD/regtest/.cache/bin/subs-private" SUBSPACE_RELAY=1 \
  regtest/in-netns.sh python3 -m regtest.harness.preflight \
  "$(regtest/run-id.sh private-loopback)" read_private_preflight private_checkout
```

The harness requires the actual `subs` socket to bind to `127.0.0.1` and
the preflight listener check to pass. It still expects the fixture's extra
Core wallets and shared recovery filesystem to fail. The storage refusal
must be a filesystem mismatch even before the first snapshot directory
exists. Then the private checkout must deliver a verified certificate.
Regtest always stays inside the isolated namespace, including with this
build. These checks are not a mainnet run or acceptance of a real VM.

For the control run, select `subs-relay` and run `read_preflight` alone.
That scenario requires the old wildcard listener and its preflight
refusal. The preflight itself has no switch to waive the listener check.
Selecting the private binary on a real machine and verifying its firewall
remain deployment preparation. Neither build nor test authorizes that.

## Local evidence, 2026-11-10

`preflight-storage-20261110T175617Z-68fc28` passed the control scenario:
the older `subs-relay` bound to `0.0.0.0`, preflight rejected that listener,
and the missing snapshot directory produced a filesystem mismatch rather
than a lookup error.

`private-loopback-20261110T180007Z-37a159` passed both the patched listener
check and the private checkout. Its socket was `127.0.0.1:18946`; only the
fixture's extra wallets and shared recovery filesystem failed preflight.
The 1,000-sat order reached finality, yielded a verified certificate,
was confirmed through the local relay and ended fulfilled. Reports are
in each run's directory under `regtest/.run/`. These are local regtest
results; the VM and mainnet purchase have not run.
