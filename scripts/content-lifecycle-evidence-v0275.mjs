#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createLifecycleEvidence, assertLifecycleAcceptance, validateLifecycleEvidence } from "./lib/content-lifecycle-evidence-v0275.mjs";
import { readProductArtifact } from "./lib/product-artifact.mjs";

const sourceRoot = process.cwd();
const evidencePath = path.join(sourceRoot, ".content-workspace", "qa", "v0275-lifecycle-evidence", "evidence.json");
const allowedPaths = [
  "VERSION.md",
  "package.json",
  "package-lock.json",
  "docs/iterations/current.md",
  "docs/iterations/history/v0.27.5.md",
  "docs/iterations/history/candidates/XBUILD-CONTENT-STORAGE-EVIDENCE-CORRECTION-003.md",
  "docs/design/v0.27.5 内容生命周期证据与发布门禁纠偏方案.md",
  "scripts/lib/content-lifecycle-evidence-v0275.mjs",
  "scripts/content-lifecycle-evidence-v0275.mjs",
  "tests/v0275-content-lifecycle-evidence.test.mjs",
  "scripts/check-project.mjs",
  "scripts/release-build.mjs",
  "scripts/release-closeout-check.mjs",
  "scripts/release-preflight.mjs",
];
const excludedExternalPaths = [
  "AGENTS.md",
  "docs/rules/00-baseline-index.md",
  "docs/rules/collaboration-workflow.md",
  "docs/rules/engineering-architecture-and-principles.md",
  "docs/rules/iteration-and-release.md",
  "docs/rules/responsibility-and-workflows.md",
  "docs/rules/task-onboarding.md",
  "docs/rules/xing-workstyle-and-context.md",
];
const excludedExternalReason = "pre-existing external workflow discussion; excluded by Xing v0.27.5 boundary";

const postCommit = process.argv.includes("--post-commit");
let artifact = null;
if (postCommit) {
  const packageJson = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const commit = (await import("node:child_process")).execFileSync("git", ["rev-parse", "HEAD"], { cwd: sourceRoot, encoding: "utf8" }).trim();
  artifact = await readProductArtifact({ clientDirectory: path.join(sourceRoot, "dist", "client"), sourceRoot, version: `v${packageJson.version}`, commit });
}
const evidence = await createLifecycleEvidence({ sourceRoot, allowedPaths, excludedExternalPaths, excludedExternalReason, stage: postCommit ? "post-commit" : "pre-commit", artifact });
assertLifecycleAcceptance(evidence.acceptance);
validateLifecycleEvidence(evidence);
await mkdir(path.dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  evidencePath,
  stage: evidence.stage,
  baseHead: evidence.baseHead,
  scopeDigest: evidence.scopeDigest,
  fixtureRunId: evidence.fixture.runId,
  acceptance: Object.fromEntries(Object.entries(evidence.acceptance).map(([id, result]) => [id, result.status])),
  blockers: Object.entries(evidence.acceptance).filter(([, result]) => result.status === "FAIL").map(([id, result]) => ({ id, reason: result.reason })),
  forbiddenActions: { commit: true, tag: true, build: true, preflight: true, transport: true, contentPublish: true },
}, null, 2)}\n`);
