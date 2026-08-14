import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { normalizeContentSetEntry, validateContentSet } from "./content-set.mjs";
import { assertProductArtifactIdentityShape } from "./product-artifact.mjs";
import { createSiteSnapshot, assertSiteSnapshotIdentity } from "./site-snapshot.mjs";

/**
 * Content lifecycle governance is deliberately a read/model layer.  It does
 * not become a second ContentSet, receipt registry, publisher, or database.
 * The existing ContentSet and SitePublication files remain the runtime facts;
 * these helpers only make the immutable references and safe dry-run decisions
 * explicit and reproducible.
 */
export const CONTENT_LIFECYCLE_SCHEMA_VERSION = "content-lifecycle-v1";
export const CONTENT_REVISION_SCHEMA_VERSION = "content-revision-v1";
export const CONTENT_CHANGE_SET_SCHEMA_VERSION = "content-change-set-v1";
export const CONTENT_INVENTORY_SCHEMA_VERSION = "content-derived-inventory-v1";
export const CONTENT_DRY_RUN_SCHEMA_VERSION = "content-derived-dry-run-v1";
export const RETENTION_DECISIONS = Object.freeze([
  "keep",
  "review",
  "archive-dry-run",
  "delete-never",
]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hashValue(value) {
  return sha256(typeof value === "string" || Buffer.isBuffer(value) ? value : stable(value));
}

function requiredString(value, field, location = "content lifecycle") {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required: ${location}`);
  return value;
}

function optionalString(value, field, location = "content lifecycle") {
  if (value == null) return null;
  return requiredString(value, field, location);
}

export function logicalContentId({ kind, target } = {}) {
  return `${requiredString(kind, "kind")}:${requiredString(target, "target")}`;
}

export function contentRevisionIdentity({ logicalContentId: id, sourceHash, valueHash, predecessorRevisionId = null, productArtifactId = null, changeSetId = null } = {}) {
  const logicalId = requiredString(id, "logicalContentId");
  const source = requiredString(sourceHash, "sourceHash");
  const value = requiredString(valueHash, "valueHash");
  const identity = {
    schemaVersion: CONTENT_REVISION_SCHEMA_VERSION,
    logicalContentId: logicalId,
    sourceHash: source,
    valueHash: value,
    predecessorRevisionId: predecessorRevisionId || null,
    productArtifactId: productArtifactId || null,
    changeSetId: changeSetId || null,
  };
  const revisionHash = hashValue(identity);
  return { ...identity, revisionHash, revisionId: `content-revision-${revisionHash.slice(0, 24)}` };
}

export function createContentRevision({ logicalContentId: id, source, value, sourceHash = null, valueHash = null, predecessorRevisionId = null, productArtifactId = null, changeSetId = null, createdAt = new Date().toISOString() } = {}) {
  const identity = contentRevisionIdentity({
    logicalContentId: id,
    sourceHash: sourceHash || hashValue(source),
    valueHash: valueHash || hashValue(value),
    predecessorRevisionId,
    productArtifactId,
    changeSetId,
  });
  const revision = { ...identity, contentHash: identity.valueHash, createdAt };
  assertContentRevision(revision);
  return revision;
}

export function assertContentRevision(revision = {}) {
  if (revision.schemaVersion !== CONTENT_REVISION_SCHEMA_VERSION) throw new Error("ContentRevision schemaVersion is invalid");
  requiredString(revision.revisionId, "revisionId");
  requiredString(revision.logicalContentId, "logicalContentId");
  requiredString(revision.sourceHash, "sourceHash");
  requiredString(revision.valueHash, "valueHash");
  if (!/^[a-f0-9]{64}$/.test(revision.sourceHash) || !/^[a-f0-9]{64}$/.test(revision.valueHash)) throw new Error("ContentRevision hashes must be SHA-256");
  const identity = contentRevisionIdentity(revision);
  if (identity.revisionId !== revision.revisionId || identity.revisionHash !== revision.revisionHash) throw new Error("ContentRevision identity hash drift");
  if (revision.contentHash !== revision.valueHash) throw new Error("ContentRevision contentHash must equal valueHash");
  if (!Number.isNaN(Date.parse(revision.createdAt))) return revision;
  throw new Error("ContentRevision createdAt is invalid");
}

/** Keep a current revision plus at most two historical revisions. */
export function retainContentRevisions({ current, history = [], maxHistory = 2 } = {}) {
  if (!current) throw new Error("Content lifecycle current revision is required");
  assertContentRevision(current);
  if (!Number.isInteger(maxHistory) || maxHistory < 0) throw new Error("maxHistory must be a non-negative integer");
  const seen = new Set([current.revisionId]);
  const retained = [];
  for (const revision of history) {
    assertContentRevision(revision);
    if (revision.logicalContentId !== current.logicalContentId) {
      throw new Error(`ContentRevision logicalContentId mismatch: ${revision.revisionId}`);
    }
    if (seen.has(revision.revisionId)) continue;
    seen.add(revision.revisionId);
    retained.push(revision);
    if (retained.length >= maxHistory) break;
  }
  return { current, history: retained };
}

function comparableEntry(entry) {
  const normalized = normalizeContentSetEntry(entry);
  return {
    entryId: normalized.entryId,
    kind: normalized.kind,
    target: normalized.target,
    sourcePath: normalized.sourcePath,
    route: normalized.route,
    contentHash: normalized.contentHash,
    sourceProof: normalized.sourceProof,
    reviewProof: normalized.reviewProof,
    mediaProof: normalized.mediaProof,
    legacyAuditId: normalized.legacyAuditId,
  };
}

function sameEntry(left, right) {
  return stable(comparableEntry(left)) === stable(comparableEntry(right));
}

/**
 * Build a deterministic ChangeSet from two entry snapshots.  Only changed or
 * newly added targets receive a revision/ref; unchanged entries are returned
 * as the exact normalized reference from the previous set.
 */
export function createContentChangeSet({ logicalContentId: explicitLogicalId = null, beforeEntries = [], afterEntries = [], productArtifactId = null, createdAt = new Date().toISOString(), sourceHashes = {} } = {}) {
  const before = new Map(beforeEntries.map((entry) => [normalizeContentSetEntry(entry).entryId, entry]));
  const after = new Map(afterEntries.map((entry) => [normalizeContentSetEntry(entry).entryId, entry]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = [];
  const reused = [];
  for (const targetId of ids) {
    const previous = before.get(targetId) || null;
    const next = after.get(targetId) || null;
    if (previous && next && sameEntry(previous, next)) {
      reused.push({ targetId, entryId: targetId, contentHash: normalizeContentSetEntry(previous).contentHash });
      continue;
    }
    const normalizedNext = next ? normalizeContentSetEntry(next) : null;
    const normalizedPrevious = previous ? normalizeContentSetEntry(previous) : null;
    const inferred = explicitLogicalId || (normalizedNext && logicalContentId({ kind: normalizedNext.kind, target: normalizedNext.target }));
    const revision = normalizedNext
      ? createContentRevision({
        logicalContentId: inferred,
        source: normalizedNext.sourceProof,
        value: comparableEntry(normalizedNext),
        // sourceProof is provenance metadata, not the canonical source.  A
        // caller that has read the source bytes supplies sourceHashes; the
        // deterministic fallback hashes the normalized source value itself.
        sourceHash: sourceHashes[targetId] || hashValue(comparableEntry(normalizedNext)),
        valueHash: normalizedNext.contentHash,
        predecessorRevisionId: normalizedPrevious?.revisionId || null,
        productArtifactId,
        changeSetId: null,
        createdAt,
      })
      : null;
    changes.push({
      targetId,
      before: normalizedPrevious ? { ...normalizedPrevious } : null,
      after: normalizedNext ? { ...normalizedNext } : null,
      revision,
    });
  }
  const identity = {
    schemaVersion: CONTENT_CHANGE_SET_SCHEMA_VERSION,
    logicalContentId: explicitLogicalId || (changes.length === 1 ? changes[0].revision?.logicalContentId || null : null),
    productArtifactId: productArtifactId || null,
    changes,
    reused,
  };
  const changeSetHash = hashValue(identity);
  const changeSetId = `content-changeset-${changeSetHash.slice(0, 24)}`;
  const result = { ...identity, changeSetId, changeSetHash, createdAt };
  // A revision's changeSetId is part of its identity. Recompute it now that
  // the deterministic change-set ID is known.
  result.changes = result.changes.map((change) => change.revision
    ? (() => {
      const revision = createContentRevision({
        logicalContentId: change.revision.logicalContentId,
        sourceHash: change.revision.sourceHash,
        valueHash: change.revision.valueHash,
        predecessorRevisionId: change.revision.predecessorRevisionId,
        productArtifactId,
        changeSetId,
        createdAt,
      });
      return {
        ...change,
        revision,
        revisionRef: {
          revisionId: revision.revisionId,
          revisionHash: revision.revisionHash,
          logicalContentId: revision.logicalContentId,
          valueHash: revision.valueHash,
        },
      };
    })()
    : change);
  return result;
}

export function reuseContentSetEntries({ beforeEntries = [], afterEntries = [], changeSet = null } = {}) {
  const before = new Map(beforeEntries.map((entry) => [normalizeContentSetEntry(entry).entryId, entry]));
  const changed = new Set((changeSet?.changes || []).map((change) => change.targetId));
  return afterEntries.map((entry) => {
    const normalized = normalizeContentSetEntry(entry);
    const previous = before.get(normalized.entryId);
    return previous && !changed.has(normalized.entryId) && sameEntry(previous, normalized)
      ? previous
      : normalized;
  });
}

export function assertContentChangeSet(changeSet = {}) {
  if (changeSet.schemaVersion !== CONTENT_CHANGE_SET_SCHEMA_VERSION) throw new Error("ContentChangeSet schemaVersion is invalid");
  requiredString(changeSet.changeSetId, "changeSetId", "ContentChangeSet");
  if (!/^content-changeset-[a-f0-9]{24}$/.test(changeSet.changeSetId)) throw new Error("ContentChangeSet changeSetId is invalid");
  if (!/^[a-f0-9]{64}$/.test(changeSet.changeSetHash || "")) throw new Error("ContentChangeSet changeSetHash must be SHA-256");
  if (!Array.isArray(changeSet.changes) || !Array.isArray(changeSet.reused)) throw new Error("ContentChangeSet changes/reused are required");
  const changedIds = new Set();
  for (const change of changeSet.changes) {
    requiredString(change.targetId, "targetId", "ContentChangeSet change");
    if (changedIds.has(change.targetId)) throw new Error(`ContentChangeSet duplicate target: ${change.targetId}`);
    changedIds.add(change.targetId);
    if (change.revision) {
      assertContentRevision(change.revision);
      if (change.revision.changeSetId !== changeSet.changeSetId) throw new Error(`ContentChangeSet revision lineage drift: ${change.targetId}`);
      if (change.revisionRef?.revisionId !== change.revision.revisionId || change.revisionRef?.revisionHash !== change.revision.revisionHash) {
        throw new Error(`ContentChangeSet revision reference drift: ${change.targetId}`);
      }
    }
  }
  for (const reused of changeSet.reused) {
    requiredString(reused.targetId, "targetId", "ContentChangeSet reused");
    if (changedIds.has(reused.targetId)) throw new Error(`ContentChangeSet target is both changed and reused: ${reused.targetId}`);
  }
  return changeSet;
}

export async function writeContentChangeSet({ sourceRoot = process.cwd(), changeSet } = {}) {
  assertContentChangeSet(changeSet);
  const directory = path.join(sourceRoot, ".content-workspace", "changes");
  const file = path.join(directory, `${changeSet.changeSetId}.json`);
  try {
    const existing = assertContentChangeSet(JSON.parse(await readFile(file, "utf8")));
    if (existing.changeSetHash !== changeSet.changeSetHash) throw new Error(`ContentChangeSet immutable identity collision: ${changeSet.changeSetId}`);
    return { file, changeSet: existing, reused: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(changeSet, null, 2)}\n`);
  await rename(temporary, file);
  return { file, changeSet, reused: false };
}

