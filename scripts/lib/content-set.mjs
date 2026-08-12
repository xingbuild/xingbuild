import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { assertProductArtifactIdentityShape } from "./product-artifact.mjs";
import { normalizeResponsiveTextSlot } from "./responsive-text-slot.mjs";
import { validateRegisteredResponsiveTextValues } from "./content-targets.mjs";

/**
 * ContentSet is the runtime authority for public content.  Receipts, slot
 * registries and package projections are deliberately accepted only as
 * migration/audit input and are never consulted by the normal reader.
 */
export const CONTENT_SET_SCHEMA_VERSION = "content-set-v1";
export const ACTIVE_CONTENT_SET_SCHEMA_VERSION = "content-set-active-v1";
export const CONTENT_SET_KINDS = Object.freeze([
  "home",
  "profile",
  "product",
  "article",
  "businessObservation",
  "practice",
  "observation",
]);

const legacyKindMap = Object.freeze({ content: "observation" });
const kindCollections = Object.freeze({
  observation: "publishedSlugs",
  article: "publishedArticleSlugs",
  practice: "practiceIds",
  profile: "profileIds",
  product: "productIds",
  businessObservation: "businessObservationIds",
});

function canonical(value) {
  return JSON.stringify(value);
}

export function hashContentSetValue(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`ContentSet ${field} is required`);
  }
  return value;
}

function array(value = []) {
  if (!Array.isArray(value)) throw new Error("ContentSet proof fields must be arrays");
  return [...new Set(value.filter((item) => typeof item === "string" && item.trim() !== ""))].sort();
}

function mapKind(kind) {
  return legacyKindMap[kind] || kind;
}

function sourcePathFor(kind, target) {
  if (kind === "home") return "content/home.json";
  if (kind === "observation") return `content/observations/${target}.json`;
  if (kind === "article") return `content/articles/${target}.json`;
  if (kind === "profile") return `content/profile/${target}.json`;
  if (kind === "businessObservation") return `content/business-observations/${target}.json`;
  return `content/products/${target}.json`;
}

function routeFor(kind, target, route = null) {
  if (route) return route;
  if (kind === "home") return "/";
  if (kind === "observation") return `/observations/${target}`;
  if (kind === "article") return "/business-observations";
  if (kind === "profile") return "/about";
  if (kind === "businessObservation") return "/";
  return "/products";
}

function normalizeReviewProof(value, fallback = {}) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("ContentSet reviewProof must be an object");
  const result = {};
  for (const key of ["reviewId", "reviewedAt", "status", "authority"]) {
    if (value[key] != null) result[key] = value[key];
  }
  return Object.keys(result).length ? result : fallback;
}

export function normalizeContentSetEntry(entry = {}) {
  const kind = mapKind(text(entry.kind, "entry.kind"));
  if (!CONTENT_SET_KINDS.includes(kind)) throw new Error(`ContentSet entry kind is unsupported: ${kind}`);
  const target = text(entry.target, "entry.target");
  const entryId = text(entry.entryId || `${kind}:${target}`, "entry.entryId");
  const contentHash = text(entry.contentHash, "entry.contentHash");
  const route = routeFor(kind, target, entry.route || entry.targetPath);
  if (!route.startsWith("/")) throw new Error(`ContentSet entry route is invalid: ${entryId}`);
  const normalized = {
    entryId,
    kind,
    target,
    sourcePath: text(entry.sourcePath || sourcePathFor(kind, target), "entry.sourcePath"),
    route,
    contentHash,
    sourceProof: array(entry.sourceProof || entry.sourceRefs || entry.sources || []),
    reviewProof: normalizeReviewProof(entry.reviewProof || entry.review, {
      reviewId: entry.reviewId || null,
      reviewedAt: entry.reviewedAt || null,
      status: entry.reviewStatus || "approved",
    }),
    mediaProof: array(entry.mediaProof || entry.mediaPaths || entry.mediaIds || []),
    legacyAuditId: entry.legacyAuditId || entry.contentReleaseId || null,
  };
  if (normalized.legacyAuditId != null && typeof normalized.legacyAuditId !== "string") {
    throw new Error(`ContentSet entry legacyAuditId is invalid: ${entryId}`);
  }
  return normalized;
}

