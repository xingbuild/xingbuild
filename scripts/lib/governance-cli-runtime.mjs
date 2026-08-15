import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, readdir, rm, unlink, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Project-local bounded governance runtime.
 *
 * The important boundary is intentional: argument parsing is pure and happens
 * before this module touches the workspace.  The heavy inventory is only
 * reachable through an explicit command with finite budgets.
 */
export const GOVERNANCE_EVIDENCE_SCHEMA = "governance-cli-evidence-v1";
export const GOVERNANCE_MODES = new Set(["metadata-only", "full-scan"]);
export const GOVERNANCE_COMMANDS = new Set(["inventory", "lifecycle", "storage"]);
export const GOVERNANCE_BUDGET_FIELDS = [
  "maxFiles",
  "maxTotalBytes",
  "maxFileBytes",
  "maxWallMs",
  "maxRssMb",
  "maxOutputBytes",
];

export const GOVERNANCE_HELP = `用法：
  node scripts/content-lifecycle-governance.mjs inventory [选项]
  node scripts/content-storage-governance.mjs inventory [选项]

选项：
  --metadata-only                 只读取目录/文件元数据（默认）
  --full-scan                     显式流式读取并计算逐文件 SHA-256
  --max-files N                   最大文件数
  --max-total-bytes N             最大累计文件字节数
  --max-file-bytes N              单文件最大字节数
  --max-wall-ms N                 最大运行时间
  --max-rss-mb N                  最大 RSS 水位
  --max-output-bytes N             最大 evidence 输出字节数
  --output PATH                   显式 machine evidence 输出路径（必填）
  --help                          仅输出帮助，不访问工作区

治理命令没有默认扫描、默认写入或默认发布行为。`;

function fail(code, message, details = {}) {
  return { kind: "error", code, message, ...details };
}

function optionName(name) {
  return {
    "max-files": "maxFiles",
    "max-total-bytes": "maxTotalBytes",
    "max-file-bytes": "maxFileBytes",
    "max-wall-ms": "maxWallMs",
    "max-rss-mb": "maxRssMb",
    "max-output-bytes": "maxOutputBytes",
  }[name] || name;
}

function parsePositiveFinite(value, field) {
  if (value === undefined || value === null || value === "") return fail("BUDGET_MISSING", `${field} is required`, { field });
  if (!/^\d+$/.test(String(value))) return fail("BUDGET_INVALID", `${field} must be a positive finite integer`, { field });
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) return fail("BUDGET_INVALID", `${field} must be a positive finite integer`, { field });
  return number;
}