export async function readContentChangeSet({ sourceRoot = process.cwd(), changeSetId } = {}) {
  requiredString(changeSetId, "changeSetId", "ContentChangeSet");
  const file = path.join(sourceRoot, ".content-workspace", "changes", `${changeSetId}.json`);
  const changeSet = JSON.parse(await readFile(file, "utf8"));
  return assertContentChangeSet(changeSet);
}

export function createDeterministicSiteSnapshot({ productArtifact, contentSet, manifest } = {}) {
  const product = assertProductArtifactIdentityShape(productArtifact);
  validateContentSet(contentSet);
  if (!manifest || typeof manifest !== "object") throw new Error("SiteSnapshot manifest is required");
  // Compatibility adapter only: the repository's sole snapshot identity
  // source is site-snapshot-v1.  Do not derive a second hash from an ad-hoc
  // manifest supplied by callers.
  if (manifest.contentSetId && manifest.contentSetId !== contentSet.contentSetId) throw new Error("SiteSnapshot manifest ContentSet identity mismatch");
  if (manifest.contentSetHash && manifest.contentSetHash !== contentSet.contentSetHash) throw new Error("SiteSnapshot manifest ContentSet hash mismatch");
  const snapshot = createSiteSnapshot({ productArtifact: product, contentSet, createdAt: "1970-01-01T00:00:00.000Z" });
  assertSiteSnapshotIdentity(snapshot);
  return snapshot;
}

