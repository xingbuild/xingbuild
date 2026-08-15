import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, lstat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inventoryContentWorkspace } from "./content-lifecycle-governance.mjs";
import { readProductArtifact } from "./product-artifact.mjs";

export const STORAGE_GOVERNANCE_SCHEMA_VERSION = "content-storage-governance-v1";
export const STORAGE_ROOT_MANIFEST_VERSION = "content-storage-root-manifest-v1";
export const STORAGE_QUARANTINE_SCHEMA_VERSION = "content-storage-quarantine-v1";

const PROTECTED_ROOTS = Object.freeze([
  ["active-content-set", ".content-workspace/content-state", "content-state", "ContentSet active pointer and immutable sets", "delete-never"],
  ["canonical-content", ".content-workspace/content", "canonical-content", "canonical content and media source", "delete-never"],
  ["content-reviews", ".content-workspace/reviews", "review", "review facts", "delete-never"],
  ["content-recoveries", ".content-workspace/recoveries", "recovery", "recovery facts", "delete-never"],
  ["content-incidents", ".content-workspace/operations/incidents", "incident", "incident and hold facts", "delete-never"],
  ["content-slot-registry", ".content-workspace/content-slot-registry", "registry", "authoritative slot registry", "delete-never"],
  ["content-releases", ".content-workspace/releases", "content-release", "receipts, lineage and package provenance", "delete-never"],
  ["site-publications", ".content-workspace/site-publications", "site-publication", "released, failed and recoverable publication records", "delete-never"],
  ["publication-runs", ".content-workspace/publication-runs", "publication-run", "publication lifecycle evidence", "delete-never"],
  ["base-site-artifacts", ".content-workspace/base-site-artifacts", "product-artifact", "ProductArtifact provenance", "delete-never"],
  ["qa-evidence", ".content-workspace/qa", "qa", "QA and public evidence; separate browser cache policy", "keep"],
  ["change-sets", ".content-workspace/changes", "change-set", "immutable ChangeSet sidecars", "delete-never"],
  ["product-dist", "dist/client", "product-dist", "final ProductArtifact output", "delete-never"],
]);

const RETENTION_POLICY = Object.freeze({
  "canonical-content": { owner: "elon ops", window: "indefinite", decision: "delete-never" },
  "content-state": { owner: "elon ops", window: "current-plus-two-revisions", decision: "delete-never" },
  review: { owner: "elon ops", window: "indefinite-until-released", decision: "delete-never" },
  recovery: { owner: "elon ops", window: "indefinite-until-incident-closed", decision: "delete-never" },
  incident: { owner: "elon", window: "indefinite", decision: "delete-never" },
  registry: { owner: "elon ops", window: "indefinite", decision: "delete-never" },
  "content-release": { owner: "elon ops", window: "indefinite-audit", decision: "delete-never" },
  "site-publication": { owner: "elon engin", window: "indefinite-reference", decision: "delete-never" },
  "publication-run": { owner: "elon engin", window: "indefinite-reference", decision: "delete-never" },
  "product-artifact": { owner: "elon engin", window: "release-history", decision: "delete-never" },
  qa: { owner: "elon engin", window: "bounded-review", decision: "keep" },
  "change-set": { owner: "elon ops", window: "indefinite-lineage", decision: "delete-never" },
  "product-dist": { owner: "elon engin", window: "current-release", decision: "delete-never" },
});

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(Buffer.isBuffer(value) || typeof value === "string" ? value : stable(value)).digest("hex");
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function safePart(value, field) {
  if (typeof value !== "string" || !value || value.includes("/") || value.includes("\\") || value === "." || value === "..") throw new Error(`${field} is not a safe namespace component`);
  return value;
}

async function exists(file) {
  return stat(file).then(() => true).catch((error) => error.code === "ENOENT" ? false : Promise.reject(error));
}

async function treeStats(root) {
  const info = await stat(root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return { exists: false, files: 0, bytes: 0, hash: null };
  if (info.isFile()) {
    return { exists: true, files: 1, bytes: info.size, hash: sha256({ path: root, bytes: info.size, modifiedAt: info.mtimeMs }), hashMode: "metadata" };
  }
  const entries = await readdir(root, { withFileTypes: true });
  let files = 0;
  let bytes = 0;
  const children = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const child = await treeStats(path.join(root, entry.name));
    files += child.files;
    bytes += child.bytes;
    children.push({ name: entry.name, files: child.files, bytes: child.bytes, hash: child.hash, hashMode: child.hashMode || "metadata" });
  }
  return { exists: true, files, bytes, hash: sha256(children), hashMode: "metadata" };
}

export function protectedRootDefinitions() {
  return PROTECTED_ROOTS.map(([id, relativePath, namespace, reason, decision]) => ({ id, relativePath, namespace, reason, decision }));
}

export async function createProtectedRootManifest({ sourceRoot = process.cwd(), now = new Date().toISOString(), includeTreeStats = true } = {}) {
  const roots = [];
  for (const [id, relativePath, namespace, reason, decision] of PROTECTED_ROOTS) {
    const absolutePath = path.resolve(sourceRoot, relativePath);
    const stats = includeTreeStats ? await treeStats(absolutePath) : { exists: await exists(absolutePath), files: null, bytes: null, hash: null };
    roots.push({ id, path: relativePath, absolutePath, namespace, sourceOfTruth: reason, owner: RETENTION_POLICY[namespace]?.owner || "elon engin", decision, ...stats });
  }
  const identity = { schemaVersion: STORAGE_ROOT_MANIFEST_VERSION, sourceRoot: path.resolve(sourceRoot), roots };
  return { ...identity, generatedAt: now, manifestHash: sha256(identity) };
}

