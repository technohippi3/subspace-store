"""The issuance controller on the regtest harness's stack (regtest only).

The controller is `controller/core.py`, the same implementation the runner
builds from a host configuration. This adapter gives it the harness's
clients (writes to subs through the fault proxy, readback direct), the
stack's control of the subs process, the upstream regtest operator wallet,
and the capabilities of the subs build the run uses. Results from it are
regtest results.
"""

from controller.core import (  # noqa: F401
    ANCHOR_FINALITY, CLOSED, FINAL_D, LIVE, NO_ATTACH, PREPARING, SCHEMA, WATCHED,
    Capabilities, Clients, Paused, Refused, label)
from controller.core import Controller as _Controller

from .procs import OPERATOR_WALLET, subs_capabilities


class StackSubs:
    """The stack's subs process: stop waits for the process to exit, start
    for subs to answer."""

    def __init__(self, stack):
        self.stack = stack

    @property
    def data_dir(self):
        return self.stack.subs_dir

    def stop(self):
        self.stack.stop_process("subs")

    def start(self):
        self.stack.start_subs()


def stack_clients(stack):
    return Clients(subs=lambda: stack.subs(via_proxy=True), subs_read=lambda: stack.subs(),
                   spaced=stack.spaced, btc=stack.btc)


class Controller(_Controller):
    def __init__(self, db_path, journal, registry, stack, verifier_bin, workdir):
        super().__init__(db_path, journal, registry, stack_clients(stack), StackSubs(stack),
                         verifier_bin, workdir, OPERATOR_WALLET,
                         Capabilities(**subs_capabilities()))
        self.stack = stack
