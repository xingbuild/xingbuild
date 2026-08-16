import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readActiveContentSet, validateContentSet } from "./content-set.mjs";
import { createContentChangeSet, assertContentChangeSet } from "./content-lifecycle-governance.mjs";

/**
 * ContentDataArtifact is the data-plane adapter for the existing ContentSet.
 * It deliberately does not replace ContentSet, SiteSnapshot v1, PublicationRun
 * or the Site Publication Coordinator.  It stores immutable content objects
 * by hash and keeps only references in the artifact/receipt records.
 */
export const CONTENT_DATA_ARTIFACT_SCHEMA_VERSION = "content-data-artifact-v1";
export const CONTENT_DATA_OBJECT_SCHEMA_VERSION = "content-data-object-v1";
export const CONTENT_DATA_ACTIVE_SCHEMA_VERSION = "content-data-active-v1";
export const CONTENT_ONLY_RECEIPT_SCHEMA_VERSION = "content-only-receipt-v1";
export const CONTENT_DATA_MANIFEST_SCHEMA_VERSION = "content-data-manifest-v1";

const SHA256 = /^[a-f0-9]{64}$/;

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
}

/** Stable value/byte hashing is part of the data-plane contract. */
export function hashContentDataValue(value) { return hash(value); }
export function hashContentDataBytes(value) { return hash(value); }
export function contentDataManifestHash(manifest) { return hash(manifest); }

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function sha(value, field) {
  required(value, field);
  if (!SHA256.test(value)) throw new Error(`${field} must be a SHA-256 hash`);
  return value;
}

function artifactDirectory(root) {
  return path.join(root, ".content-workspace", "content-state", "data-artifacts");
}

export function contentDataPaths(sourceRoot = process.cwd()) {
  const root = path.resolve(sourceRoot);
  const state = path.join(root, ".content-workspace", "content-state");
  return {
    stateDirectory: state,
    artifactsDirectory: path.join(state, "data-artifacts"),
    objectsDirectory: path.join(state, "data-objects"),
    activePath: path.join(state, "content-data-active.json"),
    receiptsDirectory: path.join(state, "content-data-receipts"),
  };
}

function sourceCandidates(root, sourcePath) {
  return [
    path.join(root, ".content-workspace", sourcePath),
    path.join(root, sourcePath),
  ];
}

export async function readCanonicalContentSource(root, sourcePath) {
  let last = null;
  for (const file of sourceCandidates(root, sourcePath)) {
    try {
      const bytes = await readFile(file);
      let value;
      try { value = JSON.parse(bytes.toString("utf8")); } catch { value = bytes.toString("utf8"); }
      return { file, bytes, value };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      last = error;
    }
  }
  const error = new Error(`canonical content source is missing: ${sourcePath}`);
  error.cause = last;
  error.code = "CONTENT_DATA_SOURCE_MISSING";
  throw error;
}

const sourceOverrideValue = (sourceOverrides, entry) => {
  if (!sourceOverrides) return undefined;
  if (sourceOverrides instanceof Map) return sourceOverrides.get(entry.entryId) ?? sourceOverrides.get(entry.sourcePath);
  if (Object.hasOwn(sourceOverrides, entry.entryId)) return sourceOverrides[entry.entryId];
  if (Object.hasOwn(sourceOverrides, entry.sourcePath)) return sourceOverrides[entry.sourcePath];
  return undefined;
};

async function readCanonicalValue(root, sourcePath, override = undefined) {
  if (override !== undefined) {
    const bytes = Buffer.from(JSON.stringify(override));
    return { file: null, bytes, value: override, overridden: true };
  }
  return readCanonicalContentSource(root, sourcePath);
}

function logicalIdFor(entry) {
  return required(entry.logicalContentId || `${entry.kind}:${entry.target}`, "logicalContentId");
}

function contentRecordIdentity({ logicalContentId, sourceHash, valueHash, predecessorRevisionId = null, entryId }) {
  return {
    schemaVersion: CONTENT_DATA_OBJECT_SCHEMA_VERSION,
    logicalContentId,
    entryId,
    sourceHash,
    valueHash,
    predecessorRevisionId: predecessorRevisionId || null,
  };
}

function revisionFor(identity) {
  const revisionHash = hash(identity);
  return { revisionId: `content-revision-${revisionHash.slice(0, 24)}`, revisionHash };
}

