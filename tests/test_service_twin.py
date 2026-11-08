"""The service's ledger against the reference model, on the model's own
seeded generated sequences (tests/test_generated.py), with a process restart
of the service every few steps.

After every step the two must agree on every name, order, refund group,
attempt, authorization and alert, and on whether each call was refused.
This is a model-twin result: the service's rules match the model's on
simulated chains. It is not regtest evidence.

SUBSPACE_TWIN_RUNS and SUBSPACE_TWIN_STEPS lengthen it.
"""

import os
import unittest

from tests.service_twin import TwinStore, differences, new_workdir
from tests.test_generated import Generator

RUNS = int(os.environ.get("SUBSPACE_TWIN_RUNS", "24"))
STEPS = int(os.environ.get("SUBSPACE_TWIN_STEPS", "150"))
RESTART_EVERY = 17


class ServiceTwin(unittest.TestCase):
    def run_seed(self, seed):
        with new_workdir() as wd:
            gen = Generator(seed)
            sim = gen.sim
            twin = TwinStore(sim.store, sim.chain, wd)
            sim.store = twin
            sim.controller.store = twin
            # Host loss restores the model from its off-host journal. The
            # service has no restore from the journal yet, so it isn't
            # twinned: a host loss is skipped on both sides.
            sim._host_loss = lambda: None
            for name, n in twin.model.names.items():
                twin.service.list_name(f"{name}@twin", n.price)
            for i in range(STEPS):
                gen.step()
                diff = differences(twin)
                if diff or twin.mismatches:
                    self.fail(f"seed {seed}, step {i}, op journal tail "
                              f"{sim.journal[-3:]}:\n" + "\n".join(twin.mismatches + diff))
                if i % RESTART_EVERY == RESTART_EVERY - 1:
                    twin.restart()
                    diff = differences(twin)
                    if diff:
                        self.fail(f"seed {seed}, after restart at step {i}:\n" + "\n".join(diff))
            twin.service.close()
            return gen, twin

    def test_service_agrees_with_the_model_on_generated_sequences(self):
        covered = {"converted": 0, "refund_groups": 0, "closed_groups": 0, "fulfilled": 0,
                   "restarts": 0}
        for seed in range(RUNS):
            with self.subTest(seed=seed):
                gen, twin = self.run_seed(seed)
                st = twin.model
                covered["converted"] += sum(o.status != "quoted" and o.price_reserve > 0
                                            for o in st.orders.values())
                covered["refund_groups"] += len(st.groups)
                covered["closed_groups"] += sum(bool(g.closed_by) for g in st.groups.values())
                covered["fulfilled"] += sum(o.status == "fulfilled" for o in st.orders.values())
                covered["restarts"] += twin.restarts
        # The sequences must reach the paths the comparison is about.
        for key, count in covered.items():
            self.assertGreater(count, 0, key)


if __name__ == "__main__":
    unittest.main()
