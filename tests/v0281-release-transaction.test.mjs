import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { execFileSync, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { canonicalJson, computeScopeDigest, sha256Bytes } from "../scripts/lib/release-scope-classifier.mjs";
import { approvalRecordPath, assertVersionIdentityFromStaged, captureProtectedFacts, computeApprovalRecordHash, computeCandidateIdentityHash, durableApprovalTagMessage, readApprovalRecord, stagedTreeOid, validateProtectedFacts, workingIdentity } from "../scripts/lib/release-transaction.mjs";
import { checkApproval, checkArtifact, checkCandidate, checkGitClosure, checkPlan, checkPrecommit, checkRecovery, checkSideEffects, evaluateInvariants } from "../scripts/lib/release-invariants.mjs";
import { diffProtectedFacts } from "../scripts/lib/release-closure-evidence.mjs";
import { hashArtifactValue, validateBaseSiteArtifact } from "../scripts/lib/base-site-artifact.mjs";
import { computeProductArtifactHash, resolveProductArtifactIdentity } from "../scripts/lib/product-artifact.mjs";
import { buildContentRelease } from "../scripts/content-release.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname); const version = "v0.28.1"; const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const treeOid = stagedTreeOid(root); const legacyTreeOid = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd: root, encoding: "utf8" }).trim(); const baseline = captureProtectedFacts(root); const emptyHash = sha256Bytes(Buffer.alloc(0));
const scope = JSON.parse(await readFile(path.join(root, "docs/iterations/scopes/v0.28.1.json"), "utf8"));
const candidate = { schemaVersion: "release-candidate-identity-v1", version, baseHead: scope.baseHead, treeOid, scopeDigest: scope.scopeDigest, protectedBaselineHash: baseline.hash };
candidate.candidateHash = computeCandidateIdentityHash(candidate);
const approval = { schemaVersion: "release-approval-record-v1", version, candidateHash: candidate.candidateHash, baseHead: candidate.baseHead, approvedTreeOid: candidate.treeOid, approver: { task: "elon", threadId: "01a00637-f0b0-79c3-aa1e-6dd463dd37d1", registryPathHash: "a".repeat(64) }, verdict: "READY_FOR_COMMIT", approvalHash: "b".repeat(64) };

/*
 * Design §8 is a finite matrix, not a collection of helper assertions.  Each
 * row below is executed by the D6 isolated fixture through the named formal
 * CLI.  The authority/observer/predicate columns make the single routing
 * contract inspectable without creating a second validator or checklist.
 */
const FORMAL_NEGATIVE_MATRIX = Object.freeze([
  { id: "I-01.version-missing", invariant: "I-01", category: "version missing", authority: "staged VERSION.md", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.version-duplicate", invariant: "I-01", category: "version duplicate", authority: "staged VERSION.md", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.version-order", invariant: "I-01", category: "version order", authority: "staged VERSION.md", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.base-mismatch", invariant: "I-01", category: "base mismatch", authority: "scope manifest", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.scope-mismatch", invariant: "I-01", category: "scope mismatch", authority: "scope manifest", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.design-mismatch", invariant: "I-01", category: "design mismatch", authority: "current/design link", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.pathHash", invariant: "I-01", category: "scope pathHash", authority: "scope manifest", observer: "scope observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.declared-missing", invariant: "I-01", category: "declared path missing", authority: "scope manifest/index", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-01.declared-extra", invariant: "I-01", category: "declared path extra", authority: "scope manifest/index", observer: "plan observer", predicate: "checkPlan", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-02.index-drift", invariant: "I-02", category: "index drift", authority: "CandidateIdentity/tree", observer: "git observer", predicate: "checkCandidate", cli: "release-candidate-freeze", phase: "candidate" },
  { id: "I-02.unstaged", invariant: "I-02", category: "unstaged drift", authority: "working tree", observer: "git observer", predicate: "checkCandidate", cli: "release-candidate-freeze", phase: "candidate" },
  { id: "I-02.mode", invariant: "I-02", category: "mode drift", authority: "index mode", observer: "git observer", predicate: "checkCandidate", cli: "release-candidate-freeze", phase: "candidate" },
  { id: "I-02.rename", invariant: "I-02", category: "rename drift", authority: "index path set", observer: "git observer", predicate: "checkCandidate", cli: "release-candidate-freeze", phase: "candidate" },
  { id: "I-02.unknown-untracked", invariant: "I-02", category: "unknown untracked", authority: "working tree", observer: "git observer", predicate: "checkCandidate", cli: "release-candidate-freeze", phase: "candidate" },
  { id: "I-02.candidate-field", invariant: "I-02", category: "Candidate field tamper", authority: "CandidateIdentity", observer: "candidate observer", predicate: "checkCandidate", cli: "release-candidate-freeze", phase: "candidate" },
  { id: "I-03.registry", invariant: "I-03", category: "wrong registry snapshot", authority: "ApprovalRecord/registry", observer: "approval observer", predicate: "checkApproval", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-03.tree", invariant: "I-03", category: "wrong approved tree", authority: "ApprovalRecord", observer: "approval observer", predicate: "checkApproval", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-03.candidate", invariant: "I-03", category: "wrong candidate", authority: "ApprovalRecord", observer: "approval observer", predicate: "checkApproval", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-03.cache", invariant: "I-03", category: "cache inconsistency", authority: "ApprovalRecord cache", observer: "approval observer", predicate: "checkApproval", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-03.tag", invariant: "I-03", category: "tag inconsistency", authority: "durable tag", observer: "Git observer", predicate: "checkGitClosure", cli: "release-preflight", phase: "postcommit" },
  { id: "I-04.implementation", invariant: "I-04", category: "implementation drift", authority: "approved tree", observer: "scope/git observer", predicate: "checkPrecommit", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-04.record-only", invariant: "I-04", category: "record-only drift", authority: "approved tree", observer: "scope/git observer", predicate: "checkPrecommit", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-04.scope", invariant: "I-04", category: "scope drift", authority: "scope manifest", observer: "scope observer", predicate: "checkPrecommit", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-04.VERSION", invariant: "I-04", category: "VERSION drift", authority: "VERSION.md", observer: "plan observer", predicate: "checkPrecommit", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-04.index", invariant: "I-04", category: "index drift", authority: "Git index", observer: "git observer", predicate: "checkPrecommit", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-04.working", invariant: "I-04", category: "working drift", authority: "working tree", observer: "git observer", predicate: "checkPrecommit", cli: "release-closeout-check", phase: "closeout" },
  { id: "I-05.tag-exists", invariant: "I-05", category: "tag already exists", authority: "refs/tags", observer: "Git observer", predicate: "checkGitClosure", cli: "release-commit", phase: "commit" },
  { id: "I-05.tag-construction", invariant: "I-05", category: "tag construction failure", authority: "annotated tag object", observer: "Git observer", predicate: "checkGitClosure", cli: "release-commit", phase: "commit" },
  { id: "I-05.ref-race", invariant: "I-05", category: "ref race/lock", authority: "refs/heads/main", observer: "Git observer", predicate: "checkGitClosure", cli: "release-commit", phase: "commit" },
  { id: "I-05.parent", invariant: "I-05", category: "parent mismatch", authority: "commit parent", observer: "Git observer", predicate: "checkGitClosure", cli: "release-preflight", phase: "postcommit" },
  { id: "I-05.tree", invariant: "I-05", category: "commit tree mismatch", authority: "commit tree", observer: "Git observer", predicate: "checkGitClosure", cli: "release-preflight", phase: "postcommit" },
  { id: "I-05.trailer", invariant: "I-05", category: "approval trailer mismatch", authority: "commit trailer", observer: "Git observer", predicate: "checkGitClosure", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.old-dist", invariant: "I-06", category: "old dist", authority: "dist/client", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.root-missing", invariant: "I-06", category: "root field missing", authority: "release.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.root-replaced", invariant: "I-06", category: "root field replaced", authority: "release.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.subordinate-hash", invariant: "I-06", category: "subordinate hash drift", authority: "base-site-artifact.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.subordinate-bytes", invariant: "I-06", category: "subordinate bytes drift", authority: "stored client", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.commit", invariant: "I-06", category: "wrong product commit", authority: "release.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.tree", invariant: "I-06", category: "wrong product tree", authority: "release.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.approval", invariant: "I-06", category: "wrong product approval", authority: "release.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-06.duplicate", invariant: "I-06", category: "subordinate duplicate identity", authority: "base-site-artifact.json", observer: "artifact observer", predicate: "checkArtifact", cli: "release-preflight", phase: "postcommit" },
  { id: "I-07.command-write", invariant: "I-07", category: "candidate command write", authority: "protected roots", observer: "protected observer", predicate: "checkSideEffects", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-07.root-modify", invariant: "I-07", category: "protected root modify", authority: "protected roots", observer: "protected observer", predicate: "checkSideEffects", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-07.root-delete", invariant: "I-07", category: "protected root delete", authority: "protected roots", observer: "protected observer", predicate: "checkSideEffects", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-07.root-add", invariant: "I-07", category: "protected root add", authority: "protected roots", observer: "protected observer", predicate: "checkSideEffects", cli: "release-candidate-check", phase: "candidate" },
  { id: "I-07.old-artifact-modify", invariant: "I-07", category: "old artifact modify", authority: "allowed artifact root", observer: "protected observer", predicate: "checkSideEffects", cli: "release-preflight", phase: "postcommit" },
  { id: "I-07.old-artifact-delete", invariant: "I-07", category: "old artifact delete", authority: "allowed artifact root", observer: "protected observer", predicate: "checkSideEffects", cli: "release-preflight", phase: "postcommit" },
  { id: "I-07.extra-artifact", invariant: "I-07", category: "extra artifact", authority: "allowed artifact root", observer: "protected observer", predicate: "checkSideEffects", cli: "release-preflight", phase: "postcommit" },
  { id: "I-07.existing-target", invariant: "I-07", category: "existing artifact target", authority: "allowed artifact root", observer: "protected observer", predicate: "checkSideEffects", cli: "release-build", phase: "postcommit" },
  { id: "I-07.source-bundle", invariant: "I-07", category: "source bundle", authority: "allowed artifact root", observer: "protected observer", predicate: "checkSideEffects", cli: "release-preflight", phase: "postcommit" },
  { id: "I-07.stale-evidence", invariant: "I-07", category: "stale evidence", authority: "post-commit scope evidence", observer: "scope observer", predicate: "checkSideEffects", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.stale-cache", invariant: "I-08", category: "stale cache", authority: "ApprovalRecord cache", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.tampered-tag", invariant: "I-08", category: "tampered tag", authority: "annotated tag", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.tampered-report", invariant: "I-08", category: "tampered ClosureReport", authority: "ClosureReport", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.tag-baseline", invariant: "I-08", category: "tag baseline missing", authority: "durable tag baseline", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.tag-hash", invariant: "I-08", category: "tag hash missing", authority: "durable tag hash", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.observer-error", invariant: "I-08", category: "observer error", authority: "canonical refs/artifact", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
  { id: "I-08.validator-write", invariant: "I-08", category: "validator tracked/ref/protected write", authority: "canonical facts", observer: "recovery observer", predicate: "checkRecovery", cli: "release-preflight", phase: "postcommit" },
]);

test("I-01 rejects pathHash and accepts classification-only scope", () => {
  assert.equal(checkPlan({ version, baseHead: scope.baseHead, scope, git: { head: scope.baseHead } }).result, "PASS");
  assert.equal(checkPlan({ version, baseHead: scope.baseHead, scope: { ...scope, entries: [{ path: "x", pathHash: "a".repeat(64) }] }, git: { head: scope.baseHead } }).result, "FAIL");
});
test("I-01 staged plan identity rejects current/design/history drift", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0281-plan-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fixture }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture }); execFileSync("git", ["config", "user.name", "test"], { cwd: fixture }); execFileSync("git", ["branch", "-M", "main"], { cwd: fixture });
    await mkdir(path.join(fixture, "docs/design", "docs/iterations/history"), { recursive: true }); await mkdir(path.join(fixture, "docs/iterations/history"), { recursive: true });
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "0.28.0" })); await writeFile(path.join(fixture, "VERSION.md"), "## v0.28.0\n"); await writeFile(path.join(fixture, "docs/iterations/current.md"), "当前唯一版本：`v0.28.0`\n"); await writeFile(path.join(fixture, "docs/iterations/history/v0.28.0.md"), "# v0.28.0\n"); await writeFile(path.join(fixture, "docs/design/old.md"), "old\n");
    execFileSync("git", ["add", "."], { cwd: fixture }); execFileSync("git", ["commit", "-qm", "base"], { cwd: fixture }); const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
    const design = "docs/design/v0.28.1 plan.md"; const entries = ["package.json", "VERSION.md", "docs/design/v0.28.1 plan.md", "docs/iterations/current.md", "docs/iterations/history/v0.28.1.md", "docs/iterations/scopes/v0.28.1.json"].map((file) => ({ path: file, classification: "record-only", owner: "elon", reason: "fixture", state: file.includes("scopes") || file.includes("design") || file.includes("history") ? "added" : "modified" })); const scopeFixture = { schemaVersion: "release-scope-v1", phase: "pre-commit", version: "v0.28.1", baseHead: base, scopeManifestPath: "docs/iterations/scopes/v0.28.1.json", paths: entries }; scopeFixture.scopeDigest = computeScopeDigest(entries, scopeFixture.scopeManifestPath);
    await writeFile(path.join(fixture, "package.json"), JSON.stringify({ version: "0.28.1" })); await writeFile(path.join(fixture, "VERSION.md"), "## v0.28.1 — plan\n"); await writeFile(path.join(fixture, "docs/iterations/current.md"), `当前唯一版本：\`v0.28.1\`\n[plan](../design/${encodeURIComponent(design)})\n`); await writeFile(path.join(fixture, "docs/iterations/history/v0.28.1.md"), "# v0.28.1\n"); await writeFile(path.join(fixture, design), "plan\n"); await mkdir(path.join(fixture, "docs/iterations/scopes"), { recursive: true }); await writeFile(path.join(fixture, "docs/iterations/scopes/v0.28.1.json"), JSON.stringify(scopeFixture)); execFileSync("git", ["add", "."], { cwd: fixture });
    assert.doesNotThrow(() => assertVersionIdentityFromStaged(fixture, "v0.28.1"));
    const versionPath = path.join(fixture, "VERSION.md"); const validVersion = await readFile(versionPath);
    await writeFile(versionPath, Buffer.concat([validVersion, Buffer.from("\n## v0.28.1 duplicate\n")])); execFileSync("git", ["add", versionPath], { cwd: fixture }); assert.throws(() => assertVersionIdentityFromStaged(fixture, "v0.28.1"), /staged version\/current\/design\/history identity mismatch/);
    await writeFile(versionPath, "## v0.28.0\nlegacy\n\n## v0.28.1 — plan\n"); execFileSync("git", ["add", versionPath], { cwd: fixture }); assert.throws(() => assertVersionIdentityFromStaged(fixture, "v0.28.1"), /staged version\/current\/design\/history identity mismatch/);
    await writeFile(versionPath, validVersion); execFileSync("git", ["add", versionPath], { cwd: fixture }); await writeFile(path.join(fixture, "docs/iterations/current.md"), "当前唯一版本：`v0.28.1`\nwrong\n"); execFileSync("git", ["add", "docs/iterations/current.md"], { cwd: fixture }); assert.throws(() => assertVersionIdentityFromStaged(fixture, "v0.28.1"), /staged version\/current\/design\/history identity mismatch/);
  } finally { await import("node:fs/promises").then(({ rm }) => rm(fixture, { recursive: true, force: true })); }
});
test("I-02 candidate is deterministic and binds tree/baseline", () => {
  assert.equal(computeCandidateIdentityHash(candidate), candidate.candidateHash); assert.equal(checkCandidate({ candidate, git: { treeOid, working: { worktreeDiffHash: emptyHash, untrackedHash: emptyHash } }, protectedBaseline: baseline }).result, "PASS");
  assert.equal(checkCandidate({ candidate, git: { treeOid: "0".repeat(40), working: { worktreeDiffHash: emptyHash, untrackedHash: emptyHash } }, protectedBaseline: baseline }).result, "FAIL");
});
test("I-03 approval binds one exact candidate without duplicating scope", () => { assert.equal(checkApproval({ approval, candidate }).result, "PASS"); assert.equal(checkApproval({ approval: { ...approval, candidateHash: "c".repeat(64) }, candidate }).result, "FAIL"); assert.equal(checkApproval({ approval: { ...approval, scopeDigest: candidate.scopeDigest }, candidate }).result, "FAIL"); });
test("I-04 rejects working or protected drift", () => { assert.equal(checkPrecommit({ approval, candidate, git: { treeOid, working: { worktreeDiffHash: emptyHash } }, protectedBefore: baseline, protectedAfter: baseline }).result, "PASS"); assert.equal(checkPrecommit({ approval, candidate, git: { treeOid, working: { worktreeDiffHash: "d".repeat(64) } }, protectedBefore: baseline, protectedAfter: { ...baseline, hash: "e".repeat(64) } }).result, "FAIL"); });
test("I-05 requires commit parent/tree/trailer and annotated tag", () => { assert.equal(checkGitClosure({ approval, commit: "c".repeat(40), parent: approval.baseHead, tree: approval.approvedTreeOid, trailer: approval.approvalHash, tag: { object: "t".repeat(40), type: "tag", target: "c".repeat(40), approvalHash: approval.approvalHash } }).result, "PASS"); assert.equal(checkGitClosure({ approval, commit: "c".repeat(40), parent: approval.baseHead, tree: approval.approvedTreeOid, trailer: approval.approvalHash, tag: { object: "t".repeat(40), type: "commit", target: "c".repeat(40), approvalHash: approval.approvalHash } }).result, "FAIL"); });
test("I-06 rejects subordinate authority duplication", () => { const artifact = { productArtifactId: "v0.28.1-123456789abc", productVersion: version, productCommit: "c".repeat(40), productArtifactHash: "d".repeat(64), approvalHash: approval.approvalHash, candidateHash: approval.candidateHash, approvedTreeOid: approval.approvedTreeOid, documents: { contentManifest: { approvalHash: "x" } } }; assert.equal(checkArtifact({ artifact, approval, commit: artifact.productCommit }).result, "FAIL"); });
test("I-07 accepts only a single expected artifact delta", () => { assert.equal(checkSideEffects({ baselineBefore: baseline, baselineAfter: { ...baseline, hash: "f".repeat(64) }, closureDiff: { immutableUnchanged: true, onlyExpectedArtifact: true, artifactClientExact: { exact: true }, extraAdded: [], deleted: [], modified: [] } }).result, "PASS"); assert.equal(checkSideEffects({ baselineBefore: baseline, baselineAfter: { ...baseline, hash: "f".repeat(64) }, closureDiff: { immutableUnchanged: true, onlyExpectedArtifact: false, artifactClientExact: { exact: true }, extraAdded: [{ path: "x" }], deleted: [], modified: [] } }).result, "FAIL"); });
test("I-08 recovery is read-only and rejects authority writes", () => { assert.equal(checkRecovery({ tagRecovery: { verified: true }, cacheBefore: { authorityHash: "a" }, cacheAfter: { authorityHash: "a" }, wroteAuthority: false }).result, "PASS"); assert.equal(checkRecovery({ tagRecovery: { verified: true }, wroteAuthority: true }).result, "FAIL"); });
test("all invariant predicates are exactly the closed eight", () => { const ids = evaluateInvariants({}).map((entry) => entry.id); assert.deepEqual(ids, ["I-01", "I-02", "I-03", "I-04", "I-05", "I-06", "I-07", "I-08"]); });
test("protected baseline is a single bounded authority payload", () => { assert.equal(typeof baseline.hash, "string"); assert.equal(Array.isArray(baseline.roots), true); assert.equal(Object.hasOwn(baseline, "records"), false); assert.equal(canonicalJson(baseline).includes("sourceDirectory"), false); });

