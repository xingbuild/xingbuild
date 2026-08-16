#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { classifyReleaseScope } from "./lib/release-scope-classifier.mjs";
import { approvalArgument, assertCommitIdentity, assertTagIdentity, assertArtifactApproval, captureProtectedFacts, gitText, readApprovalRecord } from "./lib/release-transaction.mjs";

const root = process.cwd();
function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function run(command, args, env) { const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env }); if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`); }
function assertFinalIdentity(approval, version) {
  if (git("branch", "--show-current") !== "main") throw new Error("final release build requires canonical main"); const head = git("rev-parse", "HEAD"); if (git("describe", "--tags", "--exact-match", "HEAD") !== version) throw new Error("final release build requires exact version tag");
  assertCommitIdentity({ root, approval, commit: head }); assertTagIdentity({ root, approval, tag: version, commit: head }); return { head, tag: version, treeOid: git("rev-parse", "HEAD^{tree}") };
}
export async function buildFinalProductArtifact({ sourceRoot = root, approvalPath = approvalArgument() } = {}) {
  if (path.resolve(sourceRoot) !== path.resolve(root)) throw new Error("final release build must run in canonical root");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); const version = `v${packageJson.version}`; const approval = await readApprovalRecord(root, version, approvalPath, { requireCurrentIdentity: false, allowTagRecovery: true }); const identity = assertFinalIdentity(approval, version);
  const current = await readFile(path.join(root, "docs/iterations/current.md"), "utf8"); if (!current.includes(`当前唯一版本：\`${version}\``)) throw new Error(`current.md does not identify ${version}`);
  const protectedBefore = captureProtectedFacts(root);
  const artifactPrefix = `${protectedBefore.allowedRoot.root}/${version}-${identity.head.slice(0, 12)}/`;
  if (protectedBefore.allowedRoot.records.some((record) => `${protectedBefore.allowedRoot.root}/${record.path}`.startsWith(artifactPrefix))) throw new Error("ProductArtifact target already exists in protected baseline");
  run("npm", ["run", "release:prepare"], process.env);
  run("npm", ["run", "build"], { ...process.env, XINGBUILD_FINAL_BUILD: "1", XINGBUILD_CONTENT_RUNTIME: "1", XINGBUILD_PRODUCT_VERSION: version, XINGBUILD_PRODUCT_COMMIT: identity.head, XINGBUILD_APPROVAL_HASH: approval.approvalHash, XINGBUILD_CANDIDATE_HASH: approval.candidateHash, XINGBUILD_APPROVED_TREE_OID: approval.approvedTreeOid });
  const artifact = await readProductArtifact({ clientDirectory: path.join(root, "dist", "client"), sourceRoot: root, version, commit: identity.head }); assertArtifactApproval(artifact, approval);
  const scope = JSON.parse(readFileSync(path.join(root, `docs/iterations/scopes/${version}.json`), "utf8")); const postScopePath = path.join(root, ".content-workspace", "qa", version, "release-scope-postcommit.json"); await mkdir(path.dirname(postScopePath), { recursive: true });
  await writeFile(postScopePath, `${JSON.stringify({ schemaVersion: "release-scope-postcommit-v2", phase: "post-commit", version, committedHead: identity.head, baseHead: approval.baseHead, scopeDigest: scope.scopeDigest, approvalHash: approval.approvalHash, candidateHash: approval.candidateHash, approvedTreeOid: approval.approvedTreeOid, productArtifactId: artifact.productArtifactId, productArtifactHash: artifact.productArtifactHash, baseSiteArtifactId: artifact.baseSiteArtifactId }, null, 2)}\n`);
  const scopeResult = classifyReleaseScope({ root, version, phase: "post-commit", requireStaged: false, allowManifestUntracked: false, approvalIdentity: approval }); if (!scopeResult.ready) throw new Error(`final release build left scope dirty: ${scopeResult.blockers.join("; ")}`);
  return { version, head: identity.head, tag: identity.tag, treeOid: identity.treeOid, artifact, approvalHash: approval.approvalHash, candidateHash: approval.candidateHash, approvedTreeOid: approval.approvedTreeOid, protectedBaseline: captureProtectedFacts(root) };
}
try { const result = await buildFinalProductArtifact(); console.log(JSON.stringify({ version: result.version, commit: result.head, tag: result.tag, productArtifactId: result.artifact.productArtifactId, productArtifactHash: result.artifact.productArtifactHash, baseSiteArtifactId: result.artifact.baseSiteArtifactId, approvalHash: result.approvalHash }, null, 2)); } catch (error) { console.error(`最终 ProductArtifact 构建已停止：${error.message}`); process.exitCode = 1; }
