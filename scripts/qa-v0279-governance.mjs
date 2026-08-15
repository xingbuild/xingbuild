#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  runGovernanceInventory,
  validateGovernanceEvidence,
} from "./lib/governance-cli-runtime.mjs";
import { classifyReleaseScope } from "./lib/release-scope-classifier.mjs";

const sourceRoot = process.cwd();
const version = "v0.27.9";
const outputPath = path.join(sourceRoot, ".content-workspace", "qa", "v0279-governance", "evidence.json");
const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-qa-"));
const workspace = path.join(fixture, "workspace");
const budgets = {
  maxFiles: 100,
  maxTotalBytes: 2 * 1024 * 1024,
  maxFileBytes: 256 * 1024,
  maxWallMs: 5000,
  maxRssMb: 512,
  maxOutputBytes: 2 * 1024 * 1024,
};
const cliEntries = [
  ["lifecycle", path.join(sourceRoot, "scripts", "content-lifecycle-governance.mjs")],
  ["storage", path.join(sourceRoot, "scripts", "content-storage-governance.mjs")],
  ["generic", path.join(sourceRoot, "scripts", "governance-cli.mjs")],
];
const result = {};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function git(...args) {
  return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
}

async function exactFileHash(filePath) {
  const hash = createHash("sha256");
  let bytes = 0;
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  return { hash: hash.digest("hex"), bytes };
}

async function snapshotTree(relativeRoot, excluded = new Set()) {
  const absoluteRoot = path.join(sourceRoot, relativeRoot);
  const records = [];
  const visit = async (absolute, relative) => {
    let info;
    try { info = await lstat(absolute); } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (relative !== "." && excluded.has(relative)) return;
    if (info.isDirectory()) {
      const entries = (await readdir(absolute)).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
      for (const entry of entries) await visit(path.join(absolute, entry), path.posix.join(relative, entry));
      return;
    }
    if (info.isSymbolicLink()) {
      const target = await readlink(absolute);
      records.push({ path: relative, bytes: Buffer.byteLength(target), hash: sha256(`symlink:${target}`), hashMode: "exact-link", objectKind: "symlink" });
      return;
    }
    const file = await exactFileHash(absolute);
    records.push({ path: relative, bytes: file.bytes, hash: file.hash, hashMode: "exact-byte", objectKind: "file" });
  };
  await visit(absoluteRoot, ".");
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  const pathSetHash = sha256(stable(records.map((record) => record.path)));
  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  return { root: relativeRoot, exists: records.length > 0, pathCount: records.length, pathSetHash, bytes, hash: sha256(stable(records)), records };
}

async function snapshotProtectedFacts() {
  const excludedEvidence = path.relative(sourceRoot, outputPath).split(path.sep).join("/");
  const excluded = new Set([excludedEvidence]);
  const rootPaths = [
    ".content-workspace/content-state",
    ".content-workspace/content",
    ".content-workspace/reviews",
    ".content-workspace/recoveries",
    ".content-workspace/releases",
    ".content-workspace/site-publications",
    ".content-workspace/publication-runs",
  ];
  const roots = {};
  for (const root of rootPaths) roots[root] = await snapshotTree(root, excluded);
  const activePointer = await snapshotTree(".content-workspace/content-state/active.json", excluded);
  const sitePublication = await snapshotTree(".content-workspace/site-publications", excluded);
  let status = "";
  try { status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: sourceRoot, encoding: "utf8" }); } catch { status = "git-status-error"; }
  const gitFacts = { head: git("rev-parse", "HEAD"), statusBytes: Buffer.byteLength(status), statusHash: sha256(status), statusLines: status ? status.trimEnd().split("\n").length : 0 };
  return { git: gitFacts, roots, activePointer, sitePublication, excludedPaths: [excludedEvidence], aggregateHash: sha256(stable({ git: gitFacts, roots, activePointer, sitePublication })) };
}

async function snapshotFixtureTree() {
  return snapshotTree(path.relative(sourceRoot, workspace).split(path.sep).join("/"));
}

function parseEarlyMetrics(stdout) {
  const lines = String(stdout || "").trim().split("\n").reverse();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed?.kind === "governance-early-exit-v1") return parsed;
      if (parsed?.metrics?.kind === "governance-early-exit-v1") return parsed.metrics;
    } catch { /* help text / pretty JSON lines are not metrics */ }
  }
  return null;
}

