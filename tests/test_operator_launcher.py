"""The buyer gate's test operator launcher (buyer-gate/operator.sh).

These run the launcher's own shell functions, sourced, with no namespace,
no spaced and no wallet: they check which wallet a cli call would use and
which processes stop would signal. They are launcher tests, not evidence
about the test operator.
"""

import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LAUNCHER = ROOT / "buyer-gate" / "operator.sh"
LINUX = Path("/proc/self/ns/net").exists() and shutil.which("bash") is not None


def source(snippet, *args, env=None):
    """Run `snippet` in bash after sourcing the launcher."""
    full = dict(os.environ)
    full.pop("SUBSPACE_TEST_OPERATOR_WALLET", None)
    full.update(env or {})
    script = f'launcher="$1"; shift; source "$launcher"; {snippet}'
    return subprocess.run(["bash", "-c", script, "test", str(LAUNCHER), *args],
                          capture_output=True, text=True, env=full)


def wallet_args(*args, env=None):
    return source('select_wallet "$@"; printf "%s\\n" "${CLI_ARGS[@]}"', *args, env=env)


@unittest.skipUnless(LINUX, "needs bash and /proc")
class WalletSelection(unittest.TestCase):
    def test_default_wallet_is_added_when_none_is_named(self):
        out = wallet_args("getwalletinfo")
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.split(), ["--wallet", "operator-2", "getwalletinfo"])

    def test_environment_wallet_is_added_when_none_is_named(self):
        out = wallet_args("balance", env={"SUBSPACE_TEST_OPERATOR_WALLET": "operator-3"})
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.split(), ["--wallet", "operator-3", "balance"])

    def test_another_named_wallet_passes_unchanged(self):
        for args in (["--wallet", "operator-2", "getwalletinfo"],
                     ["getwalletinfo", "--wallet=operator-2"],
                     ["-w", "operator-2", "balance"],
                     ["balance", "-woperator-2"]):
            out = wallet_args(*args)
            self.assertEqual(out.returncode, 0, (args, out.stderr))
            self.assertEqual(out.stdout.split(), args)

    def test_exposed_wallet_is_refused_in_every_form(self):
        for args in (["--wallet", "operator", "createwallet"],
                     ["createwallet", "--wallet", "operator"],
                     ["--wallet=operator", "getwalletinfo"],
                     ["-w", "operator", "balance"],
                     ["balance", "-woperator"],
                     ["balance", "-w=operator"],
                     ["--wallet", "operator-2", "balance", "-w", "operator"]):
            out = wallet_args(*args)
            self.assertNotEqual(out.returncode, 0, args)
            self.assertEqual(out.stdout, "", args)
            self.assertIn("exposed", out.stderr, args)

    def test_two_wallets_or_unclear_options_are_refused(self):
        for args in (["--wallet", "a", "-w", "b", "balance"],
                     ["--wallet"],
                     ["--wallet="],
                     ["--walet", "operator", "balance"],
                     ["-dw", "operator", "balance"]):
            out = wallet_args(*args)
            self.assertNotEqual(out.returncode, 0, args)
            self.assertEqual(out.stdout, "", args)

    def test_exposed_wallet_is_refused_from_the_environment(self):
        out = source("echo sourced", env={"SUBSPACE_TEST_OPERATOR_WALLET": "operator"})
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("sourced", out.stdout)
        self.assertIn("exposed", out.stderr)


def userns_available():
    if not LINUX or shutil.which("unshare") is None:
        return False
    probe = subprocess.run(["unshare", "--user", "--map-root-user", "--net", "--fork",
                            "--kill-child", "true"], capture_output=True)
    return probe.returncode == 0


USERNS = userns_available()