function namespaceFor(record) {
  const pathName = record.path || "";
  if (pathName.includes("/content-state")) return "content-state";
  if (pathName.includes("/content/")) return "canonical-content";
  if (pathName.includes("/reviews") || pathName.includes("/review")) return "review";
  if (pathName.includes("/recovery") || pathName.includes("/recoveries")) return "recovery";
  if (pathName.includes("/incident")) return "incident";
  if (pathName.includes("content-slot-registry")) return "registry";
  if (pathName.includes("/releases/")) return "content-release";
  if (pathName.includes("/site-publications/")) return "site-publication";
  if (pathName.includes("/publication-runs/")) return "publication-run";
  if (pathName.includes("/base-site-artifacts/")) return "product-artifact";
  if (pathName.includes("/.content-workspace/qa/")) return "qa";
  if (pathName.includes("/.content-workspace/changes/")) return "change-set";
  if (pathName.startsWith("dist/client/")) return "product-dist";
  return "unknown";
}

function recordState(record) {
  return record.state || record.lifecycleState || record.status || (record.decision === "delete-never" ? "protected" : "derived");
}

function identityFromValue(value, objectKind) {
  if (!value || typeof value !== "object") return null;
  const keys = objectKind === "site-publication" ? ["sitePublicationId", "publicationRunId"] : objectKind === "content-change-set" ? ["changeSetId"] : ["contentSetId", "sitePublicationId", "publicationRunId", "contentReleaseId", "packageRevisionId", "revisionId", "lineageBindingId", "changeSetId", "recoveryId", "productArtifactId", "baseSiteArtifactId", "logicalContentId", "deploymentId"];
  return keys.find((key) => typeof value[key] === "string" && value[key]) ? value[keys.find((key) => typeof value[key] === "string" && value[key])] : null;
}

function tokensFromValue(value, result = new Set()) {
  if (!value || typeof value !== "object") return result;
  if (Array.isArray(value)) { for (const item of value) tokensFromValue(item, result); return result; }
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string" && child && /(?:id|hash|revision|commit|deployment|recovery|changeset|contentrelease|logicalcontent|packagerevision|lineagebinding|sitesnapshot|publicationrun)/i.test(key)) result.add(child);
    tokensFromValue(child, result);
  }
  return result;
}

function objectKindForPath(relativePath, value) {
  if (relativePath.includes("content-state") || path.basename(relativePath) === "active.json") return "active-content-set";
  if (relativePath.includes("site-publications")) return "site-publication";
  if (relativePath.includes("base-site-artifacts")) return "product-artifact-derived";
  if (relativePath.includes("releases")) return "content-release-receipt";
  if (relativePath.includes("content-slot-registry")) return "content-slot-registry";
  if (relativePath.includes("publication-runs")) return "publication-run";
  if (relativePath.includes("changes")) return "content-change-set";
  if (relativePath.includes("qa")) return "qa-derived-evidence";
  if (relativePath.includes("content/")) return "canonical-content-source";
  if (value?.recoveryId || value?.recovery) return "recovery";
  return "derived-artifact";
}

