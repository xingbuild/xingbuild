import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  parseGovernanceArgs,
  runGovernanceInventory,
  validateGovernanceEvidence,
} from "../scripts/lib/governance-cli-runtime.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const lifecycleCli = path.join(root, "scripts", "content-lifecycle-governance.mjs");

const budgets = {
  maxFiles: 100,
  maxTotalBytes: 1024 * 1024,
  maxFileBytes: 128 * 1024,
  maxWallMs: 5000,
  maxRssMb: 512,
  maxOutputBytes: 1024 * 1024,
};

function cliArgs(output, extra = []) {
  return ["inventory", "--full-scan", ...Object.entries(budgets).flatMap(([key, value]) => [`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`, String(value)]), "--output", output, ...extra];
}

test("GOV-01 help/unknown/empty are early, bounded and do not create workspace state", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-cli-"));
  for (const argv of [["--help"], ["--unknown"], []]) {
    const result = spawnSync(process.execPath, [lifecycleCli, ...argv], { cwd: fixture, encoding: "utf8" });
    assert.ok(result.status === 0 || result.status === 2);
    assert.equal((await readdir(fixture)).length, 0);
  }
});

test("GOV-02 metadata-only and explicit full-scan require finite budgets", async () => {
  assert.equal(parseGovernanceArgs(["inventory", "--output", "out"]).code, "BUDGET_MISSING");
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-mode-"));
  await writeFile(path.join(fixture, "fixture.txt"), "hello");
  const metadataPath = path.join(fixture, "metadata.json");
  const metadata = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: ".", mode: "metadata-only", budgets, outputPath: metadataPath });
  assert.equal(metadata.result, "success");
  assert.equal(metadata.bytesRead, 0);
  assert.ok(metadata.records.every((record) => record.hashMode === "metadata"));
  const fullPath = path.join(fixture, "full.json");
  const full = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: ".", mode: "full-scan", budgets, outputPath: fullPath });
  assert.equal(full.result, "success");
  assert.ok(full.bytesRead > 0);
  assert.ok(full.records.some((record) => record.hashMode === "exact-byte"));
});

test("GOV-03 streams large/corrupt/symlink fixtures without retaining file bodies", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-fixtures-"));
  const workspace = path.join(fixture, "workspace");
  await writeFile(path.join(fixture, "seed.json"), "{}", "utf8");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(64 * 1024, 7));
  await writeFile(path.join(workspace, "corrupt.json"), "{not-json", "utf8");
  await writeFile(path.join(workspace, "half-written.json"), '{"logicalContentId":"half-write",', "utf8");
  await symlink(path.join(workspace, "large.bin"), path.join(workspace, "large-link"));
  const evidence = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets: { ...budgets, maxFileBytes: 128 * 1024 }, outputPath: path.join(fixture, "evidence.json") });
  assert.equal(evidence.result, "success");
  assert.equal(evidence.records.length, 4);
  assert.ok(evidence.records.every((record) => record.logicalContentId && record.sourceOfTruth));
  assert.equal(evidence.records.find((record) => record.objectKind === "symlink")?.hashMode, "metadata");
  assert.equal(evidence.records.find((record) => record.path.endsWith("half-written.json"))?.parseStatus, "invalid-json");
});

test("GOV-04 budget overflow is structured and stops before cleanup decisions", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-budget-"));
  const workspace = path.join(fixture, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "a.txt"), "a");
  await writeFile(path.join(workspace, "b.txt"), "b");
  const evidence = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets: { ...budgets, maxFiles: 1 }, outputPath: path.join(fixture, "overflow.json") });
  assert.equal(evidence.result, "partial");
  assert.equal(evidence.failure.code, "FILES_BUDGET_EXCEEDED");
  assert.deepEqual(evidence.writes, []);
});

test("GOV-04 output budget is enforced without silently returning success", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-output-budget-"));
  const workspace = path.join(fixture, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "a.txt"), "a");
  const evidence = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets: { ...budgets, maxOutputBytes: 64 }, outputPath: path.join(fixture, "tiny.json") });
  assert.ok(["partial", "failure"].includes(evidence.result));
  assert.equal(evidence.failure.code, "OUTPUT_BUDGET_EXCEEDED");
});

