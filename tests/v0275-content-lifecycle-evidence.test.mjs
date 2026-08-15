import assert from "node:assert/strict";
import test from "node:test";
import { createLifecycleEvidence, reduceLifecycleAcceptance, validateLifecycleEvidence } from "../scripts/lib/content-lifecycle-evidence-v0275.mjs";

test("v0.27.5 real scenario evidence has no placeholders and passes the pre-commit checklist", async () => {
  const evidence = await createLifecycleEvidence({ sourceRoot: process.cwd(), allowedPaths: ["package.json", "scripts/lib/content-lifecycle-evidence-v0275.mjs", "scripts/check-project.mjs", "scripts/release-build.mjs", "scripts/release-closeout-check.mjs", "scripts/release-preflight.mjs"], excludedExternalPaths: ["AGENTS.md", "docs/rules/task-onboarding.md"], excludedExternalReason: "pre-existing external workflow discussion; excluded by Xing v0.27.5 boundary" });
  validateLifecycleEvidence(evidence);
  assert.equal(evidence.stage, "pre-commit");
  assert.equal(evidence.commit, null);
  assert.deepEqual(Object.fromEntries(Object.entries(evidence.acceptance).map(([id, result]) => [id, result.status])), {
    "C-01": "PASS", "C-02": "PASS", "C-03": "PASS", "C-04": "PASS", "C-05": "PASS",
    "C-06": "PASS", "C-07": "PASS", "C-08": "PASS", "C-09": "PASS", "C-10": "PASS",
  });
  assert.match(evidence.scenarios.update.after.sourceHash, /^[a-f0-9]{64}$/);
  assert.match(evidence.scenarios.update.after.valueHash, /^[a-f0-9]{64}$/);
  assert.ok(evidence.inventory.records.every((record) => typeof record.logicalId === "string" && record.logicalId.length > 0));
  assert.equal(evidence.zeroWrite.physicalDeletion, false);
});

test("v0.27.5 reducer rejects placeholder scenario values and incomplete provenance", () => {
  const evidence = {
    schemaVersion: "content-lifecycle-evidence-v3",
    stage: "pre-commit",
    commit: null,
    tag: null,
    baseHead: "a".repeat(40),
    scopeDigest: "b".repeat(64),
    provenance: { realRun: true, runId: "run-real", fixtureHash: "c".repeat(64) },
    fixture: { runId: "run-real", fixtureHash: "c".repeat(64) },
    scenarios: { update: { changedOnly: true, changedTargets: ["demo"], before: {}, after: {}, exactEvidence: "exact-byte-evidence" } },
    inventory: {},
    zeroWrite: {},
    productionPublish: { authorized: false, executed: false },
  };
  const result = reduceLifecycleAcceptance({ evidence });
  assert.equal(result["C-02"].status, "FAIL");
  assert.equal(result["C-03"].status, "FAIL");
  assert.equal(result["C-10"].status, "PASS");
});

test("v0.27.5 post-commit identity cannot be claimed before READY_FOR_COMMIT", () => {
  const evidence = { schemaVersion: "content-lifecycle-evidence-v3", stage: "pre-commit", commit: "a".repeat(40), tag: "v0.27.5", tagCommit: "a".repeat(40), productArtifactId: "v0.27.5-x", artifactHash: "b".repeat(64), baseSiteArtifactId: "v0.27.5-x", baseHead: "a".repeat(40), scopeDigest: "c".repeat(64), scope: { allowedPaths: ["scripts/check-project.mjs", "scripts/release-build.mjs", "scripts/release-closeout-check.mjs", "scripts/release-preflight.mjs"], excludedExternalPaths: ["AGENTS.md", "docs/rules/task-onboarding.md"], excludedExternalReason: "external" }, provenance: { realRun: true }, fixture: { runId: "run", fixtureHash: "d".repeat(64) }, scenarios: {}, inventory: {}, zeroWrite: {}, productionPublish: { executed: false } };
  assert.equal(reduceLifecycleAcceptance({ evidence })["C-01"].status, "PASS");
  assert.equal(reduceLifecycleAcceptance({ evidence })["C-10"].status, "FAIL");
});