test("D2 protected observer records mode and real symlink target", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0281-protected-"));
  try {
    await mkdir(path.join(fixture, ".content-workspace", "content"), { recursive: true });
    await writeFile(path.join(fixture, ".content-workspace", "content", "source.json"), "one");
    execFileSync("git", ["init", "-q"], { cwd: fixture });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture });
    execFileSync("git", ["config", "user.name", "test"], { cwd: fixture });
    execFileSync("git", ["add", "."], { cwd: fixture });
    execFileSync("git", ["commit", "-qm", "fixture"], { cwd: fixture });
    const first = captureProtectedFacts(fixture);
    const firstRecord = first.roots.find((entry) => entry.root === ".content-workspace/content").records.find((entry) => entry.path.endsWith("source.json"));
    assert.equal(typeof firstRecord.mode, "string");
    await chmod(path.join(fixture, ".content-workspace", "content", "source.json"), 0o600);
    const modeChanged = captureProtectedFacts(fixture);
    assert.notEqual(modeChanged.hash, first.hash);
    await symlink("source.json", path.join(fixture, ".content-workspace", "content", "alias"));
    const linkA = captureProtectedFacts(fixture);
    const alias = path.join(fixture, ".content-workspace", "content", "alias"); await unlink(alias); await symlink("missing-target", alias);
    const linkB = captureProtectedFacts(fixture);
    assert.notEqual(linkA.hash, linkB.hash);
    assert.equal(validateProtectedFacts(linkB).hash, linkB.hash);
  } finally { await import("node:fs/promises").then(({ rm }) => rm(fixture, { recursive: true, force: true })); }
});

