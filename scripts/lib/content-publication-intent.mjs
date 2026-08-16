import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  assertActiveContentDataTuple,
  assertContentDataArtifact,
  changedContentDataObjects,
  contentDataPaths,
  createActiveContentDataTuple,
  createContentDataArtifact,
  hashContentDataBytes,
  hashContentDataValue,
  readActiveContentDataTuple,
  readCanonicalContentSource,
  writeContentDataArtifact,
} from "./content-data-plane.mjs";
import { contentManifestFromContentSet, readActiveContentSet, readContentSet, validateContentSet } from "./content-set.mjs";
import { assertProductArtifactIdentityShape } from "./product-artifact.mjs";
import { assertSiteSnapshotIdentity, createSiteSnapshot } from "./site-snapshot.mjs";
import { createPublicationRun } from "./publication-run.mjs";

export const CONTENT_PUBLICATION_INTENT_SCHEMA_VERSION = "content-publication-intent-v1";
export const CONTENT_PUBLICATION_INTENT_PREFIX = "content-publication-intent-";

const SHA256 = /^[a-f0-9]{64}$/;

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  return `{${Object.keys(value).sort((a, b) => Buffer.from(a).compare(Buffer.from(b))).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function hash(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : stable(value)).digest("hex");
}

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`ContentPublicationIntent ${field} is required`);
  return value;
}

function sha(value, field) {
  required(value, field);
  if (!SHA256.test(value)) throw new Error(`ContentPublicationIntent ${field} must be a SHA-256 hash`);
  return value;
}

function ref(value, fields, label) {
  if (!value || typeof value !== "object") throw new Error(`ContentPublicationIntent ${label} is required`);
  for (const field of fields) required(value[field], `${label}.${field}`);
  return value;
}

function assertApprovedContentSet(contentSet) {
  for (const entry of contentSet.entries || []) {
    if (entry.reviewProof?.status !== "approved") {
      const error = new Error(`ContentPublicationIntent review proof is not approved: ${entry.entryId}`);
      error.code = "CONTENT_PUBLICATION_REVIEW_REQUIRED";
      error.entryId = entry.entryId;
      throw error;
    }
  }
  return contentSet;
}

function intentDirectory(sourceRoot) {
  return path.join(path.resolve(sourceRoot), ".content-workspace", "content-state", "content-publication-intents");
}

function artifactFile(sourceRoot, artifactId) {
  return path.join(contentDataPaths(sourceRoot).artifactsDirectory, artifactId, "content-data-artifact.json");
}

async function readPersistedArtifact({ sourceRoot, contentDataArtifactId } = {}) {
  const artifact = JSON.parse(await readFile(artifactFile(sourceRoot, contentDataArtifactId), "utf8"));
  return assertContentDataArtifact(artifact);
}

export function contentPublicationIntentIdentity(intent = {}) {
  const product = intent.productArtifact ? assertProductArtifactIdentityShape(intent.productArtifact) : null;
  return {
    schemaVersion: CONTENT_PUBLICATION_INTENT_SCHEMA_VERSION,
    mode: intent.mode || "joint-first-publication",
    productArtifact: product,
    contentSet: intent.contentSet ? { contentSetId: intent.contentSet.contentSetId, contentSetHash: intent.contentSet.contentSetHash } : null,
    contentDataArtifact: intent.contentDataArtifact ? artifactRef(intent.contentDataArtifact) : null,
    activeTuple: intent.activeTuple,
    expectedPreviousTupleHash: intent.expectedPreviousTupleHash || null,
    siteSnapshot: intent.siteSnapshot ? snapshotRef(intent.siteSnapshot) : null,
    publicationRun: intent.publicationRun,
    changeSetId: intent.changeSetId || null,
    delta: intent.delta || null,
    authorization: intent.authorization || null,
  };
}

export function contentPublicationIntentHash(intent) {
  return hash(contentPublicationIntentIdentity(intent));
}

export function contentPublicationIntentId(intent) {
  return `${CONTENT_PUBLICATION_INTENT_PREFIX}${contentPublicationIntentHash(intent)}`;
}

function contentSetRef(contentSet) {
  return { contentSetId: contentSet.contentSetId, contentSetHash: contentSet.contentSetHash };
}

function artifactRef(artifact) {
  return { contentDataArtifactId: artifact.contentDataArtifactId, contentDataHash: artifact.contentDataHash };
}

function tupleRef(tuple) {
  return {
    schemaVersion: tuple.schemaVersion,
    contentSetId: tuple.contentSetId,
    contentSetHash: tuple.contentSetHash,
    contentDataArtifactId: tuple.contentDataArtifactId,
    contentDataHash: tuple.contentDataHash,
    productArtifactId: tuple.productArtifactId || null,
    productArtifactHash: tuple.productArtifactHash || null,
    manifestHash: tuple.manifestHash || null,
    manifestUrl: tuple.manifestUrl || `/content-data/${tuple.contentDataArtifactId}/content-data-manifest.json`,
    tupleHash: tuple.tupleHash,
  };
}

function snapshotRef(snapshot) {
  return {
    schemaVersion: snapshot.schemaVersion,
    siteSnapshotId: snapshot.siteSnapshotId,
    snapshotHash: snapshot.snapshotHash,
    contentDataArtifactId: snapshot.contentDataArtifact?.contentDataArtifactId || null,
    contentDataHash: snapshot.contentDataArtifact?.contentDataHash || null,
    activeTupleHash: snapshot.activeTupleHash || snapshot.activeTuple?.tupleHash || null,
  };
}

function runRef(run) {
  return {
    publicationRunId: run.publicationRunId,
    siteSnapshotId: run.siteSnapshotId,
    snapshotHash: run.snapshotHash,
    contentDataArtifactId: run.contentDataArtifactId || null,
    contentDataHash: run.contentDataHash || null,
    activeTupleHash: run.activeTupleHash || null,
  };
}

/**
 * Assert the one immutable input boundary consumed by content CLI, snapshot,
 * materializer, Coordinator and public verifier.  Callers may add operational
 * fields, but none of those fields participate in identity.
 */
export function assertContentPublicationIntent(intent = {}) {
  if (intent.schemaVersion !== CONTENT_PUBLICATION_INTENT_SCHEMA_VERSION) throw new Error("ContentPublicationIntent schemaVersion is invalid");
  assertProductArtifactIdentityShape(intent.productArtifact);
  ref(intent.contentSet, ["contentSetId", "contentSetHash"], "contentSet");
  sha(intent.contentSet.contentSetHash, "contentSet.contentSetHash");
  ref(intent.contentDataArtifact, ["contentDataArtifactId", "contentDataHash"], "contentDataArtifact");
  assertContentDataArtifact({
    schemaVersion: "content-data-artifact-v1",
    contentDataArtifactId: intent.contentDataArtifact.contentDataArtifactId,
    contentDataHash: intent.contentDataArtifact.contentDataHash,
    contentSetId: intent.contentSet.contentSetId,
    contentSetHash: intent.contentSet.contentSetHash,
    records: intent.contentDataArtifact.records || [],
    objectRefs: intent.contentDataArtifact.objectRefs || [],
    provenance: intent.contentDataArtifact.provenance,
  });
  assertActiveContentDataTuple(intent.activeTuple);
  if (intent.activeTuple.contentSetId !== intent.contentSet.contentSetId || intent.activeTuple.contentSetHash !== intent.contentSet.contentSetHash) throw new Error("ContentPublicationIntent ContentSet tuple drift");
  if (intent.activeTuple.contentDataArtifactId !== intent.contentDataArtifact.contentDataArtifactId || intent.activeTuple.contentDataHash !== intent.contentDataArtifact.contentDataHash) throw new Error("ContentPublicationIntent ContentDataArtifact tuple drift");
  if (intent.activeTuple.productArtifactId !== intent.productArtifact.productArtifactId || intent.activeTuple.productArtifactHash !== intent.productArtifact.productArtifactHash) throw new Error("ContentPublicationIntent ProductArtifact tuple drift");
  assertSiteSnapshotIdentity(intent.siteSnapshot);
  if (intent.siteSnapshot.contentDataArtifact?.contentDataArtifactId !== intent.contentDataArtifact.contentDataArtifactId || intent.siteSnapshot.contentDataArtifact?.contentDataHash !== intent.contentDataArtifact.contentDataHash) throw new Error("ContentPublicationIntent SiteSnapshot data identity drift");
  if ((intent.siteSnapshot.activeTupleHash || intent.siteSnapshot.activeTuple?.tupleHash) !== intent.activeTuple.tupleHash) throw new Error("ContentPublicationIntent SiteSnapshot tuple identity drift");
  if (intent.publicationRun?.publicationRunId !== intent.siteSnapshot.siteSnapshotId.replace(/^site-snapshot-/, "publication-run-site-snapshot-")) throw new Error("ContentPublicationIntent PublicationRun identity drift");
  const expectedHash = contentPublicationIntentHash(intent);
  if (intent.intentHash !== expectedHash || intent.intentId !== `${CONTENT_PUBLICATION_INTENT_PREFIX}${expectedHash}`) throw new Error("ContentPublicationIntent identity hash drift");
  if (intent.expectedPreviousTupleHash != null && !SHA256.test(intent.expectedPreviousTupleHash)) throw new Error("ContentPublicationIntent expectedPreviousTupleHash is invalid");
  return intent;
}

/** Read active tuple plus its immutable ContentSet/CDA; legacy is read-only fallback. */
export async function readContentPublicationAuthority({ sourceRoot = process.cwd(), allowLegacy = true } = {}) {
  let tuple;
  try {
    tuple = await readActiveContentDataTuple({ sourceRoot });
  } catch (error) {
    if (error.code !== "ENOENT" && error.code !== "CONTENT_DATA_ACTIVE_MISSING") throw error;
    if (!allowLegacy) {
      const missing = new Error("ContentData active tuple is required for canonical publication");
      missing.code = "CONTENT_DATA_ACTIVE_REQUIRED";
      throw missing;
    }
    const active = await readActiveContentSet({ sourceRoot });
    return { mode: "legacy", tuple: null, pointer: active.pointer, contentSet: active.contentSet, artifact: null };
  }
  if (!tuple.manifestUrl) {
    const error = new Error("ContentData active tuple manifestUrl is required after cutover");
    error.code = "CONTENT_DATA_ACTIVE_MANIFEST_REQUIRED";
    throw error;
  }
  const contentSet = await readContentSet({ sourceRoot, contentSetId: tuple.contentSetId });
  if (contentSet.contentSetHash !== tuple.contentSetHash) throw new Error("ContentData active tuple ContentSet hash drift");
  const artifact = await readPersistedArtifact({ sourceRoot, contentDataArtifactId: tuple.contentDataArtifactId });
  if (artifact.contentDataHash !== tuple.contentDataHash || artifact.contentSetId !== contentSet.contentSetId || artifact.contentSetHash !== contentSet.contentSetHash) throw new Error("ContentData active tuple artifact identity drift");
  return { mode: "tuple", tuple, pointer: tuple, contentSet, artifact };
}

function expectedLegacyContentHashes(entry, source, media = null) {
  const values = entry.kind === "practice" ? [{ value: source.value, media }] : [source.value];
  const candidates = [hashContentDataBytes(source.bytes)];
  for (const value of values) {
    candidates.push(hashContentDataValue(value));
    candidates.push(hashContentDataBytes(Buffer.from(JSON.stringify(value))));
  }
  return [...new Set(candidates)];
}

async function readPracticeMedia(sourceRoot, entry) {
  const file = path.join(sourceRoot, ".content-workspace", "content", "media", entry.target, "manifest.json");
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error.code === "ENOENT") throw new Error(`ContentData baseline media source is missing: ${entry.entryId}`);
    throw error;
  }
}

/**
 * Rebuild the first predecessor from the immutable active ContentSet.  The
 * home value intentionally comes from ContentSet.homeContent, never the
 * current canonical home.json, so the resolver can prove the one home delta.
 */
export async function resolveLegacyContentDataBaseline({ sourceRoot = process.cwd(), persist = false } = {}) {
  const active = await readContentPublicationAuthority({ sourceRoot, allowLegacy: true });
  if (active.mode === "tuple") return { ...active, baseline: false, persisted: true };
  const { contentSet } = active;
  validateContentSet(contentSet);
  assertApprovedContentSet(contentSet);
  if (contentSet.entries.length !== 38) throw new Error(`ContentData baseline entry count is not 38: ${contentSet.entries.length}`);
  const sourceOverrides = new Map();
  for (const entry of contentSet.entries) {
    let source;
    if (entry.entryId === "home:home") {
      if (!contentSet.homeContent) throw new Error("ContentData baseline homeContent is missing");
      sourceOverrides.set(entry.entryId, contentSet.homeContent);
      source = { value: contentSet.homeContent, bytes: Buffer.from(JSON.stringify(contentSet.homeContent)) };
    } else {
      source = await readCanonicalContentSource(path.resolve(sourceRoot), entry.sourcePath);
    }
    const media = entry.kind === "practice" ? await readPracticeMedia(path.resolve(sourceRoot), entry) : null;
    const expected = expectedLegacyContentHashes(entry, source, media);
    if (!expected.includes(entry.contentHash)) {
      const error = new Error(`ContentData baseline source/contentHash drift: ${entry.entryId}`);
      error.code = "CONTENT_DATA_BASELINE_HASH_DRIFT";
      error.entryId = entry.entryId;
      throw error;
    }
  }
  const artifact = await createContentDataArtifact({
    sourceRoot,
    contentSet,
    sourceOverrides,
    provenanceSource: "legacy-active-content-set-baseline",
  });
  if (artifact.records.length !== contentSet.entries.length || artifact.records.find((record) => record.logicalContentId === "home:home")?.valueHash !== hashContentDataValue(contentSet.homeContent)) {
    throw new Error("ContentData baseline artifact reconstruction is incomplete");
  }
  const written = persist ? await writeContentDataArtifact({ sourceRoot, artifact }) : null;
  return { mode: "legacy", baseline: true, persisted: Boolean(written), tuple: null, pointer: active.pointer, contentSet, artifact, written };
}

export async function createContentPublicationIntent({
  sourceRoot = process.cwd(),
  productArtifact,
  contentSet,
  contentDataArtifact,
  previousArtifact = null,
  activeTuple = null,
  expectedPreviousTupleHash = undefined,
  previousTuple = null,
  changeSetId = null,
  delta = null,
  mode = "joint-first-publication",
  authorization = null,
  manifest = null,
  createdAt = new Date().toISOString(),
} = {}) {
  const normalizedProductArtifact = assertProductArtifactIdentityShape(productArtifact);
  validateContentSet(contentSet);
  assertApprovedContentSet(contentSet);
  assertContentDataArtifact(contentDataArtifact);
  if (contentDataArtifact.contentSetId !== contentSet.contentSetId || contentDataArtifact.contentSetHash !== contentSet.contentSetHash) throw new Error("ContentPublicationIntent ContentSet identity mismatch");
  // The data manifest identity is the canonical ContentSet manifest, before
  // SitePublication adds operational fields such as siteSnapshotId.  Keeping
  // this input stable lets the tuple bind the immutable public manifest
  // without a circular snapshot/tuple dependency.
  const manifestIdentity = manifest || contentManifestFromContentSet(contentSet, { productArtifact: normalizedProductArtifact });
  const expectedManifestUrl = `/content-data/${contentDataArtifact.contentDataArtifactId}/content-data-manifest.json`;
  const tuple = activeTuple
    ? { ...activeTuple, manifestUrl: activeTuple.manifestUrl || expectedManifestUrl }
    : createActiveContentDataTuple({ contentSet, artifact: contentDataArtifact, productArtifact: normalizedProductArtifact, manifest: manifestIdentity });
  assertActiveContentDataTuple(tuple);
  if (tuple.manifestUrl !== expectedManifestUrl) throw new Error("ContentPublicationIntent active tuple manifest URL drift");
  if (tuple.productArtifactId !== normalizedProductArtifact.productArtifactId || tuple.productArtifactHash !== normalizedProductArtifact.productArtifactHash) throw new Error("ContentPublicationIntent ProductArtifact identity mismatch");
  let expected = expectedPreviousTupleHash;
  if (expected === undefined) expected = previousTuple?.tupleHash;
  if (expected === undefined) {
    try { expected = (await readActiveContentDataTuple({ sourceRoot })).tupleHash; } catch (error) {
      if (error.code !== "ENOENT") throw error;
      expected = null;
    }
  }
  const snapshot = createSiteSnapshot({
    productArtifact: normalizedProductArtifact,
    contentSet,
    contentDataArtifact: {
      contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
      contentDataHash: contentDataArtifact.contentDataHash,
      manifestHash: tuple.manifestHash,
    },
    activeTuple: tuple,
    requireContentData: true,
    createdAt,
  });
  const publicationRun = createPublicationRun({ siteSnapshot: snapshot, createdAt });
  const intent = {
    schemaVersion: CONTENT_PUBLICATION_INTENT_SCHEMA_VERSION,
    mode,
    productArtifact: normalizedProductArtifact,
    contentSet: contentSetRef(contentSet),
    contentDataArtifact: { ...artifactRef(contentDataArtifact), records: contentDataArtifact.records, objectRefs: contentDataArtifact.objectRefs, provenance: contentDataArtifact.provenance },
    activeTuple: tupleRef(tuple),
    expectedPreviousTupleHash: expected || null,
    siteSnapshot: snapshot,
    publicationRun: runRef({ ...publicationRun, activeTupleHash: tuple.tupleHash }),
    changeSetId: changeSetId || null,
    delta: delta || (previousArtifact ? changedContentDataObjects({ previousArtifact, nextArtifact: contentDataArtifact }) : null),
    authorization,
    createdAt,
  };
  intent.intentHash = contentPublicationIntentHash(intent);
  intent.intentId = `${CONTENT_PUBLICATION_INTENT_PREFIX}${intent.intentHash}`;
  assertContentPublicationIntent(intent);
  return { intent, contentSet, contentDataArtifact, activeTuple: tuple, siteSnapshot: snapshot, publicationRun };
}

export async function writeContentPublicationIntent({ sourceRoot = process.cwd(), intent } = {}) {
  assertContentPublicationIntent(intent);
  const file = path.join(intentDirectory(sourceRoot), `${intent.intentId}.json`);
  try {
    const existing = JSON.parse(await readFile(file, "utf8"));
    assertContentPublicationIntent(existing);
    if (existing.intentHash !== intent.intentHash) throw new Error("ContentPublicationIntent immutable identity collision");
    return { file, intent, reused: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(intent, null, 2)}\n`);
  await rename(temporary, file);
  return { file, intent, reused: false };
}

