# Native package contract

The first supported profile is existing native Ubuntu 24.04 amd64/systemd255.
Core31.2/spaced wallets already exist, match explicit network/descriptor
identities and finish scanning before installation. The package owns store,
subs and HTTPS units and one POSIX/SSH recovery backend. It never provisions
a VPS, creates wallet keys or chooses commercial settings.

| Case | Required behavior | Executable component evidence |
| --- | --- | --- |
| O140 | Independently trusted Ed25519 signer and exact manifest/archive/file digests; corruption and another signer refuse before use. | native/test_release.py |
| O141 | One native installer installs/idempotently reads the same artifact that Alchemy drives; separate stable data and release paths. Fresh installation also works with operator umask 077. | systemd-fixture/test_package.py with recorded application/node facts; native/test_release.py; native/test_profile.py |
| O142 | Update pauses, reports live blockers, preserves historical addresses and review count, and reconciles before paused readiness. | systemd-fixture/test_package.py; actual TS domain guards in application suite |
| O143 | Lifetime shared raw owners exclude exclusive maintenance; an interrupted update leaves a durable fail-paused latch. | runtime/controller installation-fence tests; systemd-fixture/test_package.py |
| O144 | Normal and update snapshots retain subs stop/restart ownership throughout copying and acknowledged remote upload. Competing restart refuses. | systemd-fixture/test_package.py actual Controller.snapshot; native/test_profile.py |
| O145 | Host retrieval validates exact Infisical project/environment/path/name; no stale fetched-value fallback. Attended source is explicit. | native/test_secrets.py; actual per-start systemd retrieval in systemd-fixture/test_package.py |
| O146 | Pinned SSH host trust precedes connection; Alchemy stores references only; removing/destroying its resource preserves host and data. | client/test-ssh.mjs; actual pinned Alchemy engine in systemd-fixture/test_package.py |
| O147 | Both journals and encrypted snapshots/backups share one immutable bounded backend. Exact retries, chunks, fsync/readback and recovered-ack proofs fail closed. | recovery/test_helper.py; client/test-client.mjs; native/test_profile.py |
| O148 | Loss of the seller cannot be repaired from a local mirror. Restore requires fresh remote materialization and exact acknowledged prefixes. | client/test-ssh.mjs executes remote restore after deleting its fixture seller files; installed service recovery is a separate gate |
| O149 | Representative 10,000-order actual application restore completes under one minute. Live guard latency is recorded separately without cache. | replay/replay.py generates and restores fresh production records from the source under test; it measures restore and live guard separately |
| O150 | Failed startup remains paused; rollback requires matching compatibility epochs and an explicit signed whitelist. Ordinary update never restores a newly crossed review threshold. | native/test_release.py; native/test_profile.py; systemd-fixture/test_package.py |
| O184 | After an actual host reboot with an active hold and Infisical unavailable, restoring the ordinary source recreates private runtime storage without installer preparation or attended fallback; the address, review count and hold remain. | systemd-fixture/test_package.py actual guest reboot and per-start fetch units; complete signed application rehearsal additionally required |

New public installation and release directories have mode 0755 regardless of
the operator's umask. Generated nonsecret configuration and shared lifecycle
lock files have mode 0644. The installer does not widen existing private
ancestors, wallet data, checkpoints, credentials or secret directories. An
operator-provisioned parent must already allow the intended service traversal.
This closes the restrictive-umask extraction failure without relaxing native
cookie or secret-file requirements. A source regression does not replace a
complete signed-package installation acceptance run.

Every secret-fetch unit lets systemd create its validated relative runtime
directory under /run with mode 0700 and the secrets service identity. The
shared parent survives role oneshot completion so dependent services can load
their credentials; it disappears on reboot. Each new service start still
retrieves fresh values, and failure does not use an old role directory. No
ordinary restart or source restoration requires the installer to create /run
paths again.

O151 verifies protected systemd255 credential files with the actual Node helper.
O152 closes unknown old payment prompts and journals pause before observation.
O153 provides ordinary same-database maintenance proof without host-loss
recovery markers or certificate invalidation. O180 excludes ordinary raw
writers throughout installed recovery, allowing only fixed read-only paths
from the marker's exact applicationPath. Those product contracts live in
RUNTIME.md and their production tests.

Compatibility epoch2 includes installation/seller/capability application
semantics and rebuild_guard/restore-provenance controller semantics. These
are RC compatibility labels, not stored record version numbers. A rollback
target that ignores them is unsupported regardless of matching SQLite DDL.

The supported helper/client pair uses8192 page entries with unchanged8MiB
encrypted response bytes,12MiB transport output,16MiB decoded record/page
bytes,24MiB CLI messages and512MiB total adapter replay. Both adapters still
check every live prefix. An old1024-only helper refuses new requests; the
first profile pins the complete pair atomically and never falls back.

At10,000 retained orders the measured full live guard takes14.550 seconds.
The recovery requirement passes; this is not a serving-latency qualification.
The synchronous guard can delay other requests. No cache or relaxed proof is
introduced to hide that limit.

An installation may complete as paused bootstrap with no listings and
explicit_limits=false. It reports waitingSellerSetup and productionReady=false.
The existing preview/apply seller CLI receives explicit operator inputs.
Public readiness and every send retain the complete application/runner gate.

Installed recovery persistently masks service units and uses a protected
recovery marker bound to the selected application code root. Ordinary raw
entrypoints refuse it. Normal shared read-only restore/reconcile runs only
after exclusive ownership is released, preventing lock deadlock. Marker
removal follows exact remote prefix proof and bounded ownership adoption,
immediately before normal paused startup. Every failure reinstates the marker,
maintenance latch and masks. Core/spaced wallets are never ownership-adopted.

The unconditional production wrapper ts/test/production/native-package.test.ts
executes the component fixtures above. Shared workers execute once per test
process; no stored receipt can satisfy a case. Its systemd worker uses actual
installer, SSH, TLS, credentials, Alchemy and product snapshot code with
recorded upstream/application facts. This component coverage does not claim
financial qualification. Final actual-v2 application composition, installed
service recovery and independent native-chain recovery must additionally use
the same complete signed inventory and source commit before RC acceptance.
