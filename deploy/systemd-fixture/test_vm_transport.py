"""Real disposable OpenSSH transport checks, without booting or simulating a VM."""
import re
import subprocess
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from fixtures import DRAFT, port, run, write
from vm import Guest


class GuestTransportTests(unittest.TestCase):
    def test_pinned_reuse_reconnect_timeout_idle_and_close(self):
        with tempfile.TemporaryDirectory(prefix='subspace-vm-ssh-') as directory:
            root = Path(directory)
            server = root / 'server'
            server.mkdir(mode=0o755)
            for key in (root / 'client', server / 'host', root / 'wrong-host'):
                run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'fixture', '-f', str(key)])
            write(server / 'client.pub', (root / 'client.pub').read_bytes())
            ssh_port = port()
            write(server / 'sshd_config', '\n'.join([
                'Port ' + str(ssh_port), 'ListenAddress 127.0.0.1', 'HostKey /fixture/host',
                'PidFile /tmp/sshd.pid', 'AuthorizedKeysFile /fixture/client.pub', 'StrictModes no',
                'UsePAM no', 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
                'AuthenticationMethods publickey', 'PermitRootLogin prohibit-password', 'AllowUsers root',
                'DisableForwarding yes', 'PermitTTY no', 'PermitUserEnvironment no', 'LogLevel ERROR',
                'Subsystem sftp internal-sftp',
            ]) + '\n', 0o600)
            public = lambda path: ' '.join(path.read_text().split()[:2])
            known = f'[127.0.0.1]:{ssh_port} {public(server / "host.pub")}\n'
            # Construct only the real operator SSH component. No fake guest
            # process, boot success, ownership lease or VM assertion is supplied.
            guest = Guest.__new__(Guest)
            guest.root, guest.port, guest.identity, guest.known = root, ssh_port, root / 'client', root / 'known'
            guest.process = None
            write(guest.known, known, 0o600)
            container = 'subspace-vm-ssh-' + uuid.uuid4().hex[:12]
            started = False
            try:
                run(['docker', 'build', '--tag', 'subspace-recovery-ssh-fixture:20261112', str(DRAFT / 'ssh-fixture')], timeout=120)
                run(['docker', 'run', '--detach', '--rm', '--name', container, '--network', 'host',
                     '--mount', f'type=bind,source={server},target=/fixture,readonly',
                     '--entrypoint', '/bin/sh', 'subspace-recovery-ssh-fixture:20261112', '-c',
                     'passwd -d root >/dev/null; exec /usr/sbin/sshd -D -e -f /fixture/sshd_config'])
                started = True
                deadline = time.monotonic() + 10
                while time.monotonic() < deadline:
                    if guest.exec('true', success=False, timeout=3).returncode == 0:
                        break
                    time.sleep(0.1)
                else:
                    self.fail('disposable SSH server did not become ready')

                def control(operation='check'):
                    return run(['ssh', *guest.options(), '-O', operation, '-p', str(ssh_port), 'root@127.0.0.1'],
                               success=False, timeout=3)

                def master():
                    checked = control()
                    self.assertEqual(checked.returncode, 0, checked.stderr.decode())
                    value = re.search(rb'Master running \(pid=([0-9]+)\)', checked.stderr)
                    self.assertIsNotNone(value)
                    return value.group(1)

                first = master()
                self.assertEqual(guest.exec('printf', '%s', 'literal ; value').stdout, b'literal ; value')
                source = root / 'bytes'
                payload = b'exact\x00bytes\n'
                write(source, payload, 0o600)
                guest.copy(source, '/tmp/copied bytes')
                self.assertEqual(guest.exec('cat', '/tmp/copied bytes').stdout, payload)
                self.assertEqual(guest.exec('stat', '-c', '%u:%g', '/tmp/copied bytes').stdout.strip(), b'0:0')
                self.assertEqual(master(), first, 'command and copy must reuse one authenticated master')

                # Drop the real connection, then require a new pinned handshake.
                self.assertEqual(control('exit').returncode, 0)
                stopped = time.monotonic() + 3
                while time.monotonic() < stopped and control().returncode == 0:
                    time.sleep(0.05)
                self.assertNotEqual(control().returncode, 0)
                write(guest.known, f'[127.0.0.1]:{ssh_port} {public(root / "wrong-host.pub")}\n', 0o600)
                refused = guest.exec('true', success=False)
                self.assertNotEqual(refused.returncode, 0)
                self.assertIn(b'Host key verification failed', refused.stderr)
                self.assertNotEqual(control().returncode, 0)
                write(guest.known, known, 0o600)
                self.assertEqual(guest.exec('true').returncode, 0)
                master()
                with self.assertRaises(subprocess.TimeoutExpired):
                    guest.exec('sleep', '1', timeout=0.1)
                self.assertEqual(guest.exec('printf', 'after-timeout').stdout, b'after-timeout')
                # Allow the deliberately timed-out remote sleep to finish before
                # measuring idle expiry. An active session is not an idle master.
                time.sleep(1.1)
                self.assertEqual(guest.exec('true').returncode, 0)
                master()
                # Control requests themselves count as activity. Leave the
                # connection genuinely quiet before observing its idle expiry.
                time.sleep(6)
                self.assertNotEqual(control().returncode, 0, 'idle fixture master must expire')
                guest.exec('true')
                master()
                guest.close()
                self.assertNotEqual(control().returncode, 0, 'explicit fixture close must stop the master')
                guest.close()  # Teardown is idempotent after explicit closure.
            finally:
                guest.close()
                if started:
                    run(['docker', 'rm', '--force', container], success=False)


if __name__ == '__main__':
    unittest.main()