test("v0.27.5 validator rejects stored acceptance drift and stage mismatch", async () => {
  const evidence = await createLifecycleEvidence({ sourceRoot: process.cwd(), allowedPaths: ["scripts/check-project.mjs", "scripts/release-build.mjs", "scripts/release-closeout-check.mjs", "scripts/release-preflight.mjs"], excludedExternalPaths: ["AGENTS.md", "docs/rules/task-onboarding.md"], excludedExternalReason: "external" });
  const record = evidence.inventory.records.find((candidate) => candidate.hashMode === "exact-byte") || evidence.inventory.records[0];
  const node = evidence.inventory.referenceGraph.nodes.find((candidate) => candidate.id === record.path) || evidence.inventory.referenceGraph.nodes[0];
  const output = evidence.outputRootEvidence[0];
  const compact = {
    ...evidence,
    inventory: { ...evidence.inventory, records: [record], summary: { ...evidence.inventory.summary, records: 1 }, rootManifest: { ...evidence.inventory.rootManifest, roots: [evidence.inventory.rootManifest.roots[0]] }, referenceGraph: { ...evidence.inventory.referenceGraph, nodes: [node], edges: [], unresolved: [], external: [] } },
    outputRootEvidence: [output],
  };
  compact.acceptance = reduceLifecycleAcceptance({ evidence: compact });
  validateLifecycleEvidence(compact);
  const evidenceUnderTest = compact;
  const originalScopeDigest = evidenceUnderTest.acceptance["C-01"].evidence.scopeDigest;
  evidenceUnderTest.acceptance["C-01"].evidence.scopeDigest = "0".repeat(64);
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_ACCEPTANCE_DRIFT/);
  evidenceUnderTest.acceptance["C-01"].evidence.scopeDigest = originalScopeDigest;
  const originalStage = evidenceUnderTest.stage;
  evidenceUnderTest.stage = "post-commit";
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest, { requirePostCommit: true }), /V0275_ACCEPTANCE_DRIFT|V0275_POST_COMMIT/);
  evidenceUnderTest.stage = originalStage;
  evidenceUnderTest.scenarios.update.exactEvidence = "tests/fixture-output.json";
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /path substitution|V0275_ACCEPTANCE_DRIFT/);
  delete evidenceUnderTest.scenarios.update.exactEvidence;
  for (const scenario of ["update", "add", "noChange", "failureInjection", "recovery"]) {
    const originalRunId = evidenceUnderTest.scenarios[scenario].runId;
    delete evidenceUnderTest.scenarios[scenario].runId;
    assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_EVIDENCE_FAILED|V0275_ACCEPTANCE_DRIFT/);
    evidenceUnderTest.scenarios[scenario].runId = originalRunId;
  }
  const originalUnchanged = evidenceUnderTest.scenarios.update.unchangedIdentity;
  delete evidenceUnderTest.scenarios.update.unchangedIdentity;
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_EVIDENCE_FAILED|V0275_ACCEPTANCE_DRIFT/);
  evidenceUnderTest.scenarios.update.unchangedIdentity = originalUnchanged;
  const originalMalformed = evidenceUnderTest.scenarios.update.unchangedIdentity;
  evidenceUnderTest.scenarios.update.unchangedIdentity = [{ targetId: "observation:keep", entryId: "observation:keep", contentHash: "not-a-hash" }];
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_EVIDENCE_FAILED|V0275_ACCEPTANCE_DRIFT/);
  evidenceUnderTest.scenarios.update.unchangedIdentity = originalMalformed;
  const originalTargets = evidenceUnderTest.scenarios.add.changedTargets;
  evidenceUnderTest.scenarios.add.changedTargets = originalTargets.filter((target) => target !== evidenceUnderTest.scenarios.add.after.entryId);
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_EVIDENCE_FAILED|V0275_ACCEPTANCE_DRIFT/);
  evidenceUnderTest.scenarios.add.changedTargets = originalTargets;
  const originalProductId = evidenceUnderTest.scenarios.noChange.deterministicInput.productArtifactId;
  delete evidenceUnderTest.scenarios.noChange.deterministicInput.productArtifactId;
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_EVIDENCE_FAILED|V0275_ACCEPTANCE_DRIFT/);
  evidenceUnderTest.scenarios.noChange.deterministicInput.productArtifactId = originalProductId;
  const originalContentId = evidenceUnderTest.scenarios.noChange.deterministicInput.contentSetId;
  evidenceUnderTest.scenarios.noChange.deterministicInput.contentSetId = "content-set-drift";
  assert.throws(() => validateLifecycleEvidence(evidenceUnderTest), /V0275_EVIDENCE_FAILED|V0275_ACCEPTANCE_DRIFT/);
  evidenceUnderTest.scenarios.noChange.deterministicInput.contentSetId = originalContentId;
});

test("v0.27.5 post identity requires annotated tag type and root manifest binding", () => {
  const base = { schemaVersion: "content-lifecycle-evidence-v3", stage: "post-commit", version: "v0.27.5", commit: "a".repeat(40), tag: "v0.27.5", tagType: "tag", tagCommit: "a".repeat(40), productVersion: "v0.27.5", productCommit: "a".repeat(40), productArtifactId: "v0.27.5-a", artifactHash: "b".repeat(64), baseSiteArtifactId: "v0.27.5-a", rootManifestHash: "c".repeat(64), inventory: { rootManifestHash: "c".repeat(64) }, baseHead: "a".repeat(40), scopeDigest: "d".repeat(64), scope: { allowedPaths: ["scripts/check-project.mjs", "scripts/release-build.mjs", "scripts/release-closeout-check.mjs", "scripts/release-preflight.mjs"], excludedExternalPaths: ["AGENTS.md", "docs/rules/task-onboarding.md"], excludedExternalReason: "external" }, provenance: { realRun: true }, fixture: { runId: "run", fixtureHash: "e".repeat(64) }, scenarios: {}, inventoryHash: "f".repeat(64), zeroWrite: {}, productionPublish: { authorized: false, executed: false } };
  assert.equal(reduceLifecycleAcceptance({ evidence: base })["C-01"].status, "PASS");
  assert.equal(reduceLifecycleAcceptance({ evidence: { ...base, tagType: "commit" } })["C-01"].status, "FAIL");
  assert.equal(reduceLifecycleAcceptance({ evidence: { ...base, rootManifestHash: "0".repeat(64) } })["C-01"].status, "FAIL");
});
