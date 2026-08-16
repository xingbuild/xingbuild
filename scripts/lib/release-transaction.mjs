import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, computeScopeDigest, readScopeManifest, scopeManifestRelativePath, sha256Bytes } from "./release-scope-classifier.mjs";

export const RELEASE_TRANSACTION_SCHEMA_VERSION = "release-transaction-v2";
export const CANDIDATE_IDENTITY_SCHEMA_VERSION = "release-candidate-identity-v1";
export const APPROVAL_RECORD_SCHEMA_VERSION = "release-approval-record-v1";
/* Compatibility names are aliases only; the normal path is CandidateIdentity. */
export const CANDIDATE_ENVELOPE_SCHEMA_VERSION = CANDIDATE_IDENTITY_SCHEMA_VERSION;
export const APPROVAL_ENVELOPE_SCHEMA_VERSION = APPROVAL_RECORD_SCHEMA_VERSION;
export const TASK_REGISTRY_PATH = "docs/rules/task-registry.md";
export const TRANSACTION_EVIDENCE_ROOT = ".content-workspace/qa";
export const SIDE_EFFECT_BASELINE_SCHEMA_VERSION = "side-effect-baseline-v1";
export const SIDE_EFFECT_POLICY_VERSION = "release-side-effect-policy-v1";
export const LEGACY_SIDE_EFFECT_POLICY_VERSION = "v0.28.1";
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const TREE = /^[a-f0-9]{40}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;

function git(root, args, options = {}) { return execFileSync("git", args, { cwd: root, encoding: options.encoding || "utf8" }); }
export function gitText(root, ...args) { return git(root, args).trim(); }
export function gitBytes(root, ...args) { return git(root, args, { encoding: "buffer" }); }
export function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function hashFileBytes(file) { return sha256(readFileSync(file)); }
export function transactionEvidenceDirectory(root, version) { if (!VERSION.test(version)) throw new Error(`invalid release transaction version: ${version}`); return path.join(root, TRANSACTION_EVIDENCE_ROOT, version); }
export function candidateIdentityPath(root, version) { return path.join(transactionEvidenceDirectory(root, version), "candidate-identity.json"); }
export function candidateEnvelopePath(root, version) { return candidateIdentityPath(root, version); }
export function candidateCheckEvidencePath(root, version) { return path.join(transactionEvidenceDirectory(root, version), "candidate-check.json"); }
export function approvalRecordPath(root, version) { return path.join(transactionEvidenceDirectory(root, version), "approval-record.json"); }
export function approvalEnvelopePath(root, version) { return approvalRecordPath(root, version); }
export function stagedTreeOid(root) { const tree = gitText(root, "write-tree"); if (!TREE.test(tree)) throw new Error(`staged tree OID is invalid: ${tree}`); return tree; }
export function readIndexBytes(root, relativePath) {
  if (typeof relativePath !== "string" || !relativePath || path.posix.normalize(relativePath) !== relativePath || relativePath.startsWith("../")) throw new Error(`unsafe staged path: ${relativePath}`);
  return gitBytes(root, "cat-file", "blob", `:${relativePath}`);
}
export function readIndexText(root, relativePath) { return readIndexBytes(root, relativePath).toString("utf8"); }
export function readIndexJson(root, relativePath) { try { return JSON.parse(readIndexText(root, relativePath)); } catch (error) { throw new Error(`staged JSON ${relativePath} is invalid: ${error.message}`); } }

function readTreeBytes(root, treeOid, relativePath) { return gitBytes(root, "cat-file", "blob", `${treeOid}:${relativePath}`); }
function registryText(root, { treeOid = null, index = false } = {}) {
  if (treeOid) return readTreeBytes(root, gitText(root, "rev-parse", `${treeOid}^{tree}`), TASK_REGISTRY_PATH).toString("utf8");
  if (index) return readIndexText(root, TASK_REGISTRY_PATH);
  return readFileSync(path.join(root, TASK_REGISTRY_PATH), "utf8");
}
export function readTaskRegistrySnapshot(root, { treeOid = null, index = false } = {}) {
  const bytes = Buffer.from(registryText(root, { treeOid, index }));
  return { path: TASK_REGISTRY_PATH, pathHash: sha256(bytes), bytes: bytes.length, text: bytes.toString("utf8") };
}
export function resolveElonIdentity(root, { index = true, treeOid = null } = {}) {
  const snapshot = readTaskRegistrySnapshot(root, { index, treeOid });
  const text = snapshot.text;
  const row = text.split(/\r?\n/).find((line) => /^\s*\|\s*`elon`\s*\|/.test(line) && !/历史归档/.test(line));
  const cells = row ? row.split("|").map((cell) => cell.trim()) : [];
  // Table columns are: alias, responsibility, threadId, hostId, returnThreadId.
  // The leading split cell is empty, so threadId is cells[3], not the human
  // responsibility label in cells[2].
  const threadId = cells[3] ? cells[3].replace(/^`|`$/g, "") : null;
  return { task: "elon", threadId, registryPath: snapshot.path, registryPathHash: snapshot.pathHash, bytes: snapshot.bytes };
}