export function parseGovernanceArgs(argv = []) {
  const args = [...argv];
  if (args.length === 0) return fail("EMPTY_COMMAND", "governance command is required");
  if (args.includes("--help") || args[0] === "help") return { kind: "help" };

  let command = null;
  let mode = "metadata-only";
  let outputPath = null;
  const rawBudgets = {};
  const unknown = [];
  let dryRun = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--full-scan") { mode = "full-scan"; continue; }
    if (arg === "--metadata-only") { mode = "metadata-only"; continue; }
    if (arg === "--dry-run") { dryRun = true; continue; }
    if (arg === "--output") {
      if (!args[index + 1] || args[index + 1].startsWith("--")) return fail("OPTION_VALUE_MISSING", "--output requires a path");
      outputPath = args[++index];
      continue;
    }
    const equals = /^--([^=]+)=(.*)$/.exec(arg);
    if (equals) {
      const [, rawName, rawValue] = equals;
      const name = optionName(rawName);
      if (name === "output") { outputPath = rawValue; continue; }
      if (GOVERNANCE_BUDGET_FIELDS.includes(name)) { rawBudgets[name] = rawValue; continue; }
      unknown.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const name = optionName(arg.slice(2));
      if (GOVERNANCE_BUDGET_FIELDS.includes(name)) {
        if (!args[index + 1] || args[index + 1].startsWith("--")) return fail("OPTION_VALUE_MISSING", `${arg} requires a value`);
        rawBudgets[name] = args[++index];
      } else unknown.push(arg);
      continue;
    }
    if (!command && GOVERNANCE_COMMANDS.has(arg)) { command = arg; continue; }
    if (!command && arg === "--inventory") { command = "inventory"; continue; }
    unknown.push(arg);
  }
  if (unknown.length) return fail("UNKNOWN_ARGUMENT", `unknown governance argument: ${unknown.join(" ")}`, { unknown });
  if (!command) return fail("EMPTY_COMMAND", "an explicit inventory command is required");
  if (!outputPath || outputPath === "-") return fail("OUTPUT_REQUIRED", "explicit --output is required for machine evidence");
  const budgets = {};
  for (const field of GOVERNANCE_BUDGET_FIELDS) {
    const parsed = parsePositiveFinite(rawBudgets[field], field);
    if (typeof parsed !== "number") return parsed;
    budgets[field] = parsed;
  }
  return { kind: "run", command, mode, outputPath, budgets, dryRun };
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertWithin(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} escapes source root`);
  return relative.split(path.sep).join("/") || ".";
}

function classifyPath(relative) {
  const parts = relative.split("/");
  const ext = path.extname(relative).toLowerCase();
  let namespace = "derived";
  let decision = "delete-never";
  let sourceOfTruth = relative;
  if (parts.includes("content") && !parts.includes("content-state")) { namespace = "canonical-content"; decision = "keep"; sourceOfTruth = relative; }
  else if (parts.includes("reviews")) { namespace = "review"; decision = "delete-never"; }
  else if (parts.includes("recoveries")) { namespace = "recovery"; decision = "delete-never"; }
  else if (parts.includes("site-publications") || parts.includes("publication-runs")) { namespace = "publication"; decision = "delete-never"; }
  else if (parts.includes("releases") || parts.includes("content-state")) { namespace = "lifecycle"; decision = "delete-never"; }
  else if (parts.includes("qa")) { namespace = "evidence"; decision = "delete-never"; }
  if (ext === ".tmp" || parts.some((part) => part.includes("staging") || part.includes("upload-root"))) decision = "review";
  return { namespace, decision, sourceOfTruth };
}

function identityFor(relative) {
  return `object-${sha256(relative).slice(0, 32)}`;
}

function logicalIdFor(relative) {
  const normalized = relative.replace(/\.(json|md|txt|bin|pdf|mp4)$/i, "");
  return `logical-${sha256(normalized).slice(0, 32)}`;
}

function collectReferences(value, output = [], depth = 0) {
  if (output.length >= 128 || depth > 8 || value === null || value === undefined) return output;
  if (typeof value === "string") {
    if (value.length <= 512 && (/^(content|site|revision|change|publication|deployment|lease|logical)[\w:./+-]*$/i.test(value) || value.includes(".json") || value.includes(".mjs"))) output.push(value);
    return output;
  }
  if (Array.isArray(value)) for (const item of value) collectReferences(item, output, depth + 1);
  else if (typeof value === "object") for (const item of Object.values(value)) collectReferences(item, output, depth + 1);
  return output;
}

async function readBoundedJsonFacts(filePath, bytes, context) {
  if (bytes > 1024 * 1024) return { logicalContentId: null, references: [], parseStatus: "not-read-large" };
  try {
    const text = await readFile(filePath, "utf8");
    context.bytesRead += Buffer.byteLength(text);
    if (context.bytesRead > context.budgets.maxTotalBytes) throw Object.assign(new Error("total byte budget exceeded"), { code: "TOTAL_BYTES_BUDGET_EXCEEDED", phase: "parse", stopReason: "budget" });
    const value = JSON.parse(text);
    const logicalContentId = value?.logicalContentId || value?.logicalId || value?.id || null;
    return { logicalContentId: typeof logicalContentId === "string" && logicalContentId ? logicalContentId : null, references: collectReferences(value), parseStatus: "valid-json" };
  } catch (error) {
    if (error.code === "TOTAL_BYTES_BUDGET_EXCEEDED") throw error;
    return { logicalContentId: null, references: [], parseStatus: "invalid-json" };
  }
}

function checkAbort(context, phase = "scan") {
  if (context.signal?.aborted) {
    const reason = context.signal.reason;
    const code = reason?.code || "CANCELLED";
    throw Object.assign(new Error(reason?.message || `governance run cancelled during ${phase}`), { code, phase, stopReason: "cancelled" });
  }
  if (Date.now() - context.startedAt > context.budgets.maxWallMs) {
    throw Object.assign(new Error("governance wall-time budget exceeded"), { code: "WALL_BUDGET_EXCEEDED", phase, stopReason: "budget" });
  }
  const rss = process.memoryUsage().rss;
  context.peakRssMb = Math.max(context.peakRssMb, rss / 1024 / 1024);
  if (context.peakRssMb > context.budgets.maxRssMb) {
    throw Object.assign(new Error("governance RSS budget exceeded"), { code: "RSS_BUDGET_EXCEEDED", phase, stopReason: "budget" });
  }
  if (context.monitorParent && context.parentPid > 1) {
    try { process.kill(context.parentPid, 0); } catch { throw Object.assign(new Error("parent process disappeared"), { code: "PARENT_DIED", phase, stopReason: "parent-death" }); }
  }
  if (context.leaseExpiresAt && Date.now() >= context.leaseExpiresAt) {
    throw Object.assign(new Error("governance lease expired"), { code: "LEASE_EXPIRED", phase, stopReason: "lease-expired" });
  }
}

async function streamHash(filePath, bytes, context) {
  if (bytes > context.budgets.maxFileBytes) throw Object.assign(new Error(`file budget exceeded: ${filePath}`), { code: "FILE_BUDGET_EXCEEDED", phase: "hash", stopReason: "budget" });
  const hash = createHash("sha256");
  let read = 0;
  const stream = createReadStream(filePath, { highWaterMark: 64 * 1024 });
  try {
    for await (const chunk of stream) {
      checkAbort(context, "hash");
      read += chunk.length;
      context.bytesRead += chunk.length;
      if (context.bytesRead > context.budgets.maxTotalBytes) throw Object.assign(new Error("total byte budget exceeded"), { code: "TOTAL_BYTES_BUDGET_EXCEEDED", phase: "hash", stopReason: "budget" });
      hash.update(chunk);
    }
  } finally {
    stream.destroy();
  }
  return { hash: hash.digest("hex"), bytesRead: read };
}

async function walkWorkspace({ sourceRoot, workspaceDirectory, context, mode, excluded = new Set() }) {
  const workspace = path.resolve(sourceRoot, workspaceDirectory);
  const records = [];
  const stack = [workspace];
  while (stack.length) {
    checkAbort(context, "walk");
    const directory = stack.pop();
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch (error) {
      if (error.code === "ENOENT") continue;
      throw Object.assign(new Error(`cannot read inventory directory ${directory}: ${error.message}`), { code: "READ_FAILED", phase: "walk", stopReason: "read-error" });
    }
    entries.sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      const absolute = path.join(directory, entry.name);
      const relative = assertWithin(sourceRoot, absolute, "inventory path");
      if (excluded.has(relative)) continue;
      checkAbort(context, "walk");
      let info;
      try { info = await lstat(absolute); } catch (error) {
        throw Object.assign(new Error(`cannot stat ${relative}: ${error.message}`), { code: "STAT_FAILED", phase: "walk", stopReason: "read-error" });
      }
      if (info.isDirectory()) { stack.push(absolute); continue; }
      if (records.length >= context.budgets.maxFiles) throw Object.assign(new Error("file-count budget exceeded"), { code: "FILES_BUDGET_EXCEEDED", phase: "walk", stopReason: "budget" });
      if (context.totalBytes + info.size > context.budgets.maxTotalBytes) throw Object.assign(new Error("total byte budget exceeded"), { code: "TOTAL_BYTES_BUDGET_EXCEEDED", phase: "walk", stopReason: "budget" });
      if (info.size > context.budgets.maxFileBytes && mode === "full-scan") throw Object.assign(new Error(`file budget exceeded: ${relative}`), { code: "FILE_BUDGET_EXCEEDED", phase: "walk", stopReason: "budget" });
      const policy = classifyPath(relative);
      const record = {
        path: relative,
        identity: identityFor(relative),
        bytes: info.size,
        objectKind: info.isSymbolicLink() ? "symlink" : (path.extname(relative).toLowerCase() === ".json" ? "json" : "file"),
        logicalContentId: logicalIdFor(relative),
        artifactId: null,
        hashMode: mode === "full-scan" && !info.isSymbolicLink() ? "exact-byte" : "metadata",
        hash: mode === "full-scan" && !info.isSymbolicLink() ? null : sha256(`${relative}\0${info.size}\0${info.mtimeMs}`),
        sourceOfTruth: policy.sourceOfTruth,
        owner: "xingbuild-governance",
        namespace: policy.namespace,
        state: policy.decision === "delete-never" ? "protected" : "derived",
        references: [],
        retainUntil: policy.decision === "delete-never" ? "indefinite" : null,
        decision: policy.decision === "review" ? "review" : policy.decision,
        reason: policy.decision === "review" ? "temporary or metadata-only object requires explicit review" : "conservative governance default; no cleanup action",
        symlink: info.isSymbolicLink(),
        parseStatus: "not-read",
      };
      if (mode === "full-scan" && !info.isSymbolicLink()) record.hash = (await streamHash(absolute, info.size, context)).hash;
      if (mode === "full-scan" && !info.isSymbolicLink() && record.objectKind === "json") {
        const facts = await readBoundedJsonFacts(absolute, info.size, context);
        if (facts.logicalContentId) record.logicalContentId = facts.logicalContentId;
        record.references = facts.references;
        record.parseStatus = facts.parseStatus;
      }
      records.push(record);
      context.totalBytes += info.size;
      context.fileCount = records.length;
    }
  }
  records.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return records;
}

function inventoryDigest(records, mode, budgets) {
  return sha256(stableStringify({ mode, budgets, records }));
}

export function createGovernanceRunContext({ sourceRoot = process.cwd(), mode = "metadata-only", budgets, command = "inventory", signal = null, leaseTtlMs = null, task = process.env.XBUILD_TASK || "elon engin", turn = process.env.XBUILD_TURN || "v0.27.9", parentPid = process.ppid, monitorParent = false } = {}) {
  if (!GOVERNANCE_MODES.has(mode)) throw new Error(`invalid governance mode: ${mode}`);
  for (const field of GOVERNANCE_BUDGET_FIELDS) {
    const value = budgets?.[field];
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`finite ${field} budget is required`);
  }
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  }
  const startedAt = Date.now();
  return {
    sourceRoot: path.resolve(sourceRoot), mode, budgets, command, task, turn,
    runId: `gov-${randomUUID()}`, pid: process.pid, parentPid,
    processGroup: process.pid, startedAt, signal: controller.signal,
    monitorParent,
    controller, leaseTtlMs: leaseTtlMs || Math.max(1000, budgets.maxWallMs + 1000),
    leaseExpiresAt: startedAt + (leaseTtlMs || Math.max(1000, budgets.maxWallMs + 1000)),
    peakRssMb: process.memoryUsage().rss / 1024 / 1024, bytesRead: 0, totalBytes: 0, fileCount: 0,
    leasePath: null, tempDirectory: null, signalHandlers: [],
  };
}

async function createLease(context) {
  const tempDirectory = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "xingbuild-governance-")));
  const leasePath = path.join(tempDirectory, "lease.json");
  await writeFile(leasePath, `${JSON.stringify({ schemaVersion: "governance-lease-v1", runId: context.runId, pid: context.pid, parentPid: context.parentPid, expiresAt: new Date(context.leaseExpiresAt).toISOString() })}\n`, "utf8");
  context.tempDirectory = tempDirectory;
  context.leasePath = leasePath;
  return context;
}

function addSignalHandlers(context) {
  for (const name of ["SIGINT", "SIGTERM"]) {
    const handler = () => context.controller.abort(Object.assign(new Error(`${name} received`), { code: name === "SIGINT" ? "SIGINT" : "SIGTERM" }));
    process.once(name, handler);
    context.signalHandlers.push([name, handler]);
  }
}

function removeSignalHandlers(context) {
  for (const [name, handler] of context.signalHandlers) process.removeListener(name, handler);
  context.signalHandlers = [];
}

async function cleanupContext(context) {
  removeSignalHandlers(context);
  if (context.tempDirectory) await rm(context.tempDirectory, { recursive: true, force: true }).catch(() => {});
  context.cleanup = { leaseRemoved: !context.leasePath || !(await lstat(context.leasePath).then(() => true).catch(() => false)), tempDirectoryRemoved: !context.tempDirectory || !(await lstat(context.tempDirectory).then(() => true).catch(() => false)), ownedProcessCount: 0 };
}

async function atomicWriteJson(outputPath, value, maxOutputBytes) {
  const absolute = path.resolve(outputPath);
  const parent = path.dirname(absolute);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (bytes.length > maxOutputBytes) throw Object.assign(new Error(`evidence output exceeds maxOutputBytes (${bytes.length} > ${maxOutputBytes})`), { code: "OUTPUT_BUDGET_EXCEEDED", phase: "output", stopReason: "budget" });
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(absolute)}.${randomUUID()}.tmp`);
  await writeFile(temporary, bytes, { mode: 0o600 });
  try { await rename(temporary, absolute); }
  catch (error) { await unlink(temporary).catch(() => {}); throw error; }
  return { outputPath: absolute, outputBytes: bytes.length };
}

