/** Build the owned pinned native exporter. No secrets or runtime RPCs. */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { chmodSync, lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Effect } from "effect";

// The entire generated Cargo.lock is pinned, including libveritas 0.4.4,
// spaces_nums 0.4.2 and qrcode 0.14.1 and their registry checksums. A reviewed
// dependency change must update this digest; no partial TOML parser is used.
export const EXPORT_LOCK_SHA256 = "4cdc54536c167ae77136efece13190c0b20bacc35a07cecfccfdfc070cbc6e8e";
export class NativeBuildError extends Error {}
export interface BuildCommand {
  binary: string;
  arguments: string[];
  cwd: string;
  environment: NodeJS.ProcessEnv;
  capture: boolean;
}
export type Execute = (command: BuildCommand, signal: AbortSignal) => Promise<string>;
interface BuildOptions {
  root?: string;
  fetch?: boolean;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  execute?: Execute;
}
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

// realpath also has to resolve the existing parent of a not-yet-built output.
// A dangling symlink is an existing unsafe object, rather than a missing path.
function resolvedPath(path: string): string {
  if (lstatSync(path, { throwIfNoEntry: false })) return realpathSync(path);
  const parent = dirname(path);
  if (parent === path) throw new NativeBuildError("native build output has no existing root");
  return join(resolvedPath(parent), relative(parent, path));
}
function owned(root: string, path: string): string {
  for (const candidate of [dirname(path), path]) {
    const suffix = relative(root, resolvedPath(candidate));
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../")) {
      throw new NativeBuildError("native build output must remain inside its owned source tree");
    }
  }
  return path;
}
const execute: Execute = (command, signal) => new Promise((accept, reject) => {
  const child = spawn(command.binary, command.arguments, { cwd: command.cwd, env: command.environment,
    signal, stdio: command.capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  const output: Buffer[] = [];
  child.stdout?.on("data", (bytes: Buffer) => output.push(bytes));
  child.once("error", reject);
  child.once("close", (code, termination) => {
    if (code !== 0) reject(new NativeBuildError(`native build command failed (${termination ?? code})`));
    else accept(Buffer.concat(output).toString("utf8"));
  });
});

export function buildNativeExport(options: BuildOptions = {}) {
  return Effect.tryPromise({ try: async signal => {
    const root = realpathSync(options.root ?? fileURLToPath(new URL("../../", import.meta.url)));
    const crate = join(root, "native/export"), target = owned(root, join(crate, "target"));
    const lock = readFileSync(join(crate, "Cargo.lock"));
    if (sha(lock) !== EXPORT_LOCK_SHA256) throw new NativeBuildError("native dependency pin differs");
    const home = realpathSync(options.home ?? homedir());
    const environment: NodeJS.ProcessEnv = { ...(options.environment ?? process.env), CARGO_TARGET_DIR: target };
    const cargoHome = resolvedPath(resolve(environment.CARGO_HOME ?? join(home, ".cargo")));
    delete environment.RUSTFLAGS;
    environment.CARGO_ENCODED_RUSTFLAGS = [`--remap-path-prefix=${root}=/build/source`,
      `--remap-path-prefix=${cargoHome}=/build/cargo`].join("\x1f");
    const run = (binary: string, arguments_: string[], capture = false) => (options.execute ?? execute)(
      { binary, arguments: arguments_, cwd: crate, environment, capture }, signal);
    if (options.fetch) await run("cargo", ["+1.94.1", "fetch", "--locked"]);
    await run("cargo", ["+1.94.1", "build", "--release", "--locked", "--offline"]);
    if (sha(readFileSync(join(crate, "Cargo.lock"))) !== EXPORT_LOCK_SHA256) {
      throw new NativeBuildError("native dependency pin differs");
    }
    const binary = owned(root, join(target, "release/subspace-certificate-tools"));
    const bytes = readFileSync(binary);
    for (const path of [home, root, cargoHome]) {
      if (path.length > 1 && bytes.includes(Buffer.from(path))) {
        throw new NativeBuildError("unmapped local build path remains in executable");
      }
    }
    const rustc = await run("rustc", ["+1.94.1", "-Vv"], true);
    const compiler = rustc.split(/\r?\n/)[0], host = /^host: (.+)$/m.exec(rustc)?.[1]?.trim();
    if (!compiler?.startsWith("rustc 1.94.1 ") || !host) throw new NativeBuildError("native compiler profile differs");
    const manifest = { version: 1, tool: "subspace-certificate-tools", library: "libveritas-0.4.4", spacesNums: "0.4.2",
      target: host, rustc: compiler, cargoTomlSha256: sha(readFileSync(join(crate, "Cargo.toml"))), lockSha256: sha(lock),
      sourceSha256: sha(readFileSync(join(crate, "src/main.rs"))), binarySha256: sha(bytes), remappedBuildPaths: true,
      profiles: ["spacecert-v1", "spacemsg-0.4.4"] };
    const metadata = owned(root, join(target, "native-artifact.json"));
    writeFileSync(metadata, JSON.stringify(manifest, null, 2) + "\n");
    chmodSync(metadata, 0o644);
    return { binary: relative(root, binary), sha256: manifest.binarySha256, manifest: relative(root, metadata) };
  }, catch: error => error instanceof NativeBuildError ? error : new NativeBuildError("native exporter build failed", { cause: error }) });
}

if (import.meta.main) {
  try {
    const { values } = parseArgs({ options: { fetch: { type: "boolean", default: false }, help: { type: "boolean" } } });
    if (values.help) console.log("Usage: node ts/tools/build-native-export.ts [--fetch]\nFetch only locked crates before the offline build.");
    else console.log(JSON.stringify(await Effect.runPromise(buildNativeExport({ fetch: values.fetch }))));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "native exporter build failed");
    process.exitCode = 1;
  }
}