test("D3 ProductArtifact root is sole identity and subordinate is client-only", () => {
  const productVersion = "v0.28.1"; const productCommit = "1".repeat(40); const artifactId = `${productVersion}-${productCommit.slice(0, 12)}`;
  const release = { schemaVersion: "product-artifact-release-v2", productVersion, productCommit, productArtifactId: artifactId, baseSiteArtifactId: artifactId, approvalHash: "a".repeat(64), candidateHash: "b".repeat(64), approvedTreeOid: "2".repeat(40), contentManifestHash: "0".repeat(64), baseSiteArtifactManifestHash: "0".repeat(64), clientFiles: [] };
  const contentManifest = { schemaVersion: "content-manifest-v2", publishedSlugs: [] };
  const baseSiteArtifact = { materializationKind: "client", clientPath: `.content-workspace/base-site-artifacts/${artifactId}/client`, clientHash: "2".repeat(64), clientFiles: [{ path: "index.html", sha256: "3".repeat(64) }], releaseManifestHash: hashArtifactValue(release), artifactContentHash: hashArtifactValue({ release, contentManifest }), sourceDeploymentId: "prepared-dist" };
  release.contentManifestHash = hashArtifactValue(contentManifest); release.baseSiteArtifactManifestHash = hashArtifactValue(baseSiteArtifact); release.clientFiles = [{ path: "base-site-artifact.json", sha256: "4".repeat(64) }]; release.productArtifactHash = computeProductArtifactHash(release);
  assert.doesNotThrow(() => resolveProductArtifactIdentity({ release, contentManifest, baseSiteArtifact }));
  assert.throws(() => resolveProductArtifactIdentity({ release: { ...release, approvalHash: undefined }, contentManifest, baseSiteArtifact }), /approvalHash/);
  assert.throws(() => resolveProductArtifactIdentity({ release, contentManifest, baseSiteArtifact: { ...baseSiteArtifact, productVersion } }), /duplicate ProductArtifact authority/);
  assert.throws(() => validateBaseSiteArtifact({ ...baseSiteArtifact, clientPath: `${artifactId}/source` }), /clientPath/);
});

test("D3 closure diff rejects source or external artifact additions", () => {
  const before = { roots: [], allowedRoot: { root: ".content-workspace/base-site-artifacts", records: [] } };
  const after = { roots: [], allowedRoot: { root: ".content-workspace/base-site-artifacts", records: [{ path: "v0.28.1-111111111111/source/file.js", kind: "file", mode: "644", bytes: 1, hash: "a".repeat(64) }, { path: "external.txt", kind: "file", mode: "644", bytes: 1, hash: "b".repeat(64) }] } };
  const diff = diffProtectedFacts(before, after, "v0.28.1-111111111111");
  assert.equal(diff.onlyExpectedArtifact, false); assert.ok(diff.extraAdded.length > 0);
});

test("D4 canonical publishers use immutable client and approval-record inputs", async () => {
  const unified = await readFile(path.join(root, "scripts", "unified-publish.mjs"), "utf8"); const content = await readFile(path.join(root, "scripts", "content-release.mjs"), "utf8"); const publication = await readFile(path.join(root, "scripts", "lib", "site-publication.mjs"), "utf8");
  assert.doesNotMatch(unified, /approval-envelope\.json/); assert.match(unified, /approval-record\.json/); assert.doesNotMatch(unified, /assemble:\s*true/); assert.doesNotMatch(content, /assemble:\s*true/); assert.match(content, /canonical content-only publication does not assemble/);
  assert.match(publication, /ContentSet active pointer is required for canonical ProductArtifact SitePublication/);
});

test("D4 client-only content build copies the immutable client without sourceDirectory", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0281-client-content-"));
  try {
    const artifactId = "v0.28.1-" + "a".repeat(12);
    const immutableClient = path.join(fixture, ".content-workspace", "base-site-artifacts", artifactId, "client");
    const packageDirectory = path.join(fixture, "package");
    await mkdir(immutableClient, { recursive: true });
    await writeFile(path.join(immutableClient, "release.json"), JSON.stringify({ schemaVersion: "product-artifact-release-v2", productVersion: version, productCommit: "a".repeat(40) }));
    await mkdir(packageDirectory, { recursive: true });
    const manifest = { contentReleaseId: "article-demo-" + "b".repeat(16), logicalContentId: "article:demo", kind: "article", target: "demo", contentHash: "c".repeat(64), targetPath: "/business-observations", state: "prepared", baseSiteArtifactId: artifactId };
    const manifestPath = path.join(packageDirectory, "content-release.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const built = await buildContentRelease({ sourceRoot: fixture, packageInfo: { ...manifest, packageDirectory, manifestPath, baseSiteArtifact: { materializationKind: "client", clientPath: `.content-workspace/base-site-artifacts/${artifactId}/client` } } });
    assert.equal(built.materializationKind, "client");
    assert.equal((await readFile(path.join(built.client, "release.json"), "utf8")) !== "", true);
    assert.equal(await stat(path.join(packageDirectory, "source")).then(() => true).catch(() => false), false);
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(fixture, { recursive: true, force: true }));
  }
});

