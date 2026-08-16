import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { hashArtifactValue, readBaseSiteArtifact } from "./base-site-artifact.mjs";

export const PRODUCT_ARTIFACT_CONTRACT_VERSION = "product-artifact-v2";
export const PRODUCT_ARTIFACT_IDENTITY_FIELDS = Object.freeze(["artifactContractVersion", "productArtifactId", "productVersion", "productCommit", "baseSiteArtifactId", "productArtifactHash", "contentManifestHash", "baseSiteArtifactManifestHash", "approvalHash", "candidateHash", "approvedTreeOid", "clientHash"]);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^v\d+\.\d+\.\d+$/;
const TREE = /^[a-f0-9]{40}$/;
function text(value, field) { if (typeof value !== "string" || !value.trim()) throw new Error(`ProductArtifact ${field} is missing`); return value; }
function expectedBaseId(version, commit) { return `${version}-${commit.slice(0, 12)}`; }
function assertObject(value, label) { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`ProductArtifact ${label} is missing`); return value; }
function canonical(value) { return JSON.stringify(value); }
function artifactHashPayload(root) {
  const { productArtifactHash: _ignored, ...identity } = root;
  return { ...identity, clientFiles: [...(root.clientFiles || [])].filter((entry) => entry.path !== "release.json").sort((a, b) => a.path.localeCompare(b.path)) };
}
export function computeProductArtifactHash(root) { return createHash("sha256").update(canonical(artifactHashPayload(root))).digest("hex"); }
function subordinateForbidden(document, label) {
  for (const field of ["productArtifactId", "productArtifactHash", "productVersion", "productCommit", "baseSiteArtifactId", "approvalHash", "candidateHash", "approvedTreeOid", "approvalEnvelopeHash", "candidateEnvelopeHash"]) if (Object.hasOwn(document, field)) throw new Error(`${label} must not duplicate ProductArtifact authority field ${field}`);
}
function validateRoot(root, { version, commit } = {}) {
  assertObject(root, "release.json");
  if (root.schemaVersion !== "product-artifact-release-v2") throw new Error("ProductArtifact release root schema mismatch");
  const expectedVersion = text(version || root.productVersion, "version"); const expectedCommit = text(commit || root.productCommit, "commit");
  if (!VERSION.test(expectedVersion) || !COMMIT.test(expectedCommit)) throw new Error("ProductArtifact root version/commit invalid");
  for (const field of ["productArtifactId", "baseSiteArtifactId", "contentManifestHash", "baseSiteArtifactManifestHash", "productArtifactHash"]) text(root[field], field);
  if (root.productVersion !== expectedVersion || root.productCommit !== expectedCommit) throw new Error("ProductArtifact root version/commit drift");
  if (root.productArtifactId !== expectedBaseId(expectedVersion, expectedCommit) || root.baseSiteArtifactId !== root.productArtifactId) throw new Error("ProductArtifact root id mismatch");
  if (!SHA256.test(root.productArtifactHash) || !SHA256.test(root.contentManifestHash) || !SHA256.test(root.baseSiteArtifactManifestHash)) throw new Error("ProductArtifact root hash invalid");
  for (const field of ["approvalHash", "candidateHash"]) if (!SHA256.test(root[field] || "")) throw new Error(`ProductArtifact ${field} is required for v2`);
  if (!TREE.test(root.approvedTreeOid || "")) throw new Error("ProductArtifact approvedTreeOid is required for v2");
  if (!Array.isArray(root.clientFiles) || root.clientFiles.some((entry) => !entry || typeof entry.path !== "string" || !SHA256.test(entry.sha256))) throw new Error("ProductArtifact clientFiles invalid");
  if (root.productArtifactHash !== computeProductArtifactHash(root)) throw new Error("ProductArtifact root hash mismatch");
  return root;
}
export function resolveProductArtifactIdentity({ release, contentManifest, baseSiteArtifact, clientFiles = null } = {}, { version, commit } = {}) {
  /* Read-only adapter for pre-v2 in-memory fixtures.  It is deliberately not
     reachable from readProductArtifact or any publish path; production
     artifacts must use the release.json v2 root below. */
  if (release && release.schemaVersion == null && release.version && release.commit && release.baseSiteArtifactId) {
    const legacyVersion = version || release.version; const legacyCommit = commit || release.commit;
    if (legacyVersion !== release.version || legacyCommit !== release.commit) throw new Error("legacy ProductArtifact fixture version/commit drift");
    if (contentManifest && (contentManifest.version != null && contentManifest.version !== legacyVersion || contentManifest.commit != null && contentManifest.commit !== legacyCommit || contentManifest.baseSiteArtifactId != null && contentManifest.baseSiteArtifactId !== release.baseSiteArtifactId)) throw new Error("legacy ProductArtifact fixture content identity/commit drift");
    if (baseSiteArtifact && (baseSiteArtifact.productVersion != null && baseSiteArtifact.productVersion !== legacyVersion || baseSiteArtifact.productCommit != null && baseSiteArtifact.productCommit !== legacyCommit || baseSiteArtifact.baseSiteArtifactId != null && baseSiteArtifact.baseSiteArtifactId !== release.baseSiteArtifactId)) throw new Error("legacy ProductArtifact fixture base identity drift");
    if (baseSiteArtifact?.releaseManifestHash && baseSiteArtifact.releaseManifestHash !== hashArtifactValue(release)) throw new Error("legacy ProductArtifact fixture release manifest hash drift");
    if (baseSiteArtifact?.artifactContentHash && baseSiteArtifact.artifactContentHash !== hashArtifactValue({ release, contentManifest })) throw new Error("legacy ProductArtifact fixture artifactContentHash drift");
    const legacyHash = hashArtifactValue({ schemaVersion: "product-artifact-legacy-fixture-v1", productVersion: legacyVersion, productCommit: legacyCommit, productArtifactId: release.baseSiteArtifactId, baseSiteArtifactId: release.baseSiteArtifactId, contentManifestHash: hashArtifactValue(contentManifest || {}), baseSiteArtifactManifestHash: hashArtifactValue(baseSiteArtifact || {}) });
    return Object.freeze({ artifactContractVersion: "product-artifact-legacy-fixture-v1", productArtifactId: release.baseSiteArtifactId, productVersion: legacyVersion, productCommit: legacyCommit, baseSiteArtifactId: release.baseSiteArtifactId, productArtifactHash: legacyHash, contentManifestHash: hashArtifactValue(contentManifest || {}), baseSiteArtifactManifestHash: hashArtifactValue(baseSiteArtifact || {}), approvalHash: null, candidateHash: null, approvedTreeOid: null, documents: Object.freeze({ release: Object.freeze(release), contentManifest: Object.freeze(contentManifest || {}), baseSiteArtifact: Object.freeze(baseSiteArtifact || {}) }) });
  }
  const root = validateRoot(release, { version, commit }); assertObject(contentManifest, "content-manifest.json"); assertObject(baseSiteArtifact, "base-site-artifact.json"); subordinateForbidden(contentManifest, "content-manifest.json"); subordinateForbidden(baseSiteArtifact, "base-site-artifact.json");
  const expectedVersion = root.productVersion; const expectedCommit = root.productCommit;
  if (hashArtifactValue(contentManifest) !== root.contentManifestHash) throw new Error("ProductArtifact content manifest hash drift");
  if (hashArtifactValue(baseSiteArtifact) !== root.baseSiteArtifactManifestHash) throw new Error("ProductArtifact base-site-artifact manifest hash drift");
  if (baseSiteArtifact.materializationKind !== "client") throw new Error("ProductArtifact base-site-artifact must be immutable client materialization");
  const expectedClientPath = `.content-workspace/base-site-artifacts/${root.baseSiteArtifactId}/client`;
  if (baseSiteArtifact.clientPath !== expectedClientPath) throw new Error("ProductArtifact subordinate client path drift");
  if (clientFiles) {
    const expected = root.clientFiles.filter((entry) => entry.path !== "release.json"); const actual = clientFiles.filter((entry) => entry.path !== "release.json");
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error("ProductArtifact client bytes drift");
  }
  return Object.freeze({ artifactContractVersion: PRODUCT_ARTIFACT_CONTRACT_VERSION, productArtifactId: root.productArtifactId, productVersion: expectedVersion, productCommit: expectedCommit, baseSiteArtifactId: root.baseSiteArtifactId, productArtifactHash: root.productArtifactHash, contentManifestHash: root.contentManifestHash, baseSiteArtifactManifestHash: root.baseSiteArtifactManifestHash, approvalHash: root.approvalHash || null, candidateHash: root.candidateHash || null, approvedTreeOid: root.approvedTreeOid || null, documents: Object.freeze({ release, contentManifest, baseSiteArtifact }) });
}
export const productArtifactIdentity = resolveProductArtifactIdentity;
export function productArtifactHash(artifact) { return artifact?.productArtifactHash || computeProductArtifactHash(artifact); }
export function assertProductArtifactIdentityShape(identity = {}) {
  if (!identity || typeof identity !== "object") throw new Error("ProductArtifact identity is required");
  for (const field of ["productArtifactId", "productVersion", "productCommit", "baseSiteArtifactId"]) text(identity[field], `identity.${field}`);
  if (identity.productArtifactId !== expectedBaseId(identity.productVersion, identity.productCommit) || identity.baseSiteArtifactId !== identity.productArtifactId) throw new Error("ProductArtifact identity tuple mismatch");
  const productArtifactHash = identity.productArtifactHash || hashArtifactValue({ schemaVersion: "product-artifact-legacy-identity-v1", productArtifactId: identity.productArtifactId, productVersion: identity.productVersion, productCommit: identity.productCommit, baseSiteArtifactId: identity.baseSiteArtifactId });
  if (!SHA256.test(productArtifactHash)) throw new Error("ProductArtifact identity hash invalid");
  if (identity.approvalHash != null && !SHA256.test(identity.approvalHash)) throw new Error("ProductArtifact identity approvalHash invalid");
  return Object.fromEntries(PRODUCT_ARTIFACT_IDENTITY_FIELDS.filter((field) => identity[field] != null || field === "productArtifactHash").map((field) => [field, field === "productArtifactHash" ? productArtifactHash : identity[field]]));
}
export function assertProductArtifactIdentity(documents, options = {}) { return resolveProductArtifactIdentity(documents, options); }
async function readJson(file, label) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { throw new Error(`ProductArtifact ${label} is missing or unreadable: ${error.message}`); } }
async function clientEntries(rootDirectory, current = "") {
  const entries = [];
  for (const entry of await readdir(path.join(rootDirectory, current), { withFileTypes: true })) {
    const relative = path.posix.join(current, entry.name); const absolute = path.join(rootDirectory, current, entry.name);
    if (entry.isDirectory()) entries.push(...await clientEntries(rootDirectory, relative));
    else if (entry.isFile()) entries.push({ path: relative, sha256: createHash("sha256").update(await readFile(absolute)).digest("hex") });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}
export async function readProductArtifact({ clientDirectory, sourceRoot = process.cwd(), version, commit } = {}) {
  if (typeof clientDirectory !== "string" || !clientDirectory.trim()) throw new Error("ProductArtifact client directory is required");
  const release = await readJson(path.join(clientDirectory, "release.json"), "release.json"); const contentManifest = await readJson(path.join(clientDirectory, "content-manifest.json"), "content-manifest.json"); const baseSiteArtifact = await readJson(path.join(clientDirectory, "base-site-artifact.json"), "base-site-artifact.json");
  if (release.schemaVersion !== "product-artifact-release-v2") throw new Error("ProductArtifact release root schema mismatch");
  await readBaseSiteArtifact({ sourceRoot, baseSiteArtifact, expectedIdentity: release }); const entries = await clientEntries(clientDirectory); return resolveProductArtifactIdentity({ release, contentManifest, baseSiteArtifact, clientFiles: entries }, { version, commit });
}