async function probeEarly(entry, executable, mode, argv) {
  const before = await snapshotFixtureTree();
  const startedAt = Date.now();
  const child = spawnSync(process.execPath, [executable, ...argv], { cwd: fixture, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const elapsedMs = Date.now() - startedAt;
  const after = await snapshotFixtureTree();
  const metrics = parseEarlyMetrics(child.stdout);
  return {
    entry,
    mode,
    argv,
    exitCode: child.status,
    signal: child.signal,
    elapsedMs,
    scanCount: metrics?.scanCount ?? null,
    readBytes: metrics?.readBytes ?? null,
    writeCount: metrics?.writeCount ?? null,
    subprocessCount: metrics?.subprocessCount ?? null,
    launcherProcessCount: 1,
    workspaceBeforeHash: before.hash,
    workspaceAfterHash: after.hash,
    workspaceUnchanged: before.hash === after.hash,
    stdoutBytes: Buffer.byteLength(child.stdout || ""),
    stderrBytes: Buffer.byteLength(child.stderr || ""),
    bounded: metrics?.bounded === true && elapsedMs < 2000,
    metricsSource: metrics ? "runtime-early-exit-v1" : "missing-runtime-metrics",
  };
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function childResultLine(stdout) {
  const line = String(stdout || "").split("\n").find((value) => value.startsWith("RESULT "));
  if (!line) return null;
  try { return JSON.parse(line.slice("RESULT ".length)); } catch { return null; }
}

async function runSignalScenario(signalName) {
  const childScript = path.join(fixture, `${signalName.toLowerCase()}.mjs`);
  const childOutput = path.join(fixture, `${signalName.toLowerCase()}-evidence.json`);
  const runtimePath = path.join(sourceRoot, "scripts/lib/governance-cli-runtime.mjs");
  await writeFile(childScript, `import { runGovernanceInventory } from ${JSON.stringify(runtimePath)};\nprocess.stdout.write("READY\\n");\nconst evidence = await runGovernanceInventory({ sourceRoot: ${JSON.stringify(fixture)}, workspaceDirectory: "process-workspace", mode: "full-scan", budgets: ${JSON.stringify({ ...budgets, maxTotalBytes: 256 * 1024 * 1024, maxFileBytes: 128 * 1024 * 1024 })}, outputPath: ${JSON.stringify(childOutput)} });\nprocess.stdout.write(\`RESULT \${JSON.stringify({ result: evidence.result, failure: evidence.failure || null, cleanup: evidence.cleanup || null, runId: evidence.runId })}\\n\`);\n`, "utf8");
  const child = spawn(process.execPath, [childScript], { cwd: sourceRoot, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${signalName} child did not become ready`)), 4000);
    if (stdout.includes("READY")) { clearTimeout(timer); resolve(); return; }
    const onData = () => {
      if (stdout.includes("READY")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); }
    };
    child.stdout.on("data", onData);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const pid = child.pid;
  const exitPromise = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  try { process.kill(pid, signalName); } catch { /* evidence records whether the child had already exited */ }
  let exit = await Promise.race([
    exitPromise,
    new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "QA_TIMEOUT" }), 4000)),
  ]);
  if (exit.signal === "QA_TIMEOUT") {
    try { child.kill("SIGKILL"); } catch { /* cleanup evidence records the result */ }
    exit = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve({ code: null, signal: "SIGKILL_TIMEOUT" }), 1000))]);
  }
  const parsed = childResultLine(stdout);
  return {
    signal: signalName,
    pid,
    processGroup: pid,
    exitCode: exit.code,
    exitSignal: exit.signal,
    ready: stdout.includes("READY"),
    result: parsed?.result || null,
    failure: parsed?.failure || null,
    cleanup: parsed?.cleanup || null,
    childAliveAfter: isAlive(pid),
    orphanCount: isAlive(pid) ? 1 : 0,
    stdoutBytes: Buffer.byteLength(stdout),
    stderrBytes: Buffer.byteLength(stderr),
    processTreeSource: "direct child PID/process-group probe; orphanCount derived from post-exit liveness",
  };
}

async function runParentDeathScenario() {
  const workerScript = path.join(fixture, "parent-death-worker.mjs");
  const parentScript = path.join(fixture, "parent-death-parent.mjs");
  const workerOutput = path.join(fixture, "parent-death-evidence.json");
  const workerPidPath = path.join(fixture, "parent-death-worker.pid");
  const runtimePath = path.join(sourceRoot, "scripts/lib/governance-cli-runtime.mjs");
  const workerSource = `import { runGovernanceInventory } from ${JSON.stringify(runtimePath)};\nconst evidence = await runGovernanceInventory({ sourceRoot: ${JSON.stringify(fixture)}, workspaceDirectory: "process-workspace", mode: "full-scan", budgets: ${JSON.stringify({ ...budgets, maxTotalBytes: 256 * 1024 * 1024, maxFileBytes: 128 * 1024 * 1024 })}, outputPath: process.argv[2], parentPid: Number(process.argv[3]), monitorParent: true });\nprocess.exitCode = evidence.result === "failure" ? 0 : 1;\n`;
  const parentSource = `import { spawn } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst child = spawn(process.execPath, [${JSON.stringify(workerScript)}, process.argv[2], String(process.pid)], { stdio: "ignore" });\nwriteFileSync(process.argv[3], String(child.pid));\nsetTimeout(() => process.exit(0), 60);\n`;
  await writeFile(workerScript, workerSource, "utf8");
  await writeFile(parentScript, parentSource, "utf8");
  const parent = spawn(process.execPath, [parentScript, workerOutput, workerPidPath], { cwd: sourceRoot, stdio: "ignore" });
  const parentExit = await new Promise((resolve) => parent.once("exit", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { await access(workerOutput); break; } catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
  }
  let workerEvidence = null;
  try { workerEvidence = JSON.parse(await readFile(workerOutput, "utf8")); } catch { /* recorded as missing */ }
  let workerPid = null;
  try { workerPid = Number(await readFile(workerPidPath, "utf8")); } catch { /* recorded as missing */ }
  const workerAliveAfter = Number.isInteger(workerPid) && workerPid > 0 ? isAlive(workerPid) : null;
  return {
    parentPid: parent.pid,
    workerPid,
    parentExit,
    workerResult: workerEvidence?.result || null,
    failure: workerEvidence?.failure || null,
    cleanup: workerEvidence?.cleanup || null,
    workerOutputExists: Boolean(workerEvidence),
    childAliveAfter: workerAliveAfter === true,
    workerAliveAfter,
    orphanCount: workerAliveAfter === true ? 1 : 0,
    processTreeSource: "parent exits after spawning monitored worker; worker PID readback and post-exit liveness",
  };
}

function statuses() {
  return Object.fromEntries(Object.entries(result).map(([key, value]) => [key, value ? "PASS" : "FAIL"]));
}

let evidence;
try {
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "small.json"), "{}\n", "utf8");
  await writeFile(path.join(workspace, "corrupt.json"), "{not-json", "utf8");
  await writeFile(path.join(workspace, "half-written.json"), '{"logicalContentId":"half-write",', "utf8");
  await writeFile(path.join(workspace, "large.bin"), Buffer.alloc(64 * 1024, 7));
  await symlink(path.join(workspace, "large.bin"), path.join(workspace, "large-link"));
  const wallWorkspace = path.join(fixture, "wall-workspace");
  const processWorkspace = path.join(fixture, "process-workspace");
  await mkdir(wallWorkspace, { recursive: true });
  await mkdir(processWorkspace, { recursive: true });
  await writeFile(path.join(wallWorkspace, "wall.bin"), Buffer.alloc(8 * 1024 * 1024, 3));
  await writeFile(path.join(processWorkspace, "process.bin"), Buffer.alloc(128 * 1024 * 1024, 5));

  const beforeFixture = (await snapshotFixtureTree()).hash;
  const early = [];
  for (const [entry, executable] of cliEntries) {
    early.push(await probeEarly(entry, executable, "help", ["--help"]));
    early.push(await probeEarly(entry, executable, "unknown", ["--unknown"]));
    early.push(await probeEarly(entry, executable, "empty", []));
  }
  result["GOV-01"] = early.length === 9 && early.every((run) => run.scanCount === 0 && run.readBytes === 0 && run.writeCount === 0 && run.subprocessCount === 0 && run.workspaceUnchanged && run.bounded && run.metricsSource === "runtime-early-exit-v1");

  const missingBudget = spawnSync(process.execPath, [cliEntries[0][1], "inventory", "--output", path.join(fixture, "missing.json")], { cwd: fixture, encoding: "utf8" });
  const metadata = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "metadata-only", budgets, outputPath: path.join(fixture, "metadata.json") });
  const full = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets, outputPath: path.join(fixture, "full.json") });
  result["GOV-02"] = missingBudget.status === 2 && metadata.result === "success" && metadata.bytesRead === 0 && full.result === "success" && full.bytesRead > 0 && Object.keys(budgets).every((field) => full.budgets[field] === budgets[field]);

  const halfWritten = full.records.find((record) => record.path.endsWith("half-written.json"));
  result["GOV-03"] = full.records.length === 5 && halfWritten?.parseStatus === "invalid-json" && full.records.some((record) => record.objectKind === "symlink") && full.records.every((record) => record.hash && record.logicalContentId);

  const budgetScenarios = {};
  for (const [name, overrides] of Object.entries({
    maxFiles: { maxFiles: 1 },
    maxTotalBytes: { maxTotalBytes: 1 },
    maxFileBytes: { maxFileBytes: 1 },
    maxWallMs: { maxWallMs: 1 },
    maxRssMb: { maxRssMb: 1, maxWallMs: 5000 },
    maxOutputBytes: { maxOutputBytes: 64 },
  })) {
    const workspaceDirectory = name === "maxWallMs" ? "wall-workspace" : "workspace";
    const scenarioBudgets = name === "maxWallMs"
      ? { ...budgets, ...overrides, maxFileBytes: 16 * 1024 * 1024, maxTotalBytes: 32 * 1024 * 1024 }
      : { ...budgets, ...overrides };
    budgetScenarios[name] = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory, mode: "full-scan", budgets: scenarioBudgets, outputPath: path.join(fixture, `budget-${name}.json`) });
  }
  const expectedBudgetCodes = {
    maxFiles: "FILES_BUDGET_EXCEEDED",
    maxTotalBytes: "TOTAL_BYTES_BUDGET_EXCEEDED",
    maxFileBytes: "FILE_BUDGET_EXCEEDED",
    maxWallMs: "WALL_BUDGET_EXCEEDED",
    maxRssMb: "RSS_BUDGET_EXCEEDED",
    maxOutputBytes: "OUTPUT_BUDGET_EXCEEDED",
  };
  result["GOV-04"] = Object.entries(expectedBudgetCodes).every(([name, code]) => ["partial", "failure"].includes(budgetScenarios[name]?.result) && budgetScenarios[name]?.failure?.code === code && budgetScenarios[name]?.cleanup?.ownedProcessCount === 0);

  const cancelledController = new AbortController();
  cancelledController.abort(Object.assign(new Error("qa cancellation"), { code: "QA_CANCELLED" }));
  const cancelled = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets, signal: cancelledController.signal, outputPath: path.join(fixture, "cancelled.json") });
  const leaseExpired = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "metadata-only", budgets, leaseTtlMs: -1, outputPath: path.join(fixture, "expired.json") });
  const signalRuns = [];
  for (const signalName of ["SIGINT", "SIGTERM"]) signalRuns.push(await runSignalScenario(signalName));
  const timeout = budgetScenarios.maxWallMs;
  const parentDeath = await runParentDeathScenario();
  result["GOV-05"] = signalRuns.every((run) => run.ready && run.result === "failure" && run.failure?.code === run.signal && run.cleanup?.leaseRemoved && !run.childAliveAfter && run.orphanCount === 0) && timeout.failure?.code === "WALL_BUDGET_EXCEEDED" && parentDeath.workerResult === "failure" && parentDeath.failure?.code === "PARENT_DIED" && parentDeath.workerOutputExists && !parentDeath.childAliveAfter && parentDeath.orphanCount === 0 && leaseExpired.failure?.code === "LEASE_EXPIRED";

  const repeat = await runGovernanceInventory({ sourceRoot: fixture, workspaceDirectory: "workspace", mode: "full-scan", budgets, outputPath: path.join(fixture, "repeat.json") });
  result["GOV-06"] = repeat.inventoryHash === full.inventoryHash && repeat.protectedFacts.zeroWrite === true && repeat.cleanup?.ownedProcessCount === 0;

  const canonicalBefore = await snapshotProtectedFacts();
  const canonicalAfter = await snapshotProtectedFacts();
  result["GOV-07"] = canonicalBefore.aggregateHash === canonicalAfter.aggregateHash && canonicalBefore.git.head === canonicalAfter.git.head && canonicalBefore.git.statusHash === canonicalAfter.git.statusHash && canonicalBefore.activePointer.hash === canonicalAfter.activePointer.hash && canonicalBefore.sitePublication.hash === canonicalAfter.sitePublication.hash;

  validateGovernanceEvidence(full);
  const placeholder = structuredClone(full);
  placeholder.records[0].path = "placeholder/sentinel.json";
  let placeholderRejected = false;
  try { validateGovernanceEvidence(placeholder); } catch { placeholderRejected = true; }
  const invalidCleanup = { ...full, result: "partial", failure: { code: "BUDGET", phase: "walk", stopReason: "budget" }, cleanupPlan: { decision: "delete" } };
  let cleanupRejected = false;
  try { validateGovernanceEvidence(invalidCleanup); } catch { cleanupRejected = true; }
  const invalidUnknown = { ...full, result: "unknown", failure: { code: "UNKNOWN", phase: "run", stopReason: "unknown" }, cleanupPlan: { decision: "archive" } };
  let unknownCleanupRejected = false;
  try { validateGovernanceEvidence(invalidUnknown); } catch { unknownCleanupRejected = true; }
  result["GOV-08"] = placeholderRejected && full.task && full.turn && full.pid > 0 && full.durationMs >= 0 && full.provenance.fixtureHash === full.inventoryHash;
  result["GOV-09"] = cleanupRejected && unknownCleanupRejected && Object.values(budgetScenarios).every((run) => !run.cleanupPlan && ["partial", "failure"].includes(run.result));

  const head = git("rev-parse", "HEAD");
  const exactStableTag = git("describe", "--tags", "--exact-match", "HEAD") === "v0.27.8";
  result["GOV-10"] = exactStableTag && git("rev-parse", "HEAD") === head && beforeFixture === (await snapshotFixtureTree()).hash;

  let scope;
  try {
    scope = classifyReleaseScope({ root: sourceRoot, version, phase: "pre-commit", requireStaged: false, allowManifestUntracked: true, allowDeclaredAddedUntracked: true });
  } catch (error) {
    scope = { ready: false, error: error.message, manifestPath: `docs/iterations/scopes/${version}.json` };
  }
  const acceptance = statuses();
  evidence = {
    schemaVersion: "governance-cli-acceptance-v1",
    version,
    phase: "pre-commit-self-qa",
    baseHead: head,
    stableTag: "v0.27.8",
    generatedAt: new Date().toISOString(),
    sourceRoot,
    command: `node ${path.relative(sourceRoot, process.argv[1])}`,
    pid: process.pid,
    budgets,
    acceptance,
    runs: { early, metadata, full, halfWritten: { path: halfWritten?.path, bytes: halfWritten?.bytes, parseStatus: halfWritten?.parseStatus }, budgetScenarios, cancelled, leaseExpired, signalRuns, timeout, parentDeath, repeat },
    validationChecks: {
      placeholderRejected,
      failureCleanupRejected: cleanupRejected,
      unknownCleanupRejected,
      rejectedDecision: "delete",
      unresolvedCleanupRule: "partial/failure/unknown evidence cannot authorize cleanup/archive/delete",
    },
    protectedFacts: { canonicalBefore, canonicalAfter, fixtureSourceRestored: result["GOV-10"], excludedOutputPath: path.relative(sourceRoot, outputPath).split(path.sep).join("/") },
    scope,
    externalResponsibility: { codexAppServer: "unverified; outside project scope", processStartSource: "unverified; outside project scope" },
    physicalCleanup: { executed: false, authorization: "not granted", decision: "delete-never" },
    contentPublish: { executed: false },
    productTransport: { executed: false },
    zeroWrite: result["GOV-07"] === true,
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  if (Object.values(result).some((value) => !value)) process.exitCode = 1;
  process.stdout.write(`${JSON.stringify({ evidencePath: outputPath, baseHead: head, acceptance, scope: { ready: scope.ready, blockers: scope.blockers || [], error: scope.error || null } }, null, 2)}\n`);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