function objectFor({ entry, value, sourceHash, valueHash, predecessorRevisionId = null, history = [] }) {
  const logicalContentId = logicalIdFor(entry);
  const identity = contentRecordIdentity({ logicalContentId, entryId: entry.entryId, sourceHash, valueHash, predecessorRevisionId });
  const revision = revisionFor(identity);
  const current = {
    ...identity,
    ...revision,
    predecessor: predecessorRevisionId ? { revisionId: predecessorRevisionId } : null,
    contentHash: entry.contentHash,
    status: "current",
    sourcePath: entry.sourcePath,
    route: entry.route,
    kind: entry.kind,
    target: entry.target,
    value,
  };
  // `current` is represented by the top-level fields; history contains only
  // prior revisions so the current revision is never duplicated.
  const revisions = history.filter((item) => item?.revisionId !== current.revisionId).slice(0, 2);
  const objectHash = contentDataObjectHash(current);
  return { ...current, objectHash, revisions, history: revisions };
}

/** The immutable CAS object identity is recomputable from the object record. */
export function contentDataObjectHash(record = {}) {
  return hash({
    schemaVersion: CONTENT_DATA_OBJECT_SCHEMA_VERSION,
    logicalContentId: record.logicalContentId,
    entryId: record.entryId,
    revisionId: record.revisionId,
    sourceHash: record.sourceHash,
    valueHash: record.valueHash,
    value: record.value,
  });
}

function normalizedRecord(record) {
  return {
    logicalContentId: record.logicalContentId,
    entryId: record.entryId,
    revisionId: record.revisionId,
    revisionHash: record.revisionHash,
    predecessorRevisionId: record.predecessorRevisionId || null,
    predecessor: record.predecessor?.revisionId ? { revisionId: record.predecessor.revisionId } : null,
    sourceHash: record.sourceHash,
    valueHash: record.valueHash,
    contentHash: record.contentHash,
    objectHash: record.objectHash,
    sourcePath: record.sourcePath,
    route: record.route,
    kind: record.kind,
    target: record.target,
    status: record.status,
    history: (record.history || record.revisions || []).map((item) => ({
      revisionId: item.revisionId,
      revisionHash: item.revisionHash,
      sourceHash: item.sourceHash,
      valueHash: item.valueHash,
      predecessorRevisionId: item.predecessorRevisionId || null,
    })),
  };
}

export function contentDataArtifactIdentity(artifact) {
  return {
    schemaVersion: CONTENT_DATA_ARTIFACT_SCHEMA_VERSION,
    contentSetId: artifact.contentSetId,
    contentSetHash: artifact.contentSetHash,
    records: (artifact.records || []).map(normalizedRecord).sort((a, b) => a.logicalContentId.localeCompare(b.logicalContentId)),
    objectRefs: [...(artifact.objectRefs || [])].sort(),
    provenance: artifact.provenance,
  };
}

export function contentDataArtifactHash(artifact) {
  return hash(contentDataArtifactIdentity(artifact));
}

function artifactIdFromHash(value) { return `content-data-artifact-${value.slice(0, 24)}`; }

/** Build an immutable data artifact from a validated ContentSet and source bytes. */
export async function createContentDataArtifact({ sourceRoot = process.cwd(), contentSet, previousArtifact = null, productArtifact = null, sourceOverrides = null, provenanceSource = "canonical-content-set" } = {}) {
  validateContentSet(contentSet);
  if (previousArtifact) assertContentDataArtifact(previousArtifact);
  const root = path.resolve(sourceRoot);
  const previousByLogicalId = new Map((previousArtifact?.records || []).map((record) => [record.logicalContentId, record]));
  const records = [];
  for (const rawEntry of [...contentSet.entries].sort((a, b) => a.entryId.localeCompare(b.entryId))) {
    const entry = { ...rawEntry, logicalContentId: rawEntry.logicalContentId || `${rawEntry.kind}:${rawEntry.target}` };
    const source = await readCanonicalValue(root, entry.sourcePath, sourceOverrideValue(sourceOverrides, entry));
    const sourceHash = hash(source.bytes);
    const valueHash = hash(source.value);
    const previous = previousByLogicalId.get(entry.logicalContentId);
    const unchanged = previous && previous.sourceHash === sourceHash && previous.valueHash === valueHash && previous.contentHash === entry.contentHash;
    if (unchanged) {
      records.push(previous);
      continue;
    }
    const predecessorRevisionId = previous?.revisionId || null;
    const history = previous ? [previous, ...(previous.history || [])] : [];
    records.push(objectFor({ entry, value: source.value, sourceHash, valueHash, predecessorRevisionId, history }));
  }
  const objectRefs = [...new Set(records.map((record) => record.objectHash))].sort();
  const provenance = {
    source: provenanceSource,
    sourceRoot: ".content-workspace/content",
  };
  const identity = contentDataArtifactIdentity({ contentSetId: contentSet.contentSetId, contentSetHash: contentSet.contentSetHash, records, objectRefs, provenance });
  const contentDataHash = hash(identity);
  const artifact = {
    ...identity,
    // Keep the immutable value in the CAS record projection so the runtime
    // can materialize it, while the artifact identity above intentionally
    // hashes only references and hashes (not duplicated source bytes).
    records,
    contentDataArtifactId: artifactIdFromHash(contentDataHash),
    contentDataHash,
    objectCount: objectRefs.length,
    recordCount: records.length,
    createdAt: new Date().toISOString(),
  };
  assertContentDataArtifact(artifact);
  return artifact;
}

