#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { approvalArgument, assertCommitIdentity, assertTagIdentity, captureProtectedFacts, durableApprovalTagMessage, gitText, readApprovalRecord, readCandidateIdentity } from "./lib/release-transaction.mjs";

const root = process.cwd(); const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); const version = `v${packageJson.version}`; const approvalPath = approvalArgument();
if (!approvalPath) throw new Error("RELEASE_TRANSACTION_APPROVAL_REQUIRED: release commit requires --approval <ApprovalRecord>");
const approval = await readApprovalRecord(root, version, approvalPath, { requireCurrentIdentity: true }); const candidate = await readCandidateIdentity(root, version, { requireCurrentIdentity: true });
if (gitText(root, "rev-parse", "HEAD") !== approval.baseHead || gitText(root, "write-tree") !== approval.approvedTreeOid) throw new Error("release commit precondition drift");
try { if (gitText(root, "cat-file", "-t", `refs/tags/${version}`)) throw new Error(`release tag already exists: ${version}`); } catch (error) { if (String(error.message).includes("already exists")) throw error; }
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "xingbuild-release-transaction-"));
try {
  const messagePath = path.join(tempRoot, "commit-message.txt"); await writeFile(messagePath, `${version} release transaction\n\nXingbuild-Approval: ${approval.approvalHash}\n`, "utf8");
  const commit = gitText(root, "commit-tree", candidate.treeOid, "-p", candidate.baseHead, "-F", messagePath); const baseline = captureProtectedFacts(root);
  if (baseline.hash !== candidate.protectedBaselineHash) throw new Error("SideEffectBaseline drift before ref transaction");
  const tagBody = durableApprovalTagMessage({ candidate, approval, baseline }); const tagMessagePath = path.join(tempRoot, "tag-message.txt"); await writeFile(tagMessagePath, tagBody, "utf8");
  const name = gitText(root, "config", "user.name"); const email = gitText(root, "config", "user.email"); if (!name || !email) throw new Error("annotated tag requires Git user identity");
  const tagInput = `object ${commit}\ntype commit\ntag ${version}\ntagger ${name} <${email}> ${Math.floor(Date.now() / 1000)} +0000\n\n${tagBody}`; const tagObject = execFileSync("git", ["mktag"], { cwd: root, input: tagInput, encoding: "utf8" }).trim();
  const transaction = ["start", `create refs/tags/${version} ${tagObject}`, `update refs/heads/main ${commit} ${candidate.baseHead}`, "prepare", "commit", ""].join("\n"); execFileSync("git", ["update-ref", "--stdin"], { cwd: root, input: transaction, encoding: "utf8" });
  assertCommitIdentity({ root, approval, commit }); assertTagIdentity({ root, approval, tag: version, commit }); console.log(JSON.stringify({ version, commit, tag: version, tagObject, approvalHash: approval.approvalHash, candidateHash: candidate.candidateHash, treeOid: candidate.treeOid }, null, 2));
} finally { await rm(tempRoot, { recursive: true, force: true }); }
