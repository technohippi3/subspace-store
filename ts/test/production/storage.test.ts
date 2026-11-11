import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { Effect } from "effect";
import { DurableStore, type StorageConfig } from "../../src/storage/store.ts";
import { FileJournal, type Journal } from "../../src/storage/journal.ts";
import { entry, type Entry } from "../../src/storage/codec.ts";

const project = fileURLToPath(new URL("../../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
const storeUrl = new URL("../../src/storage/store.ts", import.meta.url).href;
const journalUrl = new URL("../../src/storage/journal.ts", import.meta.url).href;
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "store-durability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journalDirectory = join(root, "journal"); mkdirSync(journalDirectory);
  return { root, database: join(root, "store.db"), journalDirectory };
}
function use<A, E>(config: StorageConfig, work: (store: DurableStore) => Effect.Effect<A, E>) {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const store = yield* DurableStore.open(config);
    return yield* work(store);
  })));
}
const name = (price: number) => ({ kind: "name", key: "one@space", value: { price } });
class FailingJournal extends FileJournal {
  down = false;
  lostAnswer = false;
  override append(entry: Entry): undefined {
    if (this.down) throw Error("simulated journal outage");
    super.append(entry);
    if (this.lostAnswer) throw Error("simulated lost acknowledgment");
  }
}
async function seed(config: StorageConfig): Promise<void> {
  await use(config, store => store.commit([name(1_000)]));
}
function crashWriter(config: StorageConfig) {
  const script = `
    import { Effect } from "effect";
    import { DurableStore } from ${JSON.stringify(storeUrl)};
    import { FileJournal } from ${JSON.stringify(journalUrl)};
    class Crash extends FileJournal {
      append(entry) { super.append(entry); process.kill(process.pid, "SIGKILL"); }
    }
    Effect.runSync(Effect.scoped(Effect.gen(function* () {
      const store = yield* DurableStore.open({ database: process.argv[1], journalDirectory: process.argv[2],
        makeJournal: () => new Crash(process.argv[2]) });
      yield* store.commit([{ kind: "order", key: "o1", value: { address: "mock-payment-address" } }]);
    })));
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script, config.database,
    config.journalDirectory], { cwd: project, encoding: "utf8", timeout: 10_000 });
}

test("Z1: SQLite records and journal receipts survive restart", async (t) => {
  const config = fixture(t);
  await use(config, store => Effect.gen(function* () {
    assert.deepEqual(yield* store.commit([name(1_000), { kind: "order", key: "o1", value: { status: "quoted" } }]),
      { seq: 1, acknowledged: true });
    assert.equal((yield* store.get("name", "one@space"))?.acknowledged, true);
  }));
  await use(config, store => Effect.gen(function* () {
    assert.deepEqual((yield* store.get("name", "one@space"))?.value, { price: 1_000 });
    assert.deepEqual(yield* store.commit([name(2_000)]), { seq: 2, acknowledged: true });
    assert.deepEqual(yield* store.status(), { seq: 2, acknowledged: 2, restoreRequired: false, journalFailure: null });
  }));
  assert.equal(new FileJournal(config.journalDirectory).read().length, 2);
  assert.equal(statSync(config.database).mode & 0o777, 0o600);
});

test("Z2: journal outage keeps the local transaction pending and retries on restart", async (t) => {
  const config = fixture(t);
  const journal = new FailingJournal(config.journalDirectory);
  await use({ ...config, makeJournal: () => journal }, store => Effect.gen(function* () {
    journal.down = true;
    assert.deepEqual(yield* store.commit([name(1_000)]), { seq: 1, acknowledged: false });
    assert.equal((yield* store.get("name", "one@space"))?.acknowledged, false);
    assert.equal(readdirSync(config.journalDirectory).length, 0);
    assert.equal((yield* store.status()).journalFailure, "simulated journal outage");
  }));
  await use(config, store => Effect.gen(function* () {
    assert.equal((yield* store.get("name", "one@space"))?.acknowledged, true);
    assert.deepEqual(yield* store.status(), { seq: 1, acknowledged: 1, restoreRequired: false, journalFailure: null });
  }));
  assert.equal(new FileJournal(config.journalDirectory).read().length, 1);
});

test("Z3: lost acknowledgment and process death replay the published entry once", async (t) => {
  const config = fixture(t);
  const journal = new FailingJournal(config.journalDirectory); journal.lostAnswer = true;
  await use({ ...config, makeJournal: () => journal }, store => Effect.gen(function* () {
    assert.equal((yield* store.commit([name(1_000)])).acknowledged, false);
    journal.lostAnswer = false;
    assert.equal(yield* store.flush(), true);
  }));
  const saved = new FileJournal(config.journalDirectory);
  assert.equal(saved.read().length, 1);
  const first = saved.read()[0]!;
  const path = join(config.journalDirectory, "0000000000000001.json");
  const before = readFileSync(path);
  assert.throws(() => saved.append(entry(first.store, 1, null, [name(9_000)])), /retry differs/);
  assert.deepEqual(readFileSync(path), before);
  const crashed = fixture(t);
  const child = crashWriter(crashed);
  assert.equal(child.signal, "SIGKILL", child.stderr);
  await use(crashed, store => Effect.gen(function* () {
    assert.deepEqual((yield* store.get("order", "o1"))?.value, { address: "mock-payment-address" });
    assert.equal((yield* store.get("order", "o1"))?.acknowledged, true);
    assert.equal((yield* store.commit([name(2_000)])).seq, 2);
  }));
  assert.equal(new FileJournal(crashed.journalDirectory).read().length, 2);
});

test("Z4: corrupt, missing and foreign journal history refuse startup", async (t) => {
  for (const damage of ["checksum", "gap", "foreign", "empty"] as const) {
    const config = fixture(t); await seed(config);
    await use(config, store => store.commit([name(2_000)]));
    const before = readFileSync(config.database);
    const path = join(config.journalDirectory, "0000000000000001.json");
    if (damage === "checksum") {
      const value = JSON.parse(readFileSync(path, "utf8")) as Entry;
      writeFileSync(path, JSON.stringify({ ...value, hash: "corrupted" }));
    } else if (damage === "gap") unlinkSync(path);
    else if (damage === "empty") {
      for (const file of readdirSync(config.journalDirectory)) unlinkSync(join(config.journalDirectory, file));
    } else {
      const other = fixture(t); await seed(other);
      copyFileSync(join(other.journalDirectory, "0000000000000001.json"), path);
    }
    await assert.rejects(use(config, store => store.status()), /checksum|sequence|identity|hash-chain|missing from journal/);
    assert.deepEqual(readFileSync(config.database), before);
  }
});

test("Z5: explicit journal-only restore retains records and requires reconciliation", async (t) => {
  const config = fixture(t);
  await use(config, store => store.commit([
    name(1_000), { kind: "order", key: "o1", value: { address: "mock-address", status: "fulfilled" } },
    { kind: "certificate", key: "o1", value: "mock-certificate" },
    { kind: "committed", key: "one@space", value: { root: "mock-root" } },
  ]));
  const restored = { ...config, database: join(config.root, "restored.db") };
  await assert.rejects(use(restored, store => store.status()), /restore required/);
  assert.equal(existsSync(restored.database), false);
  writeFileSync(restored.database, "");
  await assert.rejects(use(restored, store => store.status()), /restore required/);
  unlinkSync(restored.database);
  await use({ ...restored, restore: true }, store => Effect.gen(function* () {
    assert.equal((yield* store.status()).restoreRequired, true);
    assert.equal((yield* store.get("certificate", "o1"))?.value, "mock-certificate");
    assert.deepEqual((yield* store.get("committed", "one@space"))?.value, { root: "mock-root" });
    assert.equal((yield* store.commit([name(2_000)])).seq, 2);
  }));
  assert.equal(existsSync(restored.database + ".restoring"), false);
  await assert.rejects(use({ ...restored, restore: true }, store => store.status()), /never overwrites/);
});

test("Z6: failed SQLite transaction changes neither records, outbox nor journal", async (t) => {
  const config = fixture(t); await seed(config);
  await use(config, store => Effect.gen(function* () {
    const injection = new DatabaseSync(config.database);
    injection.exec("create trigger fail before insert on records when new.key='explode' " +
      "begin select raise(abort,'injected transaction failure'); end;");
    injection.close();
    yield* Effect.promise(async () => {
      await assert.rejects(Effect.runPromise(store.commit([
        name(2_000), { kind: "order", key: "explode", value: "fail" },
      ])), /injected transaction failure/);
    });
    assert.deepEqual((yield* store.get("name", "one@space"))?.value, { price: 1_000 });
    assert.equal((yield* store.status()).seq, 1);
    assert.equal(new FileJournal(config.journalDirectory).read().length, 1);
  }));
});

test("Z7: a Python SQLite snapshot catches up from the newer store journal", async (t) => {
  const config = fixture(t);
  const snapshot = join(config.root, "snapshot.db");
  await use(config, store => Effect.gen(function* () {
    yield* store.commit([name(1_000)]);
    execFileSync("python3", ["-c", `import sqlite3, sys
sys.path.insert(0, sys.argv[4])
from runner.store import Store
store = Store('http://unused', '/unused-token', sys.argv[1], sys.argv[3])
assert store.journal.position() == 1
source = store.db
target = sqlite3.connect(sys.argv[2])
source.backup(target)
target.close()
source.close()`, config.database, snapshot, config.journalDirectory, repository]);
    yield* store.commit([name(2_000)]);
  }));
  await use({ ...config, database: snapshot }, store => Effect.gen(function* () {
    assert.deepEqual((yield* store.get("name", "one@space"))?.value, { price: 2_000 });
    assert.equal((yield* store.status()).acknowledged, 2);
  }));
  assert.equal(new FileJournal(config.journalDirectory).read().length, 2);
});

test("Z8: interrupted restore publishes no partial serving database and resumes", async (t) => {
  const config = fixture(t); await seed(config);
  const restored = join(config.root, "restored.db");
  const script = `
    import { Effect } from "effect";
    import { DatabaseSync } from "node:sqlite";
    import { DurableStore } from ${JSON.stringify(storeUrl)};
    const exec = DatabaseSync.prototype.exec;
    let begins = 0;
    DatabaseSync.prototype.exec = function(sql) {
      const result = exec.call(this, sql);
      if (sql === "begin immediate" && ++begins === 2) process.kill(process.pid, "SIGKILL");
      return result;
    };
    Effect.runSync(Effect.scoped(DurableStore.open({ database: process.argv[1],
      journalDirectory: process.argv[2], restore: true })));
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", script,
    restored, config.journalDirectory], { cwd: project, encoding: "utf8", timeout: 10_000 });
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.equal(existsSync(restored), false);
  assert.equal(existsSync(restored + ".restoring"), true);
  await use({ ...config, database: restored, restore: true }, store => Effect.gen(function* () {
    assert.equal((yield* store.status()).restoreRequired, true);
    assert.deepEqual((yield* store.get("name", "one@space"))?.value, { price: 1_000 });
  }));
});

