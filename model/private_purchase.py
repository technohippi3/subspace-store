"""One-order private-test admission, independent of holds and payment state.

This models only the permanent allowance and its acknowledgment. It does
not model node configuration, sockets or fees, which have service tests.
"""

from dataclasses import dataclass


@dataclass
class PrivatePurchase:
    handle: str
    recipient: str
    price: int = 1000
    order: str | None = None
    acknowledged_order: str | None = None

    def quote(self, order, handle, recipient, price):
        if (handle, recipient, price) != (self.handle, self.recipient, self.price):
            return False
        if self.order is not None and self.order != order:
            return False
        self.order = order
        return True

    def acknowledge(self):
        self.acknowledged_order = self.order

    def instructions(self, order):
        return self.acknowledged_order is not None and self.acknowledged_order == order

    def restore(self):
        self.order = self.acknowledged_order
