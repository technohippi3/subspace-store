import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { createCertificateChain, VERIFY_DEFAULT } from "@spacesprotocol/libveritas";
import { verifyCertificateMessage } from "../../src/controller/libveritas.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const fixtures = [
  { directory: "combined-20261107T113909Z-345992/002-b1", handle: "one@test10000" },
  { directory: "combined-20261107T113909Z-345992/017-b7", handle: "five@test10000" },
];

test("official Node WASM package and native oracle use the same pinned production verifier", () => {
  const lock = JSON.parse(readFileSync(join(root, "ts/package-lock.json"), "utf8"));
  const dependency = lock.packages["node_modules/@spacesprotocol/libveritas"];
  assert.equal(dependency.version, "0.4.4");
  assert.equal(dependency.integrity, "sha512-8uk0hVCJpolFNDiMb2kIlTmSoe1Pztwl2Hh7X3TFhLYIx5PuPXoQF8Yz2vN6dUEwrEL1L9nHNtlkgUwnBSdglw==");
  const manifest = JSON.parse(readFileSync(join(root, "native/export/target/native-artifact.json"), "utf8"));
  assert.equal(manifest.library, "libveritas-0.4.4");
  assert.equal(manifest.binarySha256, sha(readFileSync(join(root, "native/export/target/release/subspace-certificate-tools"))));
  assert.equal(VERIFY_DEFAULT(), 0);
});

for (const fixture of fixtures) {
  test(`WASM/native saved fixture comparison: ${fixture.handle}`, async t => {
    const directory = join(root, "regtest/evidence", fixture.directory);
    const original = readFileSync(join(directory, fixture.handle + ".message.bin"));
    const anchorsText = readFileSync(join(directory, "anchors.json"), "utf8");
    const anchors = JSON.parse(anchorsText);
    const proof = JSON.parse(readFileSync(join(directory, fixture.handle + ".libveritas.json"), "utf8")) as
      { zones: { handle: string; script_pubkey: string; commitment_root: string | null; commitment_height: number | null }[] };
    const leaf = proof.zones.find(zone => zone.handle === fixture.handle)!;
    const space = proof.zones.find(zone => zone.handle === "@test10000")!;
    assert(space.commitment_root && space.commitment_height !== null);
    const temporary = mkdtempSync(join(tmpdir(), "subspace-wasm-native-"));
    t.after(() => rmSync(temporary, { recursive: true, force: true }));
    const script = Buffer.from(leaf.script_pubkey, "hex"), index = original.indexOf(script);
    assert(index >= 0);
    const altered = Buffer.from(original); altered[index + 2] = altered[index + 2]! ^ 1;
    const substituted = structuredClone(anchors); for (const anchor of substituted) anchor.spaces_root = "0".repeat(64);
    const variants = [
      { name: "valid", bytes: original, anchors: anchorsText, expected: true },
      { name: "malformed", bytes: Buffer.from([255]), anchors: anchorsText, expected: false },
      { name: "trailing-bytes", bytes: Buffer.concat([original, Buffer.from([1])]), anchors: anchorsText, expected: false },
      { name: "altered-recipient", bytes: altered, anchors: anchorsText, expected: false },
      { name: "substituted-anchors", bytes: original, anchors: JSON.stringify(substituted), expected: false },
      { name: "empty-anchors", bytes: original, anchors: "[]", expected: false },
    ];
    for (const variant of variants) {
      const messagePath = join(temporary, variant.name + ".bin"), anchorPath = join(temporary, variant.name + ".json");
      const output = join(temporary, variant.name + "-native");
      writeFileSync(messagePath, variant.bytes); writeFileSync(anchorPath, variant.anchors);
      const native: SpawnSyncReturns<string> = spawnSync(join(root, "native/export/target/release/subspace-certificate-tools"),
        ["native", messagePath, anchorPath, fixture.handle, leaf.script_pubkey, space.commitment_root, String(space.commitment_height), output],
        { encoding: "utf8", timeout: 30000, maxBuffer: 1048576 });
      assert.ifError(native.error); assert.equal(native.signal, null);
      assert.equal(native.status === 0, variant.expected, variant.name + ": native acceptance");
      const verification = verifyCertificateMessage(variant.bytes, variant.anchors);
      if (!variant.expected) { await assert.rejects(run(verification), /certificate verification refused/, variant.name); continue; }
      const verified = await run(verification);
      const nativeFacts = JSON.parse(native.stdout).verified_facts;
      for (const zone of verified.zones) {
        const expected = nativeFacts[zone.handle]; assert(expected);
        assert.equal(zone.canonical, expected.canonical); assert.equal(zone.script_pubkey, expected.script_pubkey);
        assert.equal(zone.sovereignty, expected.sovereignty);
        assert.deepEqual(zone.commitment.status === "exists" ? { root: zone.commitment.root, height: zone.commitment.height } : null, expected.commitment);
      }
      assert.equal(verified.zones.length, Object.keys(nativeFacts).length);
      assert.equal(verified.newestAnchor, anchors[0].block.height);
      assert.equal(verified.certificates.length, 2);
      assert.equal(verified.zones.find(zone => zone.handle === fixture.handle)!.commitment.status, "unknown");
      assert.equal(verified.zones.find(zone => zone.handle === "@test10000")!.commitment.status, "exists");
      const chain = createCertificateChain(fixture.handle, [...verified.certificates]);
      assert.deepEqual(Buffer.from(chain), readFileSync(join(output, "certificate.spacecert")));
      assert.deepEqual(Buffer.from(chain), Buffer.from(createCertificateChain(fixture.handle, [...(await run(verifyCertificateMessage(original, anchorsText))).certificates])));
    }
  });
}

test("WASM adapter rejects empty, excessive and malformed inputs without accepting verification", async () => {
  const directory = join(root, "regtest/evidence", fixtures[1]!.directory);
  const bytes = readFileSync(join(directory, fixtures[1]!.handle + ".message.bin"));
  const anchors = readFileSync(join(directory, "anchors.json"), "utf8"), before = sha(bytes);
  for (const [message, roots] of [[new Uint8Array(), anchors], [new Uint8Array(1048577), anchors],
    [bytes, "x".repeat(1048577)], [bytes, "{}"], [bytes, "{"], [bytes, JSON.stringify(Array(513).fill({}))]] as const)
    await assert.rejects(run(verifyCertificateMessage(message, roots)), /certificate verification refused/);
  await run(verifyCertificateMessage(bytes, anchors));
  assert.equal(sha(bytes), before);
});