export function assertContentDataArtifact(artifact = {}) {
  if (artifact.schemaVersion !== CONTENT_DATA_ARTIFACT_SCHEMA_VERSION) throw new Error("ContentDataArtifact schemaVersion is invalid");
  required(artifact.contentDataArtifactId, "contentDataArtifactId");
  if (!/^content-data-artifact-[a-f0-9]{24}$/.test(artifact.contentDataArtifactId)) throw new Error("ContentDataArtifact id is invalid");
  sha(artifact.contentDataHash, "contentDataHash");
  required(artifact.contentSetId, "contentSetId");
  sha(artifact.contentSetHash, "contentSetHash");
  if (!Array.isArray(artifact.records) || !Array.isArray(artifact.objectRefs)) throw new Error("ContentDataArtifact records/objectRefs are required");
  const ids = new Set();
  for (const record of artifact.records) {
    const logical = required(record.logicalContentId, "record.logicalContentId");
    if (ids.has(logical)) throw new Error(`ContentDataArtifact duplicate logicalContentId: ${logical}`);
    ids.add(logical);
    for (const field of ["entryId", "revisionId", "sourcePath", "route", "kind", "target", "status", "objectHash"]) required(record[field], `record.${field}`);
    for (const field of ["sourceHash", "valueHash", "contentHash", "objectHash"]) sha(record[field], `record.${field}`);
    if (contentDataObjectHash(record) !== record.objectHash) throw new Error(`ContentDataArtifact objectHash drift: ${logical}`);
    if (record.status !== "current") throw new Error(`ContentDataArtifact record status is invalid: ${logical}`);
    const history = record.history || record.revisions;
    if (!Array.isArray(history) || history.length > 2) throw new Error(`ContentDataArtifact history is invalid: ${logical}`);
    const revisionIds = new Set();
    for (const revision of history) {
      required(revision.revisionId, "record.history.revisionId");
      sha(revision.sourceHash, "record.history.sourceHash");
      sha(revision.valueHash, "record.history.valueHash");
      if (revisionIds.has(revision.revisionId)) throw new Error(`ContentDataArtifact duplicate revision: ${revision.revisionId}`);
      revisionIds.add(revision.revisionId);
    }
    if (record.predecessorRevisionId != null) {
      if (!history.some((revision) => revision.revisionId === record.predecessorRevisionId)) {
        throw new Error(`ContentDataArtifact predecessor is not retained: ${logical}`);
      }
      if (record.predecessor?.revisionId !== record.predecessorRevisionId) {
        throw new Error(`ContentDataArtifact predecessor reference drift: ${logical}`);
      }
    } else if (record.predecessor != null) {
      throw new Error(`ContentDataArtifact predecessor must be null for an initial revision: ${logical}`);
    }
  }
  if (new Set(artifact.objectRefs).size !== artifact.objectRefs.length || artifact.objectRefs.some((ref) => !SHA256.test(ref))) throw new Error("ContentDataArtifact objectRefs are invalid");
  const expected = contentDataArtifactHash(artifact);
  if (expected !== artifact.contentDataHash || artifact.contentDataArtifactId !== artifactIdFromHash(expected)) throw new Error("ContentDataArtifact identity hash drift");
  return artifact;
}

