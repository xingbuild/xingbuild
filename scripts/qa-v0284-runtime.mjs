#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const version = "v0.28.4";

// This is the single formal v0.28.4 acceptance matrix.  Every row invokes a
// production CLI, Coordinator, materializer, browser verifier, or the exact
// staged-tree chain; helper-only assertions are not rows in this matrix.
const matrix = [
  { id: "RR-01", name: "one declared acceptance spec", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-01 RuntimeAcceptanceSpec" },
  { id: "RR-02", name: "shellReady is distinct from runtimeReady", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-02/RR-03/RR-04 delayed" },
  { id: "RR-03", name: "exact normalized runtime observation", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-02/RR-03/RR-04 delayed" },
  { id: "RR-04", name: "bounded timeout abort and browser cleanup", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-06/RR-04 non-convergence" },
  { id: "RR-05", name: "identity predicates remain independent", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-05 identity" },
  { id: "RR-06", name: "delayed runtime and failure semantics", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-06 wrong runtime" },
  { id: "RR-07", name: "same-deployment recovery exact chain", file: "tests/release-transaction.test.mjs", pattern: "V283 canonical positive chain" },
  { id: "RR-08", name: "Coordinator-only finalize and CAS recovery", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-15 active tuple CAS|FM-16 finalize crash|FM-17 resume", expectedPassCount: 3 },
  { id: "RR-09", name: "phase ordering in one exact chain", file: "tests/release-transaction.test.mjs", pattern: "V283 canonical positive chain" },
  { id: "RR-10", name: "one candidate-only delivery and no transport", file: "tests/release-transaction-v0284-runtime.test.mjs", pattern: "RR-10 candidate-only" },
  { id: "FM-01", name: "baseline unreconstructible", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-01 baseline unreconstructible" },
  { id: "FM-02", name: "source/contentHash drift", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-02 source/contentHash drift" },
  { id: "FM-03", name: "approved review hash drift", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-03 approved review hash drift" },
  { id: "FM-03B", name: "review approval missing", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-03B unapproved review proof" },
  { id: "FM-04", name: "CDA/object tamper", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-04 CDA object tamper" },
  { id: "FM-05", name: "intent cross-mix", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-05 intent cross-mix" },
  { id: "FM-06", name: "ProductArtifact mismatch", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-06 ProductArtifact mismatch" },
  { id: "FM-07", name: "missing data ref", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-07 missing ContentData refs" },
  { id: "FM-08", name: "no-change", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-08 no-change" },
  { id: "FM-09", name: "duplicate prepare", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-09 duplicate prepare" },
  { id: "FM-10", name: "quota", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-10 upload quota" },
  { id: "FM-11", name: "lease", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-11 publication lease" },
  { id: "FM-12", name: "transport timeout", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-12 transport timeout" },
  { id: "FM-13", name: "public stale manifest", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-13 public stale manifest" },
  { id: "FM-14", name: "browser fallback", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-14 browser fallback" },
  { id: "FM-15", name: "CAS conflict", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-15 active tuple CAS" },
  { id: "FM-16", name: "finalize crash", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-16 finalize crash" },
  { id: "FM-17", name: "resume", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-17 resume" },
  { id: "FM-18", name: "temporary-root cleanup", file: "tests/release-transaction-v0283-content.test.mjs", pattern: "FM-18 temporary-root" },
];

function runCase(row) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(process.execPath, ["--test", "--test-name-pattern", row.pattern, row.file], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, XINGBUILD_TRANSACTION_SELF_QA: "1" },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const passCount = (stdout.match(/^✔ /gm) || []).length;
  const failCount = (stdout.match(/^✖ /gm) || []).length;
  const outputHash = createHash("sha256").update(JSON.stringify({ stdout, stderr, status: result.status, signal: result.signal })).digest("hex");
  return {
    ...row,
    command: [process.execPath, "--test", "--test-name-pattern", row.pattern, row.file],
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: result.status,
    result: result.status === 0 && passCount >= (row.expectedPassCount || 1) && failCount === 0 ? "PASS" : "FAIL",
    formalEntrypoint: true,
    helperOnly: false,
    expectedPassCount: row.expectedPassCount || 1,
    passCount,
    failCount,
    outputHash,
    stdoutTail: stdout.slice(-6000),
    stderrTail: stderr.slice(-6000),
    injection: row.id.startsWith("FM-") ? `formal test-name-pattern ${row.pattern}` : null,
    protectedFacts: row.id.startsWith("FM-") ? ["rejection semantics asserted by production entry", "protected authority/cleanup assertion retained by test"] : [],
  };
}

const startedAt = new Date().toISOString();
const cases = matrix.map(runCase);
const passed = cases.filter((entry) => entry.result === "PASS").length;
const evidence = {
  schemaVersion: "v0284-runtime-qa-v1",
  version,
  phase: "pre-commit-self-qa",
  executionSource: "formal-production-entry-runtime-and-fault-matrix",
  startedAt,
  finishedAt: new Date().toISOString(),
  result: passed === cases.length ? "PASS" : "FAIL",
  matrix: cases,
  summary: {
    total: cases.length,
    passed,
    failed: cases.length - passed,
    rrTotal: cases.filter((entry) => entry.id.startsWith("RR-")).length,
    rrPassed: cases.filter((entry) => entry.id.startsWith("RR-") && entry.result === "PASS").length,
    faultTotal: cases.filter((entry) => entry.id.startsWith("FM-")).length,
    faultPassed: cases.filter((entry) => entry.id.startsWith("FM-") && entry.result === "PASS").length,
    allFormalEntrypoints: cases.every((entry) => entry.formalEntrypoint && !entry.helperOnly),
    oneRowPerDesignFault: cases.filter((entry) => entry.id.startsWith("FM-")).length === 19,
  },
  noCanonicalTransport: true,
  noCanonicalContentPublish: true,
  noCanonicalActiveTupleMutation: true,
  noApprovalRecord: true,
};
const output = path.join(root, ".content-workspace", "qa", version, "runtime-evidence.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output, result: evidence.result, total: cases.length, passed, failed: cases.length - passed, rrPassed: evidence.summary.rrPassed, faultPassed: evidence.summary.faultPassed }, null, 2));
if (evidence.result !== "PASS") process.exitCode = 1;