export function compactSitePublicationRecord(publication = {}) {
  const productArtifact = publication.productArtifact || {
    productArtifactId: publication.productArtifactId,
    productVersion: publication.productVersion,
    productCommit: publication.productCommit,
    baseSiteArtifactId: publication.baseSiteArtifactId || publication.productArtifactId,
    productArtifactHash: publication.productArtifactHash || undefined,
  };
  const product = assertProductArtifactIdentityShape(productArtifact);
  const contentSet = publication.contentSet || {
    contentSetId: publication.contentSetId,
    contentSetHash: publication.contentSetHash,
  };
  requiredString(contentSet.contentSetId, "contentSetId", "SitePublication");
  requiredString(contentSet.contentSetHash, "contentSetHash", "SitePublication");
  const manifest = publication.manifest || publication.contentManifest || {};
  const manifestHash = publication.manifestHash || hashValue(manifest);
  return {
    schemaVersion: "site-publication-record-v2",
    sitePublicationId: requiredString(publication.sitePublicationId, "sitePublicationId", "SitePublication"),
    siteSnapshotId: optionalString(publication.siteSnapshotId, "siteSnapshotId"),
    snapshotHash: requiredString(publication.snapshotHash, "snapshotHash", "SitePublication"),
    productArtifact: product,
    contentSet: { contentSetId: contentSet.contentSetId, contentSetHash: contentSet.contentSetHash },
    manifest: { hash: manifestHash, reference: publication.manifestReference || publication.contentManifestPath || "content-manifest.json" },
    deployment: publication.deployment || (publication.deploymentId ? { deploymentId: publication.deploymentId } : null),
    publicVerify: publication.publicVerify ? verificationReference(publication.publicVerify) : null,
    recovery: publication.recovery || publication.failure || null,
    publicationRunId: publication.publicationRunId || null,
    state: publication.state || "assembled",
    stateRevision: Number.isInteger(publication.stateRevision) ? publication.stateRevision : 0,
    createdAt: publication.createdAt || publication.assembledAt || new Date().toISOString(),
    updatedAt: publication.updatedAt || publication.assembledAt || new Date().toISOString(),
  };
}