async function atomicWrite(file, value, { failAfter = null, marker = "write" } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    if (failAfter === marker) throw new Error(`injected ${marker} failure`);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeContentDataArtifact({ sourceRoot = process.cwd(), artifact, failAfter = null } = {}) {
  assertContentDataArtifact(artifact);
  const paths = contentDataPaths(sourceRoot);
  const directory = path.join(paths.artifactsDirectory, artifact.contentDataArtifactId);
  const artifactFile = path.join(directory, "content-data-artifact.json");
  try {
    const existing = JSON.parse(await readFile(artifactFile, "utf8"));
    assertContentDataArtifact(existing);
    if (existing.contentDataHash !== artifact.contentDataHash) throw new Error("ContentDataArtifact immutable identity collision");
    return { artifact, artifactFile, reused: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(paths.stateDirectory, { recursive: true });
  const stage = await mkdtemp(path.join(paths.stateDirectory, ".content-data-stage-"));
  const stagedArtifact = path.join(stage, "content-data-artifact.json");
  const stagedObjects = path.join(stage, "objects");
  try {
    await atomicWrite(stagedArtifact, artifact, { failAfter, marker: "artifact" });
    for (const record of artifact.records) {
      const objectFile = path.join(paths.objectsDirectory, `${record.objectHash}.json`);
      try {
        await stat(objectFile);
        continue;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      const stagedObject = path.join(stagedObjects, `${record.objectHash}.json`);
      await atomicWrite(stagedObject, { schemaVersion: CONTENT_DATA_OBJECT_SCHEMA_VERSION, objectHash: record.objectHash, record }, { failAfter, marker: "object" });
    }
    await mkdir(paths.objectsDirectory, { recursive: true });
    for (const record of artifact.records) {
      const objectFile = path.join(paths.objectsDirectory, `${record.objectHash}.json`);
      const stagedObject = path.join(stagedObjects, `${record.objectHash}.json`);
      try {
        await stat(objectFile);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await rename(stagedObject, objectFile);
      }
    }
    await mkdir(directory, { recursive: true });
    await rename(stagedArtifact, artifactFile);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
  }
  return { artifact, artifactFile, reused: false };
}

export function activeContentDataTupleIdentity(tuple) {
  return {
    schemaVersion: CONTENT_DATA_ACTIVE_SCHEMA_VERSION,
    contentSetId: tuple.contentSetId,
    contentSetHash: tuple.contentSetHash,
    contentDataArtifactId: tuple.contentDataArtifactId,
    contentDataHash: tuple.contentDataHash,
    productArtifactId: tuple.productArtifactId || null,
    productArtifactHash: tuple.productArtifactHash || null,
    manifestHash: tuple.manifestHash || null,
  };
}

export function activeContentDataTupleHash(tuple) { return hash(activeContentDataTupleIdentity(tuple)); }

export function createActiveContentDataTuple({ contentSet, artifact, productArtifact = null, manifest = null } = {}) {
  validateContentSet(contentSet);
  assertContentDataArtifact(artifact);
  if (artifact.contentSetId !== contentSet.contentSetId || artifact.contentSetHash !== contentSet.contentSetHash) throw new Error("ContentDataArtifact ContentSet identity mismatch");
  const tuple = {
    ...activeContentDataTupleIdentity({
      contentSetId: contentSet.contentSetId,
      contentSetHash: contentSet.contentSetHash,
      contentDataArtifactId: artifact.contentDataArtifactId,
      contentDataHash: artifact.contentDataHash,
      productArtifactId: productArtifact?.productArtifactId || null,
      productArtifactHash: productArtifact?.productArtifactHash || null,
      manifestHash: manifest ? hash(manifest) : null,
    }),
    manifestUrl: `/content-data/${artifact.contentDataArtifactId}/content-data-manifest.json`,
  };
  return { ...tuple, tupleHash: activeContentDataTupleHash(tuple), updatedAt: new Date().toISOString() };
}

export function assertActiveContentDataTuple(tuple = {}) {
  if (tuple.schemaVersion !== CONTENT_DATA_ACTIVE_SCHEMA_VERSION) throw new Error("ContentData active tuple schemaVersion is invalid");
  for (const field of ["contentSetId", "contentDataArtifactId"]) required(tuple[field], field);
  for (const field of ["contentSetHash", "contentDataHash"]) sha(tuple[field], field);
  if (tuple.productArtifactHash != null) sha(tuple.productArtifactHash, "productArtifactHash");
  if (tuple.manifestHash != null) sha(tuple.manifestHash, "manifestHash");
  sha(tuple.tupleHash, "tupleHash");
  if (activeContentDataTupleHash(tuple) !== tuple.tupleHash) throw new Error("ContentData active tuple hash drift");
  if (tuple.manifestUrl != null) required(tuple.manifestUrl, "manifestUrl");
  return tuple;
}

export async function readActiveContentDataTuple({ sourceRoot = process.cwd() } = {}) {
  const file = contentDataPaths(sourceRoot).activePath;
  const tuple = JSON.parse(await readFile(file, "utf8"));
  return assertActiveContentDataTuple(tuple);
}

export async function activateContentDataTuple({ sourceRoot = process.cwd(), tuple, expectedTupleHash = undefined, failAfter = null } = {}) {
  assertActiveContentDataTuple(tuple);
  const file = contentDataPaths(sourceRoot).activePath;
  let previous = null;
  try { previous = await readActiveContentDataTuple({ sourceRoot }); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (expectedTupleHash !== undefined && (previous?.tupleHash || null) !== (expectedTupleHash || null)) {
    const error = new Error("ContentData active tuple CAS conflict");
    error.code = "CONTENT_DATA_ACTIVE_CAS";
    throw error;
  }
  if (previous?.tupleHash === tuple.tupleHash) return { tuple: previous, previous, reused: true, file };
  await atomicWrite(file, tuple, { failAfter, marker: "active" });
  return { tuple, previous, reused: false, file };
}

export async function readContentDataRuntime({ sourceRoot = process.cwd(), logicalContentId, entryId } = {}) {
  const tuple = await readActiveContentDataTuple({ sourceRoot });
  const artifactFile = path.join(contentDataPaths(sourceRoot).artifactsDirectory, tuple.contentDataArtifactId, "content-data-artifact.json");
  const artifact = assertContentDataArtifact(JSON.parse(await readFile(artifactFile, "utf8")));
  if (artifact.contentDataHash !== tuple.contentDataHash) throw new Error("runtime ContentDataArtifact hash mismatch");
  const record = artifact.records.find((item) => (logicalContentId && item.logicalContentId === logicalContentId) || (entryId && item.entryId === entryId));
  if (!record) return null;
  const objectFile = path.join(contentDataPaths(sourceRoot).objectsDirectory, `${record.objectHash}.json`);
  const object = JSON.parse(await readFile(objectFile, "utf8"));
  if (object.objectHash !== record.objectHash || !object.record || contentDataObjectHash(object.record) !== record.objectHash) throw new Error("runtime ContentData object hash mismatch");
  return { tuple, artifact, record, value: object.record.value };
}

export async function createContentDataPreparation({ sourceRoot = process.cwd(), contentSet = null, previousArtifact = null, productArtifact = null } = {}) {
  const resolved = contentSet || (await readActiveContentSet({ sourceRoot })).contentSet;
  const artifact = await createContentDataArtifact({ sourceRoot, contentSet: resolved, previousArtifact, productArtifact });
  const written = await writeContentDataArtifact({ sourceRoot, artifact });
  return { contentSet: resolved, artifact, written };
}

/**
 * Real ContentSet -> ChangeSet -> ContentDataArtifact preparation boundary.
 * The existing ContentSet candidate writer remains responsible for review and
 * activation; this adapter adds deterministic data-plane references without
 * creating a second candidate or publisher.
 */
export async function prepareContentDataArtifactForContentSet({ sourceRoot = process.cwd(), beforeContentSet = null, contentSet, previousArtifact = null, productArtifact = null, changeSetId = null } = {}) {
  validateContentSet(contentSet);
  if (beforeContentSet) validateContentSet(beforeContentSet);
  const artifact = await createContentDataArtifact({ sourceRoot, contentSet, previousArtifact, productArtifact });
  const sourceHashes = {};
  if (beforeContentSet) {
    for (const entry of contentSet.entries) {
      const source = await readCanonicalValue(path.resolve(sourceRoot), entry.sourcePath);
      sourceHashes[entry.entryId] = hash(source.bytes);
    }
  }
  const changeSet = beforeContentSet
    ? createContentChangeSet({
      beforeEntries: beforeContentSet.entries,
      afterEntries: contentSet.entries,
      productArtifactId: productArtifact?.productArtifactId || null,
      sourceHashes,
    })
    : null;
  if (changeSet) assertContentChangeSet(changeSet);
  const delta = previousArtifact ? changedContentDataObjects({ previousArtifact, nextArtifact: artifact }) : null;
  return { artifact, changeSet, delta, changeSetId: changeSetId || changeSet?.changeSetId || null };
}

export const prepareContentDataArtifact = prepareContentDataArtifactForContentSet;

export function changedContentDataObjects({ previousArtifact, nextArtifact } = {}) {
  assertContentDataArtifact(previousArtifact);
  assertContentDataArtifact(nextArtifact);
  const before = new Map(previousArtifact.records.map((record) => [record.logicalContentId, record]));
  const changed = [];
  const reused = [];
  for (const record of nextArtifact.records) {
    const previous = before.get(record.logicalContentId);
    if (previous && previous.objectHash === record.objectHash && previous.valueHash === record.valueHash) reused.push({ logicalContentId: record.logicalContentId, objectHash: record.objectHash });
    else changed.push({ logicalContentId: record.logicalContentId, objectHash: record.objectHash, revisionId: record.revisionId, route: record.route });
  }
  return { changed, reused, productArtifactBuildCount: 0, productArtifactReused: true };
}

export function createContentOnlyReceipt({ productArtifact, contentSet, artifact, activeTuple, siteSnapshotId = null, sitePublicationId = null, publicationRunId = null, deploymentId = null, manifestHash = null, publicVerify = null, failure = null, recovery = null } = {}) {
  assertContentDataArtifact(artifact);
  assertActiveContentDataTuple(activeTuple);
  const identity = {
    schemaVersion: CONTENT_ONLY_RECEIPT_SCHEMA_VERSION,
    productArtifactId: productArtifact?.productArtifactId || null,
    productArtifactHash: productArtifact?.productArtifactHash || null,
    contentSetId: contentSet.contentSetId,
    contentSetHash: contentSet.contentSetHash,
    contentDataArtifactId: artifact.contentDataArtifactId,
    contentDataHash: artifact.contentDataHash,
    activePointerHash: activeTuple.tupleHash,
    siteSnapshotId,
    sitePublicationId,
    publicationRunId,
    deploymentId,
    manifestHash,
  };
  const receiptHash = hash(identity);
  return {
    ...identity,
    receiptHash,
    publicVerify: publicVerify || null,
    ...(failure ? { failure } : {}),
    ...(recovery ? { recovery } : {}),
    createdAt: new Date().toISOString(),
  };
}

export function assertContentOnlyReceipt(receipt = {}) {
  if (receipt.schemaVersion !== CONTENT_ONLY_RECEIPT_SCHEMA_VERSION) throw new Error("content-only receipt schemaVersion is invalid");
  for (const field of ["contentSetId", "contentDataArtifactId", "activePointerHash", "receiptHash"]) required(receipt[field], field);
  for (const field of ["contentSetHash", "contentDataHash", "activePointerHash", "receiptHash"]) sha(receipt[field], field);
  const identity = { ...receipt };
  delete identity.receiptHash; delete identity.publicVerify; delete identity.failure; delete identity.recovery; delete identity.createdAt;
  if (hash(identity) !== receipt.receiptHash) throw new Error("content-only receipt identity hash drift");
  if (receipt.failure || receipt.recovery) {
    const decision = receipt.failure?.decision || receipt.recovery?.decision;
    if (["cleanup", "delete", "archive", "migrate"].includes(decision)) throw new Error("failed/recoverable receipt cannot authorize cleanup");
  }
  return receipt;
}

export async function writeContentOnlyReceipt({ sourceRoot = process.cwd(), receipt } = {}) {
  assertContentOnlyReceipt(receipt);
  const file = path.join(contentDataPaths(sourceRoot).receiptsDirectory, `${receipt.receiptHash}.json`);
  await atomicWrite(file, receipt);
  return { file, receipt };
}

async function copyTree(source, destination) {
  await cp(source, destination, { recursive: true, errorOnExist: false, force: true });
}

async function clientFiles(root, current = "") {
  const entries = [];
  for (const entry of await readdir(path.join(root, current), { withFileTypes: true })) {
    const relative = path.posix.join(current, entry.name);
    if (entry.isDirectory()) entries.push(...await clientFiles(root, relative));
    else if (entry.isFile() && relative !== "release.json") entries.push({ path: relative, sha256: hash(await readFile(path.join(root, current, entry.name))) });
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

function productClientFiles(productArtifact) {
  return productArtifact?.documents?.release?.clientFiles
    || productArtifact?.clientFiles
    || null;
}

async function assertExactProductClient({ productClient, root, productArtifact } = {}) {
  const expected = productClientFiles(productArtifact);
  if (!expected) return;
  const actual = await clientFiles(root);
  const normalizedExpected = expected.map((entry) => ({ path: entry.path, sha256: entry.sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  if (JSON.stringify(actual) !== JSON.stringify(normalizedExpected)) {
    const error = new Error("ContentData materialization ProductArtifact client bytes drift");
    error.code = "CONTENT_DATA_PRODUCT_CLIENT_DRIFT";
    error.expected = normalizedExpected;
    error.actual = actual;
    throw error;
  }
  return { fileCount: actual.length, files: actual };
}

async function materializationFile(root, relativePath) {
  const file = path.join(root, relativePath);
  const bytes = await readFile(file);
  return { path: relativePath, bytes: bytes.byteLength, hash: hash(bytes) };
}

async function copyContentMedia({ sourceRoot, destinationRoot, contentSet, manifest }) {
  const mediaPaths = [...new Set([
    ...(manifest?.mediaPaths || []),
    ...(contentSet?.entries || []).flatMap((entry) => entry.mediaProof || []),
  ])].sort();
  const files = [];
  for (const mediaPath of mediaPaths) {
    if (typeof mediaPath !== "string" || !mediaPath.startsWith("/") || mediaPath.includes("..")) {
      throw new Error(`content media path is unsafe: ${mediaPath}`);
    }
    const relative = mediaPath.slice(1);
    const source = path.join(sourceRoot, ".content-workspace", "content", relative);
    const destination = path.join(destinationRoot, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    try {
      await copyTree(source, destination);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`content media is missing from canonical source: ${mediaPath}`);
      throw error;
    }
    files.push(await materializationFile(destinationRoot, relative));
  }
  return files;
}

/** Validate the immutable prepared data files before activation. */
export async function validateContentDataMaterialization({ root, artifact, activeTuple, manifest } = {}) {
  assertContentDataArtifact(artifact);
  assertActiveContentDataTuple(activeTuple);
  const activeFile = path.join(root, "content-data", "active.json");
  const manifestFile = path.join(root, "content-data", artifact.contentDataArtifactId, "content-data-manifest.json");
  const active = JSON.parse(await readFile(activeFile, "utf8"));
  const dataManifest = JSON.parse(await readFile(manifestFile, "utf8"));
  assertActiveContentDataTuple(active);
  if (active.tupleHash !== activeTuple.tupleHash || active.contentDataArtifactId !== artifact.contentDataArtifactId) throw new Error("prepared active tuple identity drift");
  if (dataManifest.contentDataHash !== artifact.contentDataHash || dataManifest.manifestHash !== hash(manifest || artifact.records.map(normalizedRecord))) throw new Error("prepared content manifest identity drift");
  const artifactFile = path.join(root, "content-data", artifact.contentDataArtifactId, "content-data-artifact.json");
  const artifactReadback = assertContentDataArtifact(JSON.parse(await readFile(artifactFile, "utf8")));
  const files = [await materializationFile(root, path.relative(root, activeFile)), await materializationFile(root, path.relative(root, manifestFile)), await materializationFile(root, path.relative(root, artifactFile))];
  for (const record of artifactReadback.records) {
    const relative = path.join("content-data", artifact.contentDataArtifactId, "objects", `${record.objectHash}.json`);
    const object = JSON.parse(await readFile(path.join(root, relative), "utf8"));
    if (object.objectHash !== record.objectHash) throw new Error(`prepared object identity drift: ${record.logicalContentId}`);
    files.push(await materializationFile(root, relative));
  }
  return {
    phase: "validated",
    result: "verified",
    activeTupleHash: active.tupleHash,
    contentDataArtifactId: artifactReadback.contentDataArtifactId,
    contentDataHash: artifactReadback.contentDataHash,
    manifestUrl: dataManifest.immutableDataUrl,
    cacheControl: dataManifest.cacheControl,
    files,
  };
}

/** Activate a validated temporary materialization. This only writes a temporary receipt. */
export async function activateContentDataMaterialization({ root, validation, failPhase = null } = {}) {
  if (!validation || validation.phase !== "validated" || validation.result !== "verified") throw new Error("content data materialization must be validated before activation");
  if (failPhase === "activate") throw new Error("injected content data activation failure");
  const activation = {
    schemaVersion: "content-data-activation-v1",
    activeTupleHash: validation.activeTupleHash,
    contentDataArtifactId: validation.contentDataArtifactId,
    contentDataHash: validation.contentDataHash,
    manifestUrl: validation.manifestUrl,
    result: "verified",
  };
  const file = path.join(root, "content-data", "activation.json");
  await atomicWrite(file, activation);
  return { phase: "activated", result: "verified", activation, file, fileEvidence: await materializationFile(root, path.relative(root, file)) };
}

/** Materialization is explicitly temporary and never becomes a durable publication identity. */
export async function prepareContentOnlyMaterialization({ productClient, sourceRoot = process.cwd(), artifact, activeTuple, contentSet, productArtifact = null, manifest = null, failPhase = null } = {}) {
  assertContentDataArtifact(artifact);
  assertActiveContentDataTuple(activeTuple);
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-content-data-upload-"));
  let cleaned = false;
  try {
    if (productClient) {
      await copyTree(productClient, root);
      await assertExactProductClient({ productClient, root, productArtifact });
    }
    // Media is content-owned and is added only to the temporary upload root;
    // it is not part of the immutable ProductArtifact client identity.
    const mediaFiles = await copyContentMedia({ sourceRoot, destinationRoot: root, contentSet, manifest });
    const dataRoot = path.join(root, "content-data", artifact.contentDataArtifactId);
    const objectRoot = path.join(dataRoot, "objects");
    await mkdir(objectRoot, { recursive: true });
    const sourcePaths = contentDataPaths(sourceRoot);
    const artifactFile = path.join(sourcePaths.artifactsDirectory, artifact.contentDataArtifactId, "content-data-artifact.json");
    try {
      await copyTree(artifactFile, path.join(dataRoot, "content-data-artifact.json"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeFile(path.join(dataRoot, "content-data-artifact.json"), `${JSON.stringify(artifact, null, 2)}\n`);
    }
    for (const record of artifact.records) {
      const objectFile = path.join(sourcePaths.objectsDirectory, `${record.objectHash}.json`);
      try {
        await copyTree(objectFile, path.join(objectRoot, `${record.objectHash}.json`));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        await writeFile(path.join(objectRoot, `${record.objectHash}.json`), `${JSON.stringify({ schemaVersion: CONTENT_DATA_OBJECT_SCHEMA_VERSION, objectHash: record.objectHash, record }, null, 2)}\n`);
      }
    }
    const manifestIdentity = manifest || artifact.records.map(normalizedRecord);
    const manifestHash = contentDataManifestHash(manifestIdentity);
    if (activeTuple.manifestHash != null && activeTuple.manifestHash !== manifestHash) throw new Error("ContentData active tuple manifest hash drift");
    const dataManifest = {
      schemaVersion: CONTENT_DATA_MANIFEST_SCHEMA_VERSION,
      contentDataArtifactId: artifact.contentDataArtifactId,
      contentDataHash: artifact.contentDataHash,
      activePointerHash: activeTuple.tupleHash,
      records: artifact.records.map((record) => ({ logicalContentId: record.logicalContentId, entryId: record.entryId, objectHash: record.objectHash, route: record.route })),
      manifestHash,
      immutableDataUrl: `/content-data/${artifact.contentDataArtifactId}/content-data-manifest.json`,
      cacheControl: "public,max-age=31536000,immutable",
    };
    await writeFile(path.join(dataRoot, "content-data-manifest.json"), `${JSON.stringify(dataManifest, null, 2)}\n`);
    const activePointer = {
      ...activeTuple,
      manifestUrl: dataManifest.immutableDataUrl,
      schemaVersion: CONTENT_DATA_ACTIVE_SCHEMA_VERSION,
    };
    await writeFile(path.join(root, "content-data", "active.json"), `${JSON.stringify(activePointer, null, 2)}\n`);
    if (failPhase === "prepare") throw new Error("injected content data prepare failure");
    const receipt = createContentOnlyReceipt({ productArtifact, contentSet, artifact, activeTuple, manifestHash: dataManifest.manifestHash });
    const prepared = { phase: "prepared", result: "verified", manifestUrl: dataManifest.immutableDataUrl, cacheControl: dataManifest.cacheControl, activeTupleHash: activeTuple.tupleHash, contentDataArtifactId: artifact.contentDataArtifactId, contentDataHash: artifact.contentDataHash };
    const validate = async () => validateContentDataMaterialization({ root, artifact, activeTuple: activePointer, manifest });
    const activate = async ({ failPhase: activationFailure = null } = {}) => activateContentDataMaterialization({ root, validation: await validate(), failPhase: activationFailure });
    return {
      root,
      dataManifest,
      receipt,
      activePointer,
      mediaFiles,
      state: prepared,
      validate,
      activate,
      async cleanup() { if (!cleaned) { cleaned = true; await rm(root, { recursive: true, force: true }); } },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export async function prepareContentOnlyPublication(options = {}) {
  const prepared = await createContentDataPreparation(options);
  const tuple = options.activeTuple || createActiveContentDataTuple({ contentSet: prepared.contentSet, artifact: prepared.artifact, productArtifact: options.productArtifact, manifest: options.manifest });
  if (!options.activeTuple) await activateContentDataTuple({ sourceRoot: options.sourceRoot, tuple });
  const materialization = await prepareContentOnlyMaterialization({ ...options, ...prepared, activeTuple: tuple });
  return { ...prepared, tuple, materialization, receipt: materialization.receipt };
}

export const createContentDataPlane = createContentDataArtifact;
export const validateContentDataArtifact = assertContentDataArtifact;
export const readRuntimeContentData = readContentDataRuntime;
export const createAtomicActiveTuple = createActiveContentDataTuple;
export const activateAtomicActiveTuple = activateContentDataTuple;
export const createMinimalContentOnlyReceipt = createContentOnlyReceipt;
