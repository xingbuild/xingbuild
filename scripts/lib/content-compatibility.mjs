/**
 * Product/content compatibility is a product contract, not an operational
 * guess.  Every release gate and the coordinator use this module so the
 * machine state cannot drift from the current contract.
 */
export const CONTENT_IMPACT_VALUES = Object.freeze([
  "none",
  "compatible",
  "compatible-metadata-correction",
  "migration-required",
  "breaking",
  "unknown",
]);

export const ALLOWED_CONTENT_IMPACTS = Object.freeze(["none", "compatible", "compatible-metadata-correction"]);

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

/**
 * Validate the closed contentImpact contract and the required human/evidence
 * fields.  `contentImpactReason` is intentionally not interpreted here.
 */
export function assertProductContentCompatibility({ currentText = "", activeContentReleaseIds = [] } = {}) {
  const impact = readContentImpact(currentText);
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

  if (!CONTENT_IMPACT_VALUES.includes(impact.contentImpact)) {
    throw contractIncident(
      `contentImpact must be one of ${CONTENT_IMPACT_VALUES.join(", ")}; received ${impact.contentImpact}`,
      "PRODUCT_CONTENT_IMPACT_INVALID",
      impact,
      activeContentReleaseIds,
    );
  }

  if (!ALLOWED_CONTENT_IMPACTS.includes(impact.contentImpact)) {
    throw contractIncident(
      `content compatibility is ${impact.contentImpact}`,
      "PRODUCT_CONTENT_INCOMPATIBLE",
      impact,
      activeContentReleaseIds,
    );
  }

  return { ...impact, activeContentReleaseIds };
}