/**
 * Remove assembly/runtime-only values before a SitePublication record is
 * persisted.  The assembled client remains at the temporary publication
 * directory and the full SiteSnapshot/PublicationRun remain addressable by
 * their immutable ids/sidecars; the durable record carries only references.
 */
export function sanitizeDurableSitePublicationRecord(publication = {}) {
  const durable = { ...publication };
  if (!durable.siteSnapshotId && durable.siteSnapshot?.siteSnapshotId) durable.siteSnapshotId = durable.siteSnapshot.siteSnapshotId;
  if (!durable.snapshotHash && durable.siteSnapshot?.snapshotHash) durable.snapshotHash = durable.siteSnapshot.snapshotHash;
  if (!durable.publicationRunId && durable.publicationRun?.publicationRunId) durable.publicationRunId = durable.publicationRun.publicationRunId;
  for (const forbidden of ["client", "sourceDirectory", "assembledClient", "uploadRoot", "siteSnapshot", "publicationRun"]) {
    delete durable[forbidden];
  }
  for (const field of ["publicVerify", "productVerify", "contentVerify"]) {
    if (durable[field] && typeof durable[field] === "object") durable[field] = verificationReference(durable[field]);
  }
  return durable;
}

function verificationReference(value = {}) {
  const reference = {};
  for (const key of ["sitePublicationId", "siteSnapshotId", "snapshotHash", "contentSetId", "contentSetHash", "productArtifactId", "productArtifactHash", "verifiedAt", "schemaVersion", "evidenceId", "evidencePath", "runtimeEvidencePath", "result", "verified", "ok"]) {
    if (value[key] != null && (typeof value[key] !== "object" || value[key] === null)) reference[key] = value[key];
  }
  const evidence = value.evidenceRef || value.verificationEvidenceRef || value.runtimeEvidenceRef;
  if (typeof evidence === "string") reference.evidenceRef = evidence;
  return reference;
}

