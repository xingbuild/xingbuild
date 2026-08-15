#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createLifecycleEvidence, assertLifecycleAcceptance, reduceLifecycleAcceptance, validateLifecycleEvidence } from "./lib/content-lifecycle-evidence.mjs";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { lifecycleEvidencePath } from "./lib/lifecycle-evidence-path.mjs";
import { readScopeManifest } from "./lib/release-scope-classifier.mjs";

const sourceRoot = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const version = `v${packageJson.version}`;
const postCommit = process.argv.includes("--post-commit");
const evidencePath = lifecycleEvidencePath(sourceRoot, version);
const scopeManifest = readScopeManifest(sourceRoot, version);
const excludedExternalPaths = scopeManifest.paths
  .filter((entry) => entry.classification === "excludedExternal")
  .map((entry) => entry.path)
  .sort();
const excludedExternalReason = excludedExternalPaths.length
  ? "tracked paths explicitly classified excludedExternal by the current version scope manifest; owner must resolve before closeout"
  : null;
const allowedPaths = scopeManifest.paths
  .filter((entry) => entry.classification !== "excludedExternal")
  .map((entry) => entry.path)
  .sort();

function git(...args) {
  return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim();
}

let artifact = null;
if (postCommit) {
  artifact = await readProductArtifact({
    clientDirectory: path.join(sourceRoot, "dist", "client"),
    sourceRoot,
    version,
    commit: git("rev-parse", "HEAD"),
  });
}

const evidence = await createLifecycleEvidence({
  sourceRoot,
  allowedPaths,
  excludedExternalPaths,
  excludedExternalReason,
  stage: postCommit ? "post-commit" : "pre-commit",
  artifact,
  version,
  generatedBy: "scripts/content-lifecycle-evidence.mjs",
});
try {
  const manifestPath = path.join(sourceRoot, "docs", "iterations", "scopes", `${version}.json`);
  evidence.scopeManifestPath = path.relative(sourceRoot, manifestPath);
  evidence.scopeManifestDigest = scopeManifest.scopeDigest;
  evidence.scope.scopeManifestPath = evidence.scopeManifestPath;
  // The current scope manifest is attached after the scenario/evidence
  // factory runs; recompute acceptance so C-01 validates the same envelope
  // that the release gate will read, rather than trusting a stale stored PASS.
  evidence.acceptance = reduceLifecycleAcceptance({ evidence });
} catch {
  // Self-QA may run before the tracked scope manifest is materialized.
}
assertLifecycleAcceptance(evidence.acceptance);
validateLifecycleEvidence(evidence, { requirePostCommit: postCommit, expectedVersion: version });
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  evidencePath,
  stage: evidence.stage,
  version,
  baseHead: evidence.baseHead,
  committedHead: evidence.commit,
  scopeDigest: evidence.scopeDigest,
  acceptance: Object.fromEntries(Object.entries(evidence.acceptance).map(([id, result]) => [id, result.status])),
  blockers: Object.entries(evidence.acceptance).filter(([, result]) => result.status === "FAIL").map(([id, result]) => ({ id, reason: result.reason })),
}, null, 2)}\n`);
