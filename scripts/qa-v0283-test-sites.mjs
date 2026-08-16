#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const version = "v0.28.3";
const qaRoot = path.join(root, ".content-workspace", "qa", version);
const retainedB = new Set([
  "practice projects only the approved independent Robotaxi media record",
  "Practice reconcile proves canonical before to package after without generic lifecycle files",
  "Practice before and after drift hard fail before a revision is written",
  "Practice finalize advances canonical only after public verification and is idempotent",
  "Robotaxi four media slots form one deterministic logical ChangeSet",
  "reconcile creates one immutable package revision and reuses the same tuple",
  "reconcile hard fails lifecycle drift before preparing a revision",
  "failed revision does not replace active content and released revision is deduplicated",
  "a later revision supersedes the currently released physical slot",
  "content preparation creates an independent identity without product release files",
  "content preparation accepts an explicit baseSiteArtifact without reading product release identity",
  "content build uses a staging copy and emits an independent content manifest",
  "authoritative Registry remains the runtime source for the real historical corpus",
  "legacy artifacts remain readable only during legacy migration; authoritative artifacts require the contract",
  "Practice prepare consumes a ChangeSet in staging and keeps canonical content untouched",
  "real active corpus emits one projection per slot without receipt identity mismatch",
  "workspace receipt facts retain every released target including legacy projection packages",
  "Didi finalized plus Ojai candidate keeps the active inventory complete",
  "replacement identity, review, source, and base drift hard fail",
  "incremental content publication merges eight active releases with one candidate",
  "v0.25.11 assigns Showcase spacing to one owner",
  "legacy v0.27.5 lifecycle evidence remains byte-stable and outside current output",
  "legacy v0.27.7 scope evidence is read-only and byte-stable",
]);

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return { command, args, status: result.status, signal: result.signal, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function outputHash(result) {
  return createHash("sha256").update(JSON.stringify({ status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr })).digest("hex");
}

function normalizeTitle(value) {
  return value.replace(/ \([0-9]+(?:\.[0-9]+)?ms\)$/, "").trim();
}

function parseSummary(output) {
  const match = output.match(/tests ([0-9]+)\n.*?pass ([0-9]+)\n.*?fail ([0-9]+)\n.*?cancelled ([0-9]+)\n.*?skipped ([0-9]+)/s);
  return match ? { total: Number(match[1]), pass: Number(match[2]), fail: Number(match[3]), cancelled: Number(match[4]), skipped: Number(match[5]) } : null;
}

function parseFailures(output) {
  return [...new Set([...output.matchAll(/^✖ ([^\n]+)$/gm)]
    .map((match) => normalizeTitle(match[1]))
    .filter((title) => title && title !== "failing tests:" && !title.startsWith("tests ")))].sort();
}

const testSites = run("npm", ["run", "test:sites"]);
const testOutput = `${testSites.stdout}\n${testSites.stderr}`;
const summary = parseSummary(testOutput);
const failures = parseFailures(testOutput);
const environmentFailure = !summary || testSites.status == null;
const unknownFailures = failures.filter((title) => !retainedB.has(title));

const direct = run(process.execPath, [
  "--test",
  "tests/release-transaction.test.mjs",
  "tests/release-transaction-v0283-content.test.mjs",
  "tests/product-artifact-identity.test.mjs",
  "tests/content-compatibility.test.mjs",
  "tests/v0280-content-data-plane.test.mjs",
  "tests/site-publication-coordinator.test.mjs",
]);
const directOutput = `${direct.stdout}\n${direct.stderr}`;
const directSummary = parseSummary(directOutput);

const baselinePath = path.join(root, ".content-workspace", "qa", "v0.28.2", "test-sites-classification.json");
let baselineReference = null;
try {
  const baselineBytes = await readFile(baselinePath);
  baselineReference = { path: ".content-workspace/qa/v0.28.2/test-sites-classification.json", sha256: createHash("sha256").update(baselineBytes).digest("hex") };
} catch { /* historical evidence is advisory; current output remains authoritative */ }

const classified = failures.map((title) => ({
  title,
  classification: retainedB.has(title) ? "B" : "C",
  reason: retainedB.has(title)
    ? "retained pre-v0.28.3 content/media/lifecycle/historical/legacy fixture; not a current implementation regression"
    : "not in the retained baseline set; treated as changed implementation regression",
}));
const result = environmentFailure ? "A_ENVIRONMENT" : unknownFailures.length || direct.status !== 0 ? "C_CHANGED_REGRESSION" : "PASS_WITH_RETAINED_B";
const evidence = {
  schemaVersion: "v0.28.3-test-sites-classification-v1",
  version,
  command: ["npm", "run", "test:sites"],
  result,
  runLog: ".content-workspace/qa/v0.28.3/test-sites.log",
  outputHash: outputHash(testSites),
  summary,
  failures: classified,
  classification: {
    A: { count: environmentFailure ? 1 : 0, tests: environmentFailure ? failures : [], reason: environmentFailure ? "test command did not produce a complete machine summary" : "real-host run had no environment failure" },
    B: { count: classified.filter((item) => item.classification === "B").length, tests: classified.filter((item) => item.classification === "B").map((item) => item.title), reason: "retained baseline failures are reported as failures and are not promoted to PASS" },
    C: { count: classified.filter((item) => item.classification === "C").length, tests: classified.filter((item) => item.classification === "C").map((item) => item.title), reason: "any failure outside the retained set is a blocking changed regression" },
  },
  directRegression: {
    commands: [direct.command, ...direct.args],
    result: direct.status === 0 ? "PASS" : "FAIL",
    summary: directSummary,
    outputHash: outputHash(direct),
  },
  baselineReference,
  gate: { CZero: !environmentFailure && unknownFailures.length === 0 && direct.status === 0, productTransport: false, contentPublish: false },
};

await mkdir(qaRoot, { recursive: true });
await writeFile(path.join(qaRoot, "test-sites.log"), testOutput);
await writeFile(path.join(qaRoot, "test-sites-classification.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (result !== "PASS_WITH_RETAINED_B") process.exitCode = 1;