export function assertCompactSitePublicationRecord(record = {}) {
  if (record.schemaVersion !== "site-publication-record-v2") throw new Error("SitePublication durable record schemaVersion is invalid");
  requiredString(record.sitePublicationId, "sitePublicationId", "SitePublication");
  requiredString(record.snapshotHash, "snapshotHash", "SitePublication");
  assertProductArtifactIdentityShape(record.productArtifact);
  requiredString(record.contentSet?.contentSetId, "contentSetId", "SitePublication");
  requiredString(record.contentSet?.contentSetHash, "contentSetHash", "SitePublication");
  requiredString(record.manifest?.hash, "manifest.hash", "SitePublication");
  for (const forbidden of ["client", "sourceDirectory", "assembledClient", "uploadRoot"]) {
    if (Object.hasOwn(record, forbidden)) throw new Error(`SitePublication durable record cannot persist ${forbidden}`);
  }
  for (const field of ["publicVerify", "productVerify", "contentVerify"]) {
    const value = record[field];
    if (!value || typeof value !== "object") continue;
    for (const forbidden of ["verificationEvidence", "browserRuntime", "runtimeEvidence", "assetManifest", "assets", "media", "routes"]) {
      if (Object.hasOwn(value, forbidden)) throw new Error(`SitePublication durable record cannot persist ${field}.${forbidden}`);
    }
  }
  return record;
}

/**
 * Hard readback guard for the durable SitePublication boundary.  The
 * verification/runtime payloads live in their own evidence sidecars; the
 * durable record may contain only identity/result references and manifests.
 */
