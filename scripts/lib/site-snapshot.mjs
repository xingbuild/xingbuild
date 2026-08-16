import { createHash } from "node:crypto";
import { contentManifestFromContentSet, validateContentSet } from "./content-set.mjs";
import { assertProductArtifactIdentityShape, PRODUCT_ARTIFACT_IDENTITY_FIELDS } from "./product-artifact.mjs";
import { assertActiveContentDataTuple } from "./content-data-plane.mjs";

export const SITE_SNAPSHOT_SCHEMA_VERSION = "site-snapshot-v1";

function canonical(value) {
  return JSON.stringify(value);
}
export function hashSiteSnapshotValue(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`SiteSnapshot ${field} is required`);
  return value;
}

export function productArtifactIdentity(productArtifact = {}) {
  assertProductArtifactIdentityShape(productArtifact);
  return Object.fromEntries(PRODUCT_ARTIFACT_IDENTITY_FIELDS
    .filter((field) => productArtifact[field] != null)
    .map((field) => [field, productArtifact[field]]));
}

function contentDataIdentity(contentDataArtifact = null) {
  if (!contentDataArtifact) return null;
  text(contentDataArtifact.contentDataArtifactId, "contentDataArtifact.contentDataArtifactId");
  if (!/^[a-f0-9]{64}$/.test(contentDataArtifact.contentDataHash || "")) {
    throw new Error("SiteSnapshot contentDataArtifact.contentDataHash must be SHA-256");
  }
  if (contentDataArtifact.manifestHash != null && !/^[a-f0-9]{64}$/.test(contentDataArtifact.manifestHash)) {
    throw new Error("SiteSnapshot contentDataArtifact.manifestHash must be SHA-256");
  }
  return {
    contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
    contentDataHash: contentDataArtifact.contentDataHash,
    ...(contentDataArtifact.manifestHash ? { manifestHash: contentDataArtifact.manifestHash } : {}),
  };
}

function activeTupleIdentity(activeTuple = null) {
  if (!activeTuple) return null;
  assertActiveContentDataTuple(activeTuple);
  return {
    schemaVersion: activeTuple.schemaVersion,
    tupleHash: activeTuple.tupleHash,
    contentSetId: activeTuple.contentSetId,
    contentSetHash: activeTuple.contentSetHash,
    contentDataArtifactId: activeTuple.contentDataArtifactId,
    contentDataHash: activeTuple.contentDataHash,
    productArtifactId: activeTuple.productArtifactId || null,
    productArtifactHash: activeTuple.productArtifactHash || null,
    manifestHash: activeTuple.manifestHash || null,
  };
}

function snapshotIdentity({ schemaVersion = SITE_SNAPSHOT_SCHEMA_VERSION, productArtifact, contentSet, contentManifest, contentDataArtifact = null, activeTuple = null }) {
  return {
    schemaVersion,
    productArtifact: productArtifactIdentity(productArtifact),
    contentSetId: contentSet.contentSetId,
    contentSetHash: contentSet.contentSetHash,
    contentManifest,
    ...(contentDataArtifact ? { contentDataArtifact: contentDataIdentity(contentDataArtifact) } : {}),
    ...(activeTuple ? { activeTuple: activeTupleIdentity(activeTuple), activeTupleHash: activeTuple.tupleHash } : {}),
  };
}