function normalizeHomePayload(value) {
  if (value == null) return null;
  const empty = value.emptyStates?.observations;
  for (const candidate of [value.description, value.homeTitle]) {
    try { normalizeResponsiveTextSlot(candidate, { maxLength: 400 }); }
    catch { throw new Error("ContentSet homeContent is incomplete"); }
  }
  for (const candidate of [empty?.message, empty?.description]) if (typeof candidate !== "string" || candidate.trim() === "") throw new Error("ContentSet homeContent is incomplete");
  const normalizeText = (candidate) => typeof candidate === "string" ? candidate : normalizeResponsiveTextSlot(candidate, { maxLength: 400 });
  return {
    description: normalizeText(value.description),
    homeTitle: normalizeText(value.homeTitle),
    emptyStates: { observations: { message: empty.message, description: empty.description } },
  };
}

function contentSetHashIdentity({ previousContentSetId = null, entries = [], migration = {}, homeContent = null } = {}) {
  return {
    schemaVersion: CONTENT_SET_SCHEMA_VERSION,
    previousContentSetId: previousContentSetId || null,
    entries: entries.map(normalizeContentSetEntry).sort((a, b) => a.entryId.localeCompare(b.entryId)),
    ...(homeContent ? { homeContent: normalizeHomePayload(homeContent) } : {}),
    migration: {
      source: text(migration.source || "normal-operation", "migration.source"),
      ...(migration.sourceManifestVersion ? { sourceManifestVersion: migration.sourceManifestVersion } : {}),
      ...(migration.sourceManifestCommit ? { sourceManifestCommit: migration.sourceManifestCommit } : {}),
    },
  };
}

export function createContentSet({ entries = [], previousContentSetId = null, migration = { source: "normal-operation" }, homeContent = null, createdAt = new Date().toISOString() } = {}) {
  const identity = contentSetHashIdentity({ previousContentSetId, entries, migration, homeContent });
  const contentSetHash = hashContentSetValue(identity);
  const contentSetId = `content-set-${contentSetHash}`;
  const result = {
    ...identity,
    contentSetId,
    contentSetHash,
    createdAt,
  };
  validateContentSet(result);
  return result;
}

export function validateContentSet(contentSet = {}) {
  if (contentSet.schemaVersion !== CONTENT_SET_SCHEMA_VERSION) throw new Error("ContentSet schemaVersion is invalid");
  text(contentSet.contentSetId, "contentSetId");
  if (!/^(?:content-set-)?[a-f0-9]{64}$/.test(contentSet.contentSetId)) throw new Error("ContentSet contentSetId is invalid");
  if (!/^[a-f0-9]{64}$/.test(contentSet.contentSetHash || "")) throw new Error("ContentSet contentSetHash must be SHA-256");
  const expectedIdentity = contentSetHashIdentity(contentSet);
  const expectedHash = hashContentSetValue(expectedIdentity);
  if (contentSet.contentSetHash !== expectedHash || contentSet.contentSetId !== `content-set-${expectedHash}`) {
    throw new Error("ContentSet identity hash drift");
  }
  text(contentSet.createdAt, "createdAt");
  if (!Number.isNaN(Date.parse(contentSet.createdAt))) {
    // A timestamp is required, but we intentionally do not put it in the
    // identity hash so rebuilding the same tuple remains idempotent.
  } else throw new Error("ContentSet createdAt is invalid");
  if (!Array.isArray(contentSet.entries)) throw new Error("ContentSet entries must be an array");
  if (contentSet.homeContent != null) normalizeHomePayload(contentSet.homeContent);
  const ids = new Set();
  const logicalTargets = new Set();
  for (const entry of contentSet.entries) {
    const normalized = normalizeContentSetEntry(entry);
    if (ids.has(normalized.entryId)) throw new Error(`ContentSet duplicate entryId: ${normalized.entryId}`);
    const logicalTarget = `${normalized.kind}:${normalized.target}`;
    if (logicalTargets.has(logicalTarget)) throw new Error(`ContentSet duplicate logical target: ${logicalTarget}`);
    ids.add(normalized.entryId);
    logicalTargets.add(logicalTarget);
  }
  return contentSet;
}