export function assertDurableSitePublicationRecord(record = {}) {
  for (const forbidden of ["client", "sourceDirectory", "assembledClient", "uploadRoot", "siteSnapshot", "publicationRun"]) {
    if (Object.hasOwn(record, forbidden)) throw new Error(`SitePublication durable record cannot persist ${forbidden}`);
  }
  for (const field of ["publicVerify", "productVerify", "contentVerify"]) {
    const value = record[field];
    if (!value || typeof value !== "object") continue;
    for (const forbidden of ["verificationEvidence", "browserRuntime", "runtimeEvidence", "assets", "media", "routes"]) {
      if (Object.hasOwn(value, forbidden)) throw new Error(`SitePublication durable record cannot persist ${field}.${forbidden}`);
    }
  }
  return record;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function ownerFor(relativePath) {
  if (relativePath.startsWith(".content-workspace/content/")) return "content";
  if (relativePath.includes("/review") || relativePath.includes("/reviews/")) return "content-review";
  if (relativePath.includes("/recovery") || relativePath.includes("/recoveries/") || relativePath.includes("/incidents/")) return "content-recovery";
  if (relativePath.startsWith(".content-workspace/releases/")) return "content-release";
  if (relativePath.startsWith(".content-workspace/site-publications/")) return "site-publication";
  if (relativePath.startsWith(".content-workspace/base-site-artifacts/")) return "product-artifact";
  if (relativePath.includes("content-slot-registry") || relativePath.includes("lineage-binding")) return "content-lifecycle";
  if (relativePath.includes("lease")) return "lease";
  if (relativePath.startsWith(".content-workspace/qa/")) return "qa-evidence";
  if (relativePath.startsWith(".content-workspace/changes/")) return "content-change-set";
  if (relativePath.startsWith(".content-workspace/drafts/")) return "content-draft";
  return "unknown";
}

function objectKindFor(relativePath, value = null) {
  const name = path.basename(relativePath);
  if (name === "active.json" || relativePath.includes("content-state")) return "active-content-set";
  if (relativePath.includes("content-slot-registry")) return "content-slot-registry";
  if (relativePath.includes("lineage-binding")) return "publication-lineage-binding";
  if (relativePath.includes("site-publication")) return "site-publication";
  if (relativePath.includes("base-site-artifacts")) return "product-artifact-derived";
  if (relativePath.includes("content-release.json")) return "content-release-receipt";
  if (relativePath.includes("completion.json")) return "content-release-completion";
  if (relativePath.includes("package-lineage.json")) return "content-package-lineage";
  if (relativePath.includes("change")) return "content-change-set";
  if (relativePath.includes("incident")) return "incident";
  if (relativePath.includes("lease")) return "lease";
  if (relativePath.startsWith(".content-workspace/content/")) return "canonical-content-source";
  if (relativePath.startsWith(".content-workspace/qa/")) return "qa-derived-evidence";
  if (value?.recoveryId || value?.recovery) return "recovery";
  return "derived-artifact";
}

async function walkFiles(directory, result = []) {
  for (const entry of (await readdir(directory, { withFileTypes: true }).catch(() => [])).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      result.push({ file, symlink: true });
    } else if (entry.isDirectory()) {
      await walkFiles(file, result);
    } else if (entry.isFile()) {
      result.push({ file, symlink: false });
    }
  }
  return result;
}

function identityTokens(value, tokens = new Set()) {
  if (!value || typeof value !== "object") return tokens;
  if (Array.isArray(value)) {
    for (const item of value) identityTokens(item, tokens);
    return tokens;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    if (typeof child === "string" && child && (/(?:id|hash|revision|commit)/.test(normalizedKey) || /(?:deployment|recovery|changeset|contentrelease|logicalcontent|packagerevision|lineagebinding|sitesnapshot|publicationrun)/.test(normalizedKey))) tokens.add(child);
    identityTokens(child, tokens);
  }
  return tokens;
}

function valueIdentity(value = {}, objectKind = "") {
  const preferred = objectKind === "site-publication" ? ["sitePublicationId", "publicationRunId"]
    : objectKind === "content-release-receipt" || objectKind === "content-release-completion" ? ["contentReleaseId", "packageRevisionId"]
      : objectKind === "publication-lineage-binding" ? ["lineageBindingId"]
        : objectKind === "content-slot-registry" || objectKind === "active-content-set" ? ["contentSetId"]
          : objectKind === "product-artifact-derived" ? ["productArtifactId", "baseSiteArtifactId"]
            : objectKind === "content-change-set" ? ["changeSetId"]
              : ["contentSetId", "sitePublicationId", "publicationRunId", "siteSnapshotId", "contentReleaseId", "packageRevisionId", "revisionId", "lineageBindingId", "changeSetId", "recoveryId", "productArtifactId", "baseSiteArtifactId", "logicalContentId", "deploymentId"];
  const field = preferred.find((candidate) => typeof value?.[candidate] === "string" && value[candidate]);
  return field ? value[field] : null;
}