test("GOV-04 each finite budget produces a structured stop reason", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-budgets-"));
  const workspace = path.join(fixture, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(64 * 1024, 7));
  await writeFile(path.join(workspace, "small.txt"), "small");
  const wallWorkspace = path.join(fixture, "wall-workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(wallWorkspace));
  await writeFile(path.join(wallWorkspace, "wall.bin"), Buffer.alloc(8 * 1024 * 1024, 3));
  const run = (overrides, name) => runGovernanceInventory({
    sourceRoot: fixture,
    workspaceDirectory: "workspace",
    mode: "full-scan",
    budgets: { ...budgets, ...overrides },
    outputPath: path.join(fixture, `${name}.json`),
  });
  const scenarios = {
    maxTotalBytes: await run({ maxTotalBytes: 1 }, "total"),
    maxFileBytes: await run({ maxFileBytes: 1 }, "file"),
    maxWallMs: await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "wall-workspace", mode: "full-scan", budgets: { ...budgets, maxWallMs: 1, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 }, outputPath: path.join(fixture, "wall.json") }),
    maxRssMb: await run({ maxRssMb: 1, maxWallMs: 5000 }, "rss"),
    maxOutputBytes: await run({ maxOutputBytes: 64 }, "output"),
  };
  assert.equal(scenarios.maxTotalBytes.failure.code, "TOTAL_BYTES_BUDGET_EXCEEDED");
  assert.equal(scenarios.maxFileBytes.failure.code, "FILE_BUDGET_EXCEEDED");
  assert.equal(scenarios.maxWallMs.failure.code, "WALL_BUDGET_EXCEEDED");
  assert.equal(scenarios.maxRssMb.failure.code, "RSS_BUDGET_EXCEEDED");
  assert.equal(scenarios.maxOutputBytes.failure.code, "OUTPUT_BUDGET_EXCEEDED");
  for (const evidence of Object.values(scenarios)) assert.ok(["partial", "failure"].includes(evidence.result));
});

test("GOV-05 cancellation cleans owned lease/temp and writes only a failure receipt", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-cancel-"));
  const workspace = path.join(fixture, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "a.txt"), "a");
  const controller = new AbortController();
  controller.abort(Object.assign(new Error("test cancel"), { code: "TEST_CANCEL" }));
  const evidence = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets, signal: controller.signal, outputPath: path.join(fixture, "cancel.json") });
  assert.equal(evidence.result, "failure");
  assert.equal(evidence.failure.code, "TEST_CANCEL");
  assert.equal(evidence.cleanup.ownedProcessCount, 0);
  assert.equal(evidence.cleanup.leaseRemoved, true);
});

test("GOV-06 repeated runs are deterministic and GOV-07 is zero-write", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-deterministic-"));
  const workspace = path.join(fixture, "workspace");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(workspace));
  await writeFile(path.join(workspace, "a.json"), "{}", "utf8");
  const first = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets, outputPath: path.join(fixture, "one.json") });
  const second = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets, outputPath: path.join(fixture, "two.json") });
  assert.equal(first.inventoryHash, second.inventoryHash);
  assert.deepEqual(first.protectedFacts.before, first.protectedFacts.after);
  assert.deepEqual(first.writes, []);
});

test("GOV-08 validator rejects placeholders and GOV-09 failure evidence cannot authorize cleanup", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-validator-"));
  const evidence = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: ".", mode: "metadata-only", budgets, outputPath: path.join(fixture, "evidence.json") });
  const mutated = structuredClone(evidence);
  mutated.records.push({ ...mutated.records[0], path: "placeholder/sentinel.json" });
  assert.throws(() => validateGovernanceEvidence(mutated), /sentinel path/);
  const failure = { ...evidence, result: "partial", failure: { code: "BUDGET", phase: "walk", stopReason: "budget" }, cleanupPlan: { decision: "delete" } };
  assert.throws(() => validateGovernanceEvidence(failure), /cannot authorize cleanup/);
  const unknown = { ...evidence, result: "unknown", failure: { code: "UNKNOWN", phase: "run", stopReason: "unknown" }, cleanupPlan: { decision: "archive" } };
  assert.throws(() => validateGovernanceEvidence(unknown), /result is invalid/);
  assert.equal(failure.failure.stopReason, "budget");
});

test("GOV-10 runtime never mutates stable source facts and records external responsibility", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-rollback-"));
  await writeFile(path.join(fixture, "stable.txt"), "stable");
  const before = await readFile(path.join(fixture, "stable.txt"), "utf8");
  const evidence = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: ".", mode: "metadata-only", budgets, outputPath: path.join(fixture, "evidence.json") });
  assert.equal(await readFile(path.join(fixture, "stable.txt"), "utf8"), before);
  assert.match(evidence.provenance.externalResponsibility, /Codex\/app-server/);
});