export function contentSetCollections(contentSet = {}) {
  validateContentSet(contentSet);
  const collections = Object.fromEntries(Object.values(kindCollections).map((field) => [field, []]));
  const mediaPaths = new Set();
  for (const entry of contentSet.entries) {
    const field = kindCollections[entry.kind];
    if (field) collections[field].push(entry.target);
    for (const media of entry.mediaProof || []) if (media.startsWith("/")) mediaPaths.add(media);
  }
  for (const field of Object.keys(collections)) collections[field] = [...new Set(collections[field])].sort();
  return { ...collections, mediaPaths: [...mediaPaths].sort() };
}

export function contentManifestFromContentSet(contentSet, { productArtifact = {} } = {}) {
  validateContentSet(contentSet);
  const collections = contentSetCollections(contentSet);
  const hasProductIdentity = productArtifact && typeof productArtifact === "object" && Object.keys(productArtifact).length > 0;
  let identity = null;
  if (hasProductIdentity) {
    try {
      identity = assertProductArtifactIdentityShape(productArtifact);
    } catch (error) {
      throw new Error(`ContentSet manifest requires normalized ProductArtifact identity: ${error.message}`);
    }
  }
  const version = identity?.productVersion || null;
  const commit = identity?.productCommit || null;
  const baseSiteArtifactId = identity?.baseSiteArtifactId || null;
  const manifest = {
    ...(version ? { version } : {}),
    ...(commit ? { commit } : {}),
    ...(baseSiteArtifactId ? { baseSiteArtifactId } : {}),
    ...(identity?.productArtifactId ? { productArtifactId: identity.productArtifactId } : {}),
    ...(identity?.productArtifactHash ? { productArtifactHash: identity.productArtifactHash } : {}),
    ...(identity?.releaseManifestHash ? { releaseManifestHash: identity.releaseManifestHash } : {}),
    ...(identity?.contentManifestHash ? { contentManifestHash: identity.contentManifestHash } : {}),
    ...(identity?.artifactContentHash ? { artifactContentHash: identity.artifactContentHash } : {}),
    ...(identity?.sourceBundleHash ? { sourceBundleHash: identity.sourceBundleHash } : {}),
    contentSetId: contentSet.contentSetId,
    contentSetHash: contentSet.contentSetHash,
    previousContentSetId: contentSet.previousContentSetId || null,
    migration: contentSet.migration,
    createdAt: contentSet.createdAt,
    ...(contentSet.homeContent ? { homeContent: normalizeHomePayload(contentSet.homeContent) } : {}),
    ...collections,
    contentEntries: contentSet.entries.map(normalizeContentSetEntry),
  };
  return manifest;
}

export function contentSetEntryFromLegacyReceipt(receipt = {}, { mediaPaths = [] } = {}) {
  const kind = mapKind(receipt.kind);
  const entry = normalizeContentSetEntry({
    entryId: `${kind}:${receipt.target}`,
    kind,
    target: receipt.target,
    sourcePath: sourcePathFor(kind, receipt.target),
    route: receipt.targetPath,
    contentHash: receipt.contentHash,
    sourceProof: receipt.sourceRefs || receipt.sources || [],
    reviewProof: receipt.reviewEnvelope || {
      reviewId: receipt.reviewId || null,
      reviewedAt: receipt.reviewedAt || receipt.firstPublishedAt || receipt.publishedAt || null,
      status: "approved",
    },
    mediaProof: receipt.mediaPaths || receipt.mediaIds || (kind === "practice" ? mediaPaths : []),
    legacyAuditId: receipt.contentReleaseId || null,
  });
  return entry;
}