function extractedHash(value, bytes) {
  return typeof value?.hash === "string" && /^[a-f0-9]{64}$/.test(value.hash) ? value.hash : sha256(bytes);
}

function leaseInfo(value, relativePath) {
  if (!relativePath.includes("lease") && !value?.lease && !value?.leasePath) return null;
  return value?.lease || value || { path: relativePath };
}

function classifyRecord({ relativePath, owner, objectKind, value, references, lease, reconstructible }) {
  if (objectKind === "canonical-content-source" || objectKind === "active-content-set" || objectKind === "content-slot-registry" || objectKind === "publication-lineage-binding") {
    return { decision: "delete-never", reason: "canonical or active lifecycle fact" };
  }
  if (objectKind === "incident" || objectKind === "recovery" || objectKind === "content-release-receipt" || objectKind === "content-release-completion" || objectKind === "content-package-lineage" || objectKind === "site-publication") {
    return { decision: "delete-never", reason: "audit, released, failed, or recoverable lifecycle evidence" };
  }
  if (lease) return { decision: "keep", reason: "lease is present; do not infer it is stale" };
  if (references.length) return { decision: "keep", reason: "referenced by active or recoverable lifecycle object" };
  if (owner === "unknown" || objectKind === "unknown" || objectKind === "derived-artifact") return { decision: "keep", reason: "owner or object identity is not proven" };
  if (reconstructible) return { decision: "archive-dry-run", reason: "unleased, unreferenced, and reconstructible derived object" };
  return { decision: "review", reason: "reconstructibility is not proven" };
}

function reconstructibleFor(relativePath, objectKind) {
  return ["qa-derived-evidence", "product-artifact-derived", "site-publication"].includes(objectKind)
    || relativePath.includes("/tmp/")
    || relativePath.includes("/temporary/");
}

