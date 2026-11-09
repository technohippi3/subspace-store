# Host examples

These files are examples of how the store and its operator tools would be
configured on a host. Nothing in this repository installs them, and
nothing has run from them yet. The project authorizes no production
deployment, so they name regtest. Every path is a placeholder.

- `store.example.json` configures the store service,
  `python3 -m service <config>`. Its keys are described in
  `service/__main__.py` and `docs/SERVICE.md`.
- `runner.example.json` configures the attended runner,
  `python3 -m runner <config> <command>`. Its keys are described in
  `controller/host.py`. `tests/test_controller_host.py` checks that it has
  every key the runner reads.
- `systemd/subspace-store.service` and `systemd/subs.service` are example
  systemd user units for the store service and for `subs`. `bitcoind` and
  `spaced` run under their own documentation.

None of them holds a credential. Bitcoin Core and `spaced` authenticate by
the cookie files they write at start-up, and the store's tokens are files
it creates with mode 0600 on its first start. The configurations name
those files and never contain their contents.

Four of the requirements are not obvious from the files:
- The runner stops and starts `subs` around each coordinated snapshot,
  with the commands in `subs.stop_command` and `subs.start_command`. The
  stop command must return only once `subs` has exited; `systemctl stop`
  does. The controller then copies nothing unless a connection to `subs`
  is refused, and waits until it answers again before work resumes.
- `subs.capabilities.attach_txid` must say truthfully whether the `subs`
  binary has the U1(b) route of `regtest/upstream/`. The pinned `subs`
  doesn't. Without it, a later commitment restored without its `txid`
  blocks the next batch on that space, so the operator gate needs that
  capability or another reviewed recovery procedure
  (`docs/spec/CONTROLLER-DESIGN.md`, "What this requires").
- The `network` key is a claim the runner checks, not trusts. Before every
  command it asks `bitcoind`, `spaced`, the store and each `subs` endpoint
  (`url` and `write_url`, each for the `spaced` behind it) which network
  and chain they are on, by block hash, and runs nothing unless all agree
  with it.
- The journal and snapshot directories must be on storage that survives
  the host, which is what makes a journal-only restore possible.

The test operator's machine and its network confinement are described in
`docs/BUYER-GATE.md`, not here.