export function legacyEntriesFromManifest(manifest = {}) {
  if (Array.isArray(manifest.contentEntries)) {
    return manifest.contentEntries.map(normalizeContentSetEntry).sort((a, b) => a.entryId.localeCompare(b.entryId));
  }
  if (!Array.isArray(manifest.contentReleaseReceipts)) {
    throw new Error("ContentSet migration requires complete contentReleaseReceipts; collection-only manifest is insufficient");
  }
  const mediaPaths = Array.isArray(manifest.mediaPaths) ? manifest.mediaPaths : [];
  const entries = manifest.contentReleaseReceipts.map((receipt) => contentSetEntryFromLegacyReceipt(receipt, { mediaPaths }));
  const ids = new Set();
  for (const entry of entries) {
    if (ids.has(entry.entryId)) throw new Error(`ContentSet migration has duplicate logical target: ${entry.entryId}`);
    ids.add(entry.entryId);
  }
  return entries.sort((a, b) => a.entryId.localeCompare(b.entryId));
}

function sortedStrings(value = []) {
  return [...new Set(Array.isArray(value) ? value.filter((item) => typeof item === "string" && item) : [])].sort();
}

function sameArray(a, b) {
  return JSON.stringify(sortedStrings(a)) === JSON.stringify(sortedStrings(b));
}

function manifestCollections(manifest) {
  return [
    "publishedSlugs",
    "publishedArticleSlugs",
    "practiceIds",
    "profileIds",
    "productIds",
    "businessObservationIds",
    "mediaPaths",
  ];
}

function compareEntryMaps(localEntries, publicEntries) {
  const local = new Map(localEntries.map((entry) => [entry.entryId, entry]));
  const remote = new Map(publicEntries.map((entry) => [entry.entryId, entry]));
  const missing = [...remote.keys()].filter((id) => !local.has(id));
  const extra = [...local.keys()].filter((id) => !remote.has(id));
  const drift = [];
  for (const id of remote.keys()) {
    if (!local.has(id)) continue;
    const left = local.get(id);
    const right = remote.get(id);
    for (const field of ["kind", "target", "route", "contentHash"]) {
      if (left[field] !== right[field]) drift.push(`${id}.${field}`);
    }
    if (!sameArray(left.mediaProof, right.mediaProof)) drift.push(`${id}.mediaProof`);
  }
  if (missing.length || extra.length || drift.length) {
    throw new Error(`ContentSet migration local/public conflict: missing=${missing.join(",") || "none"}; extra=${extra.join(",") || "none"}; drift=${drift.join(",") || "none"}`);
  }
}

export function assertBidirectionalContentSetManifests({ localManifest, publicManifest, productArtifact = null } = {}) {
  if (!localManifest || !publicManifest) throw new Error("ContentSet migration requires local and public content manifests");
  for (const field of ["version", "commit", "baseSiteArtifactId"]) {
    if ((localManifest[field] || null) !== (publicManifest[field] || null)) {
      throw new Error(`ContentSet migration ProductArtifact ${field} mismatch`);
    }
    if (productArtifact && productArtifact[field === "version" ? "productVersion" : field === "commit" ? "productCommit" : "baseSiteArtifactId"] != null
      && localManifest[field] !== productArtifact[field === "version" ? "productVersion" : field === "commit" ? "productCommit" : "baseSiteArtifactId"]) {
      throw new Error(`ContentSet migration ProductArtifact ${field} does not match expected artifact`);
    }
  }
  for (const field of manifestCollections(localManifest)) {
    if (!sameArray(localManifest[field], publicManifest[field])) throw new Error(`ContentSet migration collection ${field} mismatch`);
  }
  const localEntries = legacyEntriesFromManifest(localManifest);
  const publicEntries = legacyEntriesFromManifest(publicManifest);
  compareEntryMaps(localEntries, publicEntries);
  return { entries: publicEntries, count: publicEntries.length, localEntries };
}

