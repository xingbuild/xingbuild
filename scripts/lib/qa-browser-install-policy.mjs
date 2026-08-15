import { readFile } from "node:fs/promises";
import path from "node:path";

export const QA_BROWSER_INSTALL_POLICY_VERSION = "qa-browser-install-policy-v1";

export function qaBrowserInstallPolicyEvidencePath(root, version) {
  const normalized = String(version || "").startsWith("v") ? String(version) : `v${version}`;
  if (!/^v\d+\.\d+\.\d+$/.test(normalized)) throw new Error(`invalid QA browser install-policy version: ${version}`);
  return path.join(root, ".content-workspace", "qa", normalized, "qa-browser-install-policy.json");
}

export function validateQaBrowserInstallPolicyEvidence(evidence, { expectedVersion, evidencePath } = {}) {
  if (!evidence || evidence.status !== "passed" || evidence.policyVersion !== QA_BROWSER_INSTALL_POLICY_VERSION) {
    throw new Error(`QA_BROWSER_INSTALL_POLICY_INVALID:${evidencePath || "evidence"}`);
  }
  if (expectedVersion && evidence.version && evidence.version !== expectedVersion) {
    throw new Error(`QA_BROWSER_INSTALL_POLICY_VERSION_MISMATCH: expected ${expectedVersion}, got ${evidence.version}`);
  }
  return evidence;
}

export async function readQaBrowserInstallPolicyEvidence({ root, version, allowMissing = false } = {}) {
  const evidencePath = qaBrowserInstallPolicyEvidencePath(root, version);
  let evidence;
  try {
    evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") throw new Error(`QA_BROWSER_INSTALL_POLICY_MISSING:${evidencePath}`);
    throw new Error(`QA_BROWSER_INSTALL_POLICY_READ_FAILED:${evidencePath}:${error.message}`);
  }
  return validateQaBrowserInstallPolicyEvidence(evidence, { expectedVersion: String(version).startsWith("v") ? String(version) : `v${version}`, evidencePath });
}
