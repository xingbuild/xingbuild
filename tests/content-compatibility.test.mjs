import assert from "node:assert/strict";
import test from "node:test";
import {
  ALLOWED_CONTENT_IMPACTS,
  CONTENT_IMPACT_VALUES,
  assertProductContentCompatibility,
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
  assert.deepEqual(CONTENT_IMPACT_VALUES, ["none", "compatible", "compatible-metadata-correction", "migration-required", "breaking", "unknown"]);
  assert.deepEqual(ALLOWED_CONTENT_IMPACTS, ["none", "compatible", "compatible-metadata-correction"]);
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
