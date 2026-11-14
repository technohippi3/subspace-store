# Installed-package fixture operator transport

The disposable VM fixture uses one generated fixed host key per guest in a
protected temporary directory. Its operator SSH/SCP commands may reuse the same
authenticated connection through an OpenSSH control socket in that directory.
ControlMaster is auto and ControlPersist is five seconds of idle time. The socket
name includes OpenSSH's connection hash. Cold or reconnected sessions still require
the exact known host key, key-only authentication and the existing bounded options.
A reused session retains its authenticated peer; it does not repeat host-key
authentication on each channel. The host key, identity and socket directory remain
under exclusive fixture custody throughout that session.

Commands and file copies retain their existing deadlines, quoting and root-owner
readback semantics. Client timeout does not prove remote cancellation or absence.
A lost connection can reconnect under the same pin, including
after an actual guest reboot. Fixture closure requests control-master exit before
terminating the owned guest; idle persistence is finite even if ordinary cleanup
does not execute. This is fixture resource handling, not a new product OS lease or
a power-loss/hostile-local-writer guarantee. Selected application, recovery and
Alchemy SSH clients retain their own unchanged behavior.

The focused transport test uses a disposable real OpenSSH server and generated
keys without booting a VM. It verifies command/copy bytes and owner, same-master
reuse, cold wrong-pin rejection, reconnect, command timeout, idle expiry and
explicit/idempotent close. The full suite still boots the actual VM and runs all
existing package, installed systemd, schema-transition and reboot assertions.
No existing readiness, command/copy or 900000-ms shared-fixture guard is extended.

The prior outbox draft's hosted run exceeded that shared limit after cumulative
earlier slowdown. Its trace does not identify a host/resource root cause or prove
a stuck final installer. Connection reuse is a separately tested attempt to reduce
repeated handshake cost. Only completed exact-source integration evidence can
establish its observed timing; no result is assumed from the configuration alone.
