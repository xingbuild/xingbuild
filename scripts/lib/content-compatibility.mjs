/**
 * Product/content compatibility is a product contract, not an operational
 * guess.  Every release gate and the coordinator use this module so the
 * machine state cannot drift from the current contract.
 *
 * v0.28.0 is the first version whose formal contract intentionally declares
 * `contentImpact: breaking`: the content data plane changes the publication
 * input boundary and therefore requires a real, local migration/runtime
 * evidence envelope before any gate may proceed.  That exception is kept
 * here, rather than in individual gates, so all callers make the same
 * decision and an arbitrary `breaking` string can never become an override.
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
export const CONTENT_IMPACT_VALUES = Object.freeze([
  "none",
  "compatible",
  "compatible-metadata-correction",
  "compatible-joint-first-activation",
  "migration-required",
  "breaking",
  "unknown",
]);

export const ALLOWED_CONTENT_IMPACTS = Object.freeze([
  "none",
  "compatible",
  "compatible-metadata-correction",
  "compatible-joint-first-activation",
]);

// v0.28.4's current contract gives the compatible change a descriptive
// record value.  Keep the machine enum closed and normalize that approved
// record wording to the existing compatible gate class.
const V0284_COMPATIBLE_RECORD_VALUE = "compatible-public-runtime-readiness-and-same-deployment-recovery";

const V0280_VERSION = "v0.28.0";
const V0280_REASON = "content-data-plane-runtime-and-content-only-publication";
const V0280_EVIDENCE_MARKER = "requires-v0.28.0-content-migration-and-runtime-evidence";
const V0280_EVIDENCE_RELATIVE_PATH = ".content-workspace/qa/v0280-content-data-plane/evidence.json";
const V0280_ACCEPTANCE = Object.freeze({
  "SA-00": "PASS",
  "SA-01": "PASS",
  "SA-02": "PASS",
  "SA-03": "PASS",
  "SA-04": "PASS",
  "SA-05": "PASS",
  "SA-06": "N/A",
  "SA-07": "PASS",
  "SA-08": "PASS",
  "SA-09": "N/A",
  "SA-10": "PASS",
  "SA-11": "PASS",
});

export function readContentImpact(currentText = "") {
  const value = currentText.match(/^contentImpact:\s*([^\n#]+)/m)?.[1]?.trim() || null;
  const contentImpactReason = currentText.match(/^contentImpactReason:\s*([^\n#]+)/m)?.[1]?.trim() || null;
  const affectedTargets = currentText.match(/^affectedTargets:\s*(.*)$/m)?.[1]?.trim() || "[]";
  const affectedRoutes = currentText.match(/^affectedRoutes:\s*(.*)$/m)?.[1]?.trim() || "[]";
  const affectedFields = currentText.match(/^affectedFields:\s*(.*)$/m)?.[1]?.trim() || "[]";
  const compatibilityEvidence = currentText.match(/^compatibilityEvidence:\s*([^\n#]+)/m)?.[1]?.trim() || null;
  return {
    contentImpact: value,
    contentImpactReason,
    affectedTargets,
    affectedRoutes,
    affectedFields,
    compatibilityEvidence,
  };
}

function contractIncident(message, code, impact, activeContentReleaseIds) {
  const incident = new Error(`Product Incident: ${message}`);
  incident.code = code;
  incident.affectedContentReleaseIds = activeContentReleaseIds;
  incident.contentImpact = impact.contentImpact;
  incident.contentImpactReason = impact.contentImpactReason;
  return incident;
}

function currentVersion(currentText) {
  return currentText.match(/^## 当前唯一版本：`([^`]+)`/m)?.[1]?.trim() || null;
}

/**
 * Validate the one explicitly-authorized breaking contract.  The evidence is
 * deliberately read-only and must be produced by the v0.28.0 QA entry point;
 * this function does not create or repair it.  Returning a structured result
 * lets release gates expose why the exception was (or was not) accepted.
 */
