#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { classifyReleaseScope } from "./lib/release-scope-classifier.mjs";
import { createReleaseClosureReport, readReleaseClosureReport, validateReleaseClosureReport, writeReleaseClosureReport } from "./lib/release-closure-evidence.mjs";
import { assertArtifactApproval, assertCommitIdentity, assertTagIdentity, readApprovalRecord } from "./lib/release-transaction.mjs";
import { readQaBrowserInstallPolicyEvidence } from "./lib/qa-browser-install-policy.mjs";

const root = process.cwd(); const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); const version = `v${packageJson.version}`; await readQaBrowserInstallPolicyEvidence({ root, version }); const approval = await readApprovalRecord(root, version, null, { requireCurrentIdentity: false, allowTagRecovery: true }); const head = git("rev-parse", "HEAD");
if (git("branch", "--show-current") !== "main" || git("describe", "--tags", "--exact-match", head) !== version) throw new Error("release preflight requires exact main/tag");
assertCommitIdentity({ root, approval, commit: head }); assertTagIdentity({ root, approval, tag: version, commit: head });
const artifact = await readProductArtifact({ clientDirectory: path.join(root, "dist", "client"), sourceRoot: root, version, commit: head }); assertArtifactApproval(artifact, approval);
const scope = classifyReleaseScope({ root, version, phase: "post-commit", requireStaged: false, allowManifestUntracked: false, approvalIdentity: approval }); if (!scope.ready) throw new Error(`release scope is not clean: ${scope.blockers.join("; ")}`);
const existingClosurePath = path.join(root, ".content-workspace", "qa", version, "closure-report.json");
if (existsSync(existingClosurePath)) {
  const existing = await readReleaseClosureReport(root, version);
  validateReleaseClosureReport(existing, { root, version, approval, artifact, commit: head, tag: version });
}
const closure = createReleaseClosureReport({ root, version, approval, artifact, tag: version, scopeEvidencePath: path.join(root, ".content-workspace", "qa", version, "release-scope-postcommit.json") }); validateReleaseClosureReport(closure, { root, version, approval, artifact, commit: head, tag: version }); const closurePath = await writeReleaseClosureReport(root, version, closure);
console.log(`发布前置检查通过：${version}`); console.log(JSON.stringify({ version, commit: head, tag: version, approvalHash: approval.approvalHash, productArtifactId: artifact.productArtifactId, productArtifactHash: artifact.productArtifactHash, closurePath, invariants: closure.invariants }, null, 2));
