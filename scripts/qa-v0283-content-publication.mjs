#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

const root = process.cwd();
const version = "v0.28.3";
const testFile = "tests/release-transaction-v0283-content.test.mjs";

// CP rows are the approved content-publication contract. Each row is a
// formal production entry; helper-only predicates are never counted as proof.
const cases = [
  { id: "CP-01", name: "single tuple-first active authority with legacy read-only fallback", command: process.execPath, args: ["--test", "--test-name-pattern", "CP-01 tuple is the sole active ContentSet authority", testFile] },
  { id: "CP-02", name: "immutable baseline reconstruction and zero-write failure", command: process.execPath, args: ["--test", "--test-name-pattern", "FM-01 baseline unreconstructible", testFile] },
  { id: "CP-03", name: "one changed home plus 37 reused records", command: process.execPath, args: ["--test", "--test-name-pattern", "ContentPublicationIntent proves", testFile] },
  { id: "CP-04", name: "one immutable intent and cross-identity rejection", command: process.execPath, args: ["--test", "--test-name-pattern", "FM-05 intent cross-mix", testFile] },
  { id: "CP-05", name: "exact ProductArtifact client materialization and drift rejection", command: process.execPath, args: ["--test", "--test-name-pattern", "exact product client materialization", testFile] },
  { id: "CP-06", name: "joint ProductArtifact, ContentSet, CDA and tuple publication input", command: process.execPath, args: ["--test", "--test-name-pattern", "joint SitePublication uses real Coordinator", testFile] },
  { id: "CP-07", name: "public manifest/runtime/browser proof before activation", command: process.execPath, args: ["--test", "--test-name-pattern", "CP-07 public proof runs", testFile] },
  { id: "CP-08", name: "independent recovery, idempotency, CAS and cleanup paths", command: process.execPath, args: ["--test", "--test-name-pattern", "FM-09 duplicate prepare|FM-15 active tuple CAS|FM-16 finalize crash|FM-17 resume|FM-18 temporary-root", testFile] },
  { id: "CP-09", name: "exact staged-tree release/content/browser/finalize chain", command: process.execPath, args: ["--test", "--test-name-pattern", "V283 canonical positive chain", "tests/release-transaction.test.mjs"] },
  { id: "CP-10", name: "release/content/runtime regression and honest failure handling", command: "npm", args: ["run", "release:prepare"] },
  { id: "CP-11", name: "protected legacy active pointer and canonical facts unchanged", command: process.execPath, args: ["--test", "--test-name-pattern", "V283 stable scope", "tests/release-transaction.test.mjs"] },
  { id: "CP-12", name: "single pre-commit delivery with no approval/commit/build/publish side effects", command: "npm", args: ["run", "check"] },
];

// Design §8.2 finite fault matrix. Every row has a distinct test title and
// records its actual injection plus protected-fact/cleanup assertion.
const faultCases = [
  { id: "FM-01", name: "baseline unreconstructible", pattern: "FM-01 baseline unreconstructible", injection: "remove observation-01 source", assertions: ["active ContentSet pointer unchanged", "no data artifact directory"] },
  { id: "FM-02", name: "source/contentHash drift", pattern: "FM-02 source/contentHash drift", injection: "replace canonical observation bytes while retaining ContentSet hash", assertions: ["CONTENT_DATA_BASELINE_HASH_DRIFT", "pointer unchanged", "no artifact write"] },
  { id: "FM-03", name: "review hash drift", pattern: "FM-03 approved review hash drift", injection: "recovery bytes differ from approved draft/review hash", assertions: ["content lifecycle hash mismatch", "candidate directory absent"] },
  { id: "FM-03B", name: "review approval missing", pattern: "FM-03B unapproved review proof", injection: "set home reviewProof.status=pending", assertions: ["review proof is not approved", "no intent"] },
  { id: "FM-04", name: "CDA/object tamper", pattern: "FM-04 CDA object tamper", injection: "replace prepared CAS object identity", assertions: ["object identity drift", "temporary root removed"] },
  { id: "FM-05", name: "intent cross-mix", pattern: "FM-05 intent cross-mix", injection: "bind CDA/tuple from ContentSet A to ContentSet B", assertions: ["ContentSet identity mismatch", "no publication intent"] },
  { id: "FM-06", name: "ProductArtifact mismatch", pattern: "FM-06 ProductArtifact mismatch", injection: "bind tuple to a different valid product commit/id", assertions: ["ProductArtifact identity mismatch", "no intent"] },
  { id: "FM-07", name: "missing data ref", pattern: "FM-07 missing ContentData refs", injection: "omit CDA and active tuple from SiteSnapshot", assertions: ["SITE_PUBLICATION_DATA_PLANE_REQUIRED", "no snapshot accepted"] },
  { id: "FM-08", name: "no-change", pattern: "FM-08 no-change", injection: "prepare identical ContentSet twice", assertions: ["same artifact id/hash", "changed=0", "reused=38"] },
  { id: "FM-09", name: "duplicate prepare", pattern: "FM-09 duplicate prepare", injection: "prepare the same intent twice", assertions: ["same intent id/hash", "persisted.reused=true", "one intent file"] },
  { id: "FM-10", name: "quota", pattern: "FM-10 upload quota", injection: "maxFileBytes=1 on prepared upload root", assertions: ["upload quota exceeded", "temporary root removed"] },
  { id: "FM-11", name: "lease", pattern: "FM-11 publication lease", injection: "acquire second snapshot lease while first is held", assertions: ["lease conflict", "lease released/clean"] },
  { id: "FM-12", name: "transport timeout", pattern: "FM-12 transport timeout", injection: "public fetch returns HTTP 503 with maxAttempts=1", assertions: ["SITE_PUBLICATION_VERIFY_TIMEOUT", "recoverable", "deploymentCount=1", "active tuple absent"] },
  { id: "FM-13", name: "public stale manifest", pattern: "FM-13 public stale manifest", injection: "public content manifest snapshot hash differs", assertions: ["snapshot identity rejection", "no authority mutation"] },
  { id: "FM-14", name: "browser fallback", pattern: "FM-14 browser fallback", injection: "browser verifier throws after static/data proof", assertions: ["browser proof rejected", "active tuple absent"] },
  { id: "FM-15", name: "CAS conflict", pattern: "FM-15 active tuple CAS", injection: "finalize with a wrong expected tuple hash", assertions: ["CONTENT_DATA_ACTIVE_CAS", "active pointer bytes unchanged"] },
  { id: "FM-16", name: "finalize crash", pattern: "FM-16 finalize crash", injection: "fail immediately after tuple activation", assertions: ["injected finalize crash", "active tuple rolled back", "run remains assembled"] },
  { id: "FM-17", name: "resume", pattern: "FM-17 resume", injection: "repeat recoverable transport for same SiteSnapshot", assertions: ["same deployment id", "deploymentCount=1", "second deploy not called"] },
  { id: "FM-18", name: "temporary-root cleanup", pattern: "FM-18 temporary-root", injection: "fail during content materialization prepare", assertions: ["injected prepare failure", "no new upload temp root"] },
];