export function readV0280BreakingEvidence({ projectRoot = process.cwd() } = {}) {
  const evidencePath = path.resolve(projectRoot, V0280_EVIDENCE_RELATIVE_PATH);
  if (!existsSync(evidencePath)) {
    return { verified: false, code: "V0280_EVIDENCE_MISSING", evidencePath };
  }

  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    return {
      verified: false,
      code: "V0280_EVIDENCE_INVALID_JSON",
      evidencePath,
      error: error.message,
    };
  }

  const requiredFields = ["version", "baseHead", "scope", "acceptance", "noWrites", "scenarios", "productArtifact"];
  const missingFields = requiredFields.filter((field) => evidence?.[field] == null);
  if (missingFields.length) {
    return { verified: false, code: "V0280_EVIDENCE_INCOMPLETE", evidencePath, missingFields };
  }

  const acceptanceMismatch = Object.entries(V0280_ACCEPTANCE)
    .filter(([key, expected]) => evidence.acceptance?.[key]?.status !== expected)
    .map(([key, expected]) => ({ key, expected, actual: evidence.acceptance?.[key]?.status ?? null }));
  const noWriteMismatch = [
    ["canonicalActive", true],
    ["contentPublish", false],
    ["productTransport", false],
    ["physicalCleanup", false],
  ].filter(([key, expected]) => evidence.noWrites?.[key] !== expected)
    .map(([key, expected]) => ({ key, expected, actual: evidence.noWrites?.[key] ?? null }));
  const scenarioFields = ["runtime", "deterministic", "changedOnly", "cas", "materialization"];
  const missingScenarios = scenarioFields.filter((field) => evidence.scenarios?.[field] == null);
  const validHead = /^[a-f0-9]{40}$/.test(evidence.baseHead || "");
  const verified = evidence.version === V0280_VERSION
    && evidence.schemaVersion === "content-data-plane-evidence-v1"
    && validHead
    && evidence.scope?.version === V0280_VERSION
    && evidence.scope?.baseHead === evidence.baseHead
    && acceptanceMismatch.length === 0
    && noWriteMismatch.length === 0
    && missingScenarios.length === 0
    && evidence.productArtifact?.buildCount === 0
    && evidence.productArtifact?.transport === "not-authorized";

  return {
    verified,
    evidencePath,
    version: evidence.version,
    schemaVersion: evidence.schemaVersion,
    acceptanceMismatch,
    noWriteMismatch,
    missingScenarios,
    validHead,
  };
}

function assertV0280BreakingContract({ currentText, impact, activeContentReleaseIds, projectRoot }) {
  const result = readV0280BreakingEvidence({ projectRoot });
  if (currentVersion(currentText) !== V0280_VERSION
    || impact.contentImpactReason !== V0280_REASON
    || impact.compatibilityEvidence !== V0280_EVIDENCE_MARKER
    || !result.verified) {
    const incident = contractIncident(
      `content compatibility is breaking without the verified ${V0280_VERSION} data-plane evidence`,
      "PRODUCT_CONTENT_INCOMPATIBLE",
      impact,
      activeContentReleaseIds,
    );
    incident.version = currentVersion(currentText);
    incident.requiredVersion = V0280_VERSION;
    incident.evidence = result;
    throw incident;
  }
  return result;
}

/**
 * Validate the closed contentImpact contract and the required human/evidence
 * fields.  `contentImpactReason` is intentionally not interpreted here.
 */
export function assertProductContentCompatibility({ currentText = "", activeContentReleaseIds = [], projectRoot = process.cwd() } = {}) {
  const impact = readContentImpact(currentText);
  const machineImpact = impact.contentImpact === V0284_COMPATIBLE_RECORD_VALUE ? "compatible" : impact.contentImpact;
  const missingFields = [
    ["contentImpact", impact.contentImpact],
    ["contentImpactReason", impact.contentImpactReason],
    ["compatibilityEvidence", impact.compatibilityEvidence],
  ].filter(([, value]) => !value).map(([field]) => field);

  if (missingFields.length) {
    const incident = contractIncident(
      `current.md must declare ${missingFields.join(", ")} before site publication`,
      "PRODUCT_CONTENT_CONTRACT_INVALID",
      impact,
      activeContentReleaseIds,
    );
    incident.missingFields = missingFields;
    throw incident;
  }

  if (!CONTENT_IMPACT_VALUES.includes(machineImpact)) {
    throw contractIncident(
      `contentImpact must be one of ${CONTENT_IMPACT_VALUES.join(", ")}; received ${impact.contentImpact}`,
      "PRODUCT_CONTENT_IMPACT_INVALID",
      impact,
      activeContentReleaseIds,
    );
  }

  if (machineImpact === "breaking") {
    const evidence = assertV0280BreakingContract({ currentText, impact, activeContentReleaseIds, projectRoot });
    return { ...impact, activeContentReleaseIds, breakingContract: "v0.28.0-content-data-plane", evidence };
  }

  if (!ALLOWED_CONTENT_IMPACTS.includes(machineImpact)) {
    throw contractIncident(
      `content compatibility is ${impact.contentImpact}`,
      "PRODUCT_CONTENT_INCOMPATIBLE",
      impact,
      activeContentReleaseIds,
    );
  }

  return { ...impact, compatibilityClass: machineImpact, activeContentReleaseIds };
}
