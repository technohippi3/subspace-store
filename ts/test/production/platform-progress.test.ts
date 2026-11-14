import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, truncateSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { capturePlatformProgress } from "./platform-progress.ts";

const execute = promisify(execFile), fixtureDirectory = fileURLToPath(new URL("../../../deploy/systemd-fixture", import.meta.url));
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "platform-progress-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporary = join(root, "temporary"), output = join(root, "retained"); mkdirSync(temporary);
  return { root, temporary, output, file: join(temporary, "progress.jsonl") };
}
const row = (sequence = 1, event = "start", phase = "package.setup") => ({ version: 1, sequence, elapsedMs: sequence, event, phase });
function report(output: string) {
  const names = readdirSync(output); assert.equal(names.length, 1);
  const file = join(output, names[0]!); assert.equal(statSync(file).mode & 0o777, 0o600);
  return JSON.parse(readFileSync(file, "utf8"));
}
function python(code: string, file: string, timeout = 5_000) {
  return execute("python3", ["-B", "-c", code], { cwd: fixtureDirectory, timeout,
    env: { ...process.env, SUBSPACE_PACKAGE_PROGRESS_FILE: file, PYTHONDONTWRITEBYTECODE: "1" } });
}

test("platform progress survives an actual child timeout and cleanup without retaining secret input", async t => {
  const f = fixture(t), marker = "fixture-sensitive-argument-must-not-be-retained";
  const code = `import time\nfrom progress import phase, command\nwith phase('package.schema2.post-abort-update'):\n with command(['ssh', '${marker}']):\n  print('fixture-progress-ready', flush=True)\n  time.sleep(60)`;
  let failure: unknown;
  await assert.rejects(capturePlatformProgress(async () => {
    const running = python(code, f.file); let timer: ReturnType<typeof setTimeout> | undefined;
    running.child.stdout!.once("data", () => { timer = setTimeout(() => running.child.kill("SIGTERM"), 100); });
    try { await running; } catch (error) { failure = error; throw error; }
    finally { clearTimeout(timer); }
  }, f.file, f.output), error => error === failure && (error as { killed: boolean }).killed === true);
  rmSync(f.temporary, { recursive: true });
  const saved = report(f.output); assert.equal(saved.outcome, "failure"); assert.equal(saved.source, "read");
  assert.equal(saved.normalExit, false);
  assert.equal(saved.events.at(-1).phase, "command.ssh"); assert.equal(saved.events.at(-1).event, "start");
  assert(saved.events.some((r: { phase: string }) => r.phase === "package.schema2.post-abort-update"));
  assert(!JSON.stringify(saved).includes(marker));
});

test("successful progress records nested command errors with fixed labels and no exception contents", async t => {
  const f = fixture(t), marker = "fixture-sensitive-error-must-not-be-retained";
  await capturePlatformProgress(() => python(`from progress import phase, command\ntry:\n with phase('package.setup'):\n  with command(['not-allowlisted', '${marker}']):\n   raise RuntimeError('${marker}')\nexcept RuntimeError: pass`, f.file), f.file, f.output);
  const saved = report(f.output); assert.equal(saved.outcome, "success");
  assert.deepEqual(saved.events.map((r: { event: string }) => r.event), ["start", "start", "error", "error", "state"]);
  assert.equal(saved.normalExit, true); assert.equal(saved.events.at(-1).phase, "diagnostics.finished");
  assert.equal(saved.events[1].phase, "command.other"); assert(!JSON.stringify(saved).includes(marker));
});

test("malformed, unknown and partial diagnostic records cannot escape the sanitized artifact", async t => {
  const f = fixture(t), marker = "fixture-sensitive-content-must-not-be-retained", primary = Error(marker);
  const lines = [row(), { ...row(2), secret: marker }, { ...row(3), phase: marker }, { ...row(4), elapsedMs: marker },
    row(1), row(5, "complete"), row(6, "state", "guest.running")].map(x => JSON.stringify(x));
  writeFileSync(f.file, lines.join("\n") + '\n{"unclosed":"' + marker);
  await assert.rejects(capturePlatformProgress(async () => { throw primary; }, f.file, f.output), error => error === primary);
  const saved = report(f.output); assert.equal(saved.source, "partial"); assert.equal(saved.discardedRecords, 4);
  assert.deepEqual(saved.events.map((r: { sequence: number }) => r.sequence), [1, 5, 6]);
  assert(!JSON.stringify(saved).includes(marker));
});

