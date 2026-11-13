import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { withPreparation } from "./controller-preparation-fixture.ts";
import { using } from "./controller-port-fixture.ts";
import { FileControllerJournal, RemoteControllerJournal } from "../../src/controller/journal.ts";
import { requireAbortProtocol, protocolPrefix } from "../../src/controller/journal-protocol.ts";
import { RecoveryCommand } from "../../src/storage/ssh-journal.ts";
import { fixture } from "./application-fixture.ts";
import { createHash } from "node:crypto";
import { confirmControllerReceipt } from "../../src/runtime/remote-controller-proof.ts";
import { proofHash } from "../../src/application/reconciliation-records.ts";
import { frameRecord } from "../../src/controller/journal-protocol.ts";
import { Effect } from "effect";
import { FaultJournal } from "./controller-port-fixture.ts";

const execute = promisify(execFile);
test("actual old TypeScript kernels refuse mandatory file and remote history before effect ports", async t => {
  for (const revision of ["8bb7312", "7d43c77"]) await withPreparation(t, async (k, f) => {
    await using(k, c => c.freeze("@space"));
    const old = join(f.root, "old-" + revision); mkdirSync(old);
    const archive = await execute("git", ["-C", resolve(".."), "archive", "--format=tar", revision, "ts/src"], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
    const child = await import("node:child_process");
    const extracted = child.spawnSync("tar", ["-xf", "-", "-C", old], { input: archive.stdout }); assert.equal(extracted.status, 0);
    symlinkSync(resolve("node_modules"), join(old, "ts/node_modules"), "dir");
    const run = async (mode: string, database: string) => JSON.parse((await execute(process.execPath,
      ["test/production/controller-legacy-protocol-process.ts", old, database, k.directory, mode], { timeout: 20_000 })).stdout) as { opened: boolean; calls: number };
    for (const mode of ["file", "remote"]) assert.deepEqual(await run(mode, k.database), { opened: true, calls: 0 });
    const older = join(f.root, "older.db"); copyFileSync(k.database, older);
    requireAbortProtocol(k.journal);
    for (const mode of ["file", "remote"]) assert.deepEqual(await run(mode, older), { opened: false, calls: 0 });
    assert.equal((await using(k, c => c.batch("b1"))).state, "frozen");
  });
});

test("both writers produce the same mandatory frame and resolve remote append reply loss without a second floor", async t => {
  const f = fixture(t), file = join(f.root, "remote.json"); writeFileSync(file, JSON.stringify({ loss: "after", objects: [] }));
  const command = new RecoveryCommand(process.execPath, resolve("test/production/controller-rebuild-remote-helper.ts"), file);
  const journal = new RemoteControllerJournal(command);
  assert.throws(() => requireAbortProtocol(journal), /unavailable/);
  requireAbortProtocol(journal);
  assert.equal(journal.entries().length, 1);
  const python = await execute("python3", ["-c", "import sys;sys.path.insert(0,'..');from controller.journal_protocol import encode_record;print(encode_record(dict(seq=1,kind='controller_protocol',version=3,requires=['preparation_abort_v1'])))"]);
  const saved = JSON.parse(readFileSync(file, "utf8")) as { objects: { data: string }[] };
  assert.equal(saved.objects.length, 1);
  assert.equal(Buffer.from(saved.objects[0]!.data, "base64").toString(), python.stdout.trim());
  assert(python.stdout.startsWith(protocolPrefix));
});

test("mandatory controller records reject unsupported features and missing framing", t => {
  const f = fixture(t), directory = join(f.root, "protocol"); mkdirSync(directory);
  const journal = new FileControllerJournal(directory);
  assert.throws(() => journal.appendEvent("controller_protocol", { version: 3, requires: ["unknown"] }), /unsupported/);
  writeFileSync(journal.path, JSON.stringify({ seq: 1, kind: "controller_protocol", version: 3, requires: ["preparation_abort_v1"] }) + "\n");
  assert.throws(() => journal.entries(), /framing/);
});

test("remote recovery verifies the full framed controller prefix before its completion receipt", () => {
  const statement={version:1 as const,store:"11111111-1111-1111-1111-111111111111",sourceSequence:1,sequence:2,
    tipHeight:100,tipHash:"e".repeat(64),entries:[],spaces:[]};
  const receipt={position:2,proofHash:proofHash(statement)};
  const rows=[frameRecord({seq:1,kind:"controller_protocol",version:3,requires:["preparation_abort_v1"]}),
    JSON.stringify({seq:2,kind:"store_reconciliation",statement,proofHash:receipt.proofHash})];
  const command={request<T>(request:{op:string;after?:number}):T {
    const entries=rows.map((raw,i)=>({sequence:i+1,data:Buffer.from(raw).toString("base64"),sha256:createHash("sha256").update(raw).digest("hex")}));
    return (request.op==="journal-read"?{head:2,entries:entries.slice(request.after)}:{sequence:2,sha256:entries[1]!.sha256}) as T;
  }} as RecoveryCommand;
  confirmControllerReceipt(command,receipt,proofHash);
  rows[0]=rows[0]!.replace('"version":3','"version":4');
  assert.throws(()=>confirmControllerReceipt(command,receipt,proofHash),/unsupported/);
});

test("startup can record local safety during outage but legacy abort history is upgraded before later preparation", async t => {
  await withPreparation(t, async (k, f) => {
    await using(k, c => c.freeze("@space")); f.journal.down = true;
    await assert.rejects(using(k, c => c.stage("b1")), /not acknowledged/);
    f.journal.down = false; await using(k, c => c.abortPreparation("b1"));
    const rows=k.journal.entries().filter(row=>row.kind!=="controller_protocol").map((row,i)=>({...row,seq:i+1}));
    writeFileSync(k.journal.path,rows.map(row=>JSON.stringify(row)+"\n").join(""));
    const journal=new FaultJournal(k.directory); journal.down=true;
    const subject={...k,journal,config:{database:k.database,makeJournal:()=>journal}};
    await using(subject,c=>Effect.gen(function*(){
      assert.equal((yield* c.batch("b1")).state,"rebuilt");
      assert(!readFileSync(journal.path,"utf8").includes(protocolPrefix));
      journal.down=false;
      assert.equal((yield* c.freeze("@space")).bid,"b2");
      assert(readFileSync(journal.path,"utf8").includes(protocolPrefix));
      assert.equal(journal.entries().filter(row=>row.kind==="controller_protocol").length,1);
    }));
  });
});
