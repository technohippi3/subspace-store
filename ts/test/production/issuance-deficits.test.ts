import { test } from "node:test";
import { runCase } from "./issuance-deficit-scenarios.mjs";

test("N7: lost issuance response plus removed payment alerts a post-issuance deficit without unlocking or sending again", async (t) => { await runCase("N7", t); });
test("N8: mined issuance retains its original commitment and members when payment drops below three confirmations", async (t) => { await runCase("N8", t); });
test("N12: a mined payment shortfall grants no automatic replacement or unsafe supersession authority", async (t) => { await runCase("N12", t); });
test("N9: removal of a fulfilled order payment records the deficit while preserving delivery and buyer ownership", async (t) => { await runCase("N9", t); });
test("N10: a re-mined payment clears the fulfilled post-issuance reason at three confirmations", async (t) => { await runCase("N10", t); });
test("N11: an explicit merchant loss clears the fulfilled deficit reason and remains durable on reopen", async (t) => { await runCase("N11", t); });
test("N13: recorded 8000 loss suppresses repeats and a later 2000 shortfall raises only the new difference", async (t) => { await runCase("N13", t); });
