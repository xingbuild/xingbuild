#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createLifecycleEvidence, assertLifecycleAcceptance, validateLifecycleEvidence } from "./lib/content-lifecycle-evidence.mjs";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { lifecycleEvidencePath } from "./lib/lifecycle-evidence-path.mjs";

const sourceRoot = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
const version = `v${packageJson.version}`;
const postCommit = process.argv.includes("--post-commit");
const evidencePath = lifecycleEvidencePath(sourceRoot, version);
const allowedPaths = [
  "VERSION.md",
  "package.json",
  "package-lock.json",
  "docs/iterations/current.md",
  `docs/design/v0.27.8 版本无关生命周期evidence 门禁方案.md`,
  `docs/iterations/history/${version}.md`,
  `docs/iterations/scopes/${version}.json`,
  "scripts/check-project.mjs",
  "scripts/release-build.mjs",
  "scripts/release-closeout-check.mjs",
  "scripts/release-preflight.mjs",
  "scripts/lib/content-lifecycle-evidence-v0275.mjs",
  "scripts/lib/content-lifecycle-evidence.mjs",
  "scripts/lib/lifecycle-evidence-path.mjs",
  "scripts/content-lifecycle-evidence.mjs",
  "tests/v0278-lifecycle-evidence.test.mjs",
];
const excludedExternalPaths = ["AGENTS.md", "docs/rules/task-onboarding.md", "docs/rules/00-baseline-index.md", "docs/rules/collaboration-workflow.md", "docs/rules/engineering-architecture-and-principles.md", "docs/rules/iteration-and-release.md", "docs/rules/responsibility-and-workflows.md", "docs/rules/xing-workstyle-and-context.md"];
const excludedExternalReason = "pre-existing external workflow discussion; excluded by Xing v0.27.8 boundary";

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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  evidence.scopeManifestPath = path.relative(sourceRoot, manifestPath);
  evidence.scopeManifestDigest = manifest.scopeDigest;
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