test("H12: TypeScript ownership interoperates with Python and precedes journal access", async (t) => {
  const config = fixture(t);
  await use(config, store => Effect.gen(function* () {
    let touched = false;
    yield* Effect.promise(async () => {
      await assert.rejects(use({ ...config, makeJournal: () => {
        touched = true; throw Error("journal touched");
      } }, other => other.status()), /store busy/);
    });
    assert.equal(touched, false);
    const result = spawnSync("python3", ["-c", `import sys
from service.locking import Ownership, StoreBusy
try:
    Ownership(sys.argv[1])
except StoreBusy:
    raise SystemExit(3)
raise SystemExit(4)`, config.database], { cwd: repository, encoding: "utf8" });
    assert.equal(result.status, 3, result.stderr);
    assert.equal((yield* store.status()).seq, 0);
  }));
  const node = `import {Effect} from "effect"; import {DurableStore} from ${JSON.stringify(storeUrl)};
    try { Effect.runSync(Effect.scoped(DurableStore.open({database:process.argv[1],
      journalDirectory:process.argv[2], makeJournal:()=>{throw Error("journal touched")}}))); }
    catch(e) { if(String(e).includes("store busy")) process.exit(3); throw e; }`;
  const opposite = spawnSync("python3", ["-c", `import fcntl, subprocess, sys
with open(sys.argv[1]+'.lock', 'a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    result = subprocess.run([sys.argv[2], '--input-type=module', '-e', sys.argv[3], sys.argv[1], sys.argv[4]], capture_output=True, text=True)
    assert result.returncode == 3, result.stderr`, config.database, process.execPath, node,
    config.journalDirectory], { cwd: project, encoding: "utf8", timeout: 10_000 });
  assert.equal(opposite.status, 0, opposite.stderr);
  await use(config, store => store.status());
  const missing = { ...config, journalDirectory: join(config.root, "missing") };
  await assert.rejects(use(missing, store => store.status()), /ENOENT/);
  await use(config, store => store.status());
});