class Fixtures(unittest.TestCase):
    """Disposable processes the launcher must not mistake for its own, and
    a private state directory pointing at them."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        self.state = self.tmp / "state"
        (self.state / "run").mkdir(parents=True, mode=0o700)
        self.env = {"SUBSPACE_TEST_OPERATOR_DIR": str(self.state)}
        self.fifo = self.tmp / "block"
        os.mkfifo(self.fifo)

    def dummy(self, *parts):
        """A copy of bash at tmp/PARTS. It runs under any file name, unlike
        a multicall coreutils' sleep, which dispatches on its name."""
        path = self.tmp.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy(os.path.realpath(shutil.which("bash")), path)
        return path

    def spawn(self, argv, ready):
        p = subprocess.Popen(argv)
        self.addCleanup(p.wait)
        self.addCleanup(p.kill)
        for _ in range(100):
            if p.poll() is not None:
                self.fail(f"fixture exited with {p.returncode}: {argv}")
            try:
                if ready(p):
                    return p
            except OSError:
                pass
            time.sleep(0.05)
        self.fail(f"fixture did not start: {argv}")

    def run_as(self, exe, *args):
        """exe, a dummy, blocked reading a FIFO it holds open itself (no
        child process), with ARGS among its arguments."""
        return self.spawn([str(exe), "-c", 'read -r -t 600 <> "$0" || true', str(self.fifo), *args],
                          lambda p: os.readlink(f"/proc/{p.pid}/exe") == str(exe))

    def unrelated_namespace(self):
        """An unshare process in a user and network namespace of its own,
        which this launcher did not create."""
        here = os.readlink("/proc/self/ns/net")

        def ready(p):
            try:
                return os.readlink(f"/proc/{p.pid}/ns/net") != here
            except OSError:
                return False
        return self.spawn(["unshare", "--user", "--map-root-user", "--net", "--fork",
                           "--kill-child", "sleep", "600"], ready)

    def write_run(self, name, text):
        (self.state / "run" / name).write_text(text)

    def record(self, name, pid, extra):
        out = source('record "$RUN/$1" "$2" "$3"', name, str(pid), str(extra), env=self.env)
        self.assertEqual(out.returncode, 0, out.stderr)

    def launcher(self, *args):
        return subprocess.run([str(LAUNCHER), *args], capture_output=True, text=True,
                              env=dict(os.environ, **self.env))

    def check(self, fn, *args):
        return source(f'{fn} "$@"', *args, env=self.env)

    def assertAlive(self, *procs):
        time.sleep(0.2)
        for p in procs:
            self.assertIsNone(p.poll(), f"pid {p.pid} was signalled")


@unittest.skipUnless(LINUX, "needs bash and /proc")
class OwnProcesses(Fixtures):
    """stop signals the pinned binary in the launcher's own network
    namespace, never a process found by name."""

    def test_only_the_pinned_binary_in_the_namespace_is_matched(self):
        pinned_exe = self.dummy("bin", "spaced")
        pinned = self.run_as(pinned_exe)
        namesake = self.run_as(self.dummy("other", "spaced"))
        here = os.readlink("/proc/self/ns/net")
        out = self.check("own_pids", str(pinned_exe), here)
        self.assertEqual({int(x) for x in out.stdout.split()}, {pinned.pid}, out.stderr)
        self.assertNotIn(str(namesake.pid), out.stdout.split())
        # The same binary in another network namespace is not this
        # launcher's.
        self.assertEqual(self.check("own_pids", str(pinned_exe), "net:[1]").stdout, "")

    def test_stop_signals_nothing_a_stale_pid_file_names(self):
        decoy = self.run_as(self.dummy("other", "spaced"))
        self.write_run("ns.pid", f"{decoy.pid}\n")
        self.write_run("slirp.pid", f"{decoy.pid}\n")
        out = self.launcher("stop")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("nothing signalled", out.stderr)
        self.assertAlive(decoy)