/** Re-runnable, read-only inventory of ignored lifecycle and derived objects. */
export async function inventoryContentWorkspace({ sourceRoot = process.cwd(), workspaceDirectory = path.join(sourceRoot, ".content-workspace"), now = new Date().toISOString() } = {}) {
  const files = await walkFiles(workspaceDirectory);
  const parsed = [];
  const tokenSet = new Set();
  for (const item of files) {
    const bytes = item.symlink ? Buffer.from(`symlink:${relative(sourceRoot, item.file)}`) : await readFile(item.file);
    let value = null;
    let tokens = [];
    if (!item.symlink && path.extname(item.file).toLowerCase() === ".json") {
      try {
        value = JSON.parse(bytes.toString("utf8"));
        tokens = [...identityTokens(value, new Set())];
        for (const token of tokens) tokenSet.add(token);
      } catch { /* binary/partial JSON remains reviewable */ }
    }
    parsed.push({ ...item, bytes, value, tokens });
  }
  const drafts = parsed.map(({ file, symlink, bytes, value, tokens }) => {
    const relativePath = relative(sourceRoot, file);
    const owner = ownerFor(relativePath);
    const objectKind = objectKindFor(relativePath, value);
    const references = [...tokenSet].filter((token) => token && token !== valueIdentity(value, objectKind) && bytes.includes(Buffer.from(token))).sort();
    const lease = leaseInfo(value, relativePath);
    const identity = valueIdentity(value, objectKind);
    const logicalId = value?.logicalContentId || value?.content?.logicalContentId || null;
    const artifactId = value?.productArtifactId || value?.baseSiteArtifactId || value?.artifactId || null;
    return {
      path: relativePath,
      owner,
      objectKind,
      identity,
      logicalContentId: logicalId,
      artifactId,
      hash: extractedHash(value, bytes),
      bytes: bytes.byteLength,
      references,
      incomingReferences: [],
      lease,
      _owner: owner,
      _objectKind: objectKind,
      _value: value,
      _reconstructible: reconstructibleFor(relativePath, objectKind),
      reconstructible: reconstructibleFor(relativePath, objectKind),
      symlink,
    };
  });
  const identityPaths = new Map(drafts.filter((record) => record.identity).map((record) => [record.identity, record.path]));
  for (const source of parsed) {
    for (const identity of source.tokens) {
      const targetPath = identityPaths.get(identity);
      if (!targetPath) continue;
      const target = drafts.find((record) => record.path === targetPath);
      if (target && target.path !== relative(sourceRoot, source.file)) target.incomingReferences.push(relative(sourceRoot, source.file));
    }
  }
  const records = drafts.map((record) => {
    const decision = classifyRecord({ relativePath: record.path, owner: record._owner, objectKind: record._objectKind, value: record._value, references: [...record.references, ...record.incomingReferences], lease: record.lease, reconstructible: record._reconstructible });
    const clean = { ...record };
    delete clean._owner; delete clean._objectKind; delete clean._value; delete clean._reconstructible;
    return {
      ...clean,
      retainUntil: decision.decision === "delete-never" ? "indefinite" : (record._value?.retainUntil || null),
      decision: decision.decision,
      reason: decision.reason,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const nodes = records.map((record) => ({ id: record.path, identity: record.identity, objectKind: record.objectKind }));
  const nodeByToken = new Map();
  for (const record of records) if (record.identity) nodeByToken.set(record.identity, record.path);
  const edges = [];
  for (const record of records) for (const token of record.references) {
    const to = nodeByToken.get(token);
    if (to && to !== record.path) edges.push({ from: record.path, to, reference: token });
  }
  const summary = Object.fromEntries(RETENTION_DECISIONS.map((decision) => [decision, records.filter((record) => record.decision === decision).length]));
  const identity = { schemaVersion: CONTENT_INVENTORY_SCHEMA_VERSION, root: relative(sourceRoot, workspaceDirectory), records, summary, referenceGraph: { nodes, edges } };
  return { ...identity, generatedAt: now, inventoryHash: hashValue(identity) };
}

export function createLifecycleDryRun({ inventory, sourceRoot = process.cwd(), now = new Date().toISOString() } = {}) {
  if (!inventory || inventory.schemaVersion !== CONTENT_INVENTORY_SCHEMA_VERSION || !Array.isArray(inventory.records)) throw new Error("content lifecycle dry-run requires a valid inventory");
  const protectedRecords = inventory.records.filter((record) => ["keep", "delete-never", "review"].includes(record.decision));
  const protectedStateHash = hashValue(protectedRecords.map(({ path: file, hash, bytes, decision, references }) => ({ path: file, hash, bytes, decision, references })));
  const plan = inventory.records.map((record) => ({
    path: record.path,
    objectKind: record.objectKind,
    identity: record.identity,
    decision: record.decision,
    action: record.decision === "archive-dry-run" ? "archive-dry-run" : "retain",
    reversible: record.decision === "archive-dry-run",
    recoverySource: record.reconstructible ? record.path : null,
    writes: [],
  }));
  return {
    schemaVersion: CONTENT_DRY_RUN_SCHEMA_VERSION,
    generatedAt: now,
    sourceRoot: path.resolve(sourceRoot),
    inventoryHash: inventory.inventoryHash,
    zeroWrite: true,
    beforeProtectedStateHash: protectedStateHash,
    afterProtectedStateHash: protectedStateHash,
    changedPaths: [],
    plan,
    summary: Object.fromEntries(RETENTION_DECISIONS.map((decision) => [decision, plan.filter((item) => item.decision === decision).length])),
  };
}

export function assertZeroWriteDryRun(dryRun = {}) {
  if (dryRun.schemaVersion !== CONTENT_DRY_RUN_SCHEMA_VERSION || dryRun.zeroWrite !== true || (dryRun.changedPaths || []).length !== 0 || (dryRun.plan || []).some((item) => (item.writes || []).length)) {
    throw new Error("content lifecycle dry-run is not zero-write");
  }
  if (dryRun.beforeProtectedStateHash !== dryRun.afterProtectedStateHash) throw new Error("content lifecycle dry-run changed protected state");
  return true;
}

export async function runContentLifecycleInventory(options = {}) {
  const inventory = await inventoryContentWorkspace(options);
  return { inventory, dryRun: createLifecycleDryRun({ inventory, ...options }) };
}