test("missing, oversized and nonregular progress fail closed on successful work and preserve primary failure", async t => {
  for (const mode of ["missing", "oversized", "link", "fifo"]) {
    const f = fixture(t);
    if (mode === "oversized") { writeFileSync(f.file, ""); truncateSync(f.file, 4 * 1024 * 1024 + 1); }
    if (mode === "link") { writeFileSync(join(f.root, "other"), JSON.stringify(row()) + "\n"); symlinkSync(join(f.root, "other"), f.file); }
    if (mode === "fifo") await execute("mkfifo", [f.file]);
    await assert.rejects(capturePlatformProgress(async () => 1, f.file), /lacks complete valid progress/);
    const primary = Error("primary fixture failure");
    await assert.rejects(capturePlatformProgress(async () => { throw primary; }, f.file, f.output), error => error === primary);
    assert.equal(report(f.output).outcome, "failure");
  }
});

test("recorder bounds its output and collector reports the limit instead of claiming completeness", async t => {
  const f = fixture(t);
  await assert.rejects(capturePlatformProgress(() => python("from progress import event, MAX_RECORDS\nfor _ in range(MAX_RECORDS + 10): event('state', 'guest.running')", f.file), f.file, f.output), /lacks complete valid progress/);
  assert(statSync(f.file).size <= 4 * 1024 * 1024);
  const saved = report(f.output); assert.equal(saved.source, "bounded"); assert.equal(saved.events.length, 16384);
  assert.equal(saved.events.at(-1).phase, "diagnostics.limit");
});

test("artifact write failure cannot replace a primary fixture error", async t => {
  const f = fixture(t), primary = Error("primary fixture failure"), blocked = join(f.root, "not-directory");
  writeFileSync(f.file, JSON.stringify(row()) + "\n"); writeFileSync(blocked, "");
  await assert.rejects(capturePlatformProgress(async () => { throw primary; }, f.file, blocked), error => error === primary);
  await assert.rejects(capturePlatformProgress(async () => 1, f.file, blocked));
});

test("Python recorder rejects FIFO, symlink and preexisting targets without blocking or appending", async t => {
  for (const mode of ["fifo", "symlink", "existing", "oversized"]) {
    const f = fixture(t), target = join(f.root, "target"); writeFileSync(target, "preserved");
    if (mode === "fifo") await execute("mkfifo", [f.file]);
    if (mode === "symlink") symlinkSync(target, f.file);
    if (mode === "existing") writeFileSync(f.file, "preexisting evidence");
    if (mode === "oversized") { writeFileSync(f.file, ""); truncateSync(f.file, 4 * 1024 * 1024); }
    await python("from progress import event\nfor _ in range(10): event('state', 'guest.running')", f.file);
    assert.equal(readFileSync(target, "utf8"), "preserved");
    if (mode === "existing") assert.equal(readFileSync(f.file, "utf8"), "preexisting evidence");
    if (mode === "oversized") assert.equal(statSync(f.file).size, 4 * 1024 * 1024);
  }
});

test("a short real write disables the Python recorder before it can exceed its actual byte budget", async t => {
  const f = fixture(t);
  const result = await python(`import json, os\nimport progress\nwrite = os.write\ncalls = 0\ndef short(fd, data):\n global calls\n calls += 1\n return write(fd, data[:-1])\nprogress.os.write = short\nfor _ in range(progress.MAX_RECORDS * 4): progress.event('state', 'guest.running')\nprint(json.dumps({'calls':calls,'size':os.stat(os.environ['SUBSPACE_PACKAGE_PROGRESS_FILE']).st_size}))`, f.file);
  const actual = JSON.parse(result.stdout); assert.equal(actual.calls, 1); assert(actual.size > 0 && actual.size < 512);
  await assert.rejects(capturePlatformProgress(async () => 1, f.file, f.output), /lacks complete valid progress/);
  assert.equal(report(f.output).normalExit, false);
});

test("silent recorder I/O failure cannot turn a valid prefix into successful complete progress", async t => {
  const f = fixture(t);
  await assert.rejects(capturePlatformProgress(() => python(`import progress\nprogress.event('start','package.setup')\ndef fail(*args): raise OSError('fixture I/O failure')\nprogress.os.write = fail\nprogress.event('complete','package.setup')`, f.file), f.file, f.output), /lacks complete valid progress/);
  const saved = report(f.output); assert.equal(saved.source, "read"); assert.equal(saved.normalExit, false);
  assert.equal(saved.events.length, 1);
});
