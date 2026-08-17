#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const version = "v0.28.4";
const qaRoot = path.join(root, ".content-workspace", "qa", version);
const baselinePath = path.join(root, ".content-workspace", "qa", "v0.28.3", "test-sites-classification.json");

function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, ...extraEnv },
  });
  return { command, args, status: result.status, signal: result.signal, stdout: result.stdout || "", stderr: result.stderr || "" };
}

function outputHash(result) {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function normalizeTitle(value) { return value.replace(/ \([0-9]+(?:\.[0-9]+)?ms\)$/, "").trim(); }
function parseSummary(output) {
  const match = output.match(/tests ([0-9]+)\n.*?pass ([0-9]+)\n.*?fail ([0-9]+)\n.*?cancelled ([0-9]+)\n.*?skipped ([0-9]+)/s);
  return match ? { total: Number(match[1]), pass: Number(match[2]), fail: Number(match[3]), cancelled: Number(match[4]), skipped: Number(match[5]) } : null;
}
function parseFailures(output) {
  return [...new Set([...output.matchAll(/^✖ ([^\n]+)$/gm)].map((match) => normalizeTitle(match[1])).filter((title) => title && title !== "failing tests:" && !title.startsWith("tests ")))].sort();
}

let baseline = null;
let baselineBytes = null;
try {
  baselineBytes = await readFile(baselinePath);
  baseline = JSON.parse(baselineBytes.toString("utf8"));
} catch (error) {
  throw new Error(`v0.28.3 retained test-sites baseline is required: ${error.message}`);
}
const retainedB = new Set(baseline.classification?.B?.tests || baseline.failures?.filter((item) => item.classification === "B").map((item) => item.title) || []);

const testSites = run("npm", ["run", "test:sites"]);
const testOutput = `${testSites.stdout}\n${testSites.stderr}`;
const summary = parseSummary(testOutput);
const failures = parseFailures(testOutput);
const environmentFailure = !summary || testSites.status == null;
const classified = failures.map((title) => ({
  title,
  classification: retainedB.has(title) ? "B" : "C",
  reason: retainedB.has(title)
    ? "retained baseline failure reproduced in the fresh v0.28.4 run; retained as failure, never promoted to PASS"
    : "failure is absent from the retained baseline and is therefore a changed implementation regression",
}));

const direct = run(process.execPath, [
  "--test",
  "tests/release-transaction.test.mjs",
  "tests/release-transaction-v0283-content.test.mjs",
  "tests/release-transaction-v0284-runtime.test.mjs",
  "tests/product-artifact-identity.test.mjs",
  "tests/content-compatibility.test.mjs",
  "tests/v0280-content-data-plane.test.mjs",
  "tests/site-publication-coordinator.test.mjs",
]);
const directSummary = parseSummary(`${direct.stdout}\n${direct.stderr}`);
const unknownFailures = classified.filter((item) => item.classification === "C");
const result = environmentFailure || unknownFailures.length || direct.status !== 0 ? "C_CHANGED_REGRESSION" : "PASS_WITH_RETAINED_B";
const evidence = {
  schemaVersion: "v0.28.4-test-sites-classification-v1",
  version,
  command: ["npm", "run", "test:sites"],
  result,
  runLog: ".content-workspace/qa/v0.28.4/test-sites.log",
  outputHash: outputHash(testSites),
  summary,
  failures: classified,
  classification: {
    A: { count: environmentFailure ? 1 : 0, tests: environmentFailure ? failures : [], reason: environmentFailure ? "test command did not produce a complete machine summary" : "fresh host run produced a complete machine summary" },
    B: { count: classified.filter((item) => item.classification === "B").length, tests: classified.filter((item) => item.classification === "B").map((item) => item.title), reason: "retained failures remain visible as failures and are not counted as passes" },
    C: { count: unknownFailures.length, tests: unknownFailures.map((item) => item.title), reason: "changed implementation failures block candidate" },
  },
  directRegression: {
    commands: [direct.command, ...direct.args],
    result: direct.status === 0 ? "PASS" : "FAIL",
    summary: directSummary,
    outputHash: outputHash(direct),
  },
  baselineReference: { path: ".content-workspace/qa/v0.28.3/test-sites-classification.json", sha256: createHash("sha256").update(baselineBytes).digest("hex"), retainedCount: retainedB.size },
  gate: { CZero: !environmentFailure && unknownFailures.length === 0 && direct.status === 0, productTransport: false, contentPublish: false, edgeOne: false },
};
await mkdir(qaRoot, { recursive: true });
await writeFile(path.join(qaRoot, "test-sites.log"), testOutput);
await writeFile(path.join(qaRoot, "test-sites-classification.json"), `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify(evidence, null, 2));
if (result !== "PASS_WITH_RETAINED_B") process.exitCode = 1;
