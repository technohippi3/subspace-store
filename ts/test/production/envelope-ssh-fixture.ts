import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import type { TestContext } from "node:test";
import { RecoveryCommand } from "../../src/storage/ssh-journal.ts";

const project = fileURLToPath(new URL("../../../", import.meta.url));
function run(binary: string, args: string[], timeout = 30_000): Buffer {
  const result = spawnSync(binary, args, { timeout, maxBuffer: 24 * 1024 * 1024 });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString()); return result.stdout;
}
export async function encryptedFixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "envelope-ssh-")), server = join(root, "server"); mkdirSync(server, { mode: 0o755 });
  const container = "subspace-envelope-ssh-" + randomBytes(6).toString("hex"); let started = false;
  t.after(() => { try { if (started) run("docker", ["rm", "--force", container]); } finally { rmSync(root, { recursive: true, force: true }); } });
  run("docker", ["build", "--tag", "subspace-recovery-ssh-fixture:20261112", join(project, "deploy/ssh-fixture")], 120_000);
  const port = await new Promise<number>((resolve, reject) => {
    const socket = createServer(); socket.on("error", reject);
    socket.listen(0, "127.0.0.1", () => { const address = socket.address(); assert(address && typeof address !== "string"); socket.close(() => resolve(address.port)); });
  });
  for (const key of [join(root, "client"), join(root, "wrong-host"), join(server, "host")])
    run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "fixture", "-f", key]);
  writeFileSync(join(server, "client.pub"), readFileSync(join(root, "client.pub")), { mode: 0o644 });
  writeFileSync(join(server, "sshd_config"), ["Port " + port, "ListenAddress 127.0.0.1", "HostKey /fixture/host", "PidFile /tmp/sshd.pid",
    "AuthorizedKeysFile /fixture/client.pub", "StrictModes no", "UsePAM no", "PasswordAuthentication no",
    "KbdInteractiveAuthentication no", "AuthenticationMethods publickey", "AllowUsers recovery", "DisableForwarding yes",
    "PermitTTY no", "PermitUserEnvironment no", "LogLevel ERROR",
    "ForceCommand /usr/bin/python3 /code/helper.py --root /recovery --installation fixture-installation"].join("\n") + "\n", { mode: 0o600 });
  run("docker", ["run", "--detach", "--rm", "--name", container, "--network", "host",
    "--mount", "type=bind,source=" + server + ",target=/fixture,readonly",
    "--mount", "type=bind,source=" + join(project, "deploy/recovery") + ",target=/code,readonly", "subspace-recovery-ssh-fixture:20261112"]);
  started = true;
  const hostPublic = (file: string) => readFileSync(file, "utf8").split(" ").slice(0, 2).join(" ");
  writeFileSync(join(root, "known-hosts"), `[127.0.0.1]:${port} ${hostPublic(join(server, "host.pub"))}\n`, { mode: 0o600 });
  writeFileSync(join(root, "wrong-known-hosts"), `[127.0.0.1]:${port} ${hostPublic(join(root, "wrong-host.pub"))}\n`, { mode: 0o600 });
  writeFileSync(join(root, "encryption-key"), randomBytes(32), { mode: 0o600 });
  const config = { version: 1, installation: "fixture-installation", host: "127.0.0.1", port, user: "recovery",
    knownHostsFile: join(root, "known-hosts"), identityFile: join(root, "client"), encryptionKeyFile: join(root, "encryption-key"),
    connectTimeoutSeconds: 2, operationTimeoutSeconds: 5 };
  const configFile = join(root, "recovery.json"), wrongConfig = join(root, "wrong-recovery.json");
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(wrongConfig, JSON.stringify({ ...config, knownHostsFile: join(root, "wrong-known-hosts") }), { mode: 0o600 });
  const client = join(project, "deploy/client/client.mjs"), command = new RecoveryCommand(process.execPath, client, configFile);
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { command.request({ op: "probe" }); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
  }
  assert(ready, "encrypted SSH fixture readiness failed");
  return { command, wrongCommand: new RecoveryCommand(process.execPath, client, wrongConfig),
    encrypted: (sequence: number) => run("docker", ["exec", container, "cat", "/recovery/store/" + String(sequence).padStart(16, "0") + ".json"]),
    stop: () => { run("docker", ["stop", "--time", "2", container]); started = false; } };
}
