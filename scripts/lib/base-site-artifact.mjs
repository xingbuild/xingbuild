import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const sha256Pattern = /^[a-f0-9]{64}$/;
const commitPattern = /^[a-f0-9]{7,64}$/;
const versionPattern = /^v\d+\.\d+\.\d+$/;
const artifactIdPattern = /^[a-z0-9][a-z0-9._-]+$/;
export const CONTENT_SLOT_CAPABILITY_CONTRACT_VERSION = "content-slot-registry-v1";
export const CONTENT_SLOT_CAPABILITY_CONTRACT = Object.freeze({ contentKinds: ["content", "article", "practice", "profile", "businessObservation"], registeredTargets: "ContentSlotRegistry", mediaContract: "approved-media-manifest-v1", routeContract: "content-target-path-v1", fieldContract: ["logicalContentId", "activeReceiptId", "predecessorReceiptId", "packageRevisionId", "receiptHash", "projectionHash", "snapshotHash"] });
function hasText(value) { return typeof value === "string" && value.trim() !== ""; }
function canonical(value) { return JSON.stringify(value); }
export function hashArtifactValue(value) { return createHash("sha256").update(canonical(value)).digest("hex"); }
function sourceBundleHash(entries) { return hashArtifactValue(entries.map(({ path: relativePath, sha256 }) => ({ path: relativePath, sha256 }))); }
async function fileEntries(rootDirectory, current = "") {
  const entries = [];
  for (const entry of await readdir(path.join(rootDirectory, current), { withFileTypes: true })) {
    const relative = path.posix.join(current.split(path.sep).join("/"), entry.name); const absolute = path.join(rootDirectory, current, entry.name);
    if (entry.isDirectory()) entries.push(...await fileEntries(rootDirectory, relative));
    else if (entry.isFile()) entries.push({ path: relative, sha256: createHash("sha256").update(await readFile(absolute)).digest("hex"), bytes: (await stat(absolute)).size });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
async function isDirectory(directory) { try { return (await stat(directory)).isDirectory(); } catch { return false; } }
export async function hashSourceBundle(sourceDirectory) {
  if (!(await isDirectory(sourceDirectory))) throw new Error(`baseSiteArtifact source bundle is missing: ${sourceDirectory}`);
  const entries = await fileEntries(sourceDirectory); return { entries, sourceBundleHash: sourceBundleHash(entries) };
}
export async function hashClientDirectory(clientDirectory) {
  if (!(await isDirectory(clientDirectory))) throw new Error(`baseSiteArtifact client directory is missing: ${clientDirectory}`);
  const entries = (await fileEntries(clientDirectory)).filter((entry) => !["release.json", "base-site-artifact.json"].includes(entry.path)); return { entries, clientHash: sourceBundleHash(entries) };
}

export function validateBaseSiteArtifact(artifact, { sourceRoot, expectedIdentity = null } = {}) {
  if (!artifact || typeof artifact !== "object") throw new Error("immutable baseSiteArtifact is required");
  for (const field of ["releaseManifestHash", "artifactContentHash", "sourceDeploymentId"]) if (!hasText(artifact[field])) throw new Error(`baseSiteArtifact.${field} is required`);
  for (const field of ["releaseManifestHash", "artifactContentHash"]) if (!sha256Pattern.test(artifact[field])) throw new Error(`baseSiteArtifact.${field} must be SHA-256`);
  if (artifact.materializationKind === "client") {
    if (!hasText(artifact.clientPath) || !sha256Pattern.test(artifact.clientHash || "") || !Array.isArray(artifact.clientFiles) || artifact.clientFiles.length === 0) throw new Error("baseSiteArtifact client materialization is incomplete");
    if (!/^\.content-workspace\/base-site-artifacts\/[^/]+\/client$/.test(artifact.clientPath)) throw new Error("baseSiteArtifact clientPath must be canonical immutable client path");
    if (expectedIdentity) {
      if (!hasText(expectedIdentity.baseSiteArtifactId) || !hasText(expectedIdentity.productVersion) || !hasText(expectedIdentity.productCommit)) throw new Error("baseSiteArtifact expected identity is incomplete");
      const expectedPath = path.posix.join(".content-workspace", "base-site-artifacts", expectedIdentity.baseSiteArtifactId, "client");
      if (artifact.clientPath !== expectedPath) throw new Error("baseSiteArtifact clientPath identity drift");
    }
    return artifact;
  }
  /* Historical source records remain readable, but creation of new records never uses this branch. */
  for (const field of ["baseSiteArtifactId", "productVersion", "productCommit", "sourceDirectory", "sourceBundleHash"]) if (!hasText(artifact[field])) throw new Error(`baseSiteArtifact.${field} is required`);
  if (!artifactIdPattern.test(artifact.baseSiteArtifactId)) throw new Error("baseSiteArtifact.baseSiteArtifactId is invalid");
  if (!versionPattern.test(artifact.productVersion)) throw new Error("baseSiteArtifact.productVersion is invalid");
  if (!commitPattern.test(artifact.productCommit)) throw new Error("baseSiteArtifact.productCommit is invalid");
  if (!path.isAbsolute(artifact.sourceDirectory)) throw new Error("baseSiteArtifact.sourceDirectory must be absolute");
  if (sourceRoot && path.resolve(artifact.sourceDirectory) === path.resolve(sourceRoot)) throw new Error("baseSiteArtifact.sourceDirectory must not be the mutable canonical sourceRoot");
  if (!Array.isArray(artifact.sourceBundle) || artifact.sourceBundle.length === 0) throw new Error("baseSiteArtifact sourceBundle must contain source files");
  if (sourceBundleHash(artifact.sourceBundle) !== artifact.sourceBundleHash) throw new Error("baseSiteArtifact sourceBundle hash is invalid");
  return artifact;
}
export function assertBaseSiteArtifactCompatible(artifact, { requiredCapabilities = [] } = {}) {
  validateBaseSiteArtifact(artifact); if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((value) => typeof value !== "string" || !value.trim())) throw new Error("required baseSiteArtifact capabilities must be non-empty strings");
  const capabilities = Array.isArray(artifact.capabilities) ? new Set(artifact.capabilities) : null; if (capabilities && requiredCapabilities.some((value) => !capabilities.has(value))) throw new Error("baseSiteArtifact capabilities are incompatible with content target"); return artifact;
}
export function assertContentSlotArtifactCompatible(artifact, { registryMode = "legacy", requiredKinds = [] } = {}) {
  validateBaseSiteArtifact(artifact); if (!artifact.capabilityContractVersion && !artifact.capabilityContract) { if (registryMode === "legacy") return { artifact, legacy: true }; throw new Error("baseSiteArtifact content slot capability contract is unknown"); }
  if (artifact.capabilityContractVersion !== CONTENT_SLOT_CAPABILITY_CONTRACT_VERSION) throw new Error(`baseSiteArtifact content slot capability contract is incompatible: ${artifact.capabilityContractVersion || "missing"}`);
  const contract = artifact.capabilityContract; if (!contract || contract.registeredTargets !== "ContentSlotRegistry" || contract.mediaContract !== CONTENT_SLOT_CAPABILITY_CONTRACT.mediaContract || contract.routeContract !== CONTENT_SLOT_CAPABILITY_CONTRACT.routeContract) throw new Error("baseSiteArtifact content slot capability contract is incompatible");
  const kinds = new Set(contract.contentKinds || []); if (JSON.stringify([...kinds].sort()) !== JSON.stringify([...CONTENT_SLOT_CAPABILITY_CONTRACT.contentKinds].sort()) || JSON.stringify(contract.fieldContract || []) !== JSON.stringify(CONTENT_SLOT_CAPABILITY_CONTRACT.fieldContract)) throw new Error("baseSiteArtifact content slot field contract is incompatible");
  if (requiredKinds.some((kind) => !kinds.has(kind))) throw new Error("baseSiteArtifact content slot kind contract is incompatible"); return { artifact, legacy: false };
}

export async function createBaseSiteArtifact({ sourceRoot, clientDirectory = path.join(sourceRoot || "", "dist", "client"), productVersion, productCommit, release, contentManifest, sourceDeploymentId = "prepared-dist", approvalIdentity = null } = {}) {
  if (!hasText(sourceRoot) || !path.isAbsolute(sourceRoot)) throw new Error("baseSiteArtifact sourceRoot must be absolute");
  if (!versionPattern.test(productVersion || "") || !commitPattern.test(productCommit || "")) throw new Error("baseSiteArtifact product identity is invalid");
  const baseSiteArtifactId = `${productVersion}-${productCommit.slice(0, 12)}`; const artifactRoot = path.join(sourceRoot, ".content-workspace", "base-site-artifacts", baseSiteArtifactId); const clientRoot = path.join(artifactRoot, "client");
  if (await isDirectory(artifactRoot)) throw new Error(`baseSiteArtifact already exists and cannot be overwritten: ${baseSiteArtifactId}`);
  const hashed = await hashClientDirectory(clientDirectory); await mkdir(clientRoot, { recursive: true }); await cp(clientDirectory, clientRoot, { recursive: true, force: false });
  const descriptor = validateBaseSiteArtifact({ productArtifactContractVersion: "product-artifact-v2", contentSetContractVersion: "content-set-v1", releaseManifestHash: hashArtifactValue(release), artifactContentHash: hashArtifactValue({ release, contentManifest }), sourceDeploymentId, materializationKind: "client", clientPath: path.posix.join(".content-workspace", "base-site-artifacts", baseSiteArtifactId, "client"), clientFiles: hashed.entries, clientHash: hashed.clientHash, capabilityContractVersion: CONTENT_SLOT_CAPABILITY_CONTRACT_VERSION, capabilityContract: CONTENT_SLOT_CAPABILITY_CONTRACT, ...(approvalIdentity || {}) });
  await writeFile(path.join(clientRoot, "base-site-artifact.json"), `${JSON.stringify(descriptor, null, 2)}\n`); return descriptor;
}
export async function readBaseSiteArtifact({ sourceRoot, baseSiteArtifact, artifactPath, expectedIdentity = null } = {}) {
  let selected = baseSiteArtifact;
  if (typeof selected === "string") selected = JSON.parse(await readFile(path.resolve(sourceRoot, selected), "utf8"));
  if (!selected && artifactPath) { const resolved = path.resolve(sourceRoot, artifactPath); const rootDirectory = path.resolve(sourceRoot); if (resolved !== rootDirectory && !resolved.startsWith(`${rootDirectory}${path.sep}`)) throw new Error("baseSiteArtifact path must stay inside source root"); const clientResolved = path.basename(resolved) === "base-site-artifact.json" && path.basename(path.dirname(resolved)) !== "client" ? path.join(path.dirname(resolved), "client", "base-site-artifact.json") : resolved; selected = JSON.parse(await readFile(clientResolved, "utf8")); }
  if (!selected) throw new Error("explicit immutable baseSiteArtifact is required; implicit dist fallback is disabled");
  const descriptor = validateBaseSiteArtifact(selected, { sourceRoot, expectedIdentity });
  if (descriptor.materializationKind === "client") {
    if (!sourceRoot) return descriptor;
    const clientRoot = path.resolve(sourceRoot, descriptor.clientPath); const actual = await hashClientDirectory(clientRoot); if (actual.clientHash !== descriptor.clientHash || JSON.stringify(actual.entries) !== JSON.stringify(descriptor.clientFiles)) throw new Error("baseSiteArtifact client materialization drift detected");
  } else {
    const actual = await hashSourceBundle(descriptor.sourceDirectory);
    const legacyEntries = (descriptor.sourceBundle || []).map(({ path: relativePath, sha256 }) => ({ path: relativePath, sha256 }));
    const observedEntries = actual.entries.map(({ path: relativePath, sha256 }) => ({ path: relativePath, sha256 }));
    if (actual.sourceBundleHash !== descriptor.sourceBundleHash || JSON.stringify(observedEntries) !== JSON.stringify(legacyEntries)) throw new Error("baseSiteArtifact source bundle drift detected");
  }
  return descriptor;
}