export function createSiteSnapshot({ productArtifact, contentSet, contentDataArtifact = null, activeTuple = null, requireContentData = false, previousSnapshotId = null, createdAt = new Date().toISOString() } = {}) {
  validateContentSet(contentSet);
  const product = productArtifactIdentity(productArtifact);
  const contentManifest = contentManifestFromContentSet(contentSet, { productArtifact: product });
  // The release/artifact schema is the stable contract boundary.  A pending
  // product version must never select the normal path by name; only an
  // explicit legacy fixture (without the v2 artifact contract) may remain on
  // the read-only compatibility shape.
  const strictDataPlane = Boolean(requireContentData || productArtifact?.artifactContractVersion === "product-artifact-v2");
  if (strictDataPlane && (!contentDataArtifact || !activeTuple)) {
    const error = new Error("canonical ProductArtifact SiteSnapshot requires ContentDataArtifact and active tuple");
    error.code = "SITE_SNAPSHOT_DATA_PLANE_REQUIRED";
    throw error;
  }
  if (activeTuple) {
    assertActiveContentDataTuple(activeTuple);
    if (activeTuple.contentSetId !== contentSet.contentSetId || activeTuple.contentSetHash !== contentSet.contentSetHash) throw new Error("SiteSnapshot active tuple ContentSet identity mismatch");
    if (!contentDataArtifact || activeTuple.contentDataArtifactId !== contentDataArtifact.contentDataArtifactId || activeTuple.contentDataHash !== contentDataArtifact.contentDataHash) throw new Error("SiteSnapshot active tuple ContentDataArtifact identity mismatch");
    if (activeTuple.productArtifactId !== product.productArtifactId || activeTuple.productArtifactHash !== product.productArtifactHash) throw new Error("SiteSnapshot active tuple ProductArtifact identity mismatch");
  }
  // ContentData is an extension of the existing SiteSnapshot contract.  The
  // schema identity stays v1 so the first active-tuple cutover does not
  // create a second snapshot authority.  Canonical ProductArtifact inputs
  // still require the data references above; only the immutable shape is
  // extended with those references.
  const schemaVersion = SITE_SNAPSHOT_SCHEMA_VERSION;
  const identity = snapshotIdentity({ schemaVersion, productArtifact: product, contentSet, contentManifest, contentDataArtifact, activeTuple });
  const snapshotHash = hashSiteSnapshotValue(identity);
  const siteSnapshotId = `site-snapshot-${snapshotHash}`;
  const snapshot = {
    ...identity,
    siteSnapshotId,
    snapshotHash,
    previousSnapshotId: previousSnapshotId || null,
    createdAt,
    state: "assembled",
  };
  assertSiteSnapshotIdentity(snapshot);
  return snapshot;
}

