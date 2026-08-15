import { readFile } from "node:fs/promises";
import path from "node:path";

export function lifecycleEvidencePath(root, version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid lifecycle evidence version: ${version}`);
  return path.join(root, ".content-workspace", "qa", version, "lifecycle-evidence.json");
}

export async function readLifecycleEvidence({ root, version, allowMissing = false } = {}) {
  const file = lifecycleEvidencePath(root, version);
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return null;
    if (error?.code === "ENOENT") throw new Error(`LIFECYCLE_EVIDENCE_MISSING:${file}`);
    throw error;
  }
}