function walk(root, relative = "") {
  const absolute = path.join(root, relative); let entries = [];
  if (!existsSync(absolute)) return entries;
  const rootStat = lstatSync(absolute);
  if (rootStat.isFile() || rootStat.isSymbolicLink()) {
    const symlink = rootStat.isSymbolicLink();
    const target = symlink ? readlinkSync(absolute) : null;
    return [{ path: relative, kind: symlink ? "symlink" : "file", mode: (rootStat.mode & 0o7777).toString(8), bytes: rootStat.isFile() ? rootStat.size : 0, hash: rootStat.isFile() ? sha256(readFileSync(absolute)) : sha256(Buffer.from(`symlink:${target}`)), ...(symlink ? { target } : {}) }];
  }
  for (const entry of (requireFsReaddir(absolute))) {
    const child = path.posix.join(relative.split(path.sep).join("/"), entry);
    const childAbsolute = path.join(root, child);
    const stat = lstatSync(childAbsolute);
    if (stat.isDirectory() && !stat.isSymbolicLink()) entries = entries.concat(walk(root, child));
    else if (stat.isFile() || stat.isSymbolicLink()) {
      const symlink = stat.isSymbolicLink();
      const target = symlink ? readlinkSync(childAbsolute) : null;
      entries.push({ path: child, kind: symlink ? "symlink" : "file", mode: (stat.mode & 0o7777).toString(8), bytes: stat.isFile() ? stat.size : 0, hash: stat.isFile() ? sha256(readFileSync(childAbsolute)) : sha256(Buffer.from(`symlink:${target}`)), ...(symlink ? { target } : {}) });
    }
  }
  return entries.sort((a, b) => Buffer.from(a.path).compare(Buffer.from(b.path)));
}
function requireFsReaddir(directory) { return readdirSync(directory); }
// Kept separate to make the root policy obvious in review.
const IMMUTABLE_ROOTS = [
  ".content-workspace/content",
  ".content-workspace/content-state/active.json",
  ".content-workspace/content-state/sets",
  ".content-workspace/content-state/data-artifacts",
  ".content-workspace/content-state/data-objects",
  ".content-workspace/content-state/content-data-active.json",
  ".content-workspace/content-state/receipts",
  ".content-workspace/site-publications",
  ".content-workspace/publication-runs",
  ".content-workspace/recoveries",
];
const ALLOWED_ROOT = ".content-workspace/base-site-artifacts";
export function captureProtectedFacts(root) {
  const roots = IMMUTABLE_ROOTS.map((relativeRoot) => ({ root: relativeRoot, records: walk(root, relativeRoot) }));
  const allowed = { root: ALLOWED_ROOT, records: walk(root, ALLOWED_ROOT) };
  const payload = { schemaVersion: SIDE_EFFECT_BASELINE_SCHEMA_VERSION, policyVersion: SIDE_EFFECT_POLICY_VERSION, roots, allowedRoot: allowed, git: { head: gitText(root, "rev-parse", "HEAD"), indexTree: stagedTreeOid(root) } };
  return finalizeProtectedFacts(payload);
}
function protectedPathSetHash(payload) { return sha256(canonicalJson((payload.roots || []).map((entry) => ({ root: entry.root, paths: (entry.records || []).map((record) => record.path) })))); }
function protectedBytes(payload) { return (payload.roots || []).reduce((total, entry) => total + (entry.records || []).reduce((sum, record) => sum + Number(record.bytes || 0), 0), 0); }
function protectedPayload(facts) { const { hash: _hash, pathSetHash: _pathSetHash, bytes: _bytes, ...payload } = facts || {}; return payload; }
function finalizeProtectedFacts(payload) { return { ...payload, hash: sha256(canonicalJson(payload)), pathSetHash: protectedPathSetHash(payload), bytes: protectedBytes(payload) }; }
export function computeProtectedFactsHash(facts) { return sha256(canonicalJson(protectedPayload(facts))); }
export function validateProtectedFacts(facts, { allowLegacy = false } = {}) {
  const policyAccepted = facts?.policyVersion === SIDE_EFFECT_POLICY_VERSION || (allowLegacy && facts?.policyVersion === LEGACY_SIDE_EFFECT_POLICY_VERSION);
  if (!facts || facts.schemaVersion !== SIDE_EFFECT_BASELINE_SCHEMA_VERSION || !policyAccepted) throw new Error("SideEffectBaseline schema/policy mismatch");
  if (facts.hash !== computeProtectedFactsHash(facts)) throw new Error("SideEffectBaseline hash mismatch");
  const payload = protectedPayload(facts);
  if (facts.pathSetHash !== protectedPathSetHash(payload) || facts.bytes !== protectedBytes(payload)) throw new Error("SideEffectBaseline summary mismatch");
  for (const rootEntry of [...(facts.roots || []), facts.allowedRoot].filter(Boolean)) {
    if (typeof rootEntry.root !== "string" || !Array.isArray(rootEntry.records)) throw new Error("SideEffectBaseline root record missing");
    for (const record of rootEntry.records) {
      if (typeof record.path !== "string" || !/^(file|symlink)$/.test(record.kind || "") || typeof record.mode !== "string" || !/^\d+$/.test(record.mode) || !Number.isInteger(record.bytes) || record.bytes < 0 || !SHA256.test(record.hash || "")) throw new Error(`SideEffectBaseline record invalid: ${record.path}`);
      if (record.kind === "symlink" && typeof record.target !== "string") throw new Error(`SideEffectBaseline symlink target missing: ${record.path}`);
    }
  }
  return facts;
}