export async function readContentPublicationIntent({ sourceRoot = process.cwd(), intentId } = {}) {
  required(intentId, "intentId");
  const intent = JSON.parse(await readFile(path.join(intentDirectory(sourceRoot), `${intentId}.json`), "utf8"));
  return assertContentPublicationIntent(intent);
}

export async function prepareContentPublicationIntent(options = {}) {
  const { sourceRoot = process.cwd(), productArtifact, contentSet, previousArtifact = null, ...rest } = options;
  if (!productArtifact) throw new Error("ContentPublicationIntent requires ProductArtifact identity");
  const baseline = previousArtifact ? { artifact: previousArtifact } : await resolveLegacyContentDataBaseline({ sourceRoot, persist: true });
  const artifact = options.contentDataArtifact || await createContentDataArtifact({ sourceRoot, contentSet, previousArtifact: baseline.artifact, productArtifact });
  await writeContentDataArtifact({ sourceRoot, artifact });
  const prepared = await createContentPublicationIntent({ ...rest, sourceRoot, productArtifact, contentSet, contentDataArtifact: artifact, previousArtifact: baseline.artifact });
  const persisted = await writeContentPublicationIntent({ sourceRoot, intent: prepared.intent });
  return { ...prepared, baseline, persisted };
}

export async function assertIntentReferences({ sourceRoot = process.cwd(), intent } = {}) {
  assertContentPublicationIntent(intent);
  const contentSet = await readContentSet({ sourceRoot, contentSetId: intent.contentSet.contentSetId });
  if (contentSet.contentSetHash !== intent.contentSet.contentSetHash) throw new Error("ContentPublicationIntent persisted ContentSet drift");
  assertApprovedContentSet(contentSet);
  const artifact = await readPersistedArtifact({ sourceRoot, contentDataArtifactId: intent.contentDataArtifact.contentDataArtifactId });
  if (artifact.contentDataHash !== intent.contentDataArtifact.contentDataHash) throw new Error("ContentPublicationIntent persisted ContentDataArtifact drift");
  return { intent, contentSet, artifact };
}
