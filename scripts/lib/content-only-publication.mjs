import { assertProductArtifactIdentityShape } from "./product-artifact.mjs";
import { createSiteSnapshot, assertSiteSnapshotIdentity } from "./site-snapshot.mjs";
import { createPublicationRun, publicationRunIdForSnapshot } from "./publication-run.mjs";
import {
  assertActiveContentDataTuple,
  assertContentDataArtifact,
  createContentOnlyReceipt,
  prepareContentOnlyMaterialization,
  writeContentOnlyReceipt,
} from "./content-data-plane.mjs";
import { assertContentPublicationIntent, createContentPublicationIntent } from "./content-publication-intent.mjs";

/**
 * Content-only publication intent.  The existing Coordinator remains the only
 * transport owner; this adapter only assembles references and an ephemeral
 * upload root, never a durable client or a second deployment path.
 */
export async function createContentOnlyPublicationIntent({ sourceRoot = process.cwd(), productClient, productArtifact, contentSet, contentDataArtifact, activeTuple, manifest = null } = {}) {
  const product = assertProductArtifactIdentityShape(productArtifact);
  assertContentDataArtifact(contentDataArtifact);
  assertActiveContentDataTuple(activeTuple);
  if (activeTuple.contentSetId !== contentSet.contentSetId || activeTuple.contentSetHash !== contentSet.contentSetHash) throw new Error("content-only tuple ContentSet drift");
  if (activeTuple.contentDataArtifactId !== contentDataArtifact.contentDataArtifactId || activeTuple.contentDataHash !== contentDataArtifact.contentDataHash) throw new Error("content-only tuple artifact drift");
  if (product.artifactContractVersion === "product-artifact-v2") {
    const canonical = await createContentPublicationIntent({ sourceRoot, productArtifact: product, contentSet, contentDataArtifact, activeTuple, manifest });
    const materialization = await prepareContentOnlyMaterialization({ sourceRoot, productClient, productArtifact: product, contentSet, artifact: contentDataArtifact, activeTuple, manifest });
    const intent = {
      ...canonical.intent,
      materialization: {
        root: materialization.root,
        activeTupleHash: activeTuple.tupleHash,
        contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
      },
    };
    assertContentPublicationIntent(canonical.intent);
    return { ...canonical, intent, materialization, deploymentCount: 0, transportOwner: "SitePublicationCoordinator" };
  }
  const siteSnapshot = createSiteSnapshot({
    productArtifact: product,
    contentSet,
    contentDataArtifact: {
      contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
      contentDataHash: contentDataArtifact.contentDataHash,
      ...(manifest ? { manifestHash: manifest.manifestHash || null } : {}),
    },
    createdAt: "1970-01-01T00:00:00.000Z",
  });
  assertSiteSnapshotIdentity(siteSnapshot);
  const publicationRun = createPublicationRun({ siteSnapshot, createdAt: "1970-01-01T00:00:00.000Z" });
  const materialization = await prepareContentOnlyMaterialization({ sourceRoot, productClient, productArtifact: product, contentSet, artifact: contentDataArtifact, activeTuple, manifest });
  const receipt = createContentOnlyReceipt({ productArtifact: product, contentSet, artifact: contentDataArtifact, activeTuple, siteSnapshotId: siteSnapshot.siteSnapshotId, publicationRunId: publicationRun.publicationRunId, manifestHash: materialization.dataManifest.manifestHash });
  return {
    schemaVersion: "content-only-publication-intent-v1",
    productArtifact: product,
    contentSet: { contentSetId: contentSet.contentSetId, contentSetHash: contentSet.contentSetHash },
    contentDataArtifact: { contentDataArtifactId: contentDataArtifact.contentDataArtifactId, contentDataHash: contentDataArtifact.contentDataHash },
    activeTuple: { contentSetId: activeTuple.contentSetId, contentSetHash: activeTuple.contentSetHash, contentDataArtifactId: activeTuple.contentDataArtifactId, contentDataHash: activeTuple.contentDataHash, tupleHash: activeTuple.tupleHash },
    siteSnapshot: {
      siteSnapshotId: siteSnapshot.siteSnapshotId,
      snapshotHash: siteSnapshot.snapshotHash,
      schemaVersion: siteSnapshot.schemaVersion,
      contentDataArtifactId: siteSnapshot.contentDataArtifact.contentDataArtifactId,
      contentDataHash: siteSnapshot.contentDataArtifact.contentDataHash,
    },
    publicationRun: {
      publicationRunId: publicationRun.publicationRunId,
      siteSnapshotId: publicationRun.siteSnapshotId,
      snapshotHash: publicationRun.snapshotHash,
      contentDataArtifactId: publicationRun.contentDataArtifactId || null,
      contentDataHash: publicationRun.contentDataHash || null,
    },
    materialization,
    receipt,
    deploymentCount: 0,
    transportOwner: "SitePublicationCoordinator",
  };
}

export async function persistContentOnlyReceipt({ sourceRoot = process.cwd(), intent } = {}) {
  if (!intent?.receipt) throw new Error("content-only publication intent receipt is required");
  return writeContentOnlyReceipt({ sourceRoot, receipt: intent.receipt });
}

export function assertContentOnlyPublicationIntent(intent = {}) {
  if (intent.schemaVersion === "content-publication-intent-v1") return assertContentPublicationIntent(intent);
  if (intent.schemaVersion !== "content-only-publication-intent-v1") throw new Error("content-only publication intent schemaVersion is invalid");
  if (intent.transportOwner !== "SitePublicationCoordinator") throw new Error("content-only publication intent must use SitePublicationCoordinator");
  if (intent.deploymentCount !== 0) throw new Error("content-only publication intent cannot carry a deployment");
  if (intent.materialization?.root && intent.receipt?.contentDataArtifactId !== intent.contentDataArtifact?.contentDataArtifactId) throw new Error("content-only publication artifact reference drift");
  return intent;
}

export { publicationRunIdForSnapshot };
