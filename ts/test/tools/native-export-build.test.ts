import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect } from "effect";
import { buildNativeExport, EXPORT_LOCK_SHA256, type BuildCommand, type Execute } from "../../tools/build-native-export.ts";

const repository = fileURLToPath(new URL("../../../", import.meta.url));
const lock = readFileSync(join(repository, "native/export/Cargo.lock"));
const compiler = "rustc 1.94.1 (fixture)\nhost: x86_64-unknown-linux-gnu\n";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture(t: { after: (cleanup: () => void) => void }) {
  const directory = mkdtempSync(join(tmpdir(), "native-export-builder-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const root = join(directory, "repository"), home = join(directory, "home"), crate = join(root, "native/export");
  mkdirSync(join(crate, "src"), { recursive: true });
  mkdirSync(home);
  writeFileSync(join(crate, "Cargo.lock"), lock);
  writeFileSync(join(crate, "Cargo.toml"), "[package]\nname = 'fixture'\n");
  writeFileSync(join(crate, "src/main.rs"), "fn main() {}\n");
  const calls: BuildCommand[] = [];
  const binary = join(crate, "target/release/subspace-certificate-tools"), metadata = join(crate, "target/native-artifact.json");
  const execute: Execute = async command => {
    calls.push(command);
    if (command.binary === "rustc") return compiler;
    if (command.arguments.includes("build")) {
      mkdirSync(dirname(binary), { recursive: true });
      writeFileSync(binary, "native fixture executable");
    }
    return "";
  };
  return { directory, root, home, crate, binary, metadata, calls, execute };
}

test("native exporter builder preserves offline commands, remaps and artifact metadata", async t => {
  const f = fixture(t);
  const result = await Effect.runPromise(buildNativeExport({ ...f, fetch: true,
    environment: { RUSTFLAGS: "unsafe ambient flags", CARGO_ENCODED_RUSTFLAGS: "unsafe encoded flags", CARGO_TARGET_DIR: "/unused" } }));
  assert.equal(sha(lock), EXPORT_LOCK_SHA256);
  assert.deepEqual(f.calls.map(c => [c.binary, c.arguments, c.capture]), [
    ["cargo", ["+1.94.1", "fetch", "--locked"], false],
    ["cargo", ["+1.94.1", "build", "--release", "--locked", "--offline"], false],
    ["rustc", ["+1.94.1", "-Vv"], true]
  ]);
  for (const call of f.calls) {
    assert.equal(call.cwd, f.crate);
    assert.equal(call.environment.RUSTFLAGS, undefined);
    assert.equal(call.environment.CARGO_TARGET_DIR, join(f.crate, "target"));
    assert.equal(call.environment.CARGO_ENCODED_RUSTFLAGS,
      `--remap-path-prefix=${f.root}=/build/source\x1f--remap-path-prefix=${f.home}/.cargo=/build/cargo`);
  }
  const digest = sha(readFileSync(f.binary));
  assert.deepEqual(result, { binary: "native/export/target/release/subspace-certificate-tools", sha256: digest,
    manifest: "native/export/target/native-artifact.json" });
  assert.deepEqual(JSON.parse(readFileSync(f.metadata, "utf8")), { version: 1, tool: "subspace-certificate-tools",
    library: "libveritas-0.4.4", spacesNums: "0.4.2", target: "x86_64-unknown-linux-gnu", rustc: compiler.split("\n")[0],
    cargoTomlSha256: sha(readFileSync(join(f.crate, "Cargo.toml"))), lockSha256: sha(lock),
    sourceSha256: sha(readFileSync(join(f.crate, "src/main.rs"))), binarySha256: digest, remappedBuildPaths: true,
    profiles: ["spacecert-v1", "spacemsg-0.4.4"] });
  assert.equal(statSync(f.metadata).mode & 0o777, 0o644);
});

test("native exporter builder refuses changed or duplicated dependency pins before any command", async t => {
  for (const content of [lock.toString().replace('version = "0.4.4"', 'version = "0.4.5"'),
    lock.toString() + '\n[[package]]\nname = "libveritas"\nversion = "0.4.4"\n',
    lock.toString().replace(/checksum = "[a-f0-9]{64}"/, 'checksum = "invalid"')]) {
    const f = fixture(t);
    writeFileSync(join(f.crate, "Cargo.lock"), content);
    await assert.rejects(Effect.runPromise(buildNativeExport({ ...f, fetch: true })), /native dependency pin differs/);
    assert.equal(f.calls.length, 0);
    assert.equal(existsSync(f.metadata), false);
  }
});

test("native exporter builder refuses output symlinks outside the source tree", async t => {
  for (const dangling of [false, true]) {
    const f = fixture(t), outside = join(f.directory, "outside");
    if (!dangling) mkdirSync(outside);
    symlinkSync(outside, join(f.crate, "target"));
    await assert.rejects(Effect.runPromise(buildNativeExport(f)));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture(t), outside = join(f.directory, "outside-metadata");
  const execute: Execute = async (command, signal) => {
    const output = await f.execute(command, signal);
    if (command.binary === "cargo") symlinkSync(outside, f.metadata);
    return output;
  };
  await assert.rejects(Effect.runPromise(buildNativeExport({ ...f, execute })));
  assert.equal(existsSync(outside), false);
});

test("native exporter builder checks the lock again after Cargo and defaults to no fetch", async t => {
  const f = fixture(t);
  await Effect.runPromise(buildNativeExport(f));
  assert.deepEqual(f.calls.map(c => c.arguments[1]), ["build", "-Vv"]);
  const changed = fixture(t);
  const execute: Execute = async (command, signal) => {
    const output = await changed.execute(command, signal);
    if (command.binary === "cargo") writeFileSync(join(changed.crate, "Cargo.lock"), "changed during build");
    return output;
  };
  await assert.rejects(Effect.runPromise(buildNativeExport({ ...changed, execute })), /native dependency pin differs/);
  assert.equal(existsSync(changed.metadata), false);
});

test("native exporter builder refuses leaked local paths, failed builds and unexpected compiler profiles", async t => {
  for (const leak of ["home", "root", "cargo"] as const) {
    const f = fixture(t), cargoHome = join(f.directory, "custom-cargo");
    const execute: Execute = async (command, signal) => {
      const output = await f.execute(command, signal);
      if (command.binary === "cargo") writeFileSync(f.binary, leak === "home" ? f.home : leak === "root" ? f.root : cargoHome);
      return output;
    };
    await assert.rejects(Effect.runPromise(buildNativeExport({ ...f, execute, environment: { CARGO_HOME: cargoHome } })),
      /unmapped local build path remains/);
    assert.equal(existsSync(f.metadata), false);
  }
  const f = fixture(t);
  await assert.rejects(Effect.runPromise(buildNativeExport({ ...f, execute: async () => { throw Error("failed cargo"); } })),
    /native exporter build failed/);
  assert.equal(existsSync(f.metadata), false);
  for (const profile of ["rustc 1.94.0 (fixture)\nhost: x86_64-unknown-linux-gnu\n", "rustc 1.94.1 (fixture)\n"]) {
    await assert.rejects(Effect.runPromise(buildNativeExport({ ...f, execute: async (command, signal) =>
      command.binary === "rustc" ? profile : f.execute(command, signal) })), /native compiler profile differs/);
    assert.equal(existsSync(f.metadata), false);
  }
});

test("native exporter CLI rejects unknown arguments and documents the direct Node entrypoint", async () => {
  const run = promisify(execFile), entrypoint = join(repository, "ts/tools/build-native-export.ts");
  await assert.rejects(run(process.execPath, [entrypoint, "--unknown"]));
  await assert.rejects(run(process.execPath, [entrypoint, "unexpected"]));
  const result = await run(process.execPath, [entrypoint, "--help"]);
  assert.match(result.stdout, /Usage: node ts\/tools\/build-native-export.ts \[--fetch\]/);
});