function stateDirectory(sourceRoot) {
  return path.join(sourceRoot, ".content-workspace", "content-state");
}

export function contentSetPaths(sourceRoot) {
  const directory = stateDirectory(sourceRoot);
  return {
    directory,
    setsDirectory: path.join(directory, "sets"),
    activePath: path.join(directory, "active.json"),
  };
}

async function atomicWrite(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, file);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function readContentSet({ sourceRoot, contentSetId } = {}) {
  const { setsDirectory } = contentSetPaths(sourceRoot || process.cwd());
  const id = text(contentSetId, "contentSetId");
  const contentSet = await readJson(path.join(setsDirectory, id, "content-set.json"));
  return validateContentSet(contentSet);
}

export async function readActiveContentSet({ sourceRoot } = {}) {
  const root = sourceRoot || process.cwd();
  const { activePath } = contentSetPaths(root);
  const pointer = await readJson(activePath);
  if (pointer.schemaVersion !== ACTIVE_CONTENT_SET_SCHEMA_VERSION) throw new Error("ContentSet active pointer schemaVersion is invalid");
  const contentSet = await readContentSet({ sourceRoot: root, contentSetId: pointer.activeContentSetId });
  if (pointer.contentSetHash !== contentSet.contentSetHash) throw new Error("ContentSet active pointer hash drift");
  return { pointer, contentSet };
}

