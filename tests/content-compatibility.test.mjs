import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ALLOWED_CONTENT_IMPACTS,
  CONTENT_IMPACT_VALUES,
  assertProductContentCompatibility,
  readV0280BreakingEvidence,
  readContentImpact,
} from "../scripts/lib/content-compatibility.mjs";

function currentWith(overrides = {}) {
  const values = {
    contentImpact: "compatible",
    contentImpactReason: "contract-unification",
    compatibilityEvidence: "v0.25.12-content-impact-contract",
    ...overrides,
  };
  return [
    "# current",
    `contentImpact: ${values.contentImpact}`,
    `contentImpactReason: ${values.contentImpactReason}`,
    "affectedTargets: [release-gates]",
    "affectedRoutes: []",
    "affectedFields: [contentImpact, contentImpactReason]",
    `compatibilityEvidence: ${values.compatibilityEvidence}`,
  ].join("\n");
}

test("content impact exposes one closed machine enum", () => {
  assert.deepEqual(CONTENT_IMPACT_VALUES, ["none", "compatible", "compatible-metadata-correction", "compatible-joint-first-activation", "migration-required", "breaking", "unknown"]);
  assert.deepEqual(ALLOWED_CONTENT_IMPACTS, ["none", "compatible", "compatible-metadata-correction", "compatible-joint-first-activation"]);
});

test("v0.28.4 descriptive compatible impact remains one existing gate class", () => {
  const result = assertProductContentCompatibility({ currentText: currentWith({ contentImpact: "compatible-public-runtime-readiness-and-same-deployment-recovery" }) });
  assert.equal(result.contentImpact, "compatible-public-runtime-readiness-and-same-deployment-recovery");
  assert.equal(result.compatibilityClass, "compatible");
});

for (const contentImpact of CONTENT_IMPACT_VALUES) {
  test(`content impact ${contentImpact} has the same release-gate decision`, () => {
    const run = () => assertProductContentCompatibility({ currentText: currentWith({ contentImpact }) });
    if (ALLOWED_CONTENT_IMPACTS.includes(contentImpact)) {
      assert.doesNotThrow(run);
      return;
    }
    assert.throws(run, (error) => error.code === "PRODUCT_CONTENT_INCOMPATIBLE" && /Product Incident/.test(error.message));
  });
}

test("unknown or free-text content impact is rejected before transport", () => {
  assert.throws(
    () => assertProductContentCompatibility({ currentText: currentWith({ contentImpact: "compatible-style-ownership-correction" }) }),
    (error) => error.code === "PRODUCT_CONTENT_IMPACT_INVALID" && /compatible-style-ownership-correction/.test(error.message),
  );
});

test("missing content impact, reason, or evidence is a contract failure", () => {
  for (const [field, expected] of [
    ["contentImpact", "contentImpact"],
    ["contentImpactReason", "contentImpactReason"],
    ["compatibilityEvidence", "compatibilityEvidence"],
  ]) {
    const lines = currentWith().split("\n").filter((line) => !line.startsWith(`${field}:`));
    assert.throws(
      () => assertProductContentCompatibility({ currentText: lines.join("\n") }),
      (error) => error.code === "PRODUCT_CONTENT_CONTRACT_INVALID" && error.missingFields.includes(expected),
    );
  }
});

test("contentImpactReason is returned as evidence and never interpreted as machine state", () => {
  const currentText = currentWith({ contentImpactReason: "breaking-change-explanation" });
  const parsed = readContentImpact(currentText);
  assert.equal(parsed.contentImpact, "compatible");
  assert.equal(parsed.contentImpactReason, "breaking-change-explanation");
  assert.doesNotThrow(() => assertProductContentCompatibility({ currentText }));
});

function v0280Current() {
  return [
    "# 当前迭代",
    "## 当前唯一版本：`v0.28.0`",
    "contentImpact: breaking",
    "contentImpactReason: content-data-plane-runtime-and-content-only-publication",
    "compatibilityEvidence: requires-v0.28.0-content-migration-and-runtime-evidence",
  ].join("\n");
}

function v0280Evidence() {
  const acceptance = {};
  for (const key of ["SA-00", "SA-01", "SA-02", "SA-03", "SA-04", "SA-05", "SA-07", "SA-08", "SA-10", "SA-11"]) {
    acceptance[key] = { status: "PASS" };
  }
  acceptance["SA-06"] = { status: "N/A" };
  acceptance["SA-09"] = { status: "N/A" };
  return {
    schemaVersion: "content-data-plane-evidence-v1",
    version: "v0.28.0",
    baseHead: "a".repeat(40),
    scope: { version: "v0.28.0", baseHead: "a".repeat(40) },
    acceptance,
    noWrites: { canonicalActive: true, contentPublish: false, productTransport: false, physicalCleanup: false },
    scenarios: { runtime: {}, deterministic: {}, changedOnly: {}, cas: {}, materialization: {} },
    productArtifact: { buildCount: 0, transport: "not-authorized" },
  };
}

test("v0.28.0 breaking compatibility requires a real evidence envelope", () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "xingbuild-v0280-compat-"));
  const evidenceDir = path.join(projectRoot, ".content-workspace", "qa", "v0280-content-data-plane");
  mkdirSync(evidenceDir, { recursive: true });
  writeFileSync(path.join(evidenceDir, "evidence.json"), `${JSON.stringify(v0280Evidence())}\n`);
  assert.doesNotThrow(() => assertProductContentCompatibility({ currentText: v0280Current(), projectRoot }));
  const evidence = readV0280BreakingEvidence({ projectRoot });
  assert.equal(evidence.verified, true);
});

test("v0.28.0 breaking compatibility rejects missing or drifted evidence", () => {
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), "xingbuild-v0280-compat-missing-"));
  assert.throws(
    () => assertProductContentCompatibility({ currentText: v0280Current(), projectRoot }),
    (error) => error.code === "PRODUCT_CONTENT_INCOMPATIBLE" && error.evidence.code === "V0280_EVIDENCE_MISSING",
  );
  const evidenceDir = path.join(projectRoot, ".content-workspace", "qa", "v0280-content-data-plane");
  mkdirSync(evidenceDir, { recursive: true });
  const evidence = v0280Evidence();
  evidence.acceptance["SA-03"] = { status: "PASS", evidence: "placeholder" };
  evidence.noWrites.productTransport = true;
  writeFileSync(path.join(evidenceDir, "evidence.json"), `${JSON.stringify(evidence)}\n`);
  assert.throws(
    () => assertProductContentCompatibility({ currentText: v0280Current(), projectRoot }),
    (error) => error.code === "PRODUCT_CONTENT_INCOMPATIBLE" && error.evidence.noWriteMismatch.length === 1,
  );
});