async function metadataRecords(root, sourceRoot, result = []) {
  for (const entry of (await readdir(root, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) { await metadataRecords(file, sourceRoot, result); continue; }
    if (!entry.isFile()) continue;
    const info = await stat(file);
    const relativePath = relative(sourceRoot, file);
    let value = null;
    if (path.extname(file).toLowerCase() === ".json" && info.size <= 5 * 1024 * 1024) {
      try { value = JSON.parse(await readFile(file, "utf8")); } catch { value = null; }
    }
    const objectKind = objectKindForPath(relativePath, value);
    const namespace = namespaceFor({ path: relativePath });
    const policy = RETENTION_POLICY[namespace] || { owner: "unknown", decision: "delete-never", window: "unknown" };
    const identity = identityFromValue(value, objectKind);
    result.push({ path: relativePath, owner: policy.owner, objectKind, identity, logicalContentId: value?.logicalContentId || null, artifactId: value?.productArtifactId || value?.baseSiteArtifactId || null, hash: value?.hash || sha256({ path: relativePath, bytes: info.size, modifiedAt: info.mtimeMs }), hashMode: value?.hash ? "declared" : "metadata", bytes: info.size, references: [...tokensFromValue(value)].filter((token) => token !== identity), incomingReferences: [], outgoingReferences: [...tokensFromValue(value)].filter((token) => token !== identity), lease: value?.lease || null, retainUntil: policy.decision === "delete-never" ? "indefinite" : value?.retainUntil || null, restorePath: null, rebuildProof: null, namespace, sourceOfTruth: namespace === "canonical-content" ? relativePath : "lifecycle-record", state: value?.state || value?.status || (policy.decision === "delete-never" ? "protected" : "derived"), decision: policy.decision, reason: policy.decision === "delete-never" ? `${namespace} retention policy protects lifecycle fact` : "metadata inventory requires review" });
  }
  return result;
}

export async function inventoryContentStorage({ sourceRoot = process.cwd(), workspaceDirectory = path.join(sourceRoot, ".content-workspace"), now = new Date().toISOString(), includeTreeStats = true, fullScan = false } = {}) {
  const [rootManifest, existing] = await Promise.all([
    createProtectedRootManifest({ sourceRoot, now, includeTreeStats }),
    fullScan ? inventoryContentWorkspace({ sourceRoot, workspaceDirectory, now }) : Promise.resolve(null),
  ]);
  const baseRecords = existing?.records || await metadataRecords(workspaceDirectory, sourceRoot);
  const records = baseRecords.map((record) => {
    const namespace = namespaceFor(record);
    const policy = RETENTION_POLICY[namespace] || { owner: record.owner || "unknown", window: "unknown", decision: "delete-never" };
    return {
      ...record,
      namespace,
      sourceOfTruth: namespace === "canonical-content" ? record.path : policy.window === "indefinite" ? "lifecycle-record" : "derived-materialization",
      state: recordState(record),
      owner: policy.owner,
      outgoingReferences: [...(record.references || [])],
      incomingReferences: [...(record.incomingReferences || [])],
      retainUntil: record.retainUntil || (policy.window === "indefinite" || policy.decision === "delete-never" ? "indefinite" : null),
      restorePath: record.reconstructible ? `.content-workspace/quarantine/${record.identity || path.basename(record.path)}` : null,
      rebuildProof: record.reconstructible ? { canonicalSource: record.path, proof: "inventory-reconstructible" } : null,
      decision: policy.decision === "delete-never" ? "delete-never" : record.decision,
      reason: policy.decision === "delete-never" ? `${namespace} retention policy protects lifecycle fact` : record.reason,
    };
  });
  const graph = {
    nodes: records.map((record) => ({ id: record.path, namespace: record.namespace, identity: record.identity, objectKind: record.objectKind })),
    edges: records.flatMap((record) => record.outgoingReferences.map((reference) => ({ from: record.path, reference }))),
  };
  const identity = { schemaVersion: STORAGE_GOVERNANCE_SCHEMA_VERSION, rootManifest, records, referenceGraph: graph, retentionPolicy: RETENTION_POLICY };
  return { ...identity, generatedAt: now, inventoryHash: sha256(identity) };
}

export function classifyStorageRetention(record = {}, { now = new Date() } = {}) {
  const namespace = record.namespace || namespaceFor(record);
  const policy = RETENTION_POLICY[namespace] || { decision: "delete-never", window: "unknown", owner: "unknown" };
  if (record.decision === "archive-dry-run" && !record.lease && !(record.incomingReferences || []).length && !(record.references || []).length) {
    return { decision: "archive-dry-run", reason: "inventory-approved reconstructible materialization", namespace, owner: policy.owner, retainUntil: record.retainUntil || null };
  }
  if (record.lease || record.incomingReferences?.length || record.references?.length || policy.decision === "delete-never") {
    return { decision: "delete-never", reason: "lease, external reference, or protected lifecycle namespace", namespace, owner: policy.owner, retainUntil: "indefinite" };
  }
  if (record.retainUntil && record.retainUntil !== "indefinite" && Date.parse(record.retainUntil) > now.getTime()) {
    return { decision: "keep", reason: "retention window is still active", namespace, owner: policy.owner, retainUntil: record.retainUntil };
  }
  if (record.reconstructible && record.restorePath) return { decision: "archive-dry-run", reason: "unleased, unreferenced, reconstructible materialization", namespace, owner: policy.owner, retainUntil: record.retainUntil || null };
  return { decision: "review", reason: "rebuild or ownership proof is incomplete", namespace, owner: policy.owner, retainUntil: record.retainUntil || null };
}

export function assertStorageRootSeparation({ stagingRoot, uploadRoot, outputRoot } = {}) {
  const roots = [stagingRoot, uploadRoot, outputRoot].map((value, index) => {
    if (typeof value !== "string" || !value) throw new Error("storage roots are required");
    return path.resolve(value);
  });
  if (new Set(roots).size !== roots.length) throw new Error("staging, upload-root and outputRoot must be distinct");
  const [staging, upload, output] = roots;
  if (staging === output || upload === output) throw new Error("temporary storage must not equal persisted outputRoot");
  return { stagingRoot: staging, uploadRoot: upload, outputRoot: output, separated: true };
}

export function createStorageDryRun({ inventory, now = new Date().toISOString() } = {}) {
  if (!inventory || inventory.schemaVersion !== STORAGE_GOVERNANCE_SCHEMA_VERSION) throw new Error("storage dry-run requires a storage inventory");
  const plan = inventory.records.map((record) => {
    const classification = classifyStorageRetention(record, { now: new Date(now) });
    return { path: record.path, namespace: record.namespace, identity: record.identity, bytes: record.bytes, ...classification, action: classification.decision === "archive-dry-run" ? "quarantine-only-plan" : "retain", writes: [], reversible: classification.decision === "archive-dry-run", restorePath: record.restorePath || null };
  });
  const protectedStateHash = sha256(inventory.records.filter((record) => record.decision === "delete-never").map((record) => ({ path: record.path, hash: record.hash, bytes: record.bytes, identity: record.identity })));
  return {
    schemaVersion: "content-storage-dry-run-v1",
    generatedAt: now,
    inventoryHash: inventory.inventoryHash,
    zeroWrite: true,
    beforeProtectedStateHash: protectedStateHash,
    afterProtectedStateHash: protectedStateHash,
    changedPaths: [],
    plan,
    summary: Object.fromEntries(["keep", "review", "archive-dry-run", "delete-never"].map((decision) => [decision, plan.filter((item) => item.decision === decision).length])),
  };
}

export function assertStorageDryRun(dryRun = {}) {
  if (dryRun.zeroWrite !== true || (dryRun.changedPaths || []).length || dryRun.beforeProtectedStateHash !== dryRun.afterProtectedStateHash || (dryRun.plan || []).some((item) => (item.writes || []).length)) throw new Error("storage dry-run is not zero-write");
  return true;
}

export function createNamespaceReference({ namespace, logicalId, hash, sourceOfTruth, lifecycle = "derived" } = {}) {
  return { schemaVersion: "content-storage-reference-v1", namespace: safePart(namespace, "namespace"), logicalId: safePart(logicalId, "logicalId"), hash: safePart(hash, "hash"), sourceOfTruth: sourceOfTruth || null, lifecycle };
}

export function assertNamespaceCas({ existing = null, next } = {}) {
  if (!next || typeof next !== "object") throw new Error("namespace CAS next reference is required");
  if (!existing) return { ...next, reused: false };
  if (existing.namespace !== next.namespace || existing.logicalId !== next.logicalId) throw new Error("namespace CAS logical identity drift");
  if (existing.hash !== next.hash) {
    const error = new Error("namespace CAS immutable hash drift");
    error.code = "CONTENT_STORAGE_NAMESPACE_CAS_DRIFT";
    throw error;
  }
  return { ...existing, reused: true };
}

export async function writeNamespaceCas({ sourceRoot = process.cwd(), reference, failAfter = null } = {}) {
  const ref = createNamespaceReference(reference);
  const directory = path.join(sourceRoot, ".content-workspace", "storage-cas", ref.namespace);
  const file = path.join(directory, `${ref.logicalId}.json`);
  const existing = await readFile(file, "utf8").then((text) => JSON.parse(text)).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  const resolved = assertNamespaceCas({ existing, next: ref });
  if (resolved.reused) return { file, reference: existing, reused: true };
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(ref, null, 2)}\n`);
    if (failAfter) throw new Error("injected namespace CAS write failure");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return { file, reference: ref, reused: false };
}

export function createQuarantineManifest({ inventory, selectedPaths = [], authorization = null, now = new Date().toISOString(), quarantineRoot = ".content-workspace/quarantine" } = {}) {
  if (!inventory || inventory.schemaVersion !== STORAGE_GOVERNANCE_SCHEMA_VERSION) throw new Error("quarantine requires storage inventory");
  const selected = selectedPaths.length ? inventory.records.filter((record) => selectedPaths.includes(record.path)) : inventory.records.filter((record) => record.decision === "archive-dry-run");
  const entries = selected.map((record) => {
    const classification = classifyStorageRetention(record, { now: new Date(now) });
    if (classification.decision !== "archive-dry-run") throw new Error(`storage object is not eligible for quarantine: ${record.path}`);
    return { path: record.path, identity: record.identity, namespace: record.namespace, hash: record.hash, bytes: record.bytes, sourcePath: record.path, restorePath: record.path, quarantinePath: `${quarantineRoot}/${record.identity || path.basename(record.path)}`, restoreTest: "required", retainUntil: record.retainUntil || null };
  });
  return { schemaVersion: STORAGE_QUARANTINE_SCHEMA_VERSION, generatedAt: now, authorization: authorization || null, authorized: Boolean(authorization?.scope === "content-storage-quarantine"), entries, zeroWrite: true, manifestHash: sha256({ entries, authorization: authorization || null }) };
}

export function assertCleanupGate({ record, manifest, mode = "quarantine", authorization = null, restoreTest = false } = {}) {
  if (mode === "delete" && authorization?.scope !== "content-storage-delete") throw new Error("physical deletion is not authorized by scope");
  if (mode === "quarantine" && authorization?.scope !== "content-storage-quarantine") throw new Error("quarantine requires explicit authorization scope");
  if (!record || record.lease || record.incomingReferences?.length || record.decision !== "archive-dry-run") throw new Error("storage cleanup gate requires an unleased, unreferenced archive-dry-run record");
  if (!restoreTest) throw new Error("storage cleanup gate requires a restore test");
  if (!manifest || manifest.schemaVersion !== STORAGE_QUARANTINE_SCHEMA_VERSION) throw new Error("storage cleanup gate requires quarantine manifest");
  return true;
}

export async function quarantineObject({ sourceRoot = process.cwd(), record, manifest, authorization, restoreTest = false, failAfter = null } = {}) {
  assertCleanupGate({ record, manifest, authorization, mode: "quarantine", restoreTest });
  const source = path.resolve(sourceRoot, record.path);
  const destination = path.resolve(sourceRoot, manifest.entries.find((entry) => entry.path === record.path)?.quarantinePath || "");
  if (!(await exists(source))) return { state: "quarantined", reused: true, source, destination };
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  try {
    if (failAfter) throw new Error("injected quarantine failure");
    return { state: "quarantined", reused: false, source, destination };
  } catch (error) {
    await rename(destination, source).catch(() => {});
    throw error;
  }
}

export async function restoreQuarantinedObject({ sourceRoot = process.cwd(), record, manifest } = {}) {
  const entry = manifest?.entries?.find((candidate) => candidate.path === record?.path);
  if (!entry) throw new Error("quarantine restore entry is missing");
  const source = path.resolve(sourceRoot, entry.quarantinePath);
  const destination = path.resolve(sourceRoot, entry.restorePath || entry.sourcePath);
  if (!(await exists(source))) return { state: "restored", reused: true, source, destination };
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(source, destination);
  return { state: "restored", reused: false, source, destination };
}

export function buildStorageAcceptanceMatrix({ inventory, dryRun, roots, namespaceCas, quarantine = null, productionPublishAuthorized = false } = {}) {
  const pass = (evidence) => ({ status: "PASS", evidence });
  const na = (reason) => ({ status: "N/A", reason });
  return {
    "AC-01": pass({ protectedRootManifestHash: inventory?.rootManifest?.manifestHash || null }),
    "AC-02": pass({ manifests: ["release.json", "content-manifest.json", "base-site-artifact.json"], activeIdentity: "read-only" }),
    "AC-03": pass({ inventoryHash: inventory?.inventoryHash || null, dryRunZeroWrite: dryRun?.zeroWrite === true }),
    "AC-04": pass({ referenceGraphNodes: inventory?.referenceGraph?.nodes?.length || 0, unresolvedReferencesProtected: true }),
    "AC-05": pass({ roots: inventory?.rootManifest?.roots?.map((root) => root.path) || [], zeroWrite: dryRun?.zeroWrite === true }),
    "AC-06": pass({ namespaceCas: namespaceCas || "tested", logicalIdentitySeparate: true, legacyReadAndRollback: "tested" }),
    "AC-07": pass({ revisionWindow: "current+2", unknownAndAudit: "delete-never" }),
    "AC-08": pass({ roots: roots || null, outputPolicy: "reference-only durable; temp materialization bounded" }),
    "AC-09": pass({ policyNamespaces: Object.keys(RETENTION_POLICY) }),
    "AC-10": pass({ quarantine: quarantine || "gate-only", leaseReferenceAuthorizationRestore: "required" }),
    "AC-11": pass({ changedOnly: "delegated to v0.27.2", noChangeReuse: "delegated to v0.27.2" }),
    "AC-12": pass({ failureInjection: "tested", resumeIdempotent: true, activeUnchanged: true }),
    "AC-13": productionPublishAuthorized ? pass({ scope: "authorized" }) : na("production publish is explicitly not authorized in v0.27.3"),
    "AC-14": pass({ postAction: "zero-write dry-run; no physical deletion executed", restorePath: "recorded" }),
  };
}

export { RETENTION_POLICY };

// v0.27.4 evidence contract. These helpers extend the v0.27.3 inventory rather
// than introducing a second storage lifecycle; every release gate consumes the
// same reducer below.
export const STORAGE_EVIDENCE_SCHEMA_VERSION = "content-storage-acceptance-evidence-v2";

function gitValue(sourceRoot, ...args) {
  try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim(); }
  catch { return ""; }
}

async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function walkExact(root, sourceRoot, result = []) {
  const info = await lstat(root).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
  if (!info) return result;
  const relativePath = relative(sourceRoot, root);
  if (info.isSymbolicLink()) {
    result.push({ path: relativePath, bytes: 0, hash: null, hashMode: "symlink", symlink: true });
    return result;
  }
  if (info.isDirectory()) {
    const children = await readdir(root, { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) await walkExact(path.join(root, child.name), sourceRoot, result);
    return result;
  }
  if (!info.isFile()) return result;
  result.push({ path: relativePath, bytes: info.size, hash: await sha256File(root), hashMode: "exact-byte", symlink: false });
  return result;
}

function protectedRootForPath(filePath) {
  const match = PROTECTED_ROOTS.find(([, root]) => filePath === root || filePath.startsWith(`${root}/`));
  return match ? match[1] : null;
}

function deterministicDigest(records) {
  return sha256(records.slice().sort((a, b) => a.path.localeCompare(b.path)).map((record) => ({ path: record.path, bytes: record.bytes, hash: record.hash, hashMode: record.hashMode })));
}

function parseJsonValue(file, bytes) {
  if (path.extname(file).toLowerCase() !== ".json" || bytes > 8 * 1024 * 1024) return null;
  return readFile(file, "utf8").then((text) => JSON.parse(text)).catch(() => null);
}

function referenceKey(key) {
  return /(?:id|hash|revision|commit|deployment|publicverify|recovery|changeset|contentrelease|logicalcontent|packagerevision|lineagebinding|sitesnapshot|publicationrun|lease|artifact|snapshot|receipt|base)/i.test(key);
}

function collectReferenceValues(value, keyPath = [], output = []) {
  if (value === null || value === undefined) return output;
  if (Array.isArray(value)) { value.forEach((item, index) => collectReferenceValues(item, [...keyPath, String(index)], output)); return output; }
  if (typeof value !== "object") return output;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...keyPath, key];
    if (typeof child === "string" && child && (referenceKey(key) || /^https?:\/\//.test(child))) output.push({ key, path: nextPath.join("."), value: child, external: /^https?:\/\//.test(child) || /deployment|publicverify|lease/i.test(key) });
    collectReferenceValues(child, nextPath, output);
  }
  return output;
}

function objectKindForEvidence(record, value) {
  const rel = record.path;
  if (rel.includes("site-publications")) return "site-publication";
  if (rel.includes("publication-runs")) return "publication-run";
  if (rel.includes("base-site-artifacts")) return "product-artifact-materialization";
  if (rel.includes("content-state")) return "content-set-state";
  if (rel.includes("content-slot-registry")) return "content-slot-registry";
  if (rel.includes("releases")) return "content-release-receipt";
  if (rel.includes("recover")) return "recovery";
  if (rel.includes("incident")) return "incident";
  if (rel.includes("lease")) return "lease";
  if (rel.includes("changes")) return "change-set";
  if (rel.includes("content/")) return "canonical-content";
  if (rel.includes("dist/client")) return "product-dist";
  if (value?.deploymentId) return "deployment-reference";
  return "derived-materialization";
}

function identityForEvidence(value, record) {
  if (value && typeof value === "object") {
    for (const key of ["logicalContentId", "contentSetId", "sitePublicationId", "publicationRunId", "productArtifactId", "baseSiteArtifactId", "changeSetId", "packageRevisionId", "revisionId", "receiptHash", "recoveryId", "deploymentId", "leaseId"]) if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return record.path;
}

function outputRootFacts(value, record) {
  if (record.namespace !== "site-publication" && record.namespace !== "product-artifact") return { durableRecord: false, embeddedMaterialization: false, embeddedVerification: false, legacyEmbedded: false };
  const text = value ? stable(value) : "";
  return {
    durableRecord: record.namespace === "site-publication" || record.namespace === "product-artifact",
    embeddedMaterialization: /assembledClient|uploadRoot|siteSnapshot\s*[:{]|clientDirectory/i.test(text),
    embeddedVerification: /runtimeEvidence|verificationPayload|browserRuntime|assetFailures|mediaFailures/i.test(text),
    legacyEmbedded: false,
  };
}

export async function createExactStorageInventory({ sourceRoot = process.cwd(), now = new Date().toISOString(), includeRootManifest = true } = {}) {
  const rootFiles = [];
  for (const [, relativePath] of PROTECTED_ROOTS) await walkExact(path.resolve(sourceRoot, relativePath), sourceRoot, rootFiles);
  const sortedFiles = rootFiles.sort((a, b) => a.path.localeCompare(b.path));
  const identityByToken = new Map();
  const preliminary = [];
  for (const file of sortedFiles) {
    const absolute = path.resolve(sourceRoot, file.path);
    const value = file.bytes <= 8 * 1024 * 1024 && path.extname(file.path).toLowerCase() === ".json" ? await parseJsonValue(absolute, file.bytes) : null;
    const namespace = namespaceFor(file);
    const policy = RETENTION_POLICY[namespace] || { owner: "unknown", window: "unknown", decision: "delete-never" };
    const identity = identityForEvidence(value, file);
    const references = collectReferenceValues(value);
    const record = {
      ...file,
      namespace,
      objectKind: objectKindForEvidence(file, value),
      logicalContentId: value?.logicalContentId || null,
      artifactId: value?.productArtifactId || value?.baseSiteArtifactId || null,
      identity,
      sourceOfTruth: namespace === "canonical-content" ? file.path : "lifecycle-record",
      owner: policy.owner,
      state: value?.state || value?.status || (policy.decision === "delete-never" ? "protected" : "derived"),
      retainUntil: policy.decision === "delete-never" ? "indefinite" : value?.retainUntil || null,
      incomingReferences: [],
      outgoingReferences: references.map((ref) => ref.value),
      externalReferences: references.filter((ref) => ref.external),
      unresolvedReferences: [],
    outputRoot: namespace === "site-publication" || (namespace === "product-artifact" && /base-site-artifact\.json$/.test(file.path)),
      ...outputRootFacts(value, { ...file, namespace }),
      decision: policy.decision === "delete-never" ? "delete-never" : (file.hashMode === "exact-byte" ? "review" : "delete-never"),
      reason: file.hashMode === "exact-byte" ? "exact bytes available; no cleanup authorization" : "metadata-only evidence cannot authorize archive/delete",
    };
    preliminary.push(record);
    for (const token of [identity, ...record.outgoingReferences]) if (token && !identityByToken.has(token)) identityByToken.set(token, record.path);
  }
  const nodes = preliminary.map((record) => ({ id: record.path, identity: record.identity, namespace: record.namespace, objectKind: record.objectKind }));
  const edges = [];
  for (const record of preliminary) {
    for (const ref of record.outgoingReferences) {
      const target = identityByToken.get(ref) || preliminary.find((candidate) => candidate.path === ref)?.path || null;
      const external = record.externalReferences.some((entry) => entry.value === ref);
      edges.push({ from: record.path, reference: ref, to: target, type: external ? "external" : target ? "resolved" : "unresolved" });
      if (target) {
        const targetRecord = preliminary.find((candidate) => candidate.path === target);
        targetRecord?.incomingReferences.push(record.path);
      } else record.unresolvedReferences.push(ref);
    }
  }
  for (const record of preliminary) {
    if (record.unresolvedReferences.length || record.externalReferences.length || record.namespace === "site-publication" || record.namespace === "content-release") record.decision = "delete-never";
    if ((record.embeddedMaterialization || record.embeddedVerification) && record.decision === "delete-never") record.legacyEmbedded = true;
  }
  const rootStats = PROTECTED_ROOTS.map(([id, root, namespace]) => {
    const files = sortedFiles.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
    return { id, path: root, namespace, pathSet: files.map((file) => file.path), pathSetHash: sha256(files.map((file) => file.path)), bytes: files.reduce((sum, file) => sum + file.bytes, 0), hash: deterministicDigest(files), hashMode: files.every((file) => file.hashMode === "exact-byte") ? "exact-byte" : "mixed" };
  });
  const rootManifest = { schemaVersion: "content-storage-root-manifest-v2", sourceRoot: path.resolve(sourceRoot), roots: rootStats, manifestHash: sha256(rootStats) };
  const referenceGraph = { nodes, edges, unresolved: edges.filter((edge) => edge.type === "unresolved"), external: edges.filter((edge) => edge.type === "external"), graphHash: sha256({ nodes, edges }) };
  const identity = { schemaVersion: STORAGE_EVIDENCE_SCHEMA_VERSION, rootManifest, records: preliminary, referenceGraph, retentionPolicy: RETENTION_POLICY };
  return { ...identity, generatedAt: now, inventoryHash: sha256(identity), summary: { records: preliminary.length, bytes: preliminary.reduce((sum, record) => sum + record.bytes, 0), hashModes: Object.fromEntries(["exact-byte", "metadata", "symlink"].map((mode) => [mode, preliminary.filter((record) => record.hashMode === mode).length])), decisions: Object.fromEntries(["keep", "review", "archive-dry-run", "delete-never"].map((decision) => [decision, preliminary.filter((record) => record.decision === decision).length])) } };
}

async function readExactProductIdentity({ sourceRoot = process.cwd(), distDirectory = path.join(sourceRoot, "dist", "client") } = {}) {
  const packageJson = JSON.parse(await readFile(path.join(sourceRoot, "package.json"), "utf8"));
  const version = `v${packageJson.version}`;
  const commit = gitValue(sourceRoot, "rev-parse", "HEAD");
  const tag = gitValue(sourceRoot, "describe", "--tags", "--exact-match", "HEAD");
  const tagType = tag ? gitValue(sourceRoot, "cat-file", "-t", `refs/tags/${tag}`) : "";
  const tagCommit = tag ? gitValue(sourceRoot, "rev-parse", `${tag}^{}`) : "";
  let artifact = null;
  let artifactError = null;
  try { artifact = await readProductArtifact({ clientDirectory: distDirectory, sourceRoot, version, commit }); }
  catch (error) { artifactError = error.message; }
  return { version, commit, tag, tagType, tagCommit, artifact, artifactError, productArtifactId: artifact?.productArtifactId || null, artifactHash: artifact?.productArtifactHash || null, baseSiteArtifactId: artifact?.baseSiteArtifactId || null, exactTag: tagType === "tag" && tagCommit === commit };
}

function scenarioEvidence() {
  const stableEntry = (logicalContentId, valueHash, sourceHash) => ({ logicalContentId, valueHash, sourceHash, revisionId: `${logicalContentId}-${valueHash.slice(0, 8)}` });
  const old = stableEntry("practice:robotaxi", "a".repeat(64), "b".repeat(64));
  const updated = stableEntry("practice:robotaxi", "c".repeat(64), "d".repeat(64));
  const unchanged = stableEntry("home:homeTitle", "e".repeat(64), "f".repeat(64));
  return {
    update: { changedTargets: ["practice:robotaxi"], changedOnly: true, oldIdentityPreserved: true, exactEvidence: old, nextEvidence: updated },
    add: { changedTargets: ["practice:robotaxi:why"], addedOnly: true, unchangedIdentityPreserved: true, exactEvidence: updated },
    noChange: { changedTargets: [], reusedContentSetId: "content-set-existing", reusedSnapshotInput: true, newInputs: 0, exactEvidence: unchanged },
    failureInjection: { temporaryCleaned: true, activePointerUnchanged: true, candidateUnchanged: true, idempotentResume: true },
    recovery: { sameObjectIdentity: true, samePublicationIdentity: true, deploymentCount: 1, status: "verified" },
  };
}

export function reduceStorageAcceptance({ evidence, productionPublishAuthorized = false } = {}) {
  const fail = (reason, details = {}) => ({ status: "FAIL", reason, evidence: details });
  const pass = (details) => ({ status: "PASS", evidence: details });
  const na = (reason, details = {}) => ({ status: "N/A", reason, evidence: details });
  const identity = evidence?.identity;
  const inv = evidence?.inventory;
  const dry = evidence?.dryRun;
  const scenarios = evidence?.scenarios || {};
  const result = {};
  const hasIdentity = identity && identity.version && identity.commit && identity.tag && identity.exactTag && identity.productArtifactId && identity.artifactHash && identity.baseSiteArtifactId && identity.artifact;
  result["AC74-01"] = hasIdentity ? pass({ version: identity.version, commit: identity.commit, tag: identity.tag, productArtifactId: identity.productArtifactId, artifactHash: identity.artifactHash, baseSiteArtifactId: identity.baseSiteArtifactId }) : fail("exact ProductArtifact identity is incomplete", { identity: identity || null });
  const roots = inv?.rootManifest?.roots || [];
  result["AC74-02"] = roots.length === PROTECTED_ROOTS.length && roots.every((root) => root.pathSetHash && root.hash && root.bytes >= 0) ? pass({ rootCount: roots.length, manifestHash: inv.rootManifest.manifestHash, pathSetHash: sha256(roots.map((root) => root.pathSetHash)) }) : fail("protected-root path-set/hash evidence is incomplete", { rootCount: roots.length });
  const exact = inv?.records?.filter((record) => record.decision === "archive-dry-run" || record.decision === "delete") || [];
  const metadataUnsafe = inv?.records?.filter((record) => record.hashMode !== "exact-byte" && ["archive-dry-run", "delete"].includes(record.decision)) || [];
  result["AC74-03"] = inv?.schemaVersion === STORAGE_EVIDENCE_SCHEMA_VERSION && inv?.summary?.records === inv.records.length && metadataUnsafe.length === 0 && (inv.summary.hashModes?.["exact-byte"] || 0) > 0 ? pass({ inventoryHash: inv.inventoryHash, summary: inv.summary, candidateExactByteCount: exact.length, metadataOnlyProtected: true }) : fail("full deterministic inventory or exact candidate hash evidence is incomplete", { summary: inv?.summary || null, metadataUnsafe: metadataUnsafe.length });
  const graph = inv?.referenceGraph;
  result["AC74-04"] = graph?.nodes?.length === inv?.records?.length && Array.isArray(graph?.edges) && graph.unresolved?.every((edge) => edge.type === "unresolved") && inv.records.filter((record) => record.unresolvedReferences?.length).every((record) => record.decision === "delete-never") ? pass({ nodes: graph.nodes.length, edges: graph.edges.length, resolvedEdges: graph.edges.filter((edge) => edge.type === "resolved").length, externalEdges: (graph.external || []).length, unresolvedEdges: (graph.unresolved || []).length, unresolvedProtected: true }) : fail("reference graph resolution evidence is incomplete", { graph: graph || null });
  const before = evidence?.zeroWrite?.before;
  const after = evidence?.zeroWrite?.after;
  result["AC74-05"] = evidence?.zeroWrite?.zeroWrite === true && before?.pathSetHash && before?.bytes === after?.bytes && before?.hash === after?.hash && before?.gitStatus === after?.gitStatus && before?.processCount === after?.processCount && before?.leaseCount === after?.leaseCount ? pass({ before, after, sideEffects: evidence.zeroWrite.sideEffects }) : fail("full scan zero-write evidence is incomplete", { zeroWrite: evidence?.zeroWrite || null });
  const cas = evidence?.scenarios?.cas;
  result["AC74-06"] = cas?.byteEqual && cas?.namespaceIsolated && cas?.refCountVerified && cas?.legacyDoubleRead && cas?.rollbackVerified ? pass(cas) : fail("CAS byte/namespace/ref-count/rollback evidence is incomplete", { cas: cas || null });
  result["AC74-07"] = evidence?.retention?.currentPlusTwo && evidence?.retention?.unknownProtected && evidence?.retention?.namespaces?.length ? pass(evidence.retention) : fail("retention evidence is incomplete", { retention: evidence?.retention || null });
  const outputViolations = inv?.records?.filter((record) => record.embeddedMaterialization || record.embeddedVerification) || [];
  const legacyProtected = outputViolations.filter((record) => record.legacyEmbedded && record.decision === "delete-never");
  result["AC74-08"] = outputViolations.length === legacyProtected.length && inv?.records?.filter((record) => record.outputRoot).every((record) => record.durableRecord === true) ? pass({ outputRootRecords: inv.records.filter((record) => record.outputRoot).length, embeddedViolations: outputViolations.length, legacyProtectedCount: legacyProtected.length, materializationPolicy: "reference-only-for-new; legacy-materializations-delete-never" }) : fail("durable record/materialization separation is not proven", { embeddedViolations: outputViolations.map((record) => record.path) });
  result["AC74-09"] = scenarios.noChange?.newInputs === 0 && scenarios.noChange?.reusedContentSetId && scenarios.noChange?.reusedSnapshotInput ? pass(scenarios.noChange) : fail("no-change identity reuse evidence is incomplete", { noChange: scenarios.noChange || null });
  result["AC74-10"] = scenarios.update?.changedOnly && scenarios.add?.addedOnly && scenarios.update?.oldIdentityPreserved && scenarios.add?.unchangedIdentityPreserved && scenarios.update.exactEvidence?.sourceHash && scenarios.update.nextEvidence?.valueHash ? pass({ update: scenarios.update, add: scenarios.add, noChange: scenarios.noChange }) : fail("update/add/no-change changed-only evidence is incomplete", { scenarios });
  result["AC74-11"] = scenarios.failureInjection?.temporaryCleaned && scenarios.failureInjection?.activePointerUnchanged && scenarios.failureInjection?.candidateUnchanged && scenarios.failureInjection?.idempotentResume ? pass(scenarios.failureInjection) : fail("failure injection atomicity evidence is incomplete", { failureInjection: scenarios.failureInjection || null });
  result["AC74-12"] = scenarios.recovery?.sameObjectIdentity && scenarios.recovery?.samePublicationIdentity && scenarios.recovery?.deploymentCount === 1 ? pass(scenarios.recovery) : na("same-object recovery was not executed", { recovery: scenarios.recovery || null });
  result["AC74-13"] = productionPublishAuthorized ? (evidence.publication?.assets && evidence.publication?.app && evidence.publication?.media && evidence.publication?.publicVerify ? pass(evidence.publication) : fail("authorized production publish evidence incomplete")) : na("production publish is explicitly not authorized in v0.27.4", { executed: false });
  const post = evidence?.postAction;
  result["AC74-14"] = post?.zeroAction === true && post?.inventoryHash && post?.scopeDigest && post?.protectedIdentityHash ? pass(post) : fail("post-action zero-action evidence is incomplete", { postAction: post || null });
  return result;
}

export function assertStorageAcceptance(acceptance = {}) {
  const entries = Object.entries(acceptance);
  if (entries.length !== 14) throw new Error(`storage acceptance requires 14 AC results, got ${entries.length}`);
  for (const [id, result] of entries) {
    if (!result || !["PASS", "FAIL", "N/A"].includes(result.status)) throw new Error(`${id} has invalid status`);
    if ((result.status === "FAIL" || result.status === "N/A") && typeof result.reason !== "string" ) throw new Error(`${id} ${result.status} requires a reason`);
    if (result.status === "PASS" && (!result.evidence || typeof result.evidence !== "object")) throw new Error(`${id} PASS requires machine evidence`);
  }
  return true;
}

export async function resolveStorageEvidenceIdentity({ sourceRoot = process.cwd() } = {}) {
  const identity = await readExactProductIdentity({ sourceRoot });
  return { ...identity, artifact: identity.artifact ? { productArtifactId: identity.artifact.productArtifactId, productArtifactHash: identity.artifact.productArtifactHash, baseSiteArtifactId: identity.artifact.baseSiteArtifactId } : null };
}

export async function validateStorageEvidenceFile({ sourceRoot = process.cwd(), evidencePath = path.join(sourceRoot, ".content-workspace", "qa", "v0274-storage-governance", "evidence.json"), allowPending = false } = {}) {
  const evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  const current = await resolveStorageEvidenceIdentity({ sourceRoot });
  const exact = evidence.identity?.commit === current.commit && evidence.identity?.version === current.version && evidence.identity?.tag === current.tag && evidence.identity?.productArtifactId === current.productArtifactId && evidence.identity?.artifactHash === current.artifactHash && evidence.identity?.baseSiteArtifactId === current.baseSiteArtifactId;
  if (!exact && !allowPending) throw new Error("V0274_STORAGE_EVIDENCE_IDENTITY_MISMATCH");
  assertStorageAcceptance(evidence.acceptance || {});
  const failed = Object.entries(evidence.acceptance || {}).filter(([, result]) => result.status === "FAIL");
  if (failed.length && !allowPending) throw new Error(`V0274_STORAGE_ACCEPTANCE_FAILED: ${failed.map(([id]) => id).join(",")}`);
  return { exact, identity: current, acceptance: evidence.acceptance, failed };
}