@unittest.skipUnless(USERNS, "needs unprivileged user and network namespaces")
class Ownership(Fixtures):
    """The namespace and slirp4netns are this launcher's only if they match
    the identity it recorded. Being unshare outside the host's network
    namespace, or slirp4netns by name with the pid among its arguments, is
    not enough."""

    def test_legacy_pid_file_naming_an_unrelated_namespace_is_never_signalled(self):
        ns = self.unrelated_namespace()
        self.write_run("ns.pid", f"{ns.pid}\n")
        self.assertNotEqual(self.check("ns_pid").returncode, 0)
        out = self.launcher("stop")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("nothing signalled", out.stderr)
        self.assertAlive(ns)
        for cmd in ("status", "start-subs"):
            self.launcher(cmd)
        self.assertAlive(ns)

    def test_unrelated_namespace_is_not_adopted(self):
        ns = self.unrelated_namespace()
        helper = self.run_as(self.dummy("fake", "slirp4netns"), "600", str(ns.pid))
        self.write_run("ns.pid", f"{ns.pid}\n")
        self.write_run("slirp.pid", f"{helper.pid}\n")
        out = self.launcher("adopt")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("nothing adopted", out.stderr)
        self.assertFalse((self.state / "run" / "ns.id").exists())
        self.assertFalse((self.state / "run" / "slirp.id").exists())
        self.assertAlive(ns, helper)

    def test_mismatched_namespace_record_is_never_signalled(self):
        ns = self.unrelated_namespace()
        net = os.readlink(f"/proc/{ns.pid}/ns/net")
        # The right pid, executable and namespace, but another start time.
        self.write_run("ns.id", f"{ns.pid} 1 {net} {os.path.realpath(shutil.which('unshare'))}\n")
        self.assertNotEqual(self.check("ns_pid").returncode, 0)
        out = self.launcher("stop")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("nothing signalled", out.stderr)
        self.assertAlive(ns)

    def test_namesake_helper_is_never_signalled_when_the_namespace_fails(self):
        ns = self.unrelated_namespace()
        helper = self.run_as(self.dummy("fake", "slirp4netns"), "600", str(ns.pid))
        self.write_run("ns.pid", f"{ns.pid}\n")
        self.write_run("slirp.pid", f"{helper.pid}\n")
        self.record("slirp.id", helper.pid, ns.pid)
        out = self.launcher("stop")
        self.assertNotEqual(out.returncode, 0)
        self.assertIn("nothing signalled", out.stderr)
        self.assertAlive(ns, helper)

    def test_namesake_helper_does_not_match_a_helper_record(self):
        ns = self.unrelated_namespace()
        helper = self.run_as(self.dummy("fake", "slirp4netns"), "600", str(ns.pid))
        # An honest record of the namesake: its own pid, start time and
        # executable. It still isn't slirp4netns with this launcher's
        # command line for that namespace.
        self.record("slirp.id", helper.pid, ns.pid)
        self.assertNotEqual(self.check("slirp_pid").returncode, 0)
        # The real slirp4netns path in the record doesn't help either.
        real = os.path.realpath(shutil.which("slirp4netns") or "/usr/bin/slirp4netns")
        start = Path(f"/proc/{helper.pid}/stat").read_text().rsplit(") ", 1)[1].split()[19]
        self.write_run("slirp.id", f"{helper.pid} {start} {ns.pid} {real}\n")
        self.assertNotEqual(self.check("slirp_pid").returncode, 0)

    def test_recorded_namespace_is_stopped_but_not_a_mismatched_helper(self):
        ns = self.unrelated_namespace()
        helper = self.run_as(self.dummy("fake", "slirp4netns"), "600", str(ns.pid))
        # The namespace matches its record, as if this launcher had started
        # it, so stop gets past the namespace check; the helper's record is
        # honest, but the helper isn't slirp4netns for that namespace.
        self.record("ns.id", ns.pid, os.readlink(f"/proc/{ns.pid}/ns/net"))
        self.record("slirp.id", helper.pid, ns.pid)
        self.assertEqual(self.check("ns_pid").stdout.strip(), str(ns.pid))
        out = self.launcher("stop")
        self.assertNotEqual(out.returncode, 0)
        self.assertNotIn("nothing signalled", out.stderr)
        self.assertIn("slirp4netns: the process run/slirp.id names doesn't match its record; "
                      "not signalled", out.stderr)
        self.assertAlive(helper)
        self.assertTrue((self.state / "run" / "slirp.id").exists())


if __name__ == "__main__":
    unittest.main()