export function assertSiteSnapshotIdentity(snapshot = {}) {
  if (snapshot.schemaVersion !== SITE_SNAPSHOT_SCHEMA_VERSION) throw new Error("SiteSnapshot schemaVersion is invalid");
  text(snapshot.siteSnapshotId, "siteSnapshotId");
  if (!/^site-snapshot-[a-f0-9]{64}$/.test(snapshot.siteSnapshotId)) throw new Error("SiteSnapshot siteSnapshotId is invalid");
  if (!/^[a-f0-9]{64}$/.test(snapshot.snapshotHash || "")) throw new Error("SiteSnapshot snapshotHash must be SHA-256");
  const contentSet = {
    schemaVersion: "content-set-v1",
    contentSetId: snapshot.contentSetId,
    contentSetHash: snapshot.contentSetHash,
    previousContentSetId: snapshot.contentManifest?.previousContentSetId || null,
    entries: snapshot.contentManifest?.contentEntries || [],
    migration: snapshot.contentManifest?.migration || { source: "normal-operation" },
    createdAt: snapshot.contentManifest?.createdAt || snapshot.createdAt,
  };
  // The complete ContentSet is not embedded in every snapshot; the identity
  // check below is intentionally based on the immutable fields that are
  // present in the snapshot.  Callers that have the full set validate it at
  // assembly time.
  const product = productArtifactIdentity(snapshot.productArtifact);
  // Only the immutable release-schema marker opts a ProductArtifact into the
  // canonical data-plane requirement. Older product-artifact-v2 fixtures are
  // read-only compatibility inputs and must not be selected by version name.
  const canonicalDataPlane = snapshot.productArtifact?.contentDataContractVersion === "content-data-publication-v1";
  // A legacy content-only receipt may carry the immutable ContentDataArtifact
  // reference before the active tuple became part of the canonical snapshot.
  // The v1 canonical contract is selected by the tuple (or the explicit
  // release-schema marker), so the old reference-only shape remains readable
  // without creating a second snapshot schema.
  if (canonicalDataPlane || snapshot.activeTuple) {
    if (!snapshot.contentDataArtifact || !snapshot.activeTuple || snapshot.activeTupleHash !== snapshot.activeTuple.tupleHash) throw new Error("SiteSnapshot canonical data plane requires ContentDataArtifact and active tuple");
    assertActiveContentDataTuple(snapshot.activeTuple);
    if (snapshot.activeTuple.contentSetId !== snapshot.contentSetId || snapshot.activeTuple.contentSetHash !== snapshot.contentSetHash) throw new Error("SiteSnapshot active tuple ContentSet identity mismatch");
    if (snapshot.activeTuple.contentDataArtifactId !== snapshot.contentDataArtifact.contentDataArtifactId || snapshot.activeTuple.contentDataHash !== snapshot.contentDataArtifact.contentDataHash) throw new Error("SiteSnapshot active tuple ContentDataArtifact identity mismatch");
    if (snapshot.activeTuple.productArtifactId !== product.productArtifactId || snapshot.activeTuple.productArtifactHash !== product.productArtifactHash) throw new Error("SiteSnapshot active tuple ProductArtifact identity mismatch");
  }
  const identity = snapshotIdentity({
    schemaVersion: snapshot.schemaVersion,
    productArtifact: product,
    contentSet: { contentSetId: snapshot.contentSetId, contentSetHash: snapshot.contentSetHash },
    contentManifest: snapshot.contentManifest,
    contentDataArtifact: snapshot.contentDataArtifact || null,
    activeTuple: snapshot.activeTuple || null,
  });
  const expected = hashSiteSnapshotValue(identity);
  if (expected !== snapshot.snapshotHash || snapshot.siteSnapshotId !== `site-snapshot-${expected}`) throw new Error("SiteSnapshot identity hash drift");
  text(snapshot.createdAt, "createdAt");
  return snapshot;
}

export function assertSiteSnapshotTuple(snapshot, { productArtifactId, contentSetId, contentSetHash } = {}) {
  assertSiteSnapshotIdentity(snapshot);
  if (productArtifactId != null && snapshot.productArtifact.productArtifactId !== productArtifactId) throw new Error("SiteSnapshot ProductArtifact identity mismatch");
  if (contentSetId != null && snapshot.contentSetId !== contentSetId) throw new Error("SiteSnapshot ContentSet identity mismatch");
  if (contentSetHash != null && snapshot.contentSetHash !== contentSetHash) throw new Error("SiteSnapshot ContentSet hash mismatch");
  return true;
}

export function assertSiteSnapshotDataPlane(snapshot, { productArtifactId, tupleHash, contentDataArtifactId, contentDataHash } = {}) {
  assertSiteSnapshotIdentity(snapshot);
  if (snapshot.schemaVersion !== SITE_SNAPSHOT_SCHEMA_VERSION) throw new Error("SiteSnapshot v1 is required for canonical data-plane publication");
  if (productArtifactId != null && snapshot.productArtifact.productArtifactId !== productArtifactId) throw new Error("SiteSnapshot ProductArtifact identity mismatch");
  if (tupleHash != null && snapshot.activeTupleHash !== tupleHash) throw new Error("SiteSnapshot active tuple identity mismatch");
  if (contentDataArtifactId != null && snapshot.contentDataArtifact.contentDataArtifactId !== contentDataArtifactId) throw new Error("SiteSnapshot ContentDataArtifact identity mismatch");
  if (contentDataHash != null && snapshot.contentDataArtifact.contentDataHash !== contentDataHash) throw new Error("SiteSnapshot ContentData hash mismatch");
  return true;
}
