import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("fixture operator transport proves real pinned SSH reuse, reconnect, timeout, idle expiry and closure", () => {
  const result = spawnSync("python3", ["-B", "-m", "unittest", "test_vm_transport", "-v"], {
    cwd: fileURLToPath(new URL("../../../deploy/systemd-fixture/", import.meta.url)),
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr.toString());
  assert.match(result.stderr.toString(), /Ran 1 test\b/);
  assert.match(result.stderr.toString(), /\nOK\s*$/);
});
