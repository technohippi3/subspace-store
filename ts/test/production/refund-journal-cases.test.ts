import { test } from "node:test";
import { runCase } from "./controller-case-scenarios.mjs";

test("J1: TS-owned signed refund family and reservation survive journal-only host loss and are observed before any send", async (t) => { await runCase("J1", t); });
test("J2: unacknowledged preparation exports no signed bytes and blocks runner broadcast until acknowledgment", async (t) => { await runCase("J2", t); });
test("J5: a signed local refund attempt without acknowledgment cannot escape through the runner or repeated send", async (t) => { await runCase("J5", t); });
