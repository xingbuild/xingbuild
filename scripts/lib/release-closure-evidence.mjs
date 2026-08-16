import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Bytes } from "./release-scope-classifier.mjs";
import { captureProtectedFacts, readDurableApprovalRecord } from "./release-transaction.mjs";
import { checkArtifact, checkGitClosure, checkRecovery, checkSideEffects, observeGitClosure } from "./release-invariants.mjs";

const SHA256 = /^[a-f0-9]{64}$/; const OID = /^[a-f0-9]{40}$/;
function mapRecords(records = []) { return new Map(records.map((record) => [record.path, record])); }
function sameRecord(left, right) { return canonicalJson(left) === canonicalJson(right); }
function rooted(rootName, value) { return String(value).startsWith(`${rootName}/`) ? String(value) : `${rootName}/${value}`; }
function clientRecords(rootDirectory, current = "") {
  const directory = path.join(rootDirectory, current); if (!existsSync(directory)) throw new Error(`client materialization is missing: ${directory}`);
  const records = [];
  for (const name of readdirSync(directory)) {
    const relative = path.posix.join(current, name); const absolute = path.join(rootDirectory, current, name); const stat = lstatSync(absolute);
    if (stat.isDirectory()) records.push(...clientRecords(rootDirectory, relative));
    else if (stat.isFile()) records.push({ path: relative, bytes: stat.size, sha256: sha256Bytes(readFileSync(absolute)) });
    else throw new Error(`unsupported client entry: ${relative}`);
  }
  return records.sort((a, b) => a.path.localeCompare(b.path));
}
function compareArtifactClient(root, artifact) {
  const dist = clientRecords(path.join(root, "dist", "client"));
  const artifactPath = path.join(root, artifact.documents?.baseSiteArtifact?.clientPath || `.content-workspace/base-site-artifacts/${artifact.baseSiteArtifactId}/client`);
  const stored = clientRecords(artifactPath);
  return { exact: JSON.stringify(dist) === JSON.stringify(stored), distCount: dist.length, storedCount: stored.length, distHash: sha256Bytes(canonicalJson(dist)), storedHash: sha256Bytes(canonicalJson(stored)) };
}
export function diffProtectedFacts(before, after, expectedBaseSiteArtifactId) {
  const deleted = []; const modified = []; const added = []; const immutableChanged = [];
  for (const rootBefore of before.roots || []) {
    const rootAfter = (after.roots || []).find((entry) => entry.root === rootBefore.root); const left = mapRecords(rootBefore.records); const right = mapRecords(rootAfter?.records || []);
    for (const [file, record] of left) if (!right.has(file)) deleted.push(rooted(rootBefore.root, file)); else if (!sameRecord(record, right.get(file))) modified.push(rooted(rootBefore.root, file));
    for (const file of right.keys()) if (!left.has(file)) immutableChanged.push(rooted(rootBefore.root, file));
  }
  const leftAllowed = mapRecords(before.allowedRoot?.records || []); const rightAllowed = mapRecords(after.allowedRoot?.records || []);
  for (const [file, record] of leftAllowed) if (!rightAllowed.has(file)) deleted.push(rooted(before.allowedRoot.root, file)); else if (!sameRecord(record, rightAllowed.get(file))) modified.push(rooted(before.allowedRoot.root, file));
  for (const [file, record] of rightAllowed) if (!leftAllowed.has(file)) added.push({ path: rooted(after.allowedRoot.root, file), record });
  const expectedPrefix = `${after.allowedRoot.root}/${expectedBaseSiteArtifactId}/client/`;
  const extraAdded = added.filter((entry) => !entry.path.startsWith(expectedPrefix));
  const artifactAdded = added.filter((entry) => entry.path.startsWith(expectedPrefix));
  return { immutableUnchanged: deleted.filter((file) => !file.startsWith(`${after.allowedRoot.root}/`)).length === 0 && modified.filter((file) => !file.startsWith(`${after.allowedRoot.root}/`)).length === 0 && immutableChanged.length === 0, deleted, modified, added: artifactAdded, extraAdded, onlyExpectedArtifact: extraAdded.length === 0 && artifactAdded.length > 0 };
}
function reportPayload(report) { const { closureReportHash: _ignored, ...payload } = report; return payload; }
export function computeClosureReportHash(report) { return sha256Bytes(canonicalJson(reportPayload(report))); }
export function createReleaseClosureReport({ root, version, approval, artifact, scopeEvidencePath = null, tag = version, preflightResult = null } = {}) {
  const durable = readDurableApprovalRecord(root, version, tag); const baseline = durable.sideEffectBaseline; if (!baseline?.hash) throw new Error("durable SideEffectBaseline is required for closure");
  const current = captureProtectedFacts(root); const diff = { ...diffProtectedFacts(baseline, current, artifact.baseSiteArtifactId), artifactClientExact: compareArtifactClient(root, artifact) }; const gitObservation = observeGitClosure(root, tag); const commit = gitObservation.commit;
  const checks = [
    checkGitClosure({ approval, commit, gitObservation }),
    checkArtifact({ artifact, approval, commit }),
    checkSideEffects({ baselineBefore: baseline, baselineAfter: current, closureDiff: diff }),
    checkRecovery({ tagRecovery: { verified: durable.approvalHash === approval.approvalHash }, cacheBefore: { authorityHash: durable.approvalHash }, cacheAfter: { authorityHash: durable.approvalHash }, wroteAuthority: false }),
  ];
  const failed = checks.filter((entry) => entry.result !== "PASS");
  const report = { schemaVersion: "release-closure-report-v1", version, phase: "post-commit", commit, tag, tagObject: gitObservation.tagObject, tagType: gitObservation.type, parent: gitObservation.parent, tree: gitObservation.tree, trailer: gitObservation.trailer, approvalHash: approval.approvalHash, candidateHash: approval.candidateHash, approvedTreeOid: approval.approvedTreeOid, productArtifactId: artifact.productArtifactId, productArtifactHash: artifact.productArtifactHash, baseSiteArtifactId: artifact.baseSiteArtifactId, protectedBaselineHash: baseline.hash, protectedCurrentHash: current.hash, protectedDiff: diff, scopeEvidencePath, preflightResult: preflightResult ? { ready: preflightResult.ready === true, evidenceHash: preflightResult.evidenceHash || null } : null, invariants: checks, closureReportHash: null };
  report.closureReportHash = computeClosureReportHash(report); if (failed.length) throw new Error(`release closure invariant failure: ${failed.map((entry) => `${entry.id}:${entry.reason}`).join("; ")} ${JSON.stringify({ closureDiff: { immutableUnchanged: diff.immutableUnchanged, onlyExpectedArtifact: diff.onlyExpectedArtifact, added: diff.added?.length, extraAdded: diff.extraAdded?.length, deleted: diff.deleted?.length, modified: diff.modified?.length, artifactClientExact: diff.artifactClientExact } })}`); return report;
}
export const createReleaseClosureEvidence = createReleaseClosureReport;
export function validateReleaseClosureReport(report, { root, version, approval, artifact, commit = artifact?.productCommit, tag = version } = {}) {
  if (!report || report.schemaVersion !== "release-closure-report-v1" || report.version !== version) throw new Error("ClosureReport schema/version mismatch");
  if (report.closureReportHash !== computeClosureReportHash(report)) throw new Error("ClosureReport hash mismatch");
  const durable = readDurableApprovalRecord(root, version, tag); const current = captureProtectedFacts(root); const diff = { ...diffProtectedFacts(durable.sideEffectBaseline, current, artifact.baseSiteArtifactId), artifactClientExact: compareArtifactClient(root, artifact) }; const gitObservation = observeGitClosure(root, tag);
  if (report.approvalHash !== approval.approvalHash || report.candidateHash !== approval.candidateHash || report.approvedTreeOid !== approval.approvedTreeOid || report.commit !== commit || report.tagObject !== gitObservation.tagObject || report.tagType !== gitObservation.type || report.parent !== gitObservation.parent || report.tree !== gitObservation.tree || report.trailer !== gitObservation.trailer) throw new Error("ClosureReport approval/commit identity drift");
  if (report.productArtifactHash !== artifact.productArtifactHash || report.productArtifactId !== artifact.productArtifactId) throw new Error("ClosureReport ProductArtifact drift");
  if (report.protectedBaselineHash !== durable.sideEffectBaseline.hash || report.protectedCurrentHash !== current.hash || JSON.stringify(report.protectedDiff) !== JSON.stringify(diff)) throw new Error("ClosureReport protected facts are stale or self-asserted");
  const checks = [checkGitClosure({ approval, commit, gitObservation }), checkArtifact({ artifact, approval, commit }), checkSideEffects({ baselineBefore: durable.sideEffectBaseline, baselineAfter: current, closureDiff: diff }), checkRecovery({ tagRecovery: { verified: true }, cacheBefore: { authorityHash: durable.approvalHash }, cacheAfter: { authorityHash: durable.approvalHash }, wroteAuthority: false })];
  if (JSON.stringify(report.invariants) !== JSON.stringify(checks)) throw new Error("ClosureReport invariant evidence drift");
  if (checks.some((entry) => entry.result !== "PASS")) throw new Error(`ClosureReport invariant drift: ${checks.filter((entry) => entry.result !== "PASS").map((entry) => entry.id).join(",")}`); return report;
}
export const validateReleaseClosureEvidence = validateReleaseClosureReport;
export async function writeReleaseClosureReport(root, version, report) { const outputPath = path.join(root, ".content-workspace", "qa", version, "closure-report.json"); await mkdir(path.dirname(outputPath), { recursive: true }); await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`); return outputPath; }
export const writeReleaseClosureEvidence = writeReleaseClosureReport;
export async function readReleaseClosureReport(root, version) { const file = path.join(root, ".content-workspace", "qa", version, "closure-report.json"); if (!existsSync(file)) throw new Error("ClosureReport is missing"); return JSON.parse(await readFile(file, "utf8")); }