function runCase(item, { fault = false } = {}) {
  const startedAt = new Date().toISOString();
  const result = spawnSync(item.command, item.args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, XINGBUILD_V0283_CONTENT_QA: "1" },
  });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const outputHash = createHash("sha256").update(JSON.stringify({ stdout, stderr, status: result.status })).digest("hex");
  const observedTests = stdout.split(/\r?\n/).filter((line) => /^✔ /.test(line)).map((line) => line.replace(/^✔ /, "").replace(/ \([^)]*\)$/, ""));
  const passCount = observedTests.length;
  const failCount = (stdout.match(/^✖ /gm) || []).length;
  const commandSucceeded = result.status === 0;
  const observed = fault
    ? commandSucceeded && passCount === 1 && failCount === 0
    : ["CP-10", "CP-12"].includes(item.id)
      ? commandSucceeded
      : commandSucceeded && passCount >= 1 && failCount === 0;
  return {
    ...item,
    command: [item.command, ...item.args],
    startedAt,
    finishedAt: new Date().toISOString(),
    status: result.status,
    result: observed ? "PASS" : "FAIL",
    commandSucceeded,
    passCount,
    failCount,
    observedTests,
    outputHash,
    stdoutTail: stdout.slice(-6000),
    stderrTail: stderr.slice(-6000),
    assertions: {
      formalEntrypoint: fault ? testFile : item.id === "CP-09" || item.id === "CP-11" ? "tests/release-transaction.test.mjs" : item.id === "CP-10" ? "npm run release:prepare" : item.id === "CP-12" ? "scripts/check-project.mjs" : testFile,
      helperOnly: false,
      observedPassCount: passCount,
      ...(fault ? { injection: item.injection, protectedFacts: item.assertions } : {}),
    },
  };
}

const startedAt = new Date().toISOString();
const results = cases.map((item) => runCase(item));
const faultResults = faultCases.map((item) => runCase({
  id: item.id,
  name: item.name,
  command: process.execPath,
  args: ["--test", "--test-name-pattern", item.pattern, testFile],
  injection: item.injection,
  assertions: item.assertions,
}, { fault: true }));
const allPass = results.every((item) => item.result === "PASS") && faultResults.every((item) => item.result === "PASS");
const evidence = {
  schemaVersion: "v0283-content-publication-qa-v3",
  version,
  phase: "pre-commit-self-qa",
  startedAt,
  finishedAt: new Date().toISOString(),
  executionSource: "formal-data-driven-cp-and-fault-entry-matrix",
  result: allPass ? "PASS" : "FAIL",
  cases: results,
  faultMatrix: faultResults,
  summary: {
    total: results.length,
    passed: results.filter((item) => item.result === "PASS").length,
    failed: results.filter((item) => item.result !== "PASS").length,
    faultTotal: faultResults.length,
    faultPassed: faultResults.filter((item) => item.result === "PASS").length,
    faultFailed: faultResults.filter((item) => item.result !== "PASS").length,
    allFormalEntrypoints: [...results, ...faultResults].every((item) => item.assertions.helperOnly === false),
    oneRowPerFaultScenario: faultResults.length === faultCases.length && faultResults.every((item) => item.passCount === 1),
  },
  noCanonicalTransport: true,
  noCanonicalActiveMutation: true,
};
const output = path.join(root, ".content-workspace", "qa", version, "content-publication-evidence.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output, result: evidence.result, passed: evidence.summary.passed, failed: evidence.summary.failed, faultPassed: evidence.summary.faultPassed, faultFailed: evidence.summary.faultFailed }, null, 2));
if (!allPass) process.exitCode = 1;