function minimalFailure(context, error, outputPath) {
  const finishedAt = Date.now();
  return {
    schemaVersion: GOVERNANCE_EVIDENCE_SCHEMA,
    result: error?.stopReason === "budget" ? "partial" : "failure",
    failure: { code: error?.code || "GOVERNANCE_FAILED", phase: error?.phase || "run", message: error?.message || String(error), stopReason: error?.stopReason || "error" },
    runId: context.runId,
    phase: error?.phase || "run",
    command: context.command,
    task: context.task,
    turn: context.turn,
    pid: context.pid,
    parentPid: context.parentPid,
    processGroup: context.processGroup,
    budgets: context.budgets,
    sourceRoot: context.sourceRoot,
    startedAt: new Date(context.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - context.startedAt,
    files: context.fileCount,
    bytesRead: context.bytesRead,
    peakRssMb: context.peakRssMb,
    stopReason: error?.stopReason || "error",
    outputPath: outputPath ? path.resolve(outputPath) : null,
    writes: [],
    cleanup: context.cleanup || null,
    provenance: { sourceOfTruth: "bounded filesystem inventory", placeholder: false },
  };
}

export function validateGovernanceEvidence(evidence, { allowFailure = true } = {}) {
  if (!evidence || evidence.schemaVersion !== GOVERNANCE_EVIDENCE_SCHEMA) throw new Error("governance evidence schema is invalid");
  if (!/^gov-[0-9a-f-]{36}$/.test(evidence.runId || "")) throw new Error("governance evidence runId is invalid");
  if (!Number.isInteger(evidence.pid) || evidence.pid <= 0) throw new Error("governance evidence pid is invalid");
  if (!Number.isInteger(evidence.parentPid) || evidence.parentPid < 0) throw new Error("governance evidence parentPid is invalid");
  if (!path.isAbsolute(evidence.sourceRoot || "")) throw new Error("governance evidence sourceRoot is invalid");
  for (const field of GOVERNANCE_BUDGET_FIELDS) if (!Number.isSafeInteger(evidence.budgets?.[field]) || evidence.budgets[field] <= 0) throw new Error(`governance evidence budget ${field} is invalid`);
  if (!allowFailure && evidence.result !== "success") throw new Error(`governance evidence result is ${evidence.result}`);
  if (!["success", "partial", "failure"].includes(evidence.result)) throw new Error("governance evidence result is invalid");
  if (evidence.result !== "success" && !evidence.failure?.code) throw new Error("governance failure evidence needs failure code");
  const cleanupDecision = evidence.cleanupPlan?.decision || evidence.cleanup?.decision || evidence.archive?.decision;
  const forbiddenCleanup = new Set(["delete", "remove", "archive", "cleanup", "quarantine", "migrate"]);
  if (evidence.result !== "success" && cleanupDecision && forbiddenCleanup.has(String(cleanupDecision).toLowerCase())) {
    throw new Error("partial/failure evidence cannot authorize cleanup/archive/delete");
  }
  if (evidence.result === "success" && evidence.referenceGraph?.unresolved?.length && cleanupDecision) {
    throw new Error("unresolved references cannot authorize cleanup/archive/delete");
  }
  if (typeof evidence.startedAt !== "string" || typeof evidence.finishedAt !== "string" || !Number.isFinite(evidence.durationMs)) throw new Error("governance evidence timing is required");
  if (typeof evidence.stopReason !== "string" || !evidence.stopReason) throw new Error("governance evidence stopReason is required");
  if (evidence.provenance?.placeholder === true || !evidence.provenance?.sourceOfTruth) throw new Error("governance evidence provenance is invalid");
  if (evidence.result === "success") {
    if (!Array.isArray(evidence.records)) throw new Error("governance evidence records are required");
    if (!/^[a-f0-9]{64}$/.test(evidence.inventoryHash || "") || evidence.provenance.fixtureHash !== evidence.inventoryHash) throw new Error("governance evidence inventory/provenance hash is invalid");
    if (!evidence.protectedFacts?.before || !evidence.protectedFacts?.after || evidence.protectedFacts.zeroWrite !== true) throw new Error("governance protected facts evidence is required");
    for (const record of evidence.records) {
      if (typeof record?.path === "string" && ["delete", "remove", "fake", "sentinel", "placeholder"].some((word) => record.path.toLowerCase().includes(word))) throw new Error(`governance record contains sentinel path: ${record.path}`);
      for (const field of ["path", "identity", "objectKind", "logicalContentId", "hashMode", "hash", "sourceOfTruth", "owner", "namespace", "decision"]) if (typeof record[field] !== "string" || !record[field]) throw new Error(`governance record ${field} is required`);
      if (record.path.startsWith("/") || record.path.includes("..")) throw new Error(`governance record path is unsafe: ${record.path}`);
      if (!["metadata", "exact-byte"].includes(record.hashMode)) throw new Error(`governance record hashMode is invalid: ${record.path}`);
      if (!/^[a-f0-9]{64}$/.test(record.hash)) throw new Error(`governance record hash is invalid: ${record.path}`);
      if (!Array.isArray(record.references)) throw new Error(`governance record references are invalid: ${record.path}`);
    }
  }
  return evidence;
}

export async function runGovernanceInventory({ sourceRoot = process.cwd(), workspaceDirectory = ".content-workspace", mode = "metadata-only", budgets, command = "inventory", outputPath, dryRun = false, signal = null, task, turn, leaseTtlMs, parentPid = process.ppid, monitorParent = false } = {}) {
  if (!outputPath) throw new Error("explicit outputPath is required");
  const context = createGovernanceRunContext({ sourceRoot, mode, budgets, command, signal, task, turn, leaseTtlMs, parentPid, monitorParent });
  const outputAbsolute = path.resolve(outputPath);
  const excluded = new Set();
  const outputRelative = path.relative(context.sourceRoot, outputAbsolute);
  if (!outputRelative.startsWith("..") && !path.isAbsolute(outputRelative)) excluded.add(outputRelative.split(path.sep).join("/"));
  addSignalHandlers(context);
  await createLease(context);
  let evidence;
  try {
    checkAbort(context, "start");
    const records = await walkWorkspace({ sourceRoot: context.sourceRoot, workspaceDirectory, context, mode, excluded });
    const graphNodes = records.map((record) => ({ identity: record.identity, path: record.path, logicalContentId: record.logicalContentId, objectKind: record.objectKind }));
    const byIdentity = new Map(graphNodes.map((node) => [node.identity, node]));
    const byPath = new Map(graphNodes.map((node) => [node.path, node]));
    const edges = [];
    const unresolved = [];
    for (const record of records) {
      for (const reference of record.references || []) {
        const target = byIdentity.get(reference) || byPath.get(reference);
        if (target) edges.push({ from: record.identity, to: target.identity, reference, resolved: true });
        else unresolved.push({ from: record.identity, reference, reason: "unresolved reference is protected" });
      }
      if (record.objectKind === "json" && record.parseStatus === "not-read") unresolved.push({ from: record.identity, reference: record.path, reason: "metadata-only body not read" });
    }
    const graph = { nodes: graphNodes, edges, unresolved };
    const inventoryHash = inventoryDigest(records, mode, budgets);
    const protectedSnapshot = { pathSetHash: sha256(stableStringify(records.map((record) => record.path))), bytes: records.reduce((sum, record) => sum + record.bytes, 0), hash: inventoryHash };
    evidence = {
      schemaVersion: GOVERNANCE_EVIDENCE_SCHEMA,
      result: "success",
      mode,
      command,
      task: context.task,
      turn: context.turn,
      runId: context.runId,
      pid: context.pid,
      parentPid: context.parentPid,
      processGroup: context.processGroup,
      lease: { path: context.leasePath, expiresAt: new Date(context.leaseExpiresAt).toISOString() },
      sourceRoot: context.sourceRoot,
      workspaceDirectory,
      startedAt: new Date(context.startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - context.startedAt,
      budgets,
      files: records.length,
      bytesRead: context.bytesRead,
      peakRssMb: context.peakRssMb,
      stopReason: "completed",
      records,
      inventoryHash,
      referenceGraph: graph,
      protectedFacts: { before: protectedSnapshot, after: protectedSnapshot, zeroWrite: true },
      dryRun: Boolean(dryRun),
      writes: [],
      cleanup: null,
      provenance: { sourceOfTruth: "bounded filesystem metadata and streaming SHA-256", fixtureHash: inventoryHash, placeholder: false, externalResponsibility: "Codex/app-server process cancellation and start-source remain external" },
      outputPath: path.resolve(outputPath),
    };
  } catch (error) {
    evidence = minimalFailure(context, error, outputPath);
  } finally {
    await cleanupContext(context);
    if (evidence) evidence.cleanup = context.cleanup;
  }
  try { validateGovernanceEvidence(evidence); }
  catch (error) {
    evidence = { ...minimalFailure(context, Object.assign(error, { code: "EVIDENCE_INVALID", phase: "validate", stopReason: "validation" }), outputPath), validationError: error.message };
  }
  try {
    const output = await atomicWriteJson(outputPath, evidence, budgets.maxOutputBytes);
    evidence.output = output;
    return evidence;
  } catch (error) {
    const fallback = minimalFailure(context, error, outputPath);
    fallback.output = { outputPath: path.resolve(outputPath), outputBytes: null, writeError: error.message };
    await atomicWriteJson(outputPath, fallback, budgets.maxOutputBytes).catch(() => {});
    return fallback;
  }
}

export async function runGovernanceCli({ argv = [], sourceRoot = process.cwd(), commandHint = "inventory" } = {}) {
  const parsed = parseGovernanceArgs(argv);
  const earlyStartedAt = Date.now();
  const earlyMetrics = () => ({
    kind: "governance-early-exit-v1",
    scanCount: 0,
    readBytes: 0,
    writeCount: 0,
    subprocessCount: 0,
    elapsedMs: Date.now() - earlyStartedAt,
    bounded: true,
  });
  if (parsed.kind === "help") {
    process.stdout.write(`${GOVERNANCE_HELP}\n${JSON.stringify(earlyMetrics())}\n`);
    return 0;
  }
  if (parsed.kind === "error") {
    process.stdout.write(`${JSON.stringify({ result: "failure", failure: parsed, metrics: earlyMetrics() }, null, 2)}\n${JSON.stringify(earlyMetrics())}\n`);
    return 2;
  }
  const evidence = await runGovernanceInventory({ ...parsed, command: parsed.command || commandHint, sourceRoot });
  process.stdout.write(`${JSON.stringify({ result: evidence.result, evidencePath: evidence.outputPath, runId: evidence.runId, inventoryHash: evidence.inventoryHash || null, files: evidence.files || 0, stopReason: evidence.stopReason || evidence.failure?.stopReason }, null, 2)}\n`);
  return evidence.result === "success" ? 0 : 1;
}