export function workingIdentity(root) {
  const status = git(root, ["status", "--porcelain=v1", "-z"]); const index = git(root, ["diff", "--cached", "--binary"]); const worktree = git(root, ["diff", "--binary"]); const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return { worktreeDiffHash: sha256(worktree), indexDiffHash: sha256(index), untrackedHash: sha256(untracked), statusHash: sha256(status), identityHash: sha256(canonicalJson({ worktree: worktreeDiffHash(worktree), index: worktreeDiffHash(index), untracked: worktreeDiffHash(untracked) })) };
}
function worktreeDiffHash(value) { return sha256(value); }
function stagedPathSet(root) {
  const bytes = gitBytes(root, "diff", "--cached", "--name-status", "-z");
  const tokens = bytes.toString("utf8").split("\0").filter(Boolean);
  const paths = new Set();
  for (let index = 0; index < tokens.length; index += 2) {
    const status = tokens[index] || "";
    const first = tokens[index + 1];
    if (!first) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const second = tokens[index + 2];
      if (second) { paths.add(first); paths.add(second); index += 1; }
    } else paths.add(first);
  }
  return paths;
}

export function assertVersionIdentityFromStaged(root, version) {
  const packageJson = readIndexJson(root, "package.json");
  const versionDocument = readIndexText(root, "VERSION.md");
  const current = readIndexText(root, "docs/iterations/current.md");
  const scopePath = scopeManifestRelativePath(version);
  const scope = readIndexJson(root, scopePath);
  const historyPath = `docs/iterations/history/${version}.md`;
  const history = readIndexText(root, historyPath);
  const designPaths = (scope.paths || scope.entries || []).map((entry) => entry.path).filter((entry) => entry.startsWith("docs/design/"));
  if (designPaths.length !== 1) throw new Error("staged version identity must declare exactly one design");
  const decodedCurrent = decodeURIComponent(current);
  const designName = path.posix.basename(designPaths[0]);
  const versionHeadings = [...versionDocument.matchAll(/^##\s+(v\d+\.\d+\.\d+)(?:\s|$)/gm)].map((match) => match[1]);
  const matchingVersionHeadings = versionHeadings.filter((heading) => heading === version);
  const historyHeadings = [...history.matchAll(/^#\s+(v\d+\.\d+\.\d+)(?:\s|$)/gm)].map((match) => match[1]);
  const currentVersionMarkers = [...current.matchAll(/当前唯一版本：\`(v\d+\.\d+\.\d+)\`/g)].map((match) => match[1]);
  const designMentions = (decodedCurrent.match(new RegExp(designName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) || []).length;
  if (`v${packageJson.version}` !== version
    || matchingVersionHeadings.length !== 1 || versionHeadings[0] !== version
    || historyHeadings.length !== 1 || historyHeadings[0] !== version
    || currentVersionMarkers.length !== 1 || currentVersionMarkers[0] !== version
    || designMentions !== 1) {
    throw new Error("staged version/current/design/history identity mismatch");
  }
  if (scope.version !== version || scope.baseHead !== gitText(root, "rev-parse", "HEAD")) throw new Error("staged scope baseHead/version mismatch");
  if (!scope.scopeDigest || !SHA256.test(scope.scopeDigest)) throw new Error("staged scope digest is invalid");
  const declaredPaths = new Set((scope.paths || scope.entries || []).map((entry) => entry.path));
  const stagedPaths = stagedPathSet(root);
  for (const entry of declaredPaths) if (!stagedPaths.has(entry)) throw new Error(`declared staged path is missing: ${entry}`);
  for (const entry of stagedPaths) if (!declaredPaths.has(entry)) throw new Error(`staged path is outside scope manifest: ${entry}`);
  return { version, packageVersion: packageJson.version, scopePath, historyPath, designPath: designPaths[0], stagedPaths: [...stagedPaths].sort() };
}

export function candidatePayload(identity) { const { candidateHash, ...payload } = identity; return payload; }
export function computeCandidateIdentityHash(identity) { return sha256(canonicalJson(candidatePayload(identity))); }
export const computeCandidateEnvelopeHash = computeCandidateIdentityHash;
export function validateCandidateIdentity(identity, { root, version, requireCurrentIdentity = true } = {}) {
  if (!identity || identity.schemaVersion !== CANDIDATE_IDENTITY_SCHEMA_VERSION) throw new Error("CandidateIdentity schema mismatch");
  if (identity.version !== version || !VERSION.test(identity.version)) throw new Error("CandidateIdentity version mismatch");
  if (!COMMIT.test(identity.baseHead) || !TREE.test(identity.treeOid) || !SHA256.test(identity.scopeDigest) || !SHA256.test(identity.protectedBaselineHash) || !SHA256.test(identity.candidateHash)) throw new Error("CandidateIdentity identity is invalid");
  if (identity.candidateHash !== computeCandidateIdentityHash(identity)) throw new Error("CandidateIdentity hash mismatch");
  if (requireCurrentIdentity && root) {
    const scope = readScopeManifest(root, version); if (scope.baseHead !== identity.baseHead || scope.scopeDigest !== identity.scopeDigest) throw new Error("CandidateIdentity scope drift");
    if (stagedTreeOid(root) !== identity.treeOid) throw new Error("CandidateIdentity staged tree drift");
    const current = workingIdentity(root); if (current.worktreeDiffHash !== sha256(Buffer.alloc(0)) || current.untrackedHash !== sha256(Buffer.alloc(0))) throw new Error("CandidateIdentity requires clean working tree and no unknown untracked paths");
  }
  return identity;
}
export const validateCandidateEnvelope = validateCandidateIdentity;
export function createCandidateIdentity({ root, version, scope = null, protectedBaseline = null } = {}) {
  if (!root || !VERSION.test(version)) throw new Error("CandidateIdentity root/version required");
  const actualScope = scope || readScopeManifest(root, version); const baseline = protectedBaseline || captureProtectedFacts(root); const treeOid = stagedTreeOid(root); const identity = { schemaVersion: CANDIDATE_IDENTITY_SCHEMA_VERSION, version, baseHead: gitText(root, "rev-parse", "HEAD"), treeOid, scopeDigest: actualScope.scopeDigest, protectedBaselineHash: baseline.hash };
  return { ...identity, candidateHash: computeCandidateIdentityHash(identity) };
}
export function createCandidateEnvelope(options = {}) { return createCandidateIdentity(options); }
export async function writeCandidateIdentity(root, version, identity) { await mkdir(path.dirname(candidateIdentityPath(root, version)), { recursive: true }); await writeFile(candidateIdentityPath(root, version), `${JSON.stringify(validateCandidateIdentity(identity, { version, requireCurrentIdentity: false }), null, 2)}\n`); return candidateIdentityPath(root, version); }
export const writeCandidateEnvelope = writeCandidateIdentity;
export async function readCandidateIdentity(root, version, { requireCurrentIdentity = true } = {}) { const identity = JSON.parse(await readFile(candidateIdentityPath(root, version), "utf8")); return validateCandidateIdentity(identity, { root, version, requireCurrentIdentity }); }
export const readCandidateEnvelope = readCandidateIdentity;

export function approvalPayload(record) { const { approvalHash, ...payload } = record; return payload; }
export function computeApprovalRecordHash(record) { return sha256(canonicalJson(approvalPayload(record))); }
export const computeApprovalEnvelopeHash = computeApprovalRecordHash;
export function createApprovalRecord({ root, version, candidate, approver = null } = {}) {
  const identity = validateCandidateIdentity(candidate, { version, requireCurrentIdentity: false }); const snapshot = approver || resolveElonIdentity(root, { treeOid: identity.treeOid });
  if (!snapshot.threadId) throw new Error("active elon identity is missing from approved tree registry");
  const record = { schemaVersion: APPROVAL_RECORD_SCHEMA_VERSION, version, candidateHash: identity.candidateHash, baseHead: identity.baseHead, approvedTreeOid: identity.treeOid, approver: { task: "elon", threadId: snapshot.threadId, registryPath: TASK_REGISTRY_PATH, registryPathHash: snapshot.registryPathHash }, verdict: "READY_FOR_COMMIT" };
  return { ...record, approvalHash: computeApprovalRecordHash(record) };
}
export const createApprovalEnvelope = createApprovalRecord;
export function validateApprovalRecord(record, { version, candidate = null, root = null } = {}) {
  if (!record || record.schemaVersion !== APPROVAL_RECORD_SCHEMA_VERSION || record.version !== version || record.verdict !== "READY_FOR_COMMIT") throw new Error("ApprovalRecord schema/verdict mismatch");
  for (const field of ["candidateHash", "approvalHash"]) if (!SHA256.test(record[field] || "")) throw new Error(`ApprovalRecord ${field} is invalid`);
  if (Object.hasOwn(record, "scopeDigest")) throw new Error("ApprovalRecord must not duplicate CandidateIdentity scopeDigest");
  if (!TREE.test(record.approvedTreeOid || "") || !COMMIT.test(record.baseHead || "") || record.approver?.task !== "elon" || !record.approver?.threadId) throw new Error("ApprovalRecord identity is incomplete");
  if (candidate && (record.candidateHash !== candidate.candidateHash || record.approvedTreeOid !== candidate.treeOid || record.baseHead !== candidate.baseHead)) throw new Error("ApprovalRecord candidate drift");
  if (root && candidate) {
    const registry = resolveElonIdentity(root, { treeOid: candidate.treeOid });
    if (record.approver.threadId !== registry.threadId || record.approver.registryPath !== registry.registryPath || record.approver.registryPathHash !== registry.registryPathHash) throw new Error("ApprovalRecord approver registry snapshot drift");
  }
  if (record.approvalHash !== computeApprovalRecordHash(record)) throw new Error("ApprovalRecord hash mismatch");
  return record;
}
export const validateApprovalEnvelope = validateApprovalRecord;
export async function readApprovalRecord(root, version, approvalPath = null, { requireCurrentIdentity = true, allowTagRecovery = false } = {}) {
  const file = approvalPath ? path.resolve(root, approvalPath) : approvalRecordPath(root, version);
  if (existsSync(file)) {
    const record = JSON.parse(await readFile(file, "utf8"));
    if (allowTagRecovery) {
      /* After commit the annotated tag is the durable authority.  A cache is
         useful only as an exact readback; an existing stale/tampered cache
         must never silently win over the tag. */
      const durable = readDurableApprovalRecord(root, version);
      validateApprovalRecord(record, { version, candidate: durable.candidate, root });
      const durableRecord = Object.fromEntries(["schemaVersion", "version", "candidateHash", "baseHead", "approvedTreeOid", "approver", "verdict", "approvalHash"].map((field) => [field, durable[field]]));
      if (record.approvalHash !== durable.approvalHash || canonicalJson(record) !== canonicalJson(durableRecord)) {
        throw new Error("ApprovalRecord cache drift from durable tag");
      }
      return durable;
    }
    let candidate;
    try {
      candidate = await readCandidateIdentity(root, version, { requireCurrentIdentity });
    } catch (error) {
      if (!allowTagRecovery || error.code !== "ENOENT") throw error;
      throw error;
    }
    return validateApprovalRecord(record, { version, candidate, root });
  }
  if (allowTagRecovery) return readDurableApprovalRecord(root, version);
  throw new Error(`ApprovalRecord missing: ${file}`);
}
export const readApprovalEnvelope = readApprovalRecord;
export function approvalArgument(argv = process.argv.slice(2)) { const index = argv.indexOf("--approval"); return index >= 0 ? path.resolve(process.cwd(), argv[index + 1]) : null; }
export function durableApprovalTagMessage({ candidate = null, approval = null, baseline = null, approvalHash, candidateHash, approvedTreeOid, version } = {}) {
  const record = approval || { schemaVersion: APPROVAL_RECORD_SCHEMA_VERSION, version, candidateHash, approvedTreeOid, approvalHash };
  return `Xingbuild-Release-Transaction: ${canonicalJson({ candidate: candidate || null, approval: record, sideEffectBaseline: baseline || null })}`;
}
export function parseDurableApprovalTagBody(body) {
  const line = String(body || "").split(/\r?\n/).find((entry) => entry.startsWith("Xingbuild-Release-Transaction:")); if (!line) throw new Error("durable release transaction record missing from tag");
  const parsed = JSON.parse(line.slice("Xingbuild-Release-Transaction:".length).trim()); return parsed;
}
export function readDurableApprovalRecord(root, version, tag = version) {
  if (gitText(root, "cat-file", "-t", `refs/tags/${tag}`) !== "tag") throw new Error("durable release transaction tag must be annotated");
  const body = gitText(root, "for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"); const parsed = parseDurableApprovalTagBody(body); const approval = parsed.approval;
  if (!approval || !parsed.candidate) throw new Error("durable tag CandidateIdentity/ApprovalRecord missing");
  validateCandidateIdentity(parsed.candidate, { version, requireCurrentIdentity: false });
  validateApprovalRecord(approval, { version, candidate: parsed.candidate, root });
  const baseline = validateProtectedFacts(parsed.sideEffectBaseline, { allowLegacy: version === "v0.28.1" });
  if (baseline.hash !== parsed.candidate.protectedBaselineHash) throw new Error("durable tag SideEffectBaseline does not match CandidateIdentity");
  const commit = gitText(root, "rev-parse", `${tag}^{commit}`);
  if (gitText(root, "rev-parse", `${commit}^{tree}`) !== approval.approvedTreeOid || gitText(root, "rev-parse", `${commit}^`) !== approval.baseHead) throw new Error("durable tag commit identity drift");
  return { ...approval, candidate: parsed.candidate, sideEffectBaseline: baseline };
}
export const readDurableApprovalEnvelope = readDurableApprovalRecord;
export function assertCommitIdentity({ root, approval, commit = gitText(root, "rev-parse", "HEAD") } = {}) {
  if (gitText(root, "rev-parse", `${commit}^{tree}`) !== approval.approvedTreeOid) throw new Error("commit tree does not match ApprovalRecord");
  if (gitText(root, "rev-parse", `${commit}^`) !== approval.baseHead) throw new Error("commit first parent does not match ApprovalRecord");
  const body = gitText(root, "show", "-s", "--format=%B", commit); if (!body.includes(`Xingbuild-Approval: ${approval.approvalHash}`)) throw new Error("commit ApprovalRecord trailer is missing");
  return true;
}
export function assertTagIdentity({ root, approval, tag, commit = gitText(root, "rev-parse", "HEAD") } = {}) {
  if (gitText(root, "cat-file", "-t", `refs/tags/${tag}`) !== "tag") throw new Error("release tag must be annotated");
  if (gitText(root, "rev-parse", `${tag}^{commit}`) !== commit) throw new Error("annotated tag target drift");
  const body = gitText(root, "for-each-ref", `refs/tags/${tag}`, "--format=%(contents)"); const parsed = parseDurableApprovalTagBody(body); if (parsed.approval?.approvalHash !== approval.approvalHash || parsed.candidate?.candidateHash !== approval.candidateHash) throw new Error("annotated tag durable ApprovalRecord drift");
  return true;
}
export function assertArtifactApproval(artifact, approval) {
  for (const [actual, expected] of [[artifact.approvalHash, approval.approvalHash], [artifact.candidateHash, approval.candidateHash], [artifact.approvedTreeOid, approval.approvedTreeOid]]) if (actual !== expected) throw new Error("ProductArtifact ApprovalRecord identity drift");
  return artifact;
}
export function computeChecklistEvidenceHash({ id, result, capabilityTest = "PASS", evidence }) { return sha256(canonicalJson({ id, result, capabilityTest, evidence })); }
