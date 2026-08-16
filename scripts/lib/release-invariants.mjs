import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Bytes, readScopeManifest } from "./release-scope-classifier.mjs";
import { assertVersionIdentityFromStaged, captureProtectedFacts, resolveElonIdentity, stagedTreeOid, workingIdentity } from "./release-transaction.mjs";

const SHA256 = /^[a-f0-9]{64}$/;
const OID = /^[a-f0-9]{40}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
function git(root, args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function pass(id, evidence) { return { id, result: "PASS", evidence }; }
function fail(id, reason, evidence = {}) { return { id, result: "FAIL", reason, evidence }; }

/** Canonical observers: each reads one authority and never serializes a report as facts. */
export function observeGit(root) {
  const head = git(root, ["rev-parse", "HEAD"]); const treeOid = stagedTreeOid(root); const parent = git(root, ["rev-parse", `${head}^`]);
  return { head, treeOid, parent, branch: git(root, ["branch", "--show-current"]), tag: (() => { try { return git(root, ["describe", "--tags", "--exact-match", head]); } catch { return null; } })(), working: workingIdentity(root) };
}
export function observeGitClosure(root, tagName) {
  const ref = `refs/tags/${tagName}`;
  const tagObject = git(root, ["rev-parse", ref]);
  const type = git(root, ["cat-file", "-t", ref]);
  if (type !== "tag") throw new Error("GitObserver requires an annotated release tag");
  const commit = git(root, ["rev-parse", `${tagName}^{commit}`]);
  const tree = git(root, ["rev-parse", `${commit}^{tree}`]); const parent = git(root, ["rev-parse", `${commit}^`]); const body = git(root, ["for-each-ref", ref, "--format=%(contents)"]);
  const trailer = git(root, ["show", "-s", "--format=%(trailers:key=Xingbuild-Approval,valueonly)", commit]).trim();
  let durable = null;
  const line = body.split(/\r?\n/).find((entry) => entry.startsWith("Xingbuild-Release-Transaction:"));
  if (line) { try { durable = JSON.parse(line.slice("Xingbuild-Release-Transaction:".length).trim()); } catch { durable = null; } }
  return { tag: tagName, tagObject, type, commit, tree, parent, trailer, durable };
}
export function observeArtifact({ clientDirectory, root, readArtifact }) {
  if (typeof readArtifact !== "function") throw new Error("ArtifactObserver requires the ProductArtifact adapter");
  return readArtifact({ clientDirectory, sourceRoot: root });
}
export function observeProtected(root) { return captureProtectedFacts(root); }

export function checkPlan(state = {}) {
  const { version, baseHead, scope, git: observed } = state;
  if (!VERSION.test(version || "") || !OID.test(baseHead || "")) return fail("I-01", "version/baseHead is invalid");
  if (!scope || scope.version !== version || scope.baseHead !== baseHead || !SHA256.test(scope.scopeDigest || "")) return fail("I-01", "classification-only scope identity mismatch");
  for (const entry of scope.entries || scope.paths || []) if (Object.hasOwn(entry, "pathHash") || Object.hasOwn(entry, "beforePathHash")) return fail("I-01", "scope manifest carries competing path hash", { path: entry.path });
  if (observed && observed.head !== baseHead) return fail("I-01", "baseHead is not current HEAD");
  if (state.root) {
    try { const staged = assertVersionIdentityFromStaged(state.root, version); return pass("I-01", { classificationOnly: true, scopeDigest: scope.scopeDigest, staged }); }
    catch (error) { return fail("I-01", `staged plan identity mismatch: ${error.message}`); }
  }
  return pass("I-01", { classificationOnly: true, scopeDigest: scope.scopeDigest });
}
export function checkCandidate(state = {}) {
  const { candidate, git: observed, protectedBaseline } = state;
  if (!candidate || candidate.schemaVersion !== "release-candidate-identity-v1") return fail("I-02", "CandidateIdentity missing or wrong schema");
  if (!OID.test(candidate.treeOid || "") || !SHA256.test(candidate.candidateHash || "") || !SHA256.test(candidate.protectedBaselineHash || "")) return fail("I-02", "CandidateIdentity fields invalid");
  if (observed && (observed.treeOid !== candidate.treeOid || observed.working?.worktreeDiffHash !== sha256Bytes(Buffer.alloc(0)) || observed.working?.untrackedHash !== sha256Bytes(Buffer.alloc(0)))) return fail("I-02", "candidate tree or working identity drift");
  if (protectedBaseline && protectedBaseline.hash !== candidate.protectedBaselineHash) return fail("I-02", "protected baseline drift");
  return pass("I-02", { treeOid: candidate.treeOid, protectedBaselineHash: candidate.protectedBaselineHash });
}
export function checkApproval(state = {}) {
  const { approval, candidate, registry, root } = state;
  if (!approval || approval.schemaVersion !== "release-approval-record-v1" || approval.verdict !== "READY_FOR_COMMIT") return fail("I-03", "ApprovalRecord missing or not approved");
  if (!candidate || approval.candidateHash !== candidate.candidateHash || approval.approvedTreeOid !== candidate.treeOid || approval.baseHead !== candidate.baseHead) return fail("I-03", "approval does not bind one CandidateIdentity");
  if (Object.hasOwn(approval, "scopeDigest")) return fail("I-03", "ApprovalRecord duplicates CandidateIdentity scopeDigest");
  if (registry && approval.approver?.registryPathHash !== registry.pathHash) return fail("I-03", "approver registry snapshot drift");
  if (root) {
    try {
      const snapshot = resolveElonIdentity(root, { treeOid: candidate.treeOid });
      if (approval.approver?.threadId !== snapshot.threadId || approval.approver?.registryPath !== snapshot.registryPath || approval.approver?.registryPathHash !== snapshot.registryPathHash) return fail("I-03", "approved-tree elon registry snapshot drift");
    } catch (error) { return fail("I-03", `approved-tree registry cannot be resolved: ${error.message}`); }
  }
  return pass("I-03", { candidateHash: approval.candidateHash, approver: approval.approver });
}

export function checkPrecommit(state = {}) {
  const { approval, git: observed, candidate, protectedBefore, protectedAfter } = state;
  if (!approval || !candidate) return fail("I-04", "approval/candidate required");
  if (observed && (observed.treeOid !== approval.approvedTreeOid || observed.working?.worktreeDiffHash !== sha256Bytes(Buffer.alloc(0)))) return fail("I-04", "approved tree or working bytes drifted");
  if (protectedBefore && protectedAfter && sha256Bytes(canonicalJson(protectedBefore)) !== sha256Bytes(canonicalJson(protectedAfter))) return fail("I-04", "protected baseline changed before commit");
  return pass("I-04", { approvedTreeOid: approval.approvedTreeOid });
}
export function checkGitClosure(state = {}) {
  const { approval, commit, tag, parent, tree, trailer, gitObservation = null } = state;
  if (gitObservation) {
    if (gitObservation.type !== "tag" || gitObservation.commit !== commit || gitObservation.parent !== approval?.baseHead || gitObservation.tree !== approval?.approvedTreeOid || gitObservation.trailer !== approval?.approvalHash) return fail("I-05", "canonical Git observer does not match approval");
    const durableApproval = gitObservation.durable?.approval;
    if (!durableApproval || durableApproval.approvalHash !== approval.approvalHash || gitObservation.durable?.candidate?.candidateHash !== approval.candidateHash) return fail("I-05", "annotated tag does not contain canonical approval");
    return pass("I-05", { commit: gitObservation.commit, tag: gitObservation.tag, tagObject: gitObservation.tagObject });
  }
  if (!approval || !OID.test(commit || "") || tree !== approval.approvedTreeOid || parent !== approval.baseHead || trailer !== approval.approvalHash) return fail("I-05", "commit is not approval-bound");
  if (!tag || tag.type !== "tag" || tag.target !== commit || tag.approvalHash !== approval.approvalHash) return fail("I-05", "annotated tag is not durable approval");
  return pass("I-05", { commit, tag: tag.object });
}
export function checkArtifact(state = {}) {
  const { artifact, approval, commit } = state;
  if (!artifact || !artifact.productArtifactHash || artifact.productCommit !== commit || !artifact.approvalHash || !artifact.candidateHash || !artifact.approvedTreeOid) return fail("I-06", "ProductArtifact root identity missing");
  if (approval && (artifact.approvalHash !== approval.approvalHash || artifact.candidateHash !== approval.candidateHash || artifact.approvedTreeOid !== approval.approvedTreeOid)) return fail("I-06", "ProductArtifact approval identity drift");
  if (artifact.documents && [artifact.documents.contentManifest, artifact.documents.baseSiteArtifact].some((document) => document && ["approvalHash", "candidateHash", "approvedTreeOid", "productArtifactHash", "productArtifactId", "productVersion", "productCommit", "baseSiteArtifactId"].some((field) => Object.hasOwn(document, field)))) return fail("I-06", "subordinate manifest duplicated root authority");
  if (artifact.documents?.baseSiteArtifact?.materializationKind !== "client" || artifact.documents?.baseSiteArtifact?.clientPath !== `.content-workspace/base-site-artifacts/${artifact.baseSiteArtifactId}/client`) return fail("I-06", "baseSiteArtifact is not the immutable client-only record");
  return pass("I-06", { productArtifactId: artifact.productArtifactId, productArtifactHash: artifact.productArtifactHash });
}
export function checkSideEffects(state = {}) {
  const { baselineBefore, baselineAfter, closureDiff } = state;
  if (!baselineBefore || !baselineAfter) return fail("I-07", "protected side-effect baseline is missing");
  if (baselineBefore.hash !== baselineAfter.hash && !closureDiff) return fail("I-07", "protected side-effect baseline changed before commit");
  if (closureDiff && (!closureDiff.immutableUnchanged || !closureDiff.onlyExpectedArtifact || closureDiff.extraAdded?.length || closureDiff.deleted?.length || closureDiff.modified?.length || closureDiff.artifactClientExact?.exact !== true)) return fail("I-07", "closure side-effect diff is not allowed");
  return pass("I-07", { baselineHash: baselineBefore.hash, closureDiff: closureDiff || null });
}
export function checkRecovery(state = {}) {
  const { tagRecovery, cacheBefore, cacheAfter, wroteAuthority = false } = state;
  if (!tagRecovery || tagRecovery.verified !== true || wroteAuthority) return fail("I-08", "tag recovery/read-only contract failed");
  if (cacheBefore && cacheAfter && cacheBefore.authorityHash !== cacheAfter.authorityHash) return fail("I-08", "recovery changed authority");
  return pass("I-08", { recoveredFrom: "annotated-tag", readOnly: true });
}

export const INVARIANT_PREDICATES = Object.freeze([checkPlan, checkCandidate, checkApproval, checkPrecommit, checkGitClosure, checkArtifact, checkSideEffects, checkRecovery]);
export function evaluateInvariants(state = {}) {
  return INVARIANT_PREDICATES.map((predicate) => predicate(state));
}
export function assertInvariants(state = {}) {
  const results = evaluateInvariants(state); const failed = results.filter((entry) => entry.result !== "PASS");
  if (failed.length) throw new Error(`release invariant failure: ${failed.map((entry) => `${entry.id}:${entry.reason}`).join("; ")}`);
  return results;
}

export function readScopeForInvariant(root, version) { return readScopeManifest(root, version); }