export async function writeContentSet({ sourceRoot, contentSet } = {}) {
  const root = sourceRoot || process.cwd();
  validateContentSet(contentSet);
  if (contentSet.homeContent) await validateRegisteredResponsiveTextValues({ kind: "home", target: "home", value: contentSet.homeContent, rootDirectory: root });
  const { setsDirectory } = contentSetPaths(root);
  const file = path.join(setsDirectory, contentSet.contentSetId, "content-set.json");
  try {
    const existing = await readJson(file);
    if (hashContentSetValue(contentSetHashIdentity(existing)) !== hashContentSetValue(contentSetHashIdentity(contentSet))) {
      throw new Error(`ContentSet immutable identity collision: ${contentSet.contentSetId}`);
    }
    return { file, contentSet, reused: true };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await atomicWrite(file, contentSet);
  return { file, contentSet, reused: false };
}

export async function activateContentSet({ sourceRoot, nextContentSetId, expectedContentSetId = undefined, now = new Date().toISOString() } = {}) {
  const root = sourceRoot || process.cwd();
  const { activePath } = contentSetPaths(root);
  const current = await readJson(activePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const currentId = current?.activeContentSetId || null;
  if (expectedContentSetId !== undefined && currentId !== (expectedContentSetId || null)) {
    throw new Error(`ContentSet active CAS conflict: expected ${expectedContentSetId || "none"}, observed ${currentId || "none"}`);
  }
  const next = await readContentSet({ sourceRoot: root, contentSetId: nextContentSetId });
  if (currentId === next.contentSetId && current?.contentSetHash === next.contentSetHash) return { pointer: current, reused: true };
  const pointer = {
    schemaVersion: ACTIVE_CONTENT_SET_SCHEMA_VERSION,
    activeContentSetId: next.contentSetId,
    contentSetHash: next.contentSetHash,
    previousContentSetId: currentId,
    updatedAt: now,
  };
  await atomicWrite(activePath, pointer);
  return { pointer, reused: false };
}

/**
 * Restore the exact active pointer captured before a finalize transition.
 * This is deliberately a CAS operation: a later writer must never be
 * overwritten while compensating a failed publication record write.
 */
export async function restoreActiveContentSet({ sourceRoot, expectedContentSetId, previousPointer = null } = {}) {
  const root = sourceRoot || process.cwd();
  const { activePath } = contentSetPaths(root);
  const current = await readJson(activePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const currentId = current?.activeContentSetId || null;
  if (currentId !== (expectedContentSetId || null)) {
    throw new Error(`ContentSet restore CAS conflict: expected ${expectedContentSetId || "none"}, observed ${currentId || "none"}`);
  }
  if (previousPointer == null) {
    await unlink(activePath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    return { pointer: null, restored: true };
  }
  if (previousPointer.schemaVersion !== ACTIVE_CONTENT_SET_SCHEMA_VERSION || !previousPointer.activeContentSetId || !previousPointer.contentSetHash) {
    throw new Error("ContentSet restore pointer is invalid");
  }
  const previous = await readContentSet({ sourceRoot: root, contentSetId: previousPointer.activeContentSetId });
  if (previous.contentSetHash !== previousPointer.contentSetHash) throw new Error("ContentSet restore pointer hash drift");
  await atomicWrite(activePath, previousPointer);
  return { pointer: previousPointer, contentSet: previous, restored: true };
}

export async function migrateContentSet({ sourceRoot, localManifest, publicManifest, productArtifact = null, homeEntry = null, publicHomeEntry = null, homeContent = null, now = new Date().toISOString() } = {}) {
  const reconciliation = assertBidirectionalContentSetManifests({ localManifest, publicManifest, productArtifact });
  if (!reconciliation.entries.some((entry) => entry.kind === "home")) {
    if (!homeEntry || !publicHomeEntry || !homeContent) throw new Error("ContentSet migration requires a reconciled home entry from local source and public page/manifest evidence");
    const localHome = normalizeContentSetEntry(homeEntry);
    const publicHome = normalizeContentSetEntry(publicHomeEntry);
    if (localHome.entryId !== "home:home" || publicHome.entryId !== "home:home" || localHome.contentHash !== publicHome.contentHash || localHome.route !== "/" || publicHome.route !== "/") {
      throw new Error("ContentSet migration home entry/page evidence mismatch");
    }
    reconciliation.entries = [...reconciliation.entries, publicHome].sort((a, b) => a.entryId.localeCompare(b.entryId));
  }
  const resolvedHomeContent = homeContent || publicManifest.homeContent || localManifest.homeContent || null;
  if (!resolvedHomeContent) throw new Error("ContentSet migration home content payload is missing");
  const contentSet = createContentSet({
    entries: reconciliation.entries,
    homeContent: resolvedHomeContent,
    previousContentSetId: null,
    createdAt: now,
    migration: {
      source: "public-and-local-reconciled",
      sourceManifestVersion: publicManifest.version || null,
      sourceManifestCommit: publicManifest.commit || null,
    },
  });
  const written = await writeContentSet({ sourceRoot: sourceRoot || process.cwd(), contentSet });
  const { activePath } = contentSetPaths(sourceRoot || process.cwd());
  const pointer = await readJson(activePath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (pointer && pointer.activeContentSetId !== contentSet.contentSetId) {
    throw new Error(`ContentSet migration refuses to replace existing active set: ${pointer.activeContentSetId}`);
  }
  const activation = await activateContentSet({
    sourceRoot: sourceRoot || process.cwd(),
    nextContentSetId: contentSet.contentSetId,
    expectedContentSetId: pointer?.activeContentSetId || null,
    now,
  });
  return { contentSet, reconciliation, written, activation };
}

export async function readContentSetManifest({ sourceRoot, contentSetId } = {}) {
  const { contentSet } = await readContentSet({ sourceRoot, contentSetId });
  return contentManifestFromContentSet(contentSet);
}

export { kindCollections, sourcePathFor };