test("D5 tag recovery rejects stale approval cache but accepts missing caches", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0281-recovery-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: fixture }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture }); execFileSync("git", ["config", "user.name", "test"], { cwd: fixture });
    await mkdir(path.join(fixture, "docs/rules"), { recursive: true }); await writeFile(path.join(fixture, "docs/rules/task-registry.md"), "| `elon` | owner | `01a00637-f0b0-79c3-aa1e-6dd463dd37d1` | host | return |\n");
    await writeFile(path.join(fixture, "README.md"), "base\n"); execFileSync("git", ["add", "."], { cwd: fixture }); execFileSync("git", ["commit", "-qm", "base"], { cwd: fixture });
    const baseHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
    await writeFile(path.join(fixture, "candidate.txt"), "candidate\n"); execFileSync("git", ["add", "candidate.txt"], { cwd: fixture });
    const tree = execFileSync("git", ["write-tree"], { cwd: fixture, encoding: "utf8" }).trim(); const baseline = captureProtectedFacts(fixture); const registryPathHash = sha256Bytes(await readFile(path.join(fixture, "docs/rules/task-registry.md")));
    const candidate = { schemaVersion: "release-candidate-identity-v1", version, baseHead, treeOid: tree, scopeDigest: "a".repeat(64), protectedBaselineHash: baseline.hash }; candidate.candidateHash = computeCandidateIdentityHash(candidate);
    const approval = { schemaVersion: "release-approval-record-v1", version, candidateHash: candidate.candidateHash, baseHead, approvedTreeOid: tree, approver: { task: "elon", threadId: "01a00637-f0b0-79c3-aa1e-6dd463dd37d1", registryPath: "docs/rules/task-registry.md", registryPathHash }, verdict: "READY_FOR_COMMIT" }; approval.approvalHash = (await import("../scripts/lib/release-transaction.mjs")).computeApprovalRecordHash(approval);
    const commit = execFileSync("git", ["commit-tree", tree, "-p", baseHead], { cwd: fixture, encoding: "utf8", input: `fixture\n\nXingbuild-Approval: ${approval.approvalHash}\n` }).trim();
    const body = durableApprovalTagMessage({ candidate, approval, baseline }); execFileSync("git", ["tag", "-a", version, commit, "-m", body], { cwd: fixture });
    await mkdir(path.dirname(approvalRecordPath(fixture, version)), { recursive: true }); await writeFile(approvalRecordPath(fixture, version), `${JSON.stringify({ ...approval, approvalHash: "c".repeat(64) })}\n`);
    await assert.rejects(() => readApprovalRecord(fixture, version, null, { requireCurrentIdentity: false, allowTagRecovery: true }), /ApprovalRecord hash mismatch|cache drift/);
    const transaction = await import("../scripts/lib/release-transaction.mjs"); const wrongRegistry = { ...approval, approver: { ...approval.approver, registryPathHash: "d".repeat(64) } }; wrongRegistry.approvalHash = transaction.computeApprovalRecordHash(wrongRegistry); await writeFile(approvalRecordPath(fixture, version), `${JSON.stringify(wrongRegistry)}\n`); await assert.rejects(() => readApprovalRecord(fixture, version, null, { requireCurrentIdentity: false, allowTagRecovery: true }), /registry snapshot drift|cache drift/);
    await unlink(approvalRecordPath(fixture, version));
    const recovered = await readApprovalRecord(fixture, version, null, { requireCurrentIdentity: false, allowTagRecovery: true }); assert.equal(recovered.approvalHash, approval.approvalHash); assert.equal(recovered.candidate.candidateHash, candidate.candidateHash);
  } finally { await import("node:fs/promises").then(({ rm }) => rm(fixture, { recursive: true, force: true })); }
});