test("H12: Effect failure and interruption release the store ownership scope", async (t) => {
  const config = fixture(t);
  await assert.rejects(use(config, () => Effect.fail(new Error("caller failed"))), /caller failed/);
  await use(config, store => store.status());
  let ready!: () => void;
  const acquired = new Promise<void>(resolve => { ready = resolve; });
  const controller = new AbortController();
  const running = Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* DurableStore.open(config);
    ready();
    yield* Effect.never;
  })), { signal: controller.signal });
  await acquired;
  controller.abort();
  await assert.rejects(running);
  await use(config, store => store.status());
});


test("Z9: adoption retries directory durability before acknowledging a crashed publication", async (t) => {
  const config = fixture(t);
  const script = `
    import { Effect } from "effect";
    import { readdirSync } from "node:fs";
    import { DurableStore } from ${JSON.stringify(storeUrl)};
    import { FileJournal } from ${JSON.stringify(journalUrl)};
    const original = FileJournal.prototype.syncDirectory;
    FileJournal.prototype.syncDirectory = function() {
      if (readdirSync(this.directory).some(name => name.endsWith(".json"))) {
        if (process.argv[3] === "crash") process.kill(process.pid, "SIGKILL");
        throw Error("injected adoption sync failure");
      }
      return original.call(this);
    };
    const work = Effect.scoped(Effect.gen(function* () {
      const store = yield* DurableStore.open({database:process.argv[1],journalDirectory:process.argv[2]});
      yield* store.commit([{kind:"order",key:"o1",value:{address:"mock-address"}}]);
    }));
    Effect.runSync(work);
  `;
  const run = (mode: string) => spawnSync(process.execPath,
    ["--input-type=module", "-e", script, config.database, config.journalDirectory, mode],
    { cwd: project, encoding: "utf8", timeout: 10_000 });
  assert.equal(run("crash").signal, "SIGKILL");
  const failure = run("fail");
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /injected adoption sync failure/);
  const before = new DatabaseSync(config.database, { readOnly: true });
  assert.equal(before.prepare("select acknowledged from outbox where seq=1").get()?.acknowledged, 0);
  before.close();
  await use(config, store => Effect.gen(function* () {
    assert.equal((yield* store.get("order", "o1"))?.acknowledged, true);
    assert.equal((yield* store.status()).seq, 1);
  }));
});


test("Z2: an asynchronous backend cannot manufacture a synchronous acknowledgment", async (t) => {
  const config = fixture(t);
  const wrongBackend = { read: () => [], append: async () => {} } as unknown as Journal;
  await use({ ...config, makeJournal: () => wrongBackend }, store => Effect.gen(function* () {
    assert.equal((yield* store.commit([name(1_000)])).acknowledged, false);
    assert.equal((yield* store.get("name", "one@space"))?.acknowledged, false);
    assert.equal((yield* store.status()).journalFailure, "journal backend must acknowledge synchronously");
  }));
  await use(config, store => Effect.gen(function* () {
    assert.equal((yield* store.get("name", "one@space"))?.acknowledged, true);
  }));
});
