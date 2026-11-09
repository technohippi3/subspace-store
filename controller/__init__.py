"""The issuance controller and its publisher (CONTROLLER-DESIGN.md).

`core` is the controller, `publication` the publisher, `host` builds both
from a host configuration, and `journal` and `rpc` are what they share.
The regtest harness adapts the same implementation to its stack
(`regtest/harness/controller.py`).
"""
