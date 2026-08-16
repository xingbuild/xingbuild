#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { classifyReleaseScope, readScopeManifest } from "./lib/release-scope-classifier.mjs";
import { captureProtectedFacts, readApprovalRecord, readCandidateIdentity, stagedTreeOid, workingIdentity } from "./lib/release-transaction.mjs";
import { checkApproval, checkPlan, checkPrecommit } from "./lib/release-invariants.mjs";
import { readQaBrowserInstallPolicyEvidence } from "./lib/qa-browser-install-policy.mjs";

const root = process.cwd(); const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); const version = `v${packageJson.version}`;
await readQaBrowserInstallPolicyEvidence({ root, version });
const candidate = await readCandidateIdentity(root, version, { requireCurrentIdentity: true }); const approval = await readApprovalRecord(root, version, null, { requireCurrentIdentity: true });
const scope = classifyReleaseScope({ root, version, phase: "pre-commit", requireStaged: true, allowManifestUntracked: false }); const before = captureProtectedFacts(root); const current = workingIdentity(root);
if (!scope.ready) throw new Error(`release scope is not ready: ${scope.blockers.join("; ")}`);
if (stagedTreeOid(root) !== approval.approvedTreeOid || candidate.candidateHash !== approval.candidateHash) throw new Error("ApprovalRecord does not bind current staged tree/candidate");
if (before.hash !== candidate.protectedBaselineHash) throw new Error("approved SideEffectBaseline is not current");
if (current.worktreeDiffHash !== requireEmptyHash()) throw new Error("approved tree has unstaged drift");
const results = [checkPlan({ root, version, baseHead: candidate.baseHead, scope: readScopeManifest(root, version), git: { head: candidate.baseHead } }), checkApproval({ root, approval, candidate }), checkPrecommit({ approval, candidate, git: { treeOid: stagedTreeOid(root), working: current }, protectedBefore: before, protectedAfter: before })];
const failed = results.filter((entry) => entry.result !== "PASS"); if (failed.length) throw new Error(`release closeout invariant failure: ${JSON.stringify(failed)}`);
console.log(`版本收口就绪：${version}，ApprovalRecord、staged tree、scope 与 protected baseline exact`); console.log(JSON.stringify({ version, treeOid: candidate.treeOid, candidateHash: candidate.candidateHash, approvalHash: approval.approvalHash, scopeDigest: candidate.scopeDigest, invariants: results }, null, 2));
function requireEmptyHash() { return "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; }
