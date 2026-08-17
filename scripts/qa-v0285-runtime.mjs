#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";
import { withQaBrowserSession } from "./lib/qa-browser-runtime.mjs";
import { verifyPublicBrowserRuntime } from "./lib/publication-runtime.mjs";

const root = process.cwd();
const version = "v0.28.5";

function fixtureHtml() {
  return "<!doctype html><html><head><title>xingbuild QA</title></head><body><div id=\"root\"><main><h1>QA browser batch</h1></main></div></body></html>";
}

async function serveFixture() {
  const server = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(fixtureHtml());
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}/` };
}

const fixture = await serveFixture();
let manifestPath = null;
let scenarios = [];
let failure = null;
try {
  await withQaBrowserSession({ puppeteer, taskId: "v0285-runtime-batch", timeoutMs: 120000 }, async ({ runtime, run }) => {
    manifestPath = runtime.manifestPath;
    for (const [id, routes] of [["BR-01", ["/", "/products"]], ["BR-02", ["/about"]]]) {
      const startedAt = new Date().toISOString();
      try {
        const result = await verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes, taskId: `v0285-${id}`, timeoutMs: 30000 });
        const outputHash = createHash("sha256").update(JSON.stringify(result)).digest("hex");
        scenarios.push({ id, routes, result: "PASS", outputHash, evidence: result });
      } catch (error) {
        const output = { code: error.code || "QA_BROWSER_BATCH_FAILED", message: error.message, runtimeEvidence: error.runtimeEvidence || null };
        scenarios.push({ id, routes, result: "FAIL", outputHash: createHash("sha256").update(JSON.stringify(output)).digest("hex"), error: output });
        throw error;
      } finally {
        scenarios.at(-1).startedAt = startedAt;
        scenarios.at(-1).finishedAt = new Date().toISOString();
      }
    }
    return run;
  });
} catch (error) {
  failure = error;
} finally {
  await new Promise((resolve) => fixture.server.close(resolve));
}

const runManifest = manifestPath ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
const manifest = runManifest?.resources || null;
const evidence = {
  schemaVersion: "v0285-runtime-qa-v1",
  version,
  phase: "pre-commit-self-qa",
  executionSource: "single-production-browser-session",
  result: failure ? "FAIL" : "PASS",
  scenarios,
  browser: {
    ...(manifest || {}),
    exitState: runManifest?.exitState || null,
    cleanup: runManifest?.cleanup || null,
    browserPid: runManifest?.browserPid || null,
    deadlineAt: runManifest?.deadlineAt || null,
    required: { browserLaunchCount: 1, peakContextCount: 1, activeContextCount: 0, browserCommandCount: 0 },
    observed: manifest,
  },
  noCanonicalTransport: true,
  noCanonicalContentPublish: true,
  noCanonicalActiveTupleMutation: true,
  noApprovalRecord: true,
  failure: failure ? { code: failure.code || "QA_BROWSER_BATCH_FAILED", message: failure.message } : null,
};
const output = path.join(root, ".content-workspace", "qa", version, "runtime-evidence.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(JSON.stringify({ output, result: evidence.result, scenarios: scenarios.length, browser: manifest }, null, 2));
if (evidence.result !== "PASS") process.exitCode = 1;