test("D6 formal CLI chain commits, builds, preflights, and recovers from tag", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0281-cli-"));
  const buildScript = `import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, cp } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd(); const canonicalRoot = process.env.XINGBUILD_CANONICAL_ROOT; await mkdir(path.join(root, ".content-workspace", "qa"), { recursive: true }); await writeFile(path.join(root, ".content-workspace", "qa", "fixture-build-ran"), "yes");
const { createBaseSiteArtifact, hashArtifactValue } = await import(pathToFileURL(path.join(canonicalRoot, "scripts/lib/base-site-artifact.mjs")).href);
const { computeProductArtifactHash } = await import(pathToFileURL(path.join(canonicalRoot, "scripts/lib/product-artifact.mjs")).href);
const version = process.env.XINGBUILD_PRODUCT_VERSION; const commit = process.env.XINGBUILD_PRODUCT_COMMIT; const id = version + "-" + commit.slice(0, 12);
const dist = path.join(root, "dist", "client"); await mkdir(dist, { recursive: true });
const contentManifest = { schemaVersion: "content-manifest-v2", publishedSlugs: [], publishedArticleSlugs: [] };
await writeFile(path.join(dist, "index.html"), "<!doctype html><main>fixture</main>\\n"); await writeFile(path.join(dist, "content-manifest.json"), JSON.stringify(contentManifest));
const approval = { approvalHash: process.env.XINGBUILD_APPROVAL_HASH, candidateHash: process.env.XINGBUILD_CANDIDATE_HASH, approvedTreeOid: process.env.XINGBUILD_APPROVED_TREE_OID };
const provisional = { schemaVersion: "product-artifact-release-v2", productVersion: version, productCommit: commit, productArtifactId: id, baseSiteArtifactId: id, ...approval, contentManifestHash: "0".repeat(64), baseSiteArtifactManifestHash: "0".repeat(64), clientFiles: [] };
await writeFile(path.join(dist, "release.json"), JSON.stringify(provisional));
const descriptor = await createBaseSiteArtifact({ sourceRoot: root, clientDirectory: dist, productVersion: version, productCommit: commit, release: provisional, contentManifest });
await writeFile(path.join(dist, "base-site-artifact.json"), JSON.stringify(descriptor));
async function entries(dir, current = "") { const result = []; for (const entry of await readdir(path.join(dir, current), { withFileTypes: true })) { const rel = path.posix.join(current, entry.name); const abs = path.join(dir, current, entry.name); if (entry.isDirectory()) result.push(...await entries(dir, rel)); else result.push({ path: rel, sha256: createHash("sha256").update(await readFile(abs)).digest("hex") }); } return result.sort((a,b)=>a.path.localeCompare(b.path)); }
const clientFiles = (await entries(dist)).filter((entry) => entry.path !== "release.json");
const release = { ...provisional, contentManifestHash: hashArtifactValue(contentManifest), baseSiteArtifactManifestHash: hashArtifactValue(descriptor), clientFiles };
release.productArtifactHash = computeProductArtifactHash(release); await writeFile(path.join(dist, "release.json"), JSON.stringify(release));
await cp(dist, path.join(root, descriptor.clientPath), { recursive: true, force: true });
`;
  try {
    const baseArchive = execFileSync("git", ["archive", scope.baseHead], { cwd: root, maxBuffer: 64 * 1024 * 1024 });
    execFileSync("tar", ["-xf", "-"], { cwd: fixture, input: baseArchive });
    await writeFile(path.join(fixture, "fixture-build.mjs"), buildScript); await writeFile(path.join(fixture, "fixture-prepare.mjs"), `import { mkdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
const root = process.cwd(); const action = process.env.XINGBUILD_MATRIX_ACTION;
const content = path.join(root, ".content-workspace", "content"); await mkdir(content, { recursive: true });
if (action === "command-write" || action === "root-modify") await writeFile(path.join(content, "matrix-seed.json"), "mutated");
if (action === "root-delete") await unlink(path.join(content, "matrix-seed.json"));
if (action === "root-add" || action === "command-write") await writeFile(path.join(content, "matrix-added.json"), "added");
process.exit(0);
`);
    execFileSync("git", ["init", "-q"], { cwd: fixture }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture }); execFileSync("git", ["config", "user.name", "test"], { cwd: fixture }); execFileSync("git", ["branch", "-M", "main"], { cwd: fixture });
    execFileSync("git", ["add", "."], { cwd: fixture }); execFileSync("git", ["commit", "-qm", "fixture base"], { cwd: fixture }); const fixtureBase = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim();
    const candidateArchive = execFileSync("git", ["archive", legacyTreeOid], { cwd: root, maxBuffer: 64 * 1024 * 1024 }); execFileSync("tar", ["-xf", "-"], { cwd: fixture, input: candidateArchive });
    const fixturePackage = JSON.parse(await readFile(path.join(fixture, "package.json"), "utf8")); fixturePackage.version = "0.28.1"; fixturePackage.scripts.build = "node fixture-build.mjs"; fixturePackage.scripts.check = "node -e \\\"console.log('fixture check')\\\""; fixturePackage.scripts["release:prepare"] = "node fixture-prepare.mjs"; fixturePackage.scripts["test:release-transaction"] = "node -e \\\"console.log('fixture transaction check')\\\""; await writeFile(path.join(fixture, "package.json"), `${JSON.stringify(fixturePackage, null, 2)}\n`); await writeFile(path.join(fixture, "tests/v0281-release-transaction.test.mjs"), "import test from 'node:test'; test('fixture formal check', () => {});\n");
    const fixtureScopePath = path.join(fixture, "docs/iterations/scopes/v0.28.1.json"); const fixtureScope = JSON.parse(await readFile(fixtureScopePath, "utf8")); fixtureScope.baseHead = fixtureBase; await writeFile(fixtureScopePath, `${JSON.stringify(fixtureScope, null, 2)}\n`);
    execFileSync("git", ["add", "-A"], { cwd: fixture }); await mkdir(path.join(fixture, ".content-workspace/qa/v0.28.1"), { recursive: true }); await mkdir(path.join(fixture, ".content-workspace/content"), { recursive: true }); await writeFile(path.join(fixture, ".content-workspace/content/matrix-seed.json"), "seed"); await mkdir(path.join(fixture, ".content-workspace/base-site-artifacts/legacy-v0.27/client"), { recursive: true }); await writeFile(path.join(fixture, ".content-workspace/base-site-artifacts/legacy-v0.27/client/legacy.txt"), "legacy"); await writeFile(path.join(fixture, ".content-workspace/qa/v0.28.1/qa-browser-install-policy.json"), JSON.stringify({ status: "passed", policyVersion: "qa-browser-install-policy-v1", version: "v0.28.1" }));
    const approvalFixtureScript = path.join(fixture, ".content-workspace", "fixture-elon-approve.mjs"); await mkdir(path.dirname(approvalFixtureScript), { recursive: true }); await writeFile(approvalFixtureScript, `import { mkdir, readFile, writeFile } from "node:fs/promises"; import path from "node:path"; import { pathToFileURL } from "node:url"; const root=process.cwd(); const canonical=process.env.XINGBUILD_CANONICAL_ROOT; const tx=await import(pathToFileURL(path.join(canonical,"scripts/lib/release-transaction.mjs")).href); const version="v0.28.1"; const candidate=JSON.parse(await readFile(tx.candidateIdentityPath(root,version),"utf8")); const approval=tx.createApprovalRecord({root,version,candidate}); await mkdir(path.dirname(tx.approvalRecordPath(root,version)),{recursive:true}); await writeFile(tx.approvalRecordPath(root,version),JSON.stringify(approval,null,2)+"\\n");\n`);
    const runCli = (script, args = [], env = {}) => spawnSync(process.execPath, [path.join(fixture, script), ...args], { cwd: fixture, encoding: "utf8", env: { ...process.env, XINGBUILD_CANONICAL_ROOT: root, ...env } });
    const cli = (script, args = [], env = {}) => { const result = runCli(script, args, env); if (result.status !== 0) throw new Error(`${script} failed: ${result.stdout}\n${result.stderr}`); return result; };
    const cliFails = (script, args = [], env = {}) => assert.notEqual(runCli(script, args, env).status, 0, `${script} must fail`);
    const matrixResults = [];
    const candidateTreeBaseline = execFileSync("git", ["write-tree"], { cwd: fixture, encoding: "utf8" }).trim();
    const resetCandidateProtected = async () => {
      await mkdir(path.join(fixture, ".content-workspace/content"), { recursive: true });
      await writeFile(path.join(fixture, ".content-workspace/content/matrix-seed.json"), "seed");
      await rm(path.join(fixture, ".content-workspace/content/matrix-added.json"), { force: true });
    };
    const restoreCandidateState = async () => {
      execFileSync("git", ["read-tree", candidateTreeBaseline], { cwd: fixture }); execFileSync("git", ["checkout-index", "-a", "-f"], { cwd: fixture }); execFileSync("git", ["clean", "-fd"], { cwd: fixture });
      await resetCandidateProtected();
    };
    const stageJson = async (file, value) => { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`); execFileSync("git", ["add", file], { cwd: fixture }); };
    const mutateCandidateRow = async (id) => {
      if (id === "I-01.version-missing") { await writeFile(path.join(fixture, "VERSION.md"), "## v0.28.0\n"); execFileSync("git", ["add", "VERSION.md"], { cwd: fixture }); return; }
      if (id === "I-01.version-duplicate") { const bytes = await readFile(path.join(fixture, "VERSION.md")); await writeFile(path.join(fixture, "VERSION.md"), Buffer.concat([bytes, Buffer.from("\n## v0.28.1 duplicate\n")])); execFileSync("git", ["add", "VERSION.md"], { cwd: fixture }); return; }
      if (id === "I-01.version-order") { await writeFile(path.join(fixture, "VERSION.md"), "## v0.28.0\nlegacy\n\n## v0.28.1 — plan\n"); execFileSync("git", ["add", "VERSION.md"], { cwd: fixture }); return; }
      if (id === "I-01.base-mismatch") { const value = JSON.parse(await readFile(fixtureScopePath, "utf8")); value.baseHead = "0".repeat(40); await stageJson(fixtureScopePath, value); return; }
      if (id === "I-01.scope-mismatch") { const value = JSON.parse(await readFile(fixtureScopePath, "utf8")); value.scopeDigest = "0".repeat(64); await stageJson(fixtureScopePath, value); return; }
      if (id === "I-01.design-mismatch") { await writeFile(path.join(fixture, "docs/iterations/current.md"), "当前唯一版本：`v0.28.1`\n[wrong](../design/wrong.md)\n"); execFileSync("git", ["add", "docs/iterations/current.md"], { cwd: fixture }); return; }
      if (id === "I-01.pathHash") { const value = JSON.parse(await readFile(fixtureScopePath, "utf8")); value.paths[0].pathHash = "a".repeat(64); value.scopeDigest = computeScopeDigest(value.paths, value.scopeManifestPath); await stageJson(fixtureScopePath, value); return; }
      if (id === "I-01.declared-missing") { const value = JSON.parse(await readFile(fixtureScopePath, "utf8")); value.paths = value.paths.slice(1); value.scopeDigest = computeScopeDigest(value.paths, value.scopeManifestPath); await stageJson(fixtureScopePath, value); return; }
      if (id === "I-01.declared-extra") { const value = JSON.parse(await readFile(fixtureScopePath, "utf8")); value.paths.push({ classification: "record-only", owner: "matrix", path: "matrix-declared-extra.md", reason: "formal negative", state: "added" }); value.scopeDigest = computeScopeDigest(value.paths, value.scopeManifestPath); await stageJson(fixtureScopePath, value); return; }
      if (id === "I-02.index-drift") { await writeFile(path.join(fixture, "README.md"), "index drift\n"); execFileSync("git", ["add", "README.md"], { cwd: fixture }); return; }
      if (id === "I-02.unstaged") { await writeFile(path.join(fixture, "VERSION.md"), "unstaged drift\n"); return; }
      if (id === "I-02.mode") { const target = path.join(fixture, "scripts/release-candidate-freeze.mjs"); await chmod(target, 0o755); execFileSync("git", ["add", target], { cwd: fixture }); return; }
      if (id === "I-02.rename") { execFileSync("git", ["mv", "VERSION.md", "VERSION.matrix-renamed.md"], { cwd: fixture }); return; }
      if (id === "I-02.unknown-untracked") { await writeFile(path.join(fixture, "unknown-matrix.txt"), "unknown\n"); return; }
      if (id === "I-02.candidate-field") { const file = path.join(fixture, ".content-workspace/qa/v0.28.1/candidate-identity.json"); const value = JSON.parse(await readFile(file, "utf8")); value.candidateHash = "0".repeat(64); await writeFile(file, JSON.stringify(value)); return; }
      throw new Error(`missing candidate matrix mutation: ${id}`);
    };
    for (const row of FORMAL_NEGATIVE_MATRIX.filter((entry) => entry.phase === "candidate")) {
      await restoreCandidateState(); cli("scripts/release-candidate-check.mjs"); cli("scripts/release-candidate-freeze.mjs");
      if (row.id.startsWith("I-07.")) {
        const action = row.id.slice("I-07.".length); const result = runCli("scripts/release-candidate-check.mjs", ["--run-checks"], { XINGBUILD_MATRIX_ACTION: action }); assert.notEqual(result.status, 0, `${row.id} must fail through formal candidate-check`); matrixResults.push({ ...row, result: "PASS", exitCode: result.status, outputHash: sha256Bytes(Buffer.from(`${result.stdout || ""}${result.stderr || ""}`)) });
      } else {
        await mutateCandidateRow(row.id); const script = row.cli === "release-candidate-freeze" ? "scripts/release-candidate-freeze.mjs" : "scripts/release-candidate-check.mjs"; const result = runCli(script); assert.notEqual(result.status, 0, `${row.id} must fail through formal ${script}: ${result.stdout || ""}${result.stderr || ""}`); matrixResults.push({ ...row, result: "PASS", exitCode: result.status, outputHash: sha256Bytes(Buffer.from(`${result.stdout || ""}${result.stderr || ""}`)) });
      }
    }
    await restoreCandidateState();
    cli("scripts/release-candidate-check.mjs"); cli("scripts/release-candidate-freeze.mjs"); cli(".content-workspace/fixture-elon-approve.mjs");
    const approvalPathFixture = path.join(fixture, ".content-workspace/qa/v0.28.1/approval-record.json");
    const restoreApprovedState = async () => { await restoreCandidateState(); cli("scripts/release-candidate-check.mjs"); cli("scripts/release-candidate-freeze.mjs"); cli(".content-workspace/fixture-elon-approve.mjs"); };
    const mutateCloseoutRow = async (id) => {
      if (id === "I-03.registry") { const value = JSON.parse(await readFile(approvalPathFixture, "utf8")); value.approver.registryPathHash = "0".repeat(64); value.approvalHash = computeApprovalRecordHash(value); await writeFile(approvalPathFixture, JSON.stringify(value)); return; }
      if (id === "I-03.tree") { const value = JSON.parse(await readFile(approvalPathFixture, "utf8")); value.approvedTreeOid = "0".repeat(40); value.approvalHash = computeApprovalRecordHash(value); await writeFile(approvalPathFixture, JSON.stringify(value)); return; }
      if (id === "I-03.candidate") { const value = JSON.parse(await readFile(approvalPathFixture, "utf8")); value.candidateHash = "0".repeat(64); value.approvalHash = computeApprovalRecordHash(value); await writeFile(approvalPathFixture, JSON.stringify(value)); return; }
      if (id === "I-03.cache") { const value = JSON.parse(await readFile(approvalPathFixture, "utf8")); value.approvalHash = "0".repeat(64); await writeFile(approvalPathFixture, JSON.stringify(value)); return; }
      if (id === "I-04.implementation") { await writeFile(path.join(fixture, "scripts/check-project.mjs"), "implementation drift\n"); execFileSync("git", ["add", "scripts/check-project.mjs"], { cwd: fixture }); return; }
      if (id === "I-04.record-only") { await writeFile(path.join(fixture, "docs/iterations/current.md"), "record-only drift\n"); execFileSync("git", ["add", "docs/iterations/current.md"], { cwd: fixture }); return; }
      if (id === "I-04.scope") { const value = JSON.parse(await readFile(fixtureScopePath, "utf8")); value.paths[0].reason += " drift"; value.scopeDigest = computeScopeDigest(value.paths, value.scopeManifestPath); await stageJson(fixtureScopePath, value); return; }
      if (id === "I-04.VERSION") { await writeFile(path.join(fixture, "VERSION.md"), "VERSION working drift\n"); return; }
      if (id === "I-04.index") { await writeFile(path.join(fixture, "README.md"), "index working drift\n"); execFileSync("git", ["add", "README.md"], { cwd: fixture }); return; }
      if (id === "I-04.working") { await writeFile(path.join(fixture, "README.md"), "working drift\n"); return; }
      throw new Error(`missing closeout matrix mutation: ${id}`);
    };
    for (const row of FORMAL_NEGATIVE_MATRIX.filter((entry) => entry.phase === "closeout")) {
      await restoreApprovedState(); await mutateCloseoutRow(row.id); const result = runCli("scripts/release-closeout-check.mjs"); assert.notEqual(result.status, 0, `${row.id} must fail through formal closeout-check`); matrixResults.push({ ...row, result: "PASS", exitCode: result.status, outputHash: sha256Bytes(Buffer.from(`${result.stdout || ""}${result.stderr || ""}`)) });
    }
    await restoreApprovedState();
    const versionBytes = await readFile(path.join(fixture, "VERSION.md")); await writeFile(path.join(fixture, "VERSION.md"), Buffer.concat([versionBytes, Buffer.from("working drift\n")])); cliFails("scripts/release-closeout-check.mjs"); await writeFile(path.join(fixture, "VERSION.md"), versionBytes);
    const scopeBytes = await readFile(fixtureScopePath); const scopeDrift = JSON.parse(scopeBytes); scopeDrift.paths[0].reason += " drift"; await writeFile(fixtureScopePath, JSON.stringify(scopeDrift)); execFileSync("git", ["add", fixtureScopePath], { cwd: fixture }); cliFails("scripts/release-closeout-check.mjs"); await writeFile(fixtureScopePath, scopeBytes); execFileSync("git", ["add", fixtureScopePath], { cwd: fixture });
    const modeTarget = path.join(fixture, "scripts/release-candidate-freeze.mjs"); const originalMode = (await stat(modeTarget)).mode & 0o777; await chmod(modeTarget, 0o755); execFileSync("git", ["add", modeTarget], { cwd: fixture }); cliFails("scripts/release-closeout-check.mjs"); await chmod(modeTarget, originalMode); execFileSync("git", ["add", modeTarget], { cwd: fixture });
    const linkPath = path.join(fixture, "unexpected-link"); await symlink("VERSION.md", linkPath); execFileSync("git", ["add", "unexpected-link"], { cwd: fixture }); cliFails("scripts/release-closeout-check.mjs"); execFileSync("git", ["reset", "-q", "--", "unexpected-link"], { cwd: fixture }); await unlink(linkPath);
    cli("scripts/release-closeout-check.mjs");
    for (const row of FORMAL_NEGATIVE_MATRIX.filter((entry) => entry.phase === "commit")) {
      await restoreApprovedState(); cli("scripts/release-closeout-check.mjs"); const mainBefore = execFileSync("git", ["rev-parse", "main"], { cwd: fixture, encoding: "utf8" }).trim(); let result;
      if (row.id === "I-05.tag-exists") { execFileSync("git", ["tag", "-a", "v0.28.1", "-m", "existing tag", fixtureBase], { cwd: fixture }); result = runCli("scripts/release-commit.mjs", ["--approval", ".content-workspace/qa/v0.28.1/approval-record.json"]); execFileSync("git", ["tag", "-d", "v0.28.1"], { cwd: fixture }); }
      else if (row.id === "I-05.tag-construction") { const name = execFileSync("git", ["config", "user.name"], { cwd: fixture, encoding: "utf8" }).trim(); const email = execFileSync("git", ["config", "user.email"], { cwd: fixture, encoding: "utf8" }).trim(); execFileSync("git", ["config", "--unset", "user.name"], { cwd: fixture }); execFileSync("git", ["config", "--unset", "user.email"], { cwd: fixture }); result = runCli("scripts/release-commit.mjs", ["--approval", ".content-workspace/qa/v0.28.1/approval-record.json"]); execFileSync("git", ["config", "user.name", name], { cwd: fixture }); execFileSync("git", ["config", "user.email", email], { cwd: fixture }); }
      else { const lock = path.join(fixture, ".git/refs/heads/main.lock"); await writeFile(lock, "concurrent ref writer\n"); result = runCli("scripts/release-commit.mjs", ["--approval", ".content-workspace/qa/v0.28.1/approval-record.json"]); await unlink(lock); }
      assert.notEqual(result.status, 0, `${row.id} must fail through formal release-commit`); assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: fixture, encoding: "utf8" }).trim(), mainBefore); let tagPresent = true; try { execFileSync("git", ["rev-parse", "refs/tags/v0.28.1"], { cwd: fixture, encoding: "utf8", stdio: "ignore" }); } catch { tagPresent = false; } assert.equal(tagPresent, false, `${row.id} must not leave a partial tag ref`); matrixResults.push({ ...row, result: "PASS", exitCode: result.status, outputHash: sha256Bytes(Buffer.from(`${result.stdout || ""}${result.stderr || ""}`)) });
    }
    execFileSync("git", ["tag", "-a", "v0.28.1", "-m", "race fixture", fixtureBase], { cwd: fixture }); const mainBeforePartial = execFileSync("git", ["rev-parse", "main"], { cwd: fixture, encoding: "utf8" }).trim(); cliFails("scripts/release-commit.mjs", ["--approval", ".content-workspace/qa/v0.28.1/approval-record.json"]); assert.equal(execFileSync("git", ["rev-parse", "main"], { cwd: fixture, encoding: "utf8" }).trim(), mainBeforePartial); assert.equal(execFileSync("git", ["rev-parse", "v0.28.1^{commit}"], { cwd: fixture, encoding: "utf8" }).trim(), fixtureBase); execFileSync("git", ["tag", "-d", "v0.28.1"], { cwd: fixture });
    cli("scripts/release-commit.mjs", ["--approval", ".content-workspace/qa/v0.28.1/approval-record.json"]);
    cli("scripts/release-build.mjs", [], { XINGBUILD_CANONICAL_ROOT: root }); const fixtureDist = await import("node:fs/promises").then(({ readdir }) => readdir(path.join(fixture, "dist"), { withFileTypes: true }).catch(() => [])); assert.equal(await stat(path.join(fixture, ".content-workspace/qa/fixture-build-ran")).then(() => true).catch(() => false), true, "formal build command must execute fixture build"); assert.equal(await stat(path.join(fixture, "dist/client/release.json")).then(() => true).catch(() => false), true, `formal build must leave ProductArtifact client (${fixtureDist.map((entry) => entry.name).join(",")})`); cli("scripts/release-preflight.mjs");
    const committedHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim(); const originalTagObject = execFileSync("git", ["rev-parse", "refs/tags/v0.28.1"], { cwd: fixture, encoding: "utf8" }).trim(); const postScopePath = path.join(fixture, ".content-workspace/qa/v0.28.1/release-scope-postcommit.json"); const closurePath = path.join(fixture, ".content-workspace/qa/v0.28.1/closure-report.json"); const originalScopeEvidence = await readFile(postScopePath); const originalClosure = await readFile(closurePath); const originalApprovalCache = await readFile(approvalPathFixture); const candidateCachePath = path.join(fixture, ".content-workspace/qa/v0.28.1/candidate-identity.json"); const originalCandidateCache = await readFile(candidateCachePath); const originalRelease = await readFile(path.join(fixture, "dist/client/release.json")); const originalDistFiles = {}; for (const relative of ["index.html", "content-manifest.json", "release.json", "base-site-artifact.json"]) originalDistFiles[relative] = await readFile(path.join(fixture, "dist/client", relative)); const currentArtifactRoot = path.join(fixture, ".content-workspace/base-site-artifacts", `v0.28.1-${committedHead.slice(0, 12)}`); const currentStoredClient = path.join(currentArtifactRoot, "client"); const originalStoredFiles = {}; for (const relative of ["index.html", "release.json", "base-site-artifact.json"]) originalStoredFiles[relative] = await readFile(path.join(currentStoredClient, relative)); const legacyFile = path.join(fixture, ".content-workspace/base-site-artifacts/legacy-v0.27/client/legacy.txt"); const originalLegacy = await readFile(legacyFile);
    const resetPostState = async () => {
      execFileSync("git", ["update-ref", "refs/heads/main", committedHead], { cwd: fixture }); execFileSync("git", ["update-ref", "refs/tags/v0.28.1", originalTagObject], { cwd: fixture });
      for (const [relative, bytes] of Object.entries(originalDistFiles)) await writeFile(path.join(fixture, "dist/client", relative), bytes); for (const [relative, bytes] of Object.entries(originalStoredFiles)) await writeFile(path.join(currentStoredClient, relative), bytes); await writeFile(legacyFile, originalLegacy); await writeFile(postScopePath, originalScopeEvidence); await writeFile(closurePath, originalClosure); await writeFile(approvalPathFixture, originalApprovalCache); await writeFile(candidateCachePath, originalCandidateCache); await rm(path.join(currentArtifactRoot, "source"), { recursive: true, force: true }); await rm(path.join(fixture, ".content-workspace/base-site-artifacts/extra-matrix.txt"), { force: true }); await rm(path.join(fixture, ".content-workspace/base-site-artifacts/legacy-v0.27/client/matrix-extra.txt"), { force: true });
    };
    const installMalformedReleaseRef = (kind) => {
      const currentTree = execFileSync("git", ["rev-parse", `${committedHead}^{tree}`], { cwd: fixture, encoding: "utf8" }).trim(); const emptyTree = execFileSync("git", ["mktree"], { cwd: fixture, input: "", encoding: "utf8" }).trim(); const parent = kind === "parent" ? committedHead : fixtureBase; const tree = kind === "tree" ? emptyTree : currentTree; const trailer = kind === "trailer" ? "bad commit\n" : `bad commit\n\nXingbuild-Approval: ${JSON.parse(originalApprovalCache).approvalHash}\n`; const badCommit = execFileSync("git", ["commit-tree", tree, "-p", parent], { cwd: fixture, input: trailer, encoding: "utf8" }).trim(); const tagger = execFileSync("git", ["config", "user.name"], { cwd: fixture, encoding: "utf8" }).trim() + " <" + execFileSync("git", ["config", "user.email"], { cwd: fixture, encoding: "utf8" }).trim() + "> " + Math.floor(Date.now() / 1000) + " +0000"; const body = durableApprovalTagMessage({ candidate: JSON.parse(originalCandidateCache), approval: JSON.parse(originalApprovalCache), baseline: captureProtectedFacts(fixture) }); const tagInput = `object ${badCommit}\ntype commit\ntag v0.28.1\ntagger ${tagger}\n\n${body}`; const badTag = execFileSync("git", ["mktag"], { cwd: fixture, input: tagInput, encoding: "utf8" }).trim(); execFileSync("git", ["update-ref", "refs/heads/main", badCommit], { cwd: fixture }); execFileSync("git", ["update-ref", "refs/tags/v0.28.1", badTag], { cwd: fixture }); return { badCommit, badTag };
    };
    for (const row of FORMAL_NEGATIVE_MATRIX.filter((entry) => entry.phase === "postcommit")) {
      await resetPostState(); let result;
      if (["I-03.tag", "I-05.parent", "I-05.tree", "I-05.trailer"].includes(row.id)) { const kind = row.id === "I-05.parent" ? "parent" : row.id === "I-05.tree" ? "tree" : row.id === "I-05.trailer" ? "trailer" : "tag"; if (kind === "tag") { const badTag = execFileSync("git", ["tag", "-a", "v0.28.1-matrix-bad", "-m", "no durable transaction", committedHead], { cwd: fixture, encoding: "utf8" }).trim(); const badObject = execFileSync("git", ["rev-parse", "refs/tags/v0.28.1-matrix-bad"], { cwd: fixture, encoding: "utf8" }).trim(); execFileSync("git", ["update-ref", "refs/tags/v0.28.1", badObject], { cwd: fixture }); execFileSync("git", ["update-ref", "-d", "refs/tags/v0.28.1-matrix-bad"], { cwd: fixture }); } else installMalformedReleaseRef(kind); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-06.old-dist") { await writeFile(path.join(fixture, "dist/client/index.html"), "old dist\n"); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-06.root-missing" || row.id === "I-06.root-replaced" || row.id === "I-06.commit" || row.id === "I-06.tree" || row.id === "I-06.approval") { const value = JSON.parse(originalRelease); const field = row.id.endsWith("commit") ? "productCommit" : row.id.endsWith("tree") ? "approvedTreeOid" : row.id.endsWith("approval") ? "approvalHash" : "candidateHash"; if (row.id === "I-06.root-missing") delete value.candidateHash; else value[field] = field === "productCommit" ? "0".repeat(40) : field === "approvedTreeOid" ? "0".repeat(40) : "0".repeat(64); if (row.id !== "I-06.root-missing") value.productArtifactHash = computeProductArtifactHash(value); await writeFile(path.join(fixture, "dist/client/release.json"), JSON.stringify(value)); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-06.subordinate-hash" || row.id === "I-06.duplicate") { const file = path.join(currentStoredClient, "base-site-artifact.json"); const value = JSON.parse(await readFile(file, "utf8")); if (row.id === "I-06.duplicate") value.approvalHash = "0".repeat(64); else value.releaseManifestHash = "0".repeat(64); await writeFile(file, JSON.stringify(value)); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-06.subordinate-bytes") { await writeFile(path.join(currentStoredClient, "index.html"), "subordinate bytes\n"); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-07.old-artifact-modify") { await writeFile(legacyFile, "modified legacy\n"); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-07.old-artifact-delete") { await unlink(legacyFile); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-07.extra-artifact") { await writeFile(path.join(fixture, ".content-workspace/base-site-artifacts/extra-matrix.txt"), "extra\n"); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-07.existing-target") { result = runCli("scripts/release-build.mjs", [], { XINGBUILD_CANONICAL_ROOT: root }); }
      else if (row.id === "I-07.source-bundle") { await mkdir(path.join(currentArtifactRoot, "source"), { recursive: true }); await writeFile(path.join(currentArtifactRoot, "source/file.js"), "source\n"); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-07.stale-evidence") { const value = JSON.parse(originalScopeEvidence); value.committedHead = "0".repeat(40); await writeFile(postScopePath, JSON.stringify(value)); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-08.stale-cache") { const value = JSON.parse(originalApprovalCache); value.approvalHash = "0".repeat(64); await writeFile(approvalPathFixture, JSON.stringify(value)); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-08.tampered-tag") { const badObject = execFileSync("git", ["mktag"], { cwd: fixture, input: `object ${committedHead}\ntype commit\ntag v0.28.1\ntagger Matrix <matrix@example.invalid> 0 +0000\n\nnot durable\n`, encoding: "utf8" }).trim(); execFileSync("git", ["update-ref", "refs/tags/v0.28.1", badObject], { cwd: fixture }); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-08.tampered-report") { const value = JSON.parse(originalClosure); value.protectedCurrentHash = "0".repeat(64); await writeFile(closurePath, JSON.stringify(value)); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-08.tag-baseline" || row.id === "I-08.tag-hash") { const durableCandidate = JSON.parse(originalCandidateCache); const durableApproval = JSON.parse(originalApprovalCache); if (row.id === "I-08.tag-baseline") { const badPayload = { candidate: durableCandidate, approval: durableApproval, sideEffectBaseline: null }; const badObject = execFileSync("git", ["mktag"], { cwd: fixture, input: `object ${committedHead}\ntype commit\ntag v0.28.1\ntagger Matrix <matrix@example.invalid> 0 +0000\n\nXingbuild-Release-Transaction: ${canonicalJson(badPayload)}`, encoding: "utf8" }).trim(); execFileSync("git", ["update-ref", "refs/tags/v0.28.1", badObject], { cwd: fixture }); } else { delete durableApproval.approvalHash; const badPayload = { candidate: durableCandidate, approval: durableApproval, sideEffectBaseline: captureProtectedFacts(fixture) }; const badObject = execFileSync("git", ["mktag"], { cwd: fixture, input: `object ${committedHead}\ntype commit\ntag v0.28.1\ntagger Matrix <matrix@example.invalid> 0 +0000\n\nXingbuild-Release-Transaction: ${canonicalJson(badPayload)}`, encoding: "utf8" }).trim(); execFileSync("git", ["update-ref", "refs/tags/v0.28.1", badObject], { cwd: fixture }); } result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-08.observer-error") { execFileSync("git", ["update-ref", "-d", "refs/tags/v0.28.1"], { cwd: fixture }); result = runCli("scripts/release-preflight.mjs"); }
      else if (row.id === "I-08.validator-write") { const value = JSON.parse(originalClosure); value.protectedCurrentHash = "0".repeat(64); await writeFile(closurePath, JSON.stringify(value)); const beforeFacts = captureProtectedFacts(fixture); const beforeHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim(); const beforeTag = execFileSync("git", ["rev-parse", "refs/tags/v0.28.1"], { cwd: fixture, encoding: "utf8" }).trim(); const beforeIndex = execFileSync("git", ["diff", "--cached", "--binary"], { cwd: fixture, encoding: "buffer" }); result = runCli("scripts/release-preflight.mjs"); assert.notEqual(result.status, 0); assert.equal(captureProtectedFacts(fixture).hash, beforeFacts.hash); assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim(), beforeHead); assert.equal(execFileSync("git", ["rev-parse", "refs/tags/v0.28.1"], { cwd: fixture, encoding: "utf8" }).trim(), beforeTag); assert.equal(execFileSync("git", ["diff", "--cached", "--binary"], { cwd: fixture, encoding: "buffer" }).equals(beforeIndex), true); }
      else throw new Error(`missing postcommit matrix mutation: ${row.id}`);
      assert.notEqual(result.status, 0, `${row.id} must fail through formal ${row.cli}`); matrixResults.push({ ...row, result: "PASS", exitCode: result.status, outputHash: sha256Bytes(Buffer.from(`${result.stdout || ""}${result.stderr || ""}`)) });
    }
    await resetPostState();
    const releasePath = path.join(fixture, "dist/client/release.json"); const releaseBytes = await readFile(releasePath); const releaseRoot = JSON.parse(releaseBytes); for (const field of ["approvalHash", "candidateHash", "approvedTreeOid"]) { const missing = { ...releaseRoot }; delete missing[field]; await writeFile(releasePath, JSON.stringify(missing)); cliFails("scripts/release-preflight.mjs"); const replaced = { ...releaseRoot, [field]: field === "approvedTreeOid" ? "0".repeat(40) : "0".repeat(64) }; replaced.productArtifactHash = computeProductArtifactHash(replaced); await writeFile(releasePath, JSON.stringify(replaced)); cliFails("scripts/release-preflight.mjs"); } await writeFile(releasePath, releaseBytes);
    const storedClient = path.join(fixture, ".content-workspace", "base-site-artifacts", `v0.28.1-${execFileSync("git", ["rev-parse", "HEAD"], { cwd: fixture, encoding: "utf8" }).trim().slice(0, 12)}`, "client"); for (const relative of ["index.html", "release.json", "base-site-artifact.json"]) { const stored = path.join(storedClient, relative); const original = await readFile(stored); await writeFile(stored, Buffer.concat([original, Buffer.from("tampered\n")])); cliFails("scripts/release-preflight.mjs"); await writeFile(stored, original); cli("scripts/release-preflight.mjs"); }
    await unlink(path.join(fixture, ".content-workspace/qa/v0.28.1/candidate-identity.json")); await unlink(path.join(fixture, ".content-workspace/qa/v0.28.1/approval-record.json")); cli("scripts/release-preflight.mjs");
    await writeFile(path.join(fixture, ".content-workspace/qa/v0.28.1/approval-record.json"), JSON.stringify({ schemaVersion: "release-approval-record-v1", approvalHash: "0".repeat(64) })); const tampered = spawnSync(process.execPath, [path.join(fixture, "scripts/release-preflight.mjs")], { cwd: fixture, encoding: "utf8", env: { ...process.env, XINGBUILD_CANONICAL_ROOT: root } }); assert.notEqual(tampered.status, 0); await unlink(path.join(fixture, ".content-workspace/qa/v0.28.1/approval-record.json")); cli("scripts/release-preflight.mjs");
    assert.equal(matrixResults.length, FORMAL_NEGATIVE_MATRIX.length, `formal matrix coverage incomplete: ${matrixResults.length}/${FORMAL_NEGATIVE_MATRIX.length}`); await writeFile(path.join(fixture, ".content-workspace/qa/v0.28.1/formal-negative-matrix.json"), `${JSON.stringify({ schemaVersion: "v0.28.1-formal-negative-matrix-v1", authority: "docs/design/v0.28.1 Release Transaction 不可变批准与提交事务方案.md §8", rows: matrixResults }, null, 2)}\n`);
    const artifact = JSON.parse(await readFile(path.join(fixture, "dist/client/release.json"), "utf8")); assert.equal(artifact.approvalHash.length, 64); assert.equal(execFileSync("git", ["cat-file", "-t", "refs/tags/v0.28.1"], { cwd: fixture, encoding: "utf8" }).trim(), "tag");
  } finally { await import("node:fs/promises").then(({ rm }) => rm(fixture, { recursive: true, force: true })); }
});

test("D6 canonical production entries cannot bypass ApprovalRecord", () => {
  const headBefore = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  for (const script of ["scripts/release-commit.mjs", "scripts/release-build.mjs", "scripts/release-preflight.mjs"]) {
    const result = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8", env: { ...process.env, XINGBUILD_RELEASE_TRANSACTION_TEST_FIXTURE: "1" } });
    assert.notEqual(result.status, 0, `${script} must reject missing ApprovalRecord`);
    assert.match(`${result.stdout || ""}${result.stderr || ""}`, /approval|ApprovalRecord|tag/i);
  }
  assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), headBefore);
});

test("D6 ordinary npm build cannot persist a canonical ProductArtifact record", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0281-ordinary-build-"));
  try {
    const archive = execFileSync("git", ["archive", stagedTreeOid(root)], { cwd: root, maxBuffer: 64 * 1024 * 1024 }); execFileSync("tar", ["-xf", "-"], { cwd: fixture, input: archive });
    await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules")); execFileSync("git", ["init", "-q"], { cwd: fixture }); execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: fixture }); execFileSync("git", ["config", "user.name", "test"], { cwd: fixture }); execFileSync("git", ["add", "."], { cwd: fixture }); execFileSync("git", ["commit", "-qm", "isolated canonical fixture"], { cwd: fixture });
    const artifactRoot = path.join(fixture, ".content-workspace", "base-site-artifacts"); const list = async () => (await import("node:fs/promises")).readdir(artifactRoot).then((entries) => entries.sort()).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error)); const before = await list();
    const result = spawnSync("npm", ["run", "build"], { cwd: fixture, encoding: "utf8", env: { ...process.env, XINGBUILD_FINAL_BUILD: "", XINGBUILD_APPROVAL_HASH: "", XINGBUILD_CANDIDATE_HASH: "", XINGBUILD_APPROVED_TREE_OID: "" }, maxBuffer: 16 * 1024 * 1024 }); assert.notEqual(result.status, 0, "ordinary npm build must stop before ProductArtifact materialization"); assert.match(`${result.stdout || ""}${result.stderr || ""}`, /ApprovalRecord identity|final release build/i); assert.deepEqual(await list(), before, "ordinary npm build must not add a canonical ProductArtifact record");
  } finally { await import("node:fs/promises").then(({ rm }) => rm(fixture, { recursive: true, force: true })); }
});
