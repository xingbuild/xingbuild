/*
 * Browser-side reader for the immutable ContentDataArtifact data plane.
 *
 * Product-only builds remain inert and use the repository fallback. A
 * content-enabled product never imports .content-workspace as a module: it
 * fetches the active tuple, immutable manifest, and CAS objects from the
 * published content-data URL. This keeps content-only publication separate
 * from the ProductArtifact build.
 */
// Build-time embedding and product runtime capability are deliberately
// separate flags.  ProductArtifact builds keep content embedding disabled
// while enabling the HTTP ContentDataArtifact reader.
const contentRuntimeEnabledFlag = typeof __XINGBUILD_CONTENT_RUNTIME__ !== "undefined" && __XINGBUILD_CONTENT_RUNTIME__;
const RUNTIME_SCHEMA = "content-data-active-v1";
const MANIFEST_SCHEMA = "content-data-manifest-v1";
const SHA256 = /^[a-f0-9]{64}$/;
const runtimeCache = { promise: null, data: null, error: null };

function required(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function requiredHash(value, field) {
  required(value, field);
  if (!SHA256.test(value)) throw new Error(`${field} must be a SHA-256 hash`);
  return value;
}

function responseError(response, url) {
  const error = new Error(`content data request failed: ${response.status} ${url}`);
  error.code = "CONTENT_DATA_RUNTIME_FETCH_FAILED";
  error.status = response.status;
  return error;
}

async function readJson(fetchImpl, url, { cache = "no-store" } = {}) {
  const response = await fetchImpl(url, { cache, headers: { Accept: "application/json" } });
  if (!response.ok) throw responseError(response, url);
  const contentType = response.headers?.get?.("content-type") || "";
  if (contentType && !/application\/json/i.test(contentType)) {
    const error = new Error(`content data response MIME is not JSON: ${contentType}`);
    error.code = "CONTENT_DATA_RUNTIME_MIME_INVALID";
    throw error;
  }
  return response.json();
}

function resolveUrl(value, baseUrl) {
  try { return new URL(value, baseUrl).toString(); }
  catch { throw new Error(`content data URL is invalid: ${value}`); }
}

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const bytes = (key) => new TextEncoder().encode(key);
  const compare = (left, right) => {
    const a = bytes(left); const b = bytes(right);
    for (let index = 0; index < Math.min(a.length, b.length); index += 1) if (a[index] !== b[index]) return a[index] - b[index];
    return a.length - b.length;
  };
  return `{${Object.keys(value).sort(compare).map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error("content data runtime requires Web Crypto for object verification");
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function contentDataObjectHash(record) {
  return sha256Hex(stable({
    schemaVersion: "content-data-object-v1",
    logicalContentId: record.logicalContentId,
    entryId: record.entryId,
    revisionId: record.revisionId,
    sourceHash: record.sourceHash,
    valueHash: record.valueHash,
    value: record.value,
  }));
}

function assertActivePayload(active) {
  if (!active || active.schemaVersion !== RUNTIME_SCHEMA) throw new Error("content data active tuple schemaVersion is invalid");
  required(active.contentDataArtifactId, "active.contentDataArtifactId");
  requiredHash(active.contentDataHash, "active.contentDataHash");
  requiredHash(active.tupleHash, "active.tupleHash");
  required(active.manifestUrl, "active.manifestUrl");
  return active;
}

function assertManifest(manifest, active) {
  if (!manifest || manifest.schemaVersion !== MANIFEST_SCHEMA) throw new Error("content data manifest schemaVersion is invalid");
  if (manifest.contentDataArtifactId !== active.contentDataArtifactId || manifest.contentDataHash !== active.contentDataHash) {
    throw new Error("content data manifest identity does not match active tuple");
  }
  requiredHash(manifest.manifestHash, "manifest.manifestHash");
  if (!Array.isArray(manifest.records)) throw new Error("content data manifest records are required");
  return manifest;
}

async function loadRuntimeContentData({
  baseUrl = globalThis.location?.href || "/",
  activeUrl = "/content-data/active.json",
  fetchImpl = globalThis.fetch?.bind(globalThis),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("content data runtime requires fetch");
  const activeRequestUrl = resolveUrl(activeUrl, baseUrl);
  const active = assertActivePayload(await readJson(fetchImpl, activeRequestUrl));
  const expectedManifestPath = `/content-data/${active.contentDataArtifactId}/content-data-manifest.json`;
  if (active.manifestUrl !== expectedManifestPath) throw new Error("content data active tuple manifest URL is not immutable");
  const manifestUrl = resolveUrl(active.manifestUrl, activeRequestUrl);
  const manifest = assertManifest(await readJson(fetchImpl, manifestUrl), active);
  const records = new Map();
  for (const manifestRecord of manifest.records) {
    required(manifestRecord.logicalContentId, "manifest.record.logicalContentId");
    requiredHash(manifestRecord.objectHash, "manifest.record.objectHash");
    const objectUrl = resolveUrl(`objects/${manifestRecord.objectHash}.json`, manifestUrl);
    const object = await readJson(fetchImpl, objectUrl, { cache: "force-cache" });
    if (object.objectHash !== manifestRecord.objectHash || !object.record || await contentDataObjectHash(object.record) !== manifestRecord.objectHash) throw new Error(`content data object identity mismatch: ${manifestRecord.logicalContentId}`);
    records.set(manifestRecord.logicalContentId, object.record);
    if (manifestRecord.entryId) records.set(`entry:${manifestRecord.entryId}`, object.record);
  }
  return Object.freeze({ active, manifest, records, activeUrl: activeRequestUrl, manifestUrl });
}

// Exported for deterministic runtime QA; the production hook gates the
// reader behind the explicit runtime capability, not build-time embedding.
export const readRuntimeContentDataFromHttp = loadRuntimeContentData;

export function contentDataRuntimeEnabled() {
  return Boolean(contentRuntimeEnabledFlag && typeof globalThis.fetch === "function");
}

export function fetchRuntimeContentData(options = {}) {
  if (!contentDataRuntimeEnabled()) return Promise.resolve(null);
  if (!runtimeCache.promise) {
    runtimeCache.promise = loadRuntimeContentData(options)
      .then((data) => { runtimeCache.data = data; runtimeCache.error = null; return data; })
      .catch((error) => { runtimeCache.error = error; throw error; });
  }
  return runtimeCache.promise;
}

export function resetRuntimeContentData() {
  runtimeCache.promise = null;
  runtimeCache.data = null;
  runtimeCache.error = null;
}

export function getRuntimeContentData() { return runtimeCache.data; }

export function resolveRuntimeContentData({ logicalContentId, entryId, data = runtimeCache.data } = {}) {
  if (!data?.records) return null;
  const resolved = data.records.get(logicalContentId) || data.records.get(entryId ? `entry:${entryId}` : "") || null;
  // The manifest map stores immutable ContentDataArtifact records so their
  // identity/provenance remains available to diagnostics. Page composition
  // resolvers consume the record's value, never the storage envelope.
  return resolved && Object.hasOwn(resolved, "value") ? resolved.value : resolved;
}

export function getRuntimeContentDataError() { return runtimeCache.error; }
