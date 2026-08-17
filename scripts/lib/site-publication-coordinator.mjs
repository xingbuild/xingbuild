import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { assertProductContentCompatibility } from "./content-compatibility.mjs";
import { acquireSitePublicationLease, releaseSitePublicationLease, assertSitePublicationEvidence } from "./site-publication.mjs";
import { writeJsonAtomically } from "./content-release-state.mjs";
import { assertContentLifecycleProjection } from "./content-lifecycle-time.mjs";
import { assertActiveContentProjection } from "./content-release-receipt.mjs";
import { compareAndSwapContentSlot, contentLogicalContentId, contentReceiptId, ensureContentSlotRegistry, restoreContentSlot } from "./content-slot-registry.mjs";
import { activateContentSet, readActiveContentSet, restoreActiveContentSet } from "./content-set.mjs";
import { markPublicationRecoverable, markPublicationReleased, markPublicationRolledBack, readPublicationRun, writePublicationRun } from "./publication-run.mjs";
import { readPublicationAssetManifest, preparePortableUploadRoot, verifyPublicPublicationAssets } from "./publication-assets.mjs";
import { verifyPublicBrowserRuntime } from "./publication-runtime.mjs";
import { deriveRuntimeAcceptanceSpec, readOrDeriveRuntimeAcceptanceSpec, assertRuntimeAcceptanceSpec } from "./runtime-acceptance.mjs";
import {
  assertPublicationPhaseAggregate,
  createPublicationEvidenceReducer,
  createPublicationPhaseEvidence,
} from "./publication-evidence.mjs";
import { canonicalJson } from "./release-scope-classifier.mjs";
import { assertProductArtifactIdentityShape } from "./product-artifact.mjs";
import { assertActiveContentDataTuple, assertContentDataArtifact, activateContentDataTuple, contentDataObjectHash, contentDataPaths, readActiveContentDataTuple } from "./content-data-plane.mjs";
import { assertSiteSnapshotDataPlane } from "./site-snapshot.mjs";
import { assertDurableSitePublicationRecord, sanitizeDurableSitePublicationRecord } from "./content-lifecycle-governance.mjs";
import {
  assertBindingCandidate,
  assertPublicationLineageBindingAgainstRegistry,
  createOrReusePublicationLineageBinding,
  publicationLineageBindingProjection,
  readPublicationLineageBinding,
  validatePublicationLineageBinding,
} from "./publication-lineage-binding.mjs";
import {
  assertFixedPublishTarget,
  assertPublishAuthorization,
  edgeoneProjectId,
  publicUrl,
  readDeploymentResult,
  readFixedEdgeoneTarget,
} from "./publish-target.mjs";

const SHA256 = /^[a-f0-9]{64}$/;

function runCapture(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env, timeout: 120000, killSignal: "SIGTERM" });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  if (result.error?.code === "ETIMEDOUT") {
    const error = new Error(`${command} ${args.join(" ")} timed out after 120000ms`);
    error.code = "SITE_PUBLICATION_CLI_TIMEOUT";
    error.recoverable = true;
    throw error;
  }
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  return output;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export function publicationRecoveryId(sitePublicationId, failure = "transport") {
  return `${sitePublicationId}:${failure}`;
}

export async function readSitePublicationRecord(publicationDirectory) {
  return readJson(path.join(publicationDirectory, "site-publication.json"));
}

function publicationProductArtifactIdentity(publication = {}) {
  const identity = publication.productArtifact || {
    productArtifactId: publication.productArtifactId,
    productVersion: publication.productVersion,
    productCommit: publication.productCommit,
    // Legacy records predate the explicit fourth tuple field; their
    // productArtifactId is already the immutable base artifact id.
    baseSiteArtifactId: publication.baseSiteArtifactId || publication.productArtifactId,
    productArtifactHash: publication.productArtifactHash || undefined,
  };
  return assertProductArtifactIdentityShape(identity);
}

export function sitePublicationIdentity(publication = {}) {
  const identity = {
    sitePublicationId: publication.sitePublicationId || null,
    snapshotHash: publication.snapshotHash || null,
    ...publicationProductArtifactIdentity(publication),
    version: publication.productVersion || publication.productArtifact?.productVersion || null,
    commit: publication.productCommit || publication.productArtifact?.productCommit || null,
  };
  const activeTupleHash = publication.activeTupleHash || publication.activeTuple?.tupleHash || null;
  if (activeTupleHash) identity.activeTupleHash = activeTupleHash;
  return identity;
}

function propagationError(message, observedIdentity = {}) {
  const error = new Error(message);
  error.recoverable = true;
  error.propagation = true;
  error.observedIdentity = observedIdentity;
  return error;
}

function identityDriftError(message, observedIdentity = {}) {
  const error = new Error(message);
  error.code = "SITE_PUBLICATION_IDENTITY_DRIFT";
  error.observedIdentity = observedIdentity;
  return error;
}

function isContentSetPublication(publication = {}) {
  return Boolean(publication.contentSetId && publication.contentSetHash && publication.siteSnapshotId && publication.snapshotHash && publication.publicationRunId);
}

async function finalizeContentSetPublication({ current, publicationDirectory, publicVerify, sourceRoot }) {
  if (publicVerify.contentSetId !== current.contentSetId
    || publicVerify.contentSetHash !== current.contentSetHash
    || publicVerify.siteSnapshotId !== current.siteSnapshotId
    || publicVerify.snapshotHash !== current.snapshotHash
    || publicVerify.baseSiteArtifactId !== (current.baseSiteArtifactId || current.productArtifactId)
    || (current.productArtifactHash && publicVerify.productArtifactHash !== current.productArtifactHash)) {
    throw new Error("ContentSet SitePublication public evidence identity mismatch");
  }
  const activeBefore = await readActiveContentSet({ sourceRoot }).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  let run = await readPublicationRun({ sourceRoot, publicationRunId: current.publicationRunId });
  if (run.siteSnapshotId !== current.siteSnapshotId || run.snapshotHash !== current.snapshotHash || run.contentSetId !== current.contentSetId) {
    throw new Error("PublicationRun identity drift during finalize");
  }
  if (run.productArtifactId !== current.productArtifactId
    || run.productVersion !== current.productVersion
    || run.productCommit !== current.productCommit
    || run.baseSiteArtifactId !== (current.baseSiteArtifactId || current.productArtifactId)) {
    throw new Error("PublicationRun ProductArtifact identity drift during finalize");
  }
  let activeChanged = false;
  let releasedRun = run;
  try {
    if (activeBefore && activeBefore.contentSet.contentSetId !== current.contentSetId) {
      const expected = current.contentManifest?.previousContentSetId || null;
      await activateContentSet({ sourceRoot, nextContentSetId: current.contentSetId, expectedContentSetId: expected });
      activeChanged = true;
    } else if (activeBefore && activeBefore.contentSet.contentSetHash !== current.contentSetHash) {
    throw new Error("ContentSet active pointer hash drift during finalize");
    } else if (!activeBefore) {
      await activateContentSet({ sourceRoot, nextContentSetId: current.contentSetId, expectedContentSetId: null });
      activeChanged = true;
    }
    if (run.state !== "released") releasedRun = markPublicationReleased(run, publicVerify);
    else if (!run.publicVerify || run.publicVerify.sitePublicationId !== publicVerify.sitePublicationId || run.publicVerify.snapshotHash !== publicVerify.snapshotHash || run.publicVerify.contentSetId !== publicVerify.contentSetId || run.publicVerify.contentSetHash !== publicVerify.contentSetHash) throw new Error("PublicationRun released evidence drift");
    await writePublicationRun({ sourceRoot, run: releasedRun });
    return await writePublicationRecord(publicationDirectory, {
      ...current,
      publicationRun: releasedRun,
      state: "released",
      publicVerify,
      releasedAt: current.releasedAt || new Date().toISOString(),
      failure: null,
    });
  } catch (error) {
    if (activeChanged) {
      await restoreActiveContentSet({
        sourceRoot,
        expectedContentSetId: current.contentSetId,
        previousPointer: activeBefore?.pointer || null,
      }).catch(() => {});
    }
    if (releasedRun !== run) await writePublicationRun({ sourceRoot, run }).catch(() => {});
    throw error;
  }
}

function isDataPlanePublication(publication = {}) {
  return Boolean(publication.contentSetId && publication.contentSetHash && publication.contentDataArtifactId && publication.contentDataHash && publication.activeTupleHash && publication.siteSnapshotId && publication.snapshotHash && publication.publicationRunId);
}

// The v0.28.3 incident is the only historical record that predates
// RuntimeAcceptanceSpec and may be adapted.  This is an immutable compatibility
// boundary, not a version-wide fallback: every product, snapshot, tuple,
// publication, deployment and approval identity must match before derivation.
const V0283_RUNTIME_INCIDENT = Object.freeze({
  version: "v0.28.3",
  productCommit: "85e8c3d080f998449a4fefb0c8429b1e27beb36e",
  productArtifactId: "v0.28.3-85e8c3d080f9",
  baseSiteArtifactId: "v0.28.3-85e8c3d080f9",
  productArtifactHash: "368ac357a619f123d1108b9475b2b0aaf412141e2e891ac02ab68ce2734226af",
  contentManifestHash: "1679001b1b54d19b196b025fbff588ba63e432cea675fa19915128547150bc00",
  baseSiteArtifactManifestHash: "08bb0e4ff16f14002c69963e528fd75ac34f59cb4a5afb7963142cd245033f99",
  approvalHash: "510998daf2e91efbdc2c915efa93ce9a6e789fde187e80d1d7190fe708500e08",
  candidateHash: "548bdb4b6b354b1d7cf530e67de995860e57a7937ead3c8aa355b7d5399088f3",
  approvedTreeOid: "923edf4f9427e7d7e3b6a509681bc9ded9b5c2f6",
  contentSetId: "content-set-c0377df3307713df1725102c8053797bd8c0b46e1ae9895d5186c904a6f6983a",
  contentSetHash: "c0377df3307713df1725102c8053797bd8c0b46e1ae9895d5186c904a6f6983a",
  siteSnapshotId: "site-snapshot-0f0dd6c9be883e840fa0e5385ad35317bd9c1dd3e0f6d7f52acbc91ba0dbf8f2",
  snapshotHash: "0f0dd6c9be883e840fa0e5385ad35317bd9c1dd3e0f6d7f52acbc91ba0dbf8f2",
  contentDataArtifactId: "content-data-artifact-fa32e7d1fccc9ff492a9139e",
  contentDataHash: "fa32e7d1fccc9ff492a9139e3adba21fed7674d86bedf8c5901089fa2e35361b",
  activeTupleHash: "5acaf2ff4e0d531478d7a20ea781662bca536342ea4065a654195eb0d5bb74e2",
  sitePublicationId: "v0.28.3+85e8c3d080f998449a4fefb0c8429b1e27beb36e+content-set-c0377df3307713df1725102c8053797bd8c0b46e1ae9895d5186c904a6f6983a",
  publicationRunId: "publication-run-site-snapshot-0f0dd6c9be883e840fa0e5385ad35317bd9c1dd3e0f6d7f52acbc91ba0dbf8f2",
  deploymentId: "dpgr0trnxfcv",
});

const V0283_RUNTIME_INCIDENT_FIELDS = Object.freeze([
  "version",
  "productCommit",
  "productArtifactId",
  "productArtifactHash",
  "contentManifestHash",
  "contentSetId",
  "contentSetHash",
  "siteSnapshotId",
  "snapshotHash",
  "contentDataArtifactId",
  "contentDataHash",
  "activeTupleHash",
  "sitePublicationId",
  "publicationRunId",
  "deploymentId",
]);

function assertExactV0283IncidentIdentity(current, run, deployment) {
  const observed = {
    version: current.productVersion,
    productCommit: current.productCommit,
    productArtifactId: current.productArtifactId,
    productArtifactHash: current.productArtifactHash,
    contentManifestHash: current.contentManifest?.contentManifestHash,
    contentSetId: current.contentSetId,
    contentSetHash: current.contentSetHash,
    siteSnapshotId: current.siteSnapshotId,
    snapshotHash: current.snapshotHash,
    contentDataArtifactId: current.contentDataArtifactId,
    contentDataHash: current.contentDataHash,
    activeTupleHash: current.activeTupleHash,
    sitePublicationId: current.sitePublicationId,
    publicationRunId: current.publicationRunId,
    deploymentId: current.deploymentId,
  };
  for (const field of V0283_RUNTIME_INCIDENT_FIELDS) {
    if (observed[field] !== V0283_RUNTIME_INCIDENT[field]) {
      throw new Error(`v0.28.3 recovery compatibility identity mismatch: ${field}`);
    }
  }
  const productArtifact = current.productArtifact || {};
  for (const field of ["productArtifactId", "productArtifactHash", "approvalHash", "candidateHash", "approvedTreeOid", "baseSiteArtifactManifestHash", "contentManifestHash"]) {
    if (productArtifact[field] !== V0283_RUNTIME_INCIDENT[field]) {
      throw new Error(`v0.28.3 recovery compatibility ProductArtifact mismatch: ${field}`);
    }
  }
  if (!["failed", "recoverable"].includes(current.state) || current.publicVerify != null || current.runtimeAcceptanceSpec != null || !current.failure) {
    throw new Error("v0.28.3 recovery compatibility requires the persisted failed/recoverable/null-spec incident");
  }
  const incidentFailure = (current.failureHistory || []).find((failure) => failure?.phase === "verified" && failure?.code === "SITE_PUBLICATION_TRANSPORT" && failure?.lastEvidence) || current.failure;
  if (incidentFailure.phase !== "verified" || incidentFailure.code !== "SITE_PUBLICATION_TRANSPORT" || !incidentFailure.lastEvidence) {
    throw new Error("v0.28.3 recovery compatibility requires the persisted post-transport failure evidence");
  }
  const evidenceIdentity = incidentFailure.lastEvidence.publicationIdentity || {};
  for (const field of ["sitePublicationId", "snapshotHash", "productArtifactId", "productArtifactHash", "contentManifestHash", "approvalHash", "candidateHash", "approvedTreeOid", "version", "commit"]) {
    const expected = field === "commit" ? V0283_RUNTIME_INCIDENT.productCommit : field === "version" ? V0283_RUNTIME_INCIDENT.version : V0283_RUNTIME_INCIDENT[field];
    if (evidenceIdentity[field] !== expected) throw new Error(`v0.28.3 recovery compatibility failure evidence mismatch: ${field}`);
  }
  if (!run || run.publicationRunId !== V0283_RUNTIME_INCIDENT.publicationRunId || !["failed", "recoverable"].includes(run.state) || run.publicVerify != null || run.deploymentId !== V0283_RUNTIME_INCIDENT.deploymentId || run.deploymentCount !== 1 || run.runtimeAcceptanceSpec != null) {
    throw new Error("v0.28.3 recovery compatibility requires the persisted failed PublicationRun with one deployment");
  }
  if (!deployment || deployment.status !== "success" || deployment.deploymentId !== V0283_RUNTIME_INCIDENT.deploymentId || deployment.projectId !== edgeoneProjectId) {
    throw new Error("v0.28.3 recovery compatibility requires the exact successful fixed-target deployment");
  }
}

async function deriveV0283IncidentRuntimeAcceptanceSpec({ current, run, deployment, directory, sourceRoot } = {}) {
  assertExactV0283IncidentIdentity(current, run, deployment);
  const persistedManifest = await readJson(path.join(directory, "content-manifest.json"));
  if (!current.contentManifest || canonicalJson(persistedManifest) !== canonicalJson(current.contentManifest)) {
    throw new Error("v0.28.3 recovery compatibility contentManifest bytes drift");
  }
  for (const field of ["version", "commit", "baseSiteArtifactId", "productArtifactId", "productArtifactHash", "contentManifestHash", "contentSetId", "contentSetHash", "sitePublicationId", "siteSnapshotId", "snapshotHash", "contentDataArtifactId", "contentDataHash", "activeTupleHash"]) {
    const expected = field === "commit" ? V0283_RUNTIME_INCIDENT.productCommit : field === "version" ? V0283_RUNTIME_INCIDENT.version : V0283_RUNTIME_INCIDENT[field];
    if (persistedManifest[field] !== expected) throw new Error(`v0.28.3 recovery compatibility contentManifest mismatch: ${field}`);
  }
  let activeTuple = null;
  try {
    activeTuple = await readActiveContentDataTuple({ sourceRoot });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (activeTuple) throw new Error("v0.28.3 recovery compatibility requires the active ContentData tuple to be absent");
  const runtimeAcceptanceSpec = deriveRuntimeAcceptanceSpec({
    sitePublicationId: current.sitePublicationId,
    snapshotHash: current.snapshotHash,
    activeTupleHash: current.activeTupleHash,
    contentManifest: persistedManifest,
  });
  assertRuntimeAcceptanceSpec(runtimeAcceptanceSpec, {
    sitePublicationId: current.sitePublicationId,
    snapshotHash: current.snapshotHash,
    activeTupleHash: current.activeTupleHash,
    contentManifest: persistedManifest,
  });
  return runtimeAcceptanceSpec;
}

async function finalizeDataPlanePublication({ current, publicationDirectory, publicVerify, sourceRoot, failAfterActivate = null }) {
  if (publicVerify.contentSetId !== current.contentSetId
    || publicVerify.contentSetHash !== current.contentSetHash
    || publicVerify.siteSnapshotId !== current.siteSnapshotId
    || publicVerify.snapshotHash !== current.snapshotHash
    || publicVerify.baseSiteArtifactId !== (current.baseSiteArtifactId || current.productArtifactId)
    || (current.productArtifactHash && publicVerify.productArtifactHash !== current.productArtifactHash)
    || publicVerify.contentDataArtifactId !== current.contentDataArtifactId
    || publicVerify.contentDataHash !== current.contentDataHash
    || publicVerify.activeTupleHash !== current.activeTupleHash) {
    throw new Error("ContentData SitePublication public evidence identity mismatch");
  }
  if (!current.activeTuple) throw new Error("ContentData SitePublication active tuple reference is missing");
  assertActiveContentDataTuple(current.activeTuple);
  const snapshot = current.siteSnapshot || null;
  if (snapshot) assertSiteSnapshotDataPlane(snapshot, {
    productArtifactId: current.productArtifactId,
    tupleHash: current.activeTupleHash,
    contentDataArtifactId: current.contentDataArtifactId,
    contentDataHash: current.contentDataHash,
  });
  let run = await readPublicationRun({ sourceRoot, publicationRunId: current.publicationRunId });
  if (run.siteSnapshotId !== current.siteSnapshotId || run.snapshotHash !== current.snapshotHash || run.contentSetId !== current.contentSetId || run.contentDataArtifactId !== current.contentDataArtifactId || run.contentDataHash !== current.contentDataHash || run.activeTupleHash !== current.activeTupleHash) {
    throw new Error("PublicationRun ContentData identity drift during finalize");
  }
  const runtimeAcceptanceSpec = readOrDeriveRuntimeAcceptanceSpec(current, { allowDerived: false });
  assertRuntimeAcceptanceSpec(runtimeAcceptanceSpec, current);
  if (!run.runtimeAcceptanceSpec
    || run.runtimeAcceptanceSpecHash !== runtimeAcceptanceSpec.specHash
    || canonicalJson(run.runtimeAcceptanceSpec) !== canonicalJson(runtimeAcceptanceSpec)
    || publicVerify.runtimeAcceptanceSpecHash !== runtimeAcceptanceSpec.specHash) {
    throw new Error("PublicationRun RuntimeAcceptanceSpec identity drift during finalize");
  }
  const authorityMutation = current.contentAuthorityMutation === true || Boolean(current.contentPublicationIntentId);
  let previous = null;
  try { previous = await readActiveContentDataTuple({ sourceRoot }); } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!authorityMutation) {
    // Product publication composes the current ProductArtifact with the
    // already-active ContentAuthority. It is forbidden to rewrite the active
    // pointer, even when the persisted tuple is a legacy v1 adapter.
    if (!previous || previous.tupleHash !== current.activeTupleHash) {
      const error = new Error("Product SitePublication must preserve the active ContentAuthority");
      error.code = "CONTENT_AUTHORITY_PRODUCT_WRITE_FORBIDDEN";
      throw error;
    }
    const releasedRun = run.state === "released" ? run : markPublicationReleased(run, publicVerify);
    await writePublicationRun({ sourceRoot, run: releasedRun });
    return writePublicationRecord(publicationDirectory, {
      ...current,
      publicationRun: releasedRun,
      state: "released",
      publicVerify,
      releasedAt: current.releasedAt || new Date().toISOString(),
      failure: null,
      failureHistory: current.failure ? [...(current.failureHistory || []), { ...current.failure, preservedAt: new Date().toISOString(), recoveryAttemptId: publicVerify.attemptId || null }] : (current.failureHistory || []),
    });
  }
  const expectedPrevious = current.expectedPreviousTupleHash ?? null;
  if ((previous?.tupleHash || null) !== expectedPrevious && previous?.tupleHash !== current.activeTupleHash) {
    const error = new Error("ContentData active tuple CAS conflict during finalize");
    error.code = "CONTENT_DATA_ACTIVE_CAS";
    throw error;
  }
  let activated = false;
  const previousFailure = current.failure || null;
  try {
    if (previous?.tupleHash === current.activeTupleHash) {
      // Idempotent finalize: the same tuple is already authoritative.
    } else {
      await activateContentDataTuple({ sourceRoot, tuple: current.activeTuple, expectedTupleHash: expectedPrevious });
      activated = true;
    }
    if (failAfterActivate === "crash") throw new Error("injected finalize crash after active tuple activation");
    const releasedRun = run.state === "released" ? run : markPublicationReleased(run, publicVerify);
    await writePublicationRun({ sourceRoot, run: releasedRun });
    const failureHistory = previousFailure
      ? [...(current.failureHistory || []), { ...previousFailure, preservedAt: new Date().toISOString(), recoveryAttemptId: publicVerify.attemptId || null }]
      : (current.failureHistory || []);
    return await writePublicationRecord(publicationDirectory, {
      ...current,
      publicationRun: releasedRun,
      state: "released",
      publicVerify,
      releasedAt: current.releasedAt || new Date().toISOString(),
      failure: null,
      failureHistory,
    });
  } catch (error) {
    if (activated) {
      const activePath = contentDataPaths(sourceRoot).activePath;
      if (previous) await activateContentDataTuple({ sourceRoot, tuple: previous, expectedTupleHash: current.activeTupleHash }).catch(() => {});
      else await unlink(activePath).catch(() => {});
    }
    throw error;
  }
}

export async function finalizeSitePublication({ publicationDirectory, publicVerify, sourceRoot = null, failAfterActivate = null } = {}) {
  let current = await readSitePublicationRecord(publicationDirectory);
  if (!current.deploymentId || !publicVerify) throw new Error("SitePublication finalize requires deploymentId and publicVerify");
  if (publicVerify.sitePublicationId !== current.sitePublicationId || publicVerify.snapshotHash !== current.snapshotHash) {
    throw new Error("SitePublication finalize evidence identity mismatch");
  }
  const requiresV4Evidence = Boolean(current.assetManifest || current.productVersion === "v0.26.19" || publicVerify.verificationEvidence);
  if (requiresV4Evidence) {
    if (!publicVerify.verificationEvidence) throw new Error("SitePublication finalize requires publication-runtime-evidence-v4 aggregate");
    assertPublicationPhaseAggregate(publicVerify.verificationEvidence, {
      expectedIdentity: sitePublicationIdentity(current),
      expectedAttemptId: publicVerify.verificationEvidence.attemptId,
    });
  }
  const resolvedSourceRoot = sourceRoot || path.resolve(publicationDirectory, "..", "..", "..");
  if (isDataPlanePublication(current)) {
    return finalizeDataPlanePublication({ current, publicationDirectory, publicVerify, sourceRoot: resolvedSourceRoot, failAfterActivate });
  }
  if (isContentSetPublication(current)) {
    return finalizeContentSetPublication({ current, publicationDirectory, publicVerify, sourceRoot: resolvedSourceRoot });
  }
  const expectedReceipts = current.contentManifest?.contentReleaseReceipts || [];
  const actualReceipts = publicVerify.contentManifest?.contentReleaseReceipts || [];
  for (const expected of expectedReceipts) {
    const actual = actualReceipts.find((item) => item.contentReleaseId === expected.contentReleaseId);
    if (actual) assertContentLifecycleProjection(actual, expected, expected.contentReleaseId);
  }
  const expectedProjections = current.contentManifest?.activeContentProjections || [];
  const actualProjections = publicVerify.contentManifest?.activeContentProjections || [];
  if (expectedProjections.length) {
    if (actualProjections.length !== expectedProjections.length) throw new Error("SitePublication finalize active projection set is incomplete");
    for (const expected of expectedProjections) {
      const actual = actualProjections.find((item) => item.contentReleaseId === expected.contentReleaseId);
      if (!actual || actual.projectionHash !== expected.projectionHash || actual.receiptHash !== expected.receiptHash) {
        throw new Error(`SitePublication finalize active projection identity mismatch: ${expected.contentReleaseId}`);
      }
      assertActiveContentProjection(actual);
    }
  }
  const expected = [...(current.contentReleaseIds || [])].sort();
  const actual = [...(publicVerify.activeContentReleaseIds || [])].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("SitePublication finalize evidence is incomplete");
  let lineageBinding = current.lineageBinding ? validatePublicationLineageBinding(current.lineageBinding, {
    sitePublicationId: current.sitePublicationId,
  }) : null;
  if (current.lineageBindingId) {
    const persistedBinding = await readPublicationLineageBinding({
      sourceRoot: resolvedSourceRoot,
      lineageBindingId: current.lineageBindingId,
      expected: { sitePublicationId: current.sitePublicationId },
    });
    if (lineageBinding && persistedBinding.bindingHash !== lineageBinding.bindingHash) {
      throw new Error("SitePublication lineage binding sidecar drift");
    }
    lineageBinding = persistedBinding;
  }
  let contentSlotTransition = current.contentSlotTransition || null;
  if (current.candidateContentReleaseId && !contentSlotTransition) {
    const candidate = actualReceipts.find((item) => item.contentReleaseId === current.candidateContentReleaseId
      && (current.candidatePackageRevisionId == null || item.packageRevisionId === current.candidatePackageRevisionId));
    if (!candidate) throw new Error("SitePublication finalize candidate receipt projection is missing");
    const logicalContentId = contentLogicalContentId(candidate);
    if (!logicalContentId) throw new Error("SitePublication finalize candidate logicalContentId is missing");
    const registry = await ensureContentSlotRegistry({ sourceRoot: resolvedSourceRoot });
    if (!lineageBinding && current.lineageBindingId) {
      lineageBinding = await readPublicationLineageBinding({
        sourceRoot: resolvedSourceRoot,
        lineageBindingId: current.lineageBindingId,
        expected: { sitePublicationId: current.sitePublicationId },
      });
    }
    if (!lineageBinding) {
      if (!candidate.packageRevisionId) throw new Error("SitePublication finalize candidate packageRevisionId is missing for lineage binding");
      const created = await createOrReusePublicationLineageBinding({
        sourceRoot: resolvedSourceRoot,
        sitePublicationId: current.sitePublicationId,
        candidate,
        registry,
        expectedRegistryRevision: current.contentSlotRegistryRevision ?? registry.registryRevision,
      });
      lineageBinding = publicationLineageBindingProjection(created);
      current = await writePublicationRecord(publicationDirectory, {
        ...current,
        lineageBindingId: lineageBinding.lineageBindingId,
        lineageBinding,
        contentReplacement: {
          ...(current.contentReplacement || {}),
          lineageBindingId: lineageBinding.lineageBindingId,
          bindingHash: lineageBinding.bindingHash,
          predecessorReceiptId: lineageBinding.predecessorReceiptId,
          predecessorPackageSlotId: lineageBinding.predecessorPackageId,
          supersedesPackageId: lineageBinding.predecessorPackageId,
        },
      });
    } else {
      assertBindingCandidate(lineageBinding, candidate);
    }
    await assertPublicationLineageBindingAgainstRegistry({ sourceRoot: resolvedSourceRoot, binding: lineageBinding, candidate });
    const candidateReceiptId = contentReceiptId(candidate);
    const existingSlot = registry.slots.find((slot) => slot.logicalContentId === logicalContentId);
    if (existingSlot?.activeReceiptId === candidateReceiptId) {
      if (existingSlot.predecessorReceiptId !== lineageBinding.predecessorReceiptId) {
        throw new Error("SitePublication finalize active candidate lineage binding drift");
      }
      contentSlotTransition = { type: "idempotent", logicalContentId, predecessorReceiptId: lineageBinding.predecessorReceiptId, activeReceiptId: existingSlot.activeReceiptId, registryRevision: registry.registryRevision, lineageBindingId: lineageBinding.lineageBindingId, bindingHash: lineageBinding.bindingHash };
    } else {
      const candidatePackageDirectory = current.candidatePackageDirectory
        ? path.resolve(resolvedSourceRoot, current.candidatePackageDirectory)
        : null;
      const transition = await compareAndSwapContentSlot({
        sourceRoot: resolvedSourceRoot,
        logicalContentId,
        expectedReceiptId: lineageBinding.predecessorReceiptId,
        expectedRegistryRevision: lineageBinding.registryRevision,
        candidate: {
          ...candidate,
          logicalContentId,
          predecessorReceiptId: lineageBinding.predecessorReceiptId,
        },
        transition: { activePackageDirectory: candidatePackageDirectory ? path.relative(resolvedSourceRoot, candidatePackageDirectory) : null },
      });
      contentSlotTransition = {
        type: "compare-and-swap",
        logicalContentId,
        predecessorReceiptId: transition.previousSlot?.activeReceiptId || null,
        activeReceiptId: transition.nextSlot.activeReceiptId,
        registryRevision: transition.registry.registryRevision,
        lineageBindingId: lineageBinding.lineageBindingId,
        bindingHash: lineageBinding.bindingHash,
        previousSlot: transition.previousSlot,
        nextSlot: transition.nextSlot,
      };
    }
  }
  try {
  return await writePublicationRecord(publicationDirectory, {
      ...current,
      contentSlotTransition,
      lineageBindingId: lineageBinding?.lineageBindingId || current.lineageBindingId || null,
      lineageBinding: lineageBinding || current.lineageBinding || null,
      contentSlotRegistryRevision: contentSlotTransition?.registryRevision || current.contentSlotRegistryRevision || null,
      state: "released",
      publicVerify,
      releasedAt: current.releasedAt || new Date().toISOString(),
      failure: null,
    });
  } catch (error) {
    // Registry CAS and publication state are separate durable files. If the
    // publication record cannot be committed after a fresh CAS, compensate
    // only that exact transition; never leave an active slot ahead of its
    // finalized SitePublication.
    if (contentSlotTransition?.type === "compare-and-swap" && contentSlotTransition.previousSlot) {
      await restoreContentSlot({
        sourceRoot: sourceRoot || path.resolve(publicationDirectory, "..", "..", ".."),
        logicalContentId: contentSlotTransition.logicalContentId,
        expectedReceiptId: contentSlotTransition.activeReceiptId,
        previousSlot: contentSlotTransition.previousSlot,
      }).catch(() => {});
    }
    throw error;
  }
}

export async function rollbackSitePublication({ publicationDirectory, reason = "explicit rollback" } = {}) {
  const current = await readSitePublicationRecord(publicationDirectory);
  const sourceRoot = path.resolve(publicationDirectory, "..", "..", "..");
  if (isDataPlanePublication(current)) {
    const run = await readPublicationRun({ sourceRoot, publicationRunId: current.publicationRunId });
    const rolledRun = markPublicationRolledBack(run, { reason, at: new Date().toISOString(), restoredContentDataArtifactId: current.contentDataArtifactId });
    await writePublicationRun({ sourceRoot, run: rolledRun });
    return writePublicationRecord(publicationDirectory, {
      ...current,
      publicationRun: rolledRun,
      state: "rolled-back",
      failure: { message: reason, at: new Date().toISOString() },
    });
  }
  if (isContentSetPublication(current)) {
    const active = await readActiveContentSet({ sourceRoot });
    if (active.contentSet.contentSetId !== current.contentSetId) {
      throw new Error("ContentSet rollback active identity does not match SiteSnapshot");
    }
    const previousContentSetId = current.contentManifest?.previousContentSetId || null;
    if (!previousContentSetId) throw new Error("ContentSet rollback has no previous active snapshot");
    await activateContentSet({ sourceRoot, nextContentSetId: previousContentSetId, expectedContentSetId: current.contentSetId });
    const run = await readPublicationRun({ sourceRoot, publicationRunId: current.publicationRunId });
    const rolledRun = markPublicationRolledBack(run, { reason, at: new Date().toISOString(), restoredContentSetId: previousContentSetId });
    await writePublicationRun({ sourceRoot, run: rolledRun });
    return writePublicationRecord(publicationDirectory, {
      ...current,
      publicationRun: rolledRun,
      state: "rolled-back",
      failure: { message: reason, at: new Date().toISOString() },
    });
  }
  return writePublicationRecord(publicationDirectory, { ...current, state: "rolled-back", failure: { message: reason, at: new Date().toISOString() } });
}

async function writePublicationRecord(publicationDirectory, value) {
  const durable = assertDurableSitePublicationRecord(sanitizeDurableSitePublicationRecord(value));
  await writeJsonAtomically(path.join(publicationDirectory, "site-publication.json"), durable);
  const readback = await readJson(path.join(publicationDirectory, "site-publication.json"));
  assertDurableSitePublicationRecord(readback);
  return value;
}

const PUBLICATION_STATES = new Set(["assembled", "deploying", "propagating", "verifying", "released", "recoverable", "failed", "rolled-back"]);

function assertRecoverableFailure(failure) {
  if (!failure || typeof failure !== "object" || typeof failure.code !== "string" || typeof failure.phase !== "string" || !("lastEvidence" in failure)) {
    throw new Error("recoverable SitePublication transition requires failure.code, failure.phase and failure.lastEvidence");
  }
}

/**
 * The only top-level SitePublication state writer. Evidence and propagation
 * callbacks call this reducer without a state, so they can append facts but
 * cannot turn a recoverable publication back into propagating.
 */
export async function transitionSitePublication({ publicationDirectory, current = null, expectedRevision = null, state, phase, patch = {}, failure = undefined } = {}) {
  const before = current || await readSitePublicationRecord(publicationDirectory);
  if (expectedRevision != null && (before.stateRevision || 0) !== expectedRevision) {
    const error = new Error("SitePublication state revision CAS failed");
    error.code = "SITE_PUBLICATION_STATE_CAS";
    throw error;
  }
  const nextState = state || before.state || "assembled";
  if (!PUBLICATION_STATES.has(nextState)) throw new Error(`unknown SitePublication state: ${nextState}`);
  const nextFailure = failure === undefined ? (patch.failure === undefined ? before.failure || null : patch.failure) : failure;
  if (nextFailure && nextState === "propagating") throw new Error("SitePublication cannot be propagating while failure exists");
  if (nextState === "recoverable") assertRecoverableFailure(nextFailure);
  const next = {
    ...before,
    ...patch,
    state: nextState,
    ...(phase ? { phase } : {}),
    failure: nextFailure,
    stateRevision: (before.stateRevision || 0) + 1,
    updatedAt: new Date().toISOString(),
  };
  if (next.failure && next.state === "propagating") throw new Error("SitePublication cannot be propagating while failure exists");
  if (next.state === "recoverable") assertRecoverableFailure(next.failure);
  return writePublicationRecord(publicationDirectory, next);
}

async function fetchJson(url, fetchImpl, signal = null) {
  const response = await fetchImpl(url, { redirect: "follow", cache: "no-store", ...(signal ? { signal } : {}) });
  if (!response.ok) {
    const error = new Error(`public verify ${url} returned HTTP ${response.status}`);
    error.recoverable = response.status >= 500 || response.status === 404;
    error.propagation = error.recoverable;
    error.observedIdentity = { url: String(url), status: response.status };
    throw error;
  }
  try {
    return await response.json();
  } catch (cause) {
    const error = new Error(`public verify ${url} returned an invalid JSON manifest`);
    error.cause = cause;
    error.code = "SITE_PUBLICATION_MANIFEST_PROPAGATION";
    error.recoverable = true;
    error.propagation = true;
    error.observedIdentity = { url: String(url), invalidJson: true };
    throw error;
  }
}

async function loadPublicationAssetManifest(publication) {
  if (publication.assetManifest) return publication.assetManifest;
  if (!publication.client) return null;
  const manifest = await readPublicationAssetManifest(publication.client).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!manifest && await stat(path.join(publication.client, "index.html")).catch(() => null)) {
    throw new Error("SitePublication asset manifest is required for a client upload root");
  }
  return manifest;
}

function assertIndexIdentity(indexHtml, assetManifest) {
  if (!assetManifest?.index) return;
  const bytes = Buffer.byteLength(indexHtml);
  const hash = createHash("sha256").update(indexHtml).digest("hex");
  if (bytes !== assetManifest.index.bytes || hash !== assetManifest.index.sha256) {
    const error = new Error("public index.html integrity mismatch");
    error.code = "SITE_PUBLICATION_ASSET_VERIFY";
    error.recoverable = true;
    error.propagation = true;
    error.observedIdentity = { indexBytes: bytes, indexSha256: hash };
    throw error;
  }
}

function assertExactArray(actual, expected, field) {
  if (!Array.isArray(actual)) throw new Error(`public content manifest ${field} is missing`);
  const actualValues = [...new Set(actual)].sort();
  const expectedValues = [...new Set(expected || [])].sort();
  if (JSON.stringify(actualValues) !== JSON.stringify(expectedValues)) {
    throw new Error(`public content manifest ${field} does not match SitePublication`);
  }
  return actualValues;
}

function phaseEnvelope(publication, attemptId, phase, extra = {}) {
  return createPublicationPhaseEvidence({
    publicationIdentity: sitePublicationIdentity(publication),
    attemptId,
    phase,
    ...(phase === "verifying-assets" ? { assets: {} } : {}),
    ...extra,
  });
}

/**
 * Recover a previously transported data-plane SitePublication without
 * materializing, transporting, or creating another deployment.  The existing
 * durable publication, PublicationRun and deployment are the only authorities;
 * this function appends a verification attempt and then delegates the one
 * active-tuple mutation to finalizeSitePublication.
 */
export async function recoverExistingSitePublication({
  publicationDirectory,
  sourceRoot = null,
  baseUrl = publicUrl,
  fetchImpl = fetch,
  browserRuntimeVerify = verifyPublicBrowserRuntime,
  maxAttempts = 1,
  initialDelayMs = 0,
  maxDelayMs = 0,
  sleepImpl = async () => {},
  onEvidence = null,
  signal = null,
  argv = [],
  env = process.env,
} = {}) {
  if (!publicationDirectory) throw new Error("existing SitePublication recovery requires publicationDirectory");
  assertFixedPublishTarget(env);
  assertPublishAuthorization({ argv, env });
  const directory = path.resolve(publicationDirectory);
  const resolvedSourceRoot = sourceRoot || path.resolve(directory, "..", "..", "..");
  let current = await readSitePublicationRecord(directory);
  if (!isDataPlanePublication(current)) throw new Error("existing SitePublication recovery requires a canonical ContentData SitePublication");
  if (!current.deploymentId) throw new Error("existing SitePublication recovery requires an existing deployment");
  const finalizedRecovery = current.state === "released" && current.publicVerify && current.recovery?.result === "finalized";
  if (!finalizedRecovery && (!['recoverable', 'failed'].includes(current.state) || !current.failure || current.publicVerify)) {
    throw new Error("existing SitePublication recovery requires a failed or recoverable post-transport verifier failure");
  }
  await readFixedEdgeoneTarget(resolvedSourceRoot);
  const deployment = current.deployment || await readJson(path.join(directory, "deployment.json"));
  if (!deployment || deployment.deploymentId !== current.deploymentId || deployment.projectId !== edgeoneProjectId || deployment.status !== "success") {
    throw new Error("existing SitePublication recovery requires the exact successful fixed-target deployment");
  }
  const run = await readPublicationRun({ sourceRoot: resolvedSourceRoot, publicationRunId: current.publicationRunId });
  if (run.deploymentId !== current.deploymentId || run.deploymentCount !== 1 || run.deployment?.deploymentId !== current.deploymentId || run.deployment?.projectId !== edgeoneProjectId) {
    throw new Error("existing SitePublication recovery deployment identity/count drift");
  }
  if (!finalizedRecovery && (!['recoverable', 'failed'].includes(run.state) || run.publicVerify)) {
    throw new Error("existing SitePublication recovery requires a failed or recoverable PublicationRun without public verification");
  }
  if (finalizedRecovery) {
    if (run.state !== "released" || !run.publicVerify || run.recovery?.result !== "finalized") throw new Error("finalized SitePublication recovery state drift");
    if (!current.runtimeAcceptanceSpec || !run.runtimeAcceptanceSpec
      || current.runtimeAcceptanceSpecHash !== current.runtimeAcceptanceSpec.specHash
      || run.runtimeAcceptanceSpecHash !== current.runtimeAcceptanceSpecHash
      || canonicalJson(run.runtimeAcceptanceSpec) !== canonicalJson(current.runtimeAcceptanceSpec)) {
      throw new Error("finalized SitePublication recovery RuntimeAcceptanceSpec drift");
    }
    assertRuntimeAcceptanceSpec(current.runtimeAcceptanceSpec, current);
    let activeTuple = null;
    try { activeTuple = await readActiveContentDataTuple({ sourceRoot: resolvedSourceRoot }); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (activeTuple?.tupleHash !== current.activeTupleHash) throw new Error("finalized SitePublication recovery active tuple drift");
    return current;
  }
  let runtimeAcceptanceSpec;
  let runtimeAcceptanceSpecSource = "persisted-publication";
  if (current.runtimeAcceptanceSpec) {
    runtimeAcceptanceSpec = readOrDeriveRuntimeAcceptanceSpec(current, { allowDerived: false });
  } else {
    runtimeAcceptanceSpec = await deriveV0283IncidentRuntimeAcceptanceSpec({
      current,
      run,
      deployment,
      directory,
      sourceRoot: resolvedSourceRoot,
    });
    runtimeAcceptanceSpecSource = "v0.28.3-approved-content-manifest";
  }
  assertRuntimeAcceptanceSpec(runtimeAcceptanceSpec, {
    ...current,
    runtimeAcceptanceSpec,
  });
  if (run.runtimeAcceptanceSpec) {
    if (run.runtimeAcceptanceSpecHash !== runtimeAcceptanceSpec.specHash
      || canonicalJson(run.runtimeAcceptanceSpec) !== canonicalJson(runtimeAcceptanceSpec)) {
      throw new Error("existing SitePublication recovery PublicationRun RuntimeAcceptanceSpec drift");
    }
  } else if (current.runtimeAcceptanceSpec) {
    throw new Error("existing SitePublication recovery PublicationRun RuntimeAcceptanceSpec is missing");
  }
  if (current.runtimeAcceptanceSpec) {
    let activeTuple = null;
    try {
      activeTuple = await readActiveContentDataTuple({ sourceRoot: resolvedSourceRoot });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (activeTuple) throw new Error("existing SitePublication recovery requires the active ContentData tuple to be absent");
  }
  const leaseDirectory = path.join(resolvedSourceRoot, ".content-workspace", "site-publications", ".site-lease");
  const lease = await acquireSitePublicationLease({
    publicationDirectory: directory,
    leaseDirectory,
    sitePublicationId: current.sitePublicationId,
    snapshotHash: current.snapshotHash,
    ttlMs: 900000,
  });
  const attemptId = `recovery-${Date.now()}-${current.deploymentId}`;
  const startedAt = new Date().toISOString();
  const priorFailure = current.failure || null;
  const initialAttempt = {
    attemptId,
    kind: "same-deployment-recovery",
    startedAt,
    deploymentId: current.deploymentId,
    deploymentCount: run.deploymentCount,
    runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
    runtimeAcceptanceSpec,
    runtimeAcceptanceSpecSource,
    transportCalls: 0,
    result: "running",
  };
  const appendAttempt = (attempts, next) => [...(attempts || []).filter((item) => item.attemptId !== next.attemptId), next];
  const priorHistory = priorFailure
    ? [...(current.failureHistory || []), { ...priorFailure, preservedAt: startedAt, recoveryAttemptId: attemptId }]
    : (current.failureHistory || []);
  let recoveryRun = run;
  try {
    current = await transitionSitePublication({
      publicationDirectory: directory,
      current,
      state: "verifying",
      phase: "verifying-assets",
      failure: null,
      patch: {
        runtimeAcceptanceSpec,
        runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
        runtimeAcceptanceSpecSource,
        verificationAttemptId: attemptId,
        failureHistory: priorHistory,
        recovery: {
          type: "same-deployment",
          deploymentId: current.deploymentId,
          deploymentCount: run.deploymentCount,
          transportCalls: 0,
        startedAt,
        priorFailure,
        runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
        runtimeAcceptanceSpec,
        runtimeAcceptanceSpecSource,
        result: "running",
        },
        verificationAttempts: [...(current.verificationAttempts || []), initialAttempt],
      },
    });
    recoveryRun = await writePublicationRun({
      sourceRoot: resolvedSourceRoot,
      run: {
        ...run,
        state: "verifying",
        publicVerify: null,
        runtimeAcceptanceSpec,
        runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
        runtimeAcceptanceSpecSource,
        recovery: {
          type: "same-deployment",
          deploymentId: current.deploymentId,
          deploymentCount: run.deploymentCount,
          transportCalls: 0,
          startedAt,
          priorFailure,
          runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
          runtimeAcceptanceSpec,
          runtimeAcceptanceSpecSource,
          result: "running",
        },
        recoveryAttempts: appendAttempt(run.recoveryAttempts, initialAttempt),
        updatedAt: new Date().toISOString(),
      },
    }).then(({ run: written }) => written);
    const publicVerify = await waitForPublicSitePublication({
      publication: { ...current, client: directory, deployment, runtimeAcceptanceSpec },
      baseUrl,
      fetchImpl,
      browserRuntimeVerify,
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      sleepImpl,
      attemptId,
      signal,
      allowDerivedRuntimeAcceptanceSpec: false,
      onEvidence: async ({ phase, result }) => {
        current = await transitionSitePublication({
          publicationDirectory: directory,
          current,
          phase,
          patch: { verificationAttemptId: attemptId, runtimeEvidence: result, lastEvidence: result },
        });
        await onEvidence?.({ phase, result });
      },
    });
    const productVerify = { version: current.productVersion, commit: current.productCommit, verifiedAt: publicVerify.verifiedAt };
    const contentVerify = { activeContentReleaseIds: publicVerify.activeContentReleaseIds || [], snapshotHash: publicVerify.snapshotHash, contentManifest: publicVerify.contentManifest, verifiedAt: publicVerify.verifiedAt };
    assertSitePublicationEvidence({ deployment, publicVerify, productVerify, contentVerify });
    const completedAttempt = {
      ...initialAttempt,
      result: "verified",
      finishedAt: new Date().toISOString(),
      observed: {
        runtimeAcceptanceSpecHash: publicVerify.runtimeAcceptanceSpecHash || runtimeAcceptanceSpec.specHash,
        deploymentId: current.deploymentId,
        deploymentCount: run.deploymentCount,
        transportCalls: 0,
      },
    };
    current = await transitionSitePublication({
      publicationDirectory: directory,
      current,
      patch: { verificationAttempts: appendAttempt(current.verificationAttempts, completedAttempt), recovery: { ...current.recovery, result: "verified", finishedAt: completedAttempt.finishedAt, transportCalls: 0 } },
    });
    recoveryRun = await writePublicationRun({
      sourceRoot: resolvedSourceRoot,
      run: {
        ...await readPublicationRun({ sourceRoot: resolvedSourceRoot, publicationRunId: current.publicationRunId }),
        state: "verifying",
        publicVerify,
        recovery: { ...recoveryRun.recovery, result: "verified", finishedAt: completedAttempt.finishedAt, transportCalls: 0 },
        recoveryAttempts: appendAttempt(recoveryRun.recoveryAttempts, completedAttempt),
        updatedAt: new Date().toISOString(),
      },
    }).then(({ run: written }) => written);
    const finalized = await finalizeSitePublication({ publicationDirectory: directory, publicVerify, sourceRoot: resolvedSourceRoot });
    const finishedAt = new Date().toISOString();
    const finalRecovery = { ...finalized.recovery, type: "same-deployment", deploymentId: current.deploymentId, deploymentCount: 1, transportCalls: 0, result: "finalized", finishedAt };
    const finalizedRun = await readPublicationRun({ sourceRoot: resolvedSourceRoot, publicationRunId: current.publicationRunId });
    await writePublicationRun({ sourceRoot: resolvedSourceRoot, run: { ...finalizedRun, recovery: finalRecovery, recoveryAttempts: appendAttempt(finalizedRun.recoveryAttempts, completedAttempt), updatedAt: finishedAt } });
    return writePublicationRecord(directory, { ...finalized, productVerify, contentVerify, recovery: finalRecovery });
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const failedAttempt = {
      ...initialAttempt,
      result: "recoverable",
      finishedAt,
      failure: { code: error.code || "SITE_PUBLICATION_RECOVERY", message: error.message },
    };
    const failureState = error.recoverable === false ? "failed" : "recoverable";
    const failure = { code: error.code || "SITE_PUBLICATION_RECOVERY", phase: error.phase || "verifying-app", message: error.message, at: finishedAt, lastEvidence: error.runtimeEvidence || error.lastEvidence || current.lastEvidence || null };
    const failureHistory = current.failureHistory?.length ? current.failureHistory : priorHistory;
    const currentRun = await readPublicationRun({ sourceRoot: resolvedSourceRoot, publicationRunId: current.publicationRunId }).catch(() => recoveryRun);
    await writePublicationRun({
      sourceRoot: resolvedSourceRoot,
      run: {
        ...currentRun,
        state: failureState,
        publicVerify: null,
        recovery: { ...(currentRun.recovery || recoveryRun.recovery || {}), result: failureState, finishedAt, transportCalls: 0, failure },
        recoveryAttempts: appendAttempt(currentRun.recoveryAttempts, failedAttempt),
        updatedAt: finishedAt,
      },
    });
    await transitionSitePublication({
      publicationDirectory: directory,
      current,
      state: failureState,
      phase: "recoverable",
      failure,
      patch: { failureHistory, recovery: { ...current.recovery, result: failureState, finishedAt, transportCalls: 0, failure }, verificationAttempts: appendAttempt(current.verificationAttempts, failedAttempt) },
    });
    throw error;
  } finally {
    await releaseSitePublicationLease(lease);
  }
}

function recoverablePhaseError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.recoverable = true;
  error.propagation = true;
  error.observedIdentity = details;
  return error;
}

function phaseFailureEnvelope(publication, attemptId, phase, error) {
  const lastEvidence = error.runtimeEvidence || error.details?.evidence || error.observedIdentity || {
    code: error.code || "SITE_PUBLICATION_PHASE_FAILED",
    message: error.message,
  };
  return createPublicationPhaseEvidence({
    publicationIdentity: sitePublicationIdentity(publication),
    attemptId,
    phase: "recoverable",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: "recoverable",
    verified: false,
    lastEvidence,
    failure: {
      code: error.code || "SITE_PUBLICATION_PHASE_FAILED",
      phase,
      message: error.message,
      lastEvidence,
    },
  });
}

async function recordPhaseFailure({ publication, attemptId, phase, error, onEvidence }) {
  if (error.runtimeEvidence?.schemaVersion === "publication-runtime-evidence-v4") {
    error.phase ||= phase;
    error.lastEvidence ||= error.runtimeEvidence;
    return error.runtimeEvidence;
  }
  const envelope = phaseFailureEnvelope(publication, attemptId, phase, error);
  error.recoverable = true;
  error.propagation = true;
  error.phase = phase;
  error.lastEvidence = envelope;
  error.runtimeEvidence = envelope;
  await onEvidence?.({ phase: "recoverable", result: envelope });
  return envelope;
}

async function verifyMediaPhase({ publication, base, indexHtml, assetManifest, mediaPaths, fetchImpl, signal, attemptId } = {}) {
  if (signal?.aborted) throw recoverablePhaseError("SITE_PUBLICATION_MEDIA_ABORTED", "public media verification was aborted", { phase: "verifying-media" });
  const required = [...new Set(mediaPaths || [])];
  const startedAt = new Date().toISOString();
  const identity = sitePublicationIdentity(publication);
  if (!required.length) return createPublicationPhaseEvidence({
    publicationIdentity: identity,
    attemptId,
    phase: "verifying-media",
    startedAt,
    finishedAt: new Date().toISOString(),
    media: {},
    result: "verified",
    verified: true,
    lastEvidence: { media: {} },
  });
  if (assetManifest?.assets) {
    const entries = new Map(assetManifest.assets.map((item) => [item.path, item]));
    const missing = required.filter((item) => !entries.has(item));
    if (missing.length) throw recoverablePhaseError("SITE_PUBLICATION_MEDIA_ASSET_UNMANIFESTED", `public media is absent from the asset manifest: ${missing.join(", ")}`, { phase: "verifying-media", missing });
    const verified = await verifyPublicPublicationAssets({
      baseUrl: base,
      indexHtml,
      assetManifest,
      fetchImpl,
      onlyKinds: ["media"],
      signal,
      publicationIdentity: identity,
      attemptId,
    });
    const media = {};
    for (const item of required) media[item] = { ...(verified.assets[item] || {}), browserProbe: "not-probed", verified: true };
    return createPublicationPhaseEvidence({
      publicationIdentity: identity,
      attemptId,
      phase: "verifying-media",
      startedAt,
      finishedAt: new Date().toISOString(),
      media,
      result: "verified",
      verified: true,
      lastEvidence: { media },
    });
  }
  const media = {};
  for (const mediaPath of required) {
    const response = await fetchImpl(new URL(mediaPath, base), { redirect: "follow", cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) throw recoverablePhaseError("SITE_PUBLICATION_MEDIA_HTTP", `public verify ${mediaPath} returned HTTP ${response.status}`, { phase: "verifying-media", mediaPath, status: response.status });
    const body = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    const bodyPrefix = Buffer.from(body).toString("utf8").trimStart().slice(0, 128).toLowerCase();
    if (/text\/html/i.test(contentType) || bodyPrefix.startsWith("<!doctype html") || bodyPrefix.startsWith("<html")) throw recoverablePhaseError("SITE_PUBLICATION_MEDIA_MIME", `public media ${mediaPath} returned HTML`, { phase: "verifying-media", mediaPath, contentType });
    media[mediaPath] = { status: response.status, contentType, bytes: body.byteLength, browserProbe: "not-probed", verified: true };
  }
  return createPublicationPhaseEvidence({
    publicationIdentity: identity,
    attemptId,
    phase: "verifying-media",
    startedAt,
    finishedAt: new Date().toISOString(),
    media,
    result: "verified",
    verified: true,
    lastEvidence: { media },
  });
}

async function verifyPublicationPhaseSet({ publication, base, indexHtml, assetManifest, routes, mediaPaths, fetchImpl, browserRuntimeVerify, runtimeAcceptanceSpec = null, onEvidence, signal, attemptId } = {}) {
  const identity = sitePublicationIdentity(publication);
  let assetsPhase;
  try {
    assetsPhase = await verifyPublicPublicationAssets({
      baseUrl: base,
      indexHtml,
      assetManifest,
      fetchImpl,
      onlyKinds: ["script", "style", "icon"],
      signal,
      publicationIdentity: identity,
      attemptId,
    });
  } catch (error) {
    await recordPhaseFailure({ publication, attemptId, phase: "verifying-assets", error, onEvidence });
    throw error;
  }
  if (!assetsPhase.skipped) await onEvidence?.({ phase: "verifying-assets", result: assetsPhase });
  let appPhase = null;
  if (runtimeAcceptanceSpec) assertRuntimeAcceptanceSpec(runtimeAcceptanceSpec, publication);
  if (browserRuntimeVerify) {
    try {
      appPhase = await browserRuntimeVerify({
        baseUrl: base,
        routes: [...routes],
        taskId: "site-publication-public-verify",
        publicationIdentity: identity,
        runtimeAcceptanceSpec,
        runtimeAcceptanceExpected: publication,
        attemptId,
        onEvidence,
        signal,
      });
    } catch (error) {
      await recordPhaseFailure({ publication, attemptId, phase: "verifying-app", error, onEvidence });
      throw error;
    }
  }
  let mediaPhase;
  try {
    mediaPhase = await verifyMediaPhase({ publication, base, indexHtml, assetManifest, mediaPaths, fetchImpl, signal, attemptId });
  } catch (error) {
    await recordPhaseFailure({ publication, attemptId, phase: "verifying-media", error, onEvidence });
    throw error;
  }
  await onEvidence?.({ phase: "verifying-media", result: mediaPhase });
  let verificationEvidence = null;
  if (!assetsPhase.skipped && appPhase) {
    const reducer = createPublicationEvidenceReducer({ publicationIdentity: identity, attemptId });
    reducer.add(assetsPhase);
    reducer.add(appPhase);
    reducer.add(mediaPhase);
    verificationEvidence = reducer.aggregate();
    await onEvidence?.({ phase: "verified", result: verificationEvidence });
  }
  return { assetsPhase, appPhase, mediaPhase, verificationEvidence };
}

async function verifyPublicContentDataPlane({ publication, base, fetchImpl, signal }) {
  const active = await fetchJson(new URL("/content-data/active.json", base), fetchImpl, signal);
  assertActiveContentDataTuple(active);
  if (active.tupleHash !== publication.activeTupleHash
    || active.contentSetId !== publication.contentSetId
    || active.contentSetHash !== publication.contentSetHash
    || active.contentDataArtifactId !== publication.contentDataArtifactId
    || active.contentDataHash !== publication.contentDataHash) {
    throw propagationError("public ContentData active tuple identity does not match SitePublication", {
      activeTupleHash: active.tupleHash || null,
      contentSetId: active.contentSetId || null,
      contentDataArtifactId: active.contentDataArtifactId || null,
      contentDataHash: active.contentDataHash || null,
      expectedActiveTupleHash: publication.activeTupleHash,
      expectedContentDataArtifactId: publication.contentDataArtifactId,
    });
  }
  const manifestUrl = `/content-data/${active.contentDataArtifactId}/content-data-manifest.json`;
  if (active.manifestUrl !== manifestUrl) throw new Error("public ContentData active tuple manifest URL is not immutable");
  const manifest = await fetchJson(new URL(manifestUrl, base), fetchImpl, signal);
  if (manifest.schemaVersion !== "content-data-manifest-v1"
    || manifest.contentDataArtifactId !== publication.contentDataArtifactId
    || manifest.contentDataHash !== publication.contentDataHash
    || manifest.activePointerHash !== publication.activeTupleHash
    || ((publication.contentAuthorityManifestHash || publication.contentManifest?.contentAuthorityManifestHash || publication.activeTuple?.contentAuthorityManifestHash || publication.activeTuple?.manifestHash)
      && manifest.manifestHash !== (publication.contentAuthorityManifestHash || publication.contentManifest?.contentAuthorityManifestHash || publication.activeTuple?.contentAuthorityManifestHash || publication.activeTuple?.manifestHash))
    || manifest.immutableDataUrl !== manifestUrl
    || !SHA256.test(manifest.manifestHash || "")) {
    throw new Error("public ContentData manifest identity is incomplete or drifted");
  }
  if (!Array.isArray(manifest.records) || manifest.records.length === 0) throw new Error("public ContentData manifest records are missing");
  const objects = [];
  const manifestBase = new URL(manifestUrl, base);
  const artifact = assertContentDataArtifact(await fetchJson(new URL("content-data-artifact.json", manifestBase), fetchImpl, signal));
  if (artifact.contentDataArtifactId !== publication.contentDataArtifactId
    || artifact.contentDataHash !== publication.contentDataHash
    || artifact.contentSetId !== publication.contentSetId
    || artifact.contentSetHash !== publication.contentSetHash) {
    throw new Error("public ContentData artifact identity is incomplete or drifted");
  }
  const artifactObjects = new Map(artifact.records.map((record) => [record.logicalContentId, record.objectHash]));
  if (artifactObjects.size !== manifest.records.length || manifest.records.some((record) => artifactObjects.get(record.logicalContentId) !== record.objectHash)) {
    throw new Error("public ContentData manifest/object projection is incomplete or drifted");
  }
  for (const record of manifest.records) {
    if (!record.logicalContentId || !SHA256.test(record.objectHash || "")) throw new Error("public ContentData manifest object identity is invalid");
    const object = await fetchJson(new URL(`objects/${record.objectHash}.json`, manifestBase), fetchImpl, signal);
    if (object.objectHash !== record.objectHash || !object.record || object.record.logicalContentId !== record.logicalContentId || contentDataObjectHash(object.record) !== record.objectHash) throw new Error(`public ContentData object identity mismatch: ${record.logicalContentId}`);
    objects.push({ logicalContentId: record.logicalContentId, objectHash: record.objectHash, verified: true });
  }
  return { active, artifact, manifest, objects, verified: true, manifestUrl };
}

export async function verifyPublicSitePublication({ publication, baseUrl = publicUrl, fetchImpl = fetch, browserRuntimeVerify = null, attemptId = null, onEvidence = null, signal = null, allowDerivedRuntimeAcceptanceSpec = false } = {}) {
  const resolvedAttemptId = attemptId || `attempt-${Date.now()}`;
  await onEvidence?.({ phase: "verifying-assets", result: phaseEnvelope(publication, resolvedAttemptId, "verifying-assets", { result: "running" }) });
  const base = new URL(baseUrl);
  const [release, contentManifest] = await Promise.all([
    fetchJson(new URL("/release.json", base), fetchImpl, signal),
    fetchJson(new URL("/content-manifest.json", base), fetchImpl, signal),
  ]);
  const expectedIdentity = sitePublicationIdentity(publication);
  const observedIdentity = {
    version: release.version || null,
    commit: release.commit || null,
    contentVersion: contentManifest.version || null,
    contentCommit: contentManifest.commit || null,
    sitePublicationId: contentManifest.sitePublicationId || null,
    snapshotHash: contentManifest.snapshotHash || null,
    baseSiteArtifactId: contentManifest.baseSiteArtifactId || null,
  };
  if (!release.version || !release.commit || !contentManifest.version || !contentManifest.commit
    || !contentManifest.sitePublicationId || !contentManifest.snapshotHash || !contentManifest.baseSiteArtifactId) {
    throw new Error("public release/content manifest identity fields are incomplete");
  }
  if (release.version !== publication.productVersion || release.commit !== publication.productCommit) {
    throw propagationError("public release identity does not match SitePublication", { ...observedIdentity, expected: expectedIdentity });
  }
  if (contentManifest.version !== publication.productVersion || contentManifest.commit !== publication.productCommit) {
    throw propagationError("public content manifest identity does not match SitePublication", { ...observedIdentity, expected: expectedIdentity });
  }
  if (contentManifest.sitePublicationId !== publication.sitePublicationId || contentManifest.snapshotHash !== publication.snapshotHash) {
    throw propagationError("public content manifest snapshot identity does not match SitePublication", { ...observedIdentity, expected: expectedIdentity });
  }
  if (contentManifest.baseSiteArtifactId !== publication.productArtifactId) {
    throw identityDriftError("public content manifest ProductArtifact identity does not match SitePublication", { ...observedIdentity, expected: expectedIdentity });
  }
  if (publication.productArtifactHash && contentManifest.productArtifactHash !== publication.productArtifactHash) {
    throw identityDriftError("public content manifest ProductArtifact hash does not match SitePublication", {
      ...observedIdentity,
      observedProductArtifactHash: contentManifest.productArtifactHash || null,
      expectedProductArtifactHash: publication.productArtifactHash,
    });
  }
  if (isDataPlanePublication(publication)) {
    const runtimeAcceptanceSpec = readOrDeriveRuntimeAcceptanceSpec(publication, { allowDerived: allowDerivedRuntimeAcceptanceSpec });
    assertRuntimeAcceptanceSpec(runtimeAcceptanceSpec, publication);
    if (release.productArtifactId !== publication.productArtifactId
      || release.baseSiteArtifactId !== publication.baseSiteArtifactId
      || release.productArtifactHash !== publication.productArtifactHash) {
      throw identityDriftError("public release ProductArtifact identity does not match SitePublication", {
        ...observedIdentity,
        observedProductArtifactId: release.productArtifactId || null,
        observedProductArtifactHash: release.productArtifactHash || null,
        expectedProductArtifactId: publication.productArtifactId,
        expectedProductArtifactHash: publication.productArtifactHash,
      });
    }
    const expectedAuthorityManifestHash = publication.contentAuthorityManifestHash || publication.contentManifest?.contentAuthorityManifestHash || null;
    if (contentManifest.contentSetId !== publication.contentSetId
      || contentManifest.contentSetHash !== publication.contentSetHash
      || contentManifest.siteSnapshotId !== publication.siteSnapshotId
      || contentManifest.contentDataArtifactId !== publication.contentDataArtifactId
      || contentManifest.contentDataHash !== publication.contentDataHash
      || contentManifest.activeTupleHash !== publication.activeTupleHash
      || (expectedAuthorityManifestHash && contentManifest.contentAuthorityManifestHash !== expectedAuthorityManifestHash)) {
      throw propagationError("public ContentData SiteSnapshot identity does not match SitePublication", {
        contentSetId: contentManifest.contentSetId || null,
        contentSetHash: contentManifest.contentSetHash || null,
        siteSnapshotId: contentManifest.siteSnapshotId || null,
        contentDataArtifactId: contentManifest.contentDataArtifactId || null,
      contentDataHash: contentManifest.contentDataHash || null,
      activeTupleHash: contentManifest.activeTupleHash || null,
      contentAuthorityManifestHash: contentManifest.contentAuthorityManifestHash || null,
      });
    }
    if (contentManifest.runtimeAcceptanceSpecHash
      && contentManifest.runtimeAcceptanceSpecHash !== runtimeAcceptanceSpec.specHash) {
      throw identityDriftError("public runtime acceptance specification identity does not match SitePublication", {
        expectedRuntimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
        observedRuntimeAcceptanceSpecHash: contentManifest.runtimeAcceptanceSpecHash,
      });
    }
    const dataProof = await verifyPublicContentDataPlane({ publication, base, fetchImpl, signal });
    const routes = new Set(["/", "/products", "/business-observations", "/observations", "/about"]);
    const pages = {};
    let indexHtml = null;
    for (const route of routes) {
      const response = await fetchImpl(new URL(route, base), { redirect: "follow", cache: "no-store", ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error(`public verify ${route} returned HTTP ${response.status}`);
      const text = await response.text();
      if (!/<title>xingbuild/i.test(text)) throw new Error(`public verify ${route} is not an xingbuild page`);
      if (route === "/") indexHtml = text;
      pages[route] = { status: response.status, verified: true };
    }
    const assetManifest = await loadPublicationAssetManifest(publication);
    assertIndexIdentity(indexHtml, assetManifest);
    const { assetsPhase, appPhase: browserRuntime, mediaPhase, verificationEvidence } = await verifyPublicationPhaseSet({
      publication,
      base,
      indexHtml,
      assetManifest,
      routes,
      mediaPaths: publication.contentManifest?.mediaPaths || [],
      fetchImpl,
      browserRuntimeVerify,
      runtimeAcceptanceSpec,
      onEvidence,
      signal,
      attemptId: resolvedAttemptId,
    });
    // A data-plane home value is rendered by the browser runtime, not
    // serialized into the SPA shell's index.html. Require the actual browser
    // evidence when available; only legacy/audit adapters may fall back to a
    // static shell assertion.
    const homeRuntime = browserRuntime?.routes?.["/"] || null;
    const expectedHome = runtimeAcceptanceSpec.routes[0].expectations[0];
    if (!homeRuntime || homeRuntime.shellReady !== true || homeRuntime.runtimeReady !== true
      || homeRuntime.runtimeObserved?.normalizedValue !== expectedHome.normalizedValue
      || homeRuntime.runtimeObserved?.valueHash !== expectedHome.valueHash) {
      const error = new Error("public home runtime did not converge to the approved RuntimeAcceptanceSpec");
      error.code = "PUBLICATION_RUNTIME_ACCEPTANCE_FAILED";
      error.recoverable = true;
      error.propagation = true;
      error.observedIdentity = {
        runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
        observedNormalizedValue: homeRuntime?.runtimeObserved?.normalizedValue || null,
        observedValueHash: homeRuntime?.runtimeObserved?.valueHash || null,
        runtimeReady: homeRuntime?.runtimeReady || false,
      };
      throw error;
    }
    return {
      sitePublicationId: publication.sitePublicationId,
      snapshotHash: publication.snapshotHash,
      siteSnapshotId: publication.siteSnapshotId,
      contentSetId: publication.contentSetId,
      contentSetHash: publication.contentSetHash,
      contentDataArtifactId: publication.contentDataArtifactId,
      contentDataHash: publication.contentDataHash,
      activeTupleHash: publication.activeTupleHash,
      contentAuthorityManifestHash: publication.contentAuthorityManifestHash || contentManifest.contentAuthorityManifestHash || null,
      attemptId: resolvedAttemptId,
      baseSiteArtifactId: contentManifest.baseSiteArtifactId,
      productArtifactId: contentManifest.productArtifactId || publication.productArtifactId,
      productArtifactHash: contentManifest.productArtifactHash || publication.productArtifactHash || null,
      version: publication.productVersion,
      commit: publication.productCommit,
      activeContentReleaseIds: [],
      release: { version: release.version, commit: release.commit, baseSiteArtifactId: release.baseSiteArtifactId || null },
      contentData: dataProof,
      contentManifest,
      runtimeAcceptanceSpec,
      runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash,
      pages,
      assets: assetsPhase,
      browserRuntime,
      media: mediaPhase.media,
      ...(verificationEvidence ? { verificationEvidence } : {}),
      verifiedAt: new Date().toISOString(),
    };
  }
  if (isContentSetPublication(publication)) {
    if (contentManifest.contentSetId !== publication.contentSetId
      || contentManifest.contentSetHash !== publication.contentSetHash
      || contentManifest.siteSnapshotId !== publication.siteSnapshotId
      || contentManifest.snapshotHash !== publication.snapshotHash) {
      throw propagationError("public ContentSet/SiteSnapshot identity does not match SitePublication", {
        ...observedIdentity,
        contentSetId: contentManifest.contentSetId || null,
        contentSetHash: contentManifest.contentSetHash || null,
        siteSnapshotId: contentManifest.siteSnapshotId || null,
        expectedContentSetId: publication.contentSetId,
        expectedContentSetHash: publication.contentSetHash,
        expectedSiteSnapshotId: publication.siteSnapshotId,
      });
    }
    const expectedEntries = publication.contentManifest?.contentEntries || [];
    if (JSON.stringify(contentManifest.contentEntries || []) !== JSON.stringify(expectedEntries)) {
      throw new Error("public ContentSet entry projection is incomplete or reordered");
    }
    if (JSON.stringify(contentManifest.homeContent || null) !== JSON.stringify(publication.contentManifest?.homeContent || null)) {
      throw new Error("public Home ContentSet projection is incomplete or drifted");
    }
    for (const field of ["publishedSlugs", "publishedArticleSlugs", "practiceIds", "profileIds", "productIds", "businessObservationIds", "mediaPaths"]) {
      assertExactArray(contentManifest[field], publication.contentManifest?.[field], field);
    }
    const routes = new Set(["/", "/products", "/business-observations", "/observations", "/about"]);
    const pages = {};
    let indexHtml = null;
    for (const route of routes) {
      const response = await fetchImpl(new URL(route, base), { redirect: "follow", cache: "no-store", ...(signal ? { signal } : {}) });
      if (!response.ok) throw new Error(`public verify ${route} returned HTTP ${response.status}`);
      const text = await response.text();
      if (!/<title>xingbuild/i.test(text)) throw new Error(`public verify ${route} is not an xingbuild page`);
      if (route === "/") indexHtml = text;
      pages[route] = { status: response.status, verified: true };
    }
    const assetManifest = await loadPublicationAssetManifest(publication);
    assertIndexIdentity(indexHtml, assetManifest);
    const { assetsPhase, appPhase: browserRuntime, mediaPhase, verificationEvidence } = await verifyPublicationPhaseSet({
      publication,
      base,
      indexHtml,
      assetManifest,
      routes,
      mediaPaths: publication.contentManifest?.mediaPaths || [],
      fetchImpl,
      browserRuntimeVerify,
      onEvidence,
      signal,
      attemptId: resolvedAttemptId,
    });
    return {
      sitePublicationId: publication.sitePublicationId,
      snapshotHash: publication.snapshotHash,
      siteSnapshotId: publication.siteSnapshotId,
      contentSetId: publication.contentSetId,
      contentSetHash: publication.contentSetHash,
      baseSiteArtifactId: contentManifest.baseSiteArtifactId,
      productArtifactId: contentManifest.productArtifactId || publication.productArtifactId,
      productArtifactHash: contentManifest.productArtifactHash || null,
      version: publication.productVersion,
      commit: publication.productCommit,
      activeContentReleaseIds: [],
      release: { version: release.version, commit: release.commit, baseSiteArtifactId: release.baseSiteArtifactId || null },
      contentManifest,
      pages,
      assets: assetsPhase,
      browserRuntime,
      media: mediaPhase.media,
      ...(verificationEvidence ? { verificationEvidence } : {}),
      verifiedAt: new Date().toISOString(),
    };
  }
  const actualIds = assertExactArray(contentManifest.activeContentReleaseIds, publication.contentReleaseIds, "activeContentReleaseIds");
  if (publication.contentManifest?.activeReceiptIds) {
    assertExactArray(contentManifest.activeReceiptIds, publication.contentManifest.activeReceiptIds, "activeReceiptIds");
  }
  for (const field of ["publishedSlugs", "publishedArticleSlugs", "practiceIds", "profileIds", "businessObservationIds", "mediaPaths"]) {
    assertExactArray(contentManifest[field], publication.contentManifest?.[field], field);
  }
  const expectedReceipts = publication.contentManifest?.contentReleaseReceipts || [];
  const actualReceipts = contentManifest.contentReleaseReceipts;
  if (!Array.isArray(actualReceipts) || actualReceipts.length !== expectedReceipts.length) throw new Error("public content manifest receipt projection is incomplete");
  for (const expected of expectedReceipts) {
    const actual = actualReceipts.find((item) => item.contentReleaseId === expected.contentReleaseId);
    if (!actual || actual.receiptHash !== expected.receiptHash || (actual.packageRevisionId || null) !== (expected.packageRevisionId || null)
      || actual.contentHash !== expected.contentHash || actual.kind !== expected.kind || actual.target !== expected.target) {
      throw new Error(`public content manifest receipt identity mismatch: ${expected.contentReleaseId}`);
    }
    assertContentLifecycleProjection(actual, expected, expected.contentReleaseId);
  }
  const expectedProjections = publication.contentManifest?.activeContentProjections || [];
  if (expectedProjections.length) {
    const actualProjections = contentManifest.activeContentProjections;
    if (!Array.isArray(actualProjections) || actualProjections.length !== expectedProjections.length) throw new Error("public content manifest active projection set is incomplete");
    for (const expected of expectedProjections) {
      const actual = actualProjections.find((item) => item.contentReleaseId === expected.contentReleaseId);
      if (!actual || actual.projectionHash !== expected.projectionHash || actual.receiptHash !== expected.receiptHash) {
        throw new Error(`public content manifest active projection identity mismatch: ${expected.contentReleaseId}`);
      }
      assertActiveContentProjection(actual);
    }
    if (JSON.stringify(actualProjections) !== JSON.stringify(actualReceipts)) throw new Error("public content manifest projection and receipt views diverge");
  }
  if (publication.lineageBinding) {
    const expectedBinding = validatePublicationLineageBinding(publication.lineageBinding, { sitePublicationId: publication.sitePublicationId });
    const actualCandidate = actualReceipts.find((item) => item.contentReleaseId === expectedBinding.candidateContentReleaseId
      && item.packageRevisionId === expectedBinding.packageRevisionId);
    if (!actualCandidate
      || actualCandidate.lineageBindingId !== expectedBinding.lineageBindingId
      || actualCandidate.predecessorReceiptId !== expectedBinding.predecessorReceiptId
      || actualCandidate.supersedesPackageId !== expectedBinding.predecessorPackageId) {
      throw new Error("public content manifest lineage binding projection mismatch");
    }
    if (contentManifest.lineageBindingId !== expectedBinding.lineageBindingId
      || JSON.stringify(contentManifest.lineageBinding || null) !== JSON.stringify(expectedBinding)) {
      throw new Error("public content manifest lineage binding identity mismatch");
    }
  }
  if ((contentManifest.candidatePackageRevisionId || null) !== (publication.candidatePackageRevisionId || null)) {
    throw new Error("public content manifest candidate package revision identity mismatch");
  }
  if (JSON.stringify(contentManifest.contentReplacement || null) !== JSON.stringify(publication.contentReplacement || null)) {
    throw new Error("public content manifest replacement lineage mismatch");
  }
  const routes = new Set(["/", "/products", "/business-observations", "/observations", "/about"]);
  if (publication.targetPath) routes.add(publication.targetPath);
  for (const receipt of expectedReceipts) if (receipt.targetPath) routes.add(receipt.targetPath);
  const pages = {};
  let indexHtml = null;
  for (const route of routes) {
    const response = await fetchImpl(new URL(route, base), { redirect: "follow", cache: "no-store", ...(signal ? { signal } : {}) });
    if (!response.ok) throw new Error(`public verify ${route} returned HTTP ${response.status}`);
    const text = await response.text();
    if (!/<title>xingbuild/i.test(text)) throw new Error(`public verify ${route} is not an xingbuild page`);
    if (route === "/") indexHtml = text;
    pages[route] = { status: response.status, verified: true };
  }
  const assetManifest = await loadPublicationAssetManifest(publication);
  assertIndexIdentity(indexHtml, assetManifest);
  const { assetsPhase, appPhase: browserRuntime, mediaPhase, verificationEvidence } = await verifyPublicationPhaseSet({
    publication,
    base,
    indexHtml,
    assetManifest,
    routes,
    mediaPaths: publication.contentManifest?.mediaPaths || publication.mediaPaths || [],
    fetchImpl,
    browserRuntimeVerify,
    onEvidence,
    signal,
    attemptId: resolvedAttemptId,
  });
  if (publication.candidateContentReleaseId && !actualIds.includes(publication.candidateContentReleaseId)) {
    throw new Error("public content manifest does not contain the candidate release");
  }
  return {
    sitePublicationId: publication.sitePublicationId,
    snapshotHash: publication.snapshotHash,
    version: publication.productVersion,
    commit: publication.productCommit,
    activeContentReleaseIds: actualIds,
    release: { version: release.version, commit: release.commit },
    contentManifest: {
      version: contentManifest.version,
      commit: contentManifest.commit,
      sitePublicationId: contentManifest.sitePublicationId,
      snapshotHash: contentManifest.snapshotHash,
      baseSiteArtifactId: contentManifest.baseSiteArtifactId,
      activeReceiptIds: contentManifest.activeReceiptIds || [],
      publishedSlugs: contentManifest.publishedSlugs,
      publishedArticleSlugs: contentManifest.publishedArticleSlugs,
      practiceIds: contentManifest.practiceIds,
      profileIds: contentManifest.profileIds,
      businessObservationIds: contentManifest.businessObservationIds,
      mediaPaths: contentManifest.mediaPaths,
      activeContentProjections: contentManifest.activeContentProjections || [],
      contentReleaseReceipts: actualReceipts,
      candidatePackageRevisionId: contentManifest.candidatePackageRevisionId || null,
      contentReplacement: contentManifest.contentReplacement || null,
      lineageBindingId: contentManifest.lineageBindingId || null,
      lineageBinding: contentManifest.lineageBinding || null,
    },
    pages,
    assets: assetsPhase,
    browserRuntime,
    media: mediaPhase.media,
    ...(verificationEvidence ? { verificationEvidence } : {}),
    verifiedAt: new Date().toISOString(),
  };
}

export async function waitForPublicSitePublication({ publication, baseUrl = publicUrl, fetchImpl = fetch, browserRuntimeVerify = null, maxAttempts = 30, initialDelayMs = 1000, maxDelayMs = 10000, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onObservation = async () => {}, onEvidence = null, attemptId = null, signal = null, allowDerivedRuntimeAcceptanceSpec = false } = {}) {
  let lastError;
  const observations = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { ...(await verifyPublicSitePublication({ publication, baseUrl, fetchImpl, browserRuntimeVerify, onEvidence, attemptId: attemptId || `attempt-${attempt}`, signal, allowDerivedRuntimeAcceptanceSpec })), attempts: attempt, propagationObservations: observations };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) {
        const aborted = new Error(error.message || "site publication verification was aborted");
        aborted.code = error.code || "SITE_PUBLICATION_ABORTED";
        aborted.phase = error.phase || "verifying-assets";
        aborted.lastEvidence = error.runtimeEvidence || error.lastEvidence || null;
        aborted.runtimeEvidence = error.runtimeEvidence || null;
        aborted.recoverable = true;
        aborted.propagation = false;
        throw aborted;
      }
      if (error.propagation) {
        const observation = {
          expectedIdentity: sitePublicationIdentity(publication),
          observedIdentity: error.observedIdentity || null,
          attempt,
          observedAt: new Date().toISOString(),
          message: error.message,
        };
        observations.push(observation);
        await onObservation(observation);
      }
      if (!error.recoverable) throw error;
      if (attempt === maxAttempts) break;
      await sleepImpl(Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1)));
    }
  }
  const error = new Error(`site publication public verification timed out after ${maxAttempts} attempts: ${lastError?.message || "unknown"}`);
  error.code = "SITE_PUBLICATION_VERIFY_TIMEOUT";
  error.recoveryId = publicationRecoveryId(publication.sitePublicationId, "public-verify");
  error.recoverable = true;
  error.propagation = true;
  error.expectedIdentity = sitePublicationIdentity(publication);
  error.observedIdentity = observations.at(-1)?.observedIdentity || lastError?.observedIdentity || null;
  error.propagationObservations = observations;
  error.phase = lastError?.runtimeEvidence?.phase || lastError?.details?.phase || "verifying-assets";
  error.lastEvidence = lastError?.runtimeEvidence || lastError?.details?.evidence || null;
  error.runtimeEvidence = lastError?.runtimeEvidence || null;
  throw error;
}

export async function transportSitePublication({ publication, sourceRoot, argv = [], env = process.env, edgeonePath, baseUrl = publicUrl, fetchImpl = fetch, browserRuntimeVerify = null, runCaptureImpl = runCapture, maxAttempts = 30, initialDelayMs = 1000, maxDelayMs = 10000, sleepImpl } = {}) {
  assertFixedPublishTarget(env);
  assertPublishAuthorization({ argv, env });
  const productArtifact = publicationProductArtifactIdentity(publication);
  if (!publication?.sitePublicationId || !productArtifact.productVersion || !productArtifact.productCommit) throw new Error("SitePublication identity is required");
  const currentText = await readFile(path.join(sourceRoot, "docs/iterations/current.md"), "utf8");
  assertProductContentCompatibility({ currentText, activeContentReleaseIds: publication.contentReleaseIds || [] });
  const target = await readFixedEdgeoneTarget(sourceRoot);
  let persisted = null;
  try {
    persisted = await readSitePublicationRecord(publication.client);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (persisted && (persisted.sitePublicationId !== publication.sitePublicationId
    || persisted.snapshotHash !== publication.snapshotHash
    || persisted.productVersion !== productArtifact.productVersion
    || persisted.productCommit !== productArtifact.productCommit
    || (persisted.productArtifactId || null) !== (productArtifact.productArtifactId || null)
    || (persisted.baseSiteArtifactId || persisted.productArtifactId || null) !== (productArtifact.baseSiteArtifactId || null)
    // Legacy fixture publications do not persist a ProductArtifact hash.  A
    // hash is part of the resume identity only once the request/record has an
    // explicit v2 hash; otherwise comparing the adapter's derived legacy
    // hash would make a valid first-run record impossible to resume.
    || ((publication.productArtifactHash || publication.productArtifact?.productArtifactHash || persisted.productArtifactHash)
      && (persisted.productArtifactHash || null) !== (productArtifact.productArtifactHash || null)))) {
    throw new Error("persisted SitePublication identity does not match resume request");
  }
  const leaseDirectory = path.join(sourceRoot, ".content-workspace", "site-publications", ".site-lease");
  const lease = await acquireSitePublicationLease({ publicationDirectory: publication.client, leaseDirectory, sitePublicationId: publication.sitePublicationId, snapshotHash: publication.snapshotHash, ttlMs: 900000 });
  let current = { ...publication };
  let publicationRun = null;
  if (isContentSetPublication(current)) {
    publicationRun = await readPublicationRun({ sourceRoot, publicationRunId: current.publicationRunId });
    if (publicationRun.siteSnapshotId !== current.siteSnapshotId || publicationRun.snapshotHash !== current.snapshotHash || publicationRun.contentSetId !== current.contentSetId) {
      throw new Error("PublicationRun identity does not match SitePublication resume");
    }
    if (current.deploymentId && publicationRun.deploymentId && current.deploymentId !== publicationRun.deploymentId) {
      throw new Error("PublicationRun deployment identity drift on resume");
    }
    if (!current.deploymentId && publicationRun.deploymentId) {
      current = { ...current, deploymentId: publicationRun.deploymentId, deployment: publicationRun.deployment || null };
    }
  }
  let propagationObservations = current.propagation?.observations || [];
  let uploadRoot = null;
  const attemptId = `attempt-${Date.now()}-${current.deploymentId || "pending"}`;
  const abortController = new AbortController();
  const signalHandlers = new Map();
  let interruption = null;
  const markInterrupted = (signal) => {
    if (interruption) return;
    const failure = {
      code: "SITE_PUBLICATION_INTERRUPTED", phase: current.phase || "transport", message: `received ${signal}`,
      at: new Date().toISOString(), lastEvidence: current.runtimeEvidence || current.lastEvidence || { phase: current.phase || "transport" },
    };
    abortController.abort();
    interruption = transitionSitePublication({
      publicationDirectory: publication.client,
      current,
      state: "recoverable",
      phase: "recoverable",
      failure,
      patch: { recoveryId: current.recoveryId || publicationRecoveryId(current.sitePublicationId, "interrupted") },
    }).then((next) => { current = next; return next; }).catch(() => null);
  };
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => markInterrupted(signal);
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }
  try {
    const indexExists = Boolean(await stat(path.join(publication.client, "index.html")).catch(() => null));
    if (runCaptureImpl === runCapture || indexExists) {
      uploadRoot = await preparePortableUploadRoot({
        clientRoot: publication.client,
        additionalPaths: publication.contentManifest?.mediaPaths || publication.mediaPaths || [],
      });
    } else {
      // Unit and audit fixtures may exercise coordinator state transitions without
      // a client tree; real transport always takes the explicit upload-root path.
      uploadRoot = { root: publication.client, manifest: publication.assetManifest || null, async cleanup() {} };
    }
    current = await transitionSitePublication({ publicationDirectory: publication.client, current, patch: { assetManifest: uploadRoot.manifest, failure: null } }).catch(() => ({ ...current, assetManifest: uploadRoot.manifest, failure: null }));
    if (!current.deploymentId) {
      if (!edgeonePath) throw new Error("EdgeOne CLI path is required for SitePublication transport");
      let output;
      try {
        runCaptureImpl(edgeonePath, ["whoami"], sourceRoot, env);
        output = runCaptureImpl(edgeonePath, ["makers", "deploy", uploadRoot.root, "--name", target.name, "--env", "production", "--json"], sourceRoot, env);
      } catch (error) {
        error.recoverable = true;
        throw error;
      }
      const deployment = readDeploymentResult(output);
      if (publicationRun) {
        publicationRun = {
          ...publicationRun,
          state: "deploying",
          deploymentId: deployment.deploymentId,
          deployment,
          deploymentCount: 1,
          updatedAt: new Date().toISOString(),
        };
        await writePublicationRun({ sourceRoot, run: publicationRun });
      }
      current = await transitionSitePublication({ publicationDirectory: publication.client, current, state: ["pending", "processing", "running"].includes(deployment.status) ? "propagating" : "deploying", patch: {
        ...current,
        deploymentId: deployment.deploymentId,
        deployment,
        publicationRun: publicationRun || current.publicationRun,
        recoveryId: publicationRecoveryId(publication.sitePublicationId, "transport"),
        deploymentRecordedAt: new Date().toISOString(),
      }});
      await writeJsonAtomically(path.join(publication.client, "deployment.json"), deployment);
    }
    current = await transitionSitePublication({ publicationDirectory: publication.client, current, state: "verifying", phase: "verifying-assets", patch: { verificationAttemptId: attemptId, failure: null } });
    const publicVerify = await waitForPublicSitePublication({
      publication: current,
      baseUrl,
      fetchImpl,
      maxAttempts,
      initialDelayMs,
      maxDelayMs,
      sleepImpl,
      attemptId,
      signal: abortController.signal,
      onEvidence: async ({ phase, result }) => {
        current = await transitionSitePublication({
          publicationDirectory: publication.client,
          current,
          phase,
          patch: { verificationAttemptId: attemptId, runtimeEvidence: result, lastEvidence: result },
        });
      },
      browserRuntimeVerify: browserRuntimeVerify || (fetchImpl === fetch
        ? async (options) => {
          try {
            return await verifyPublicBrowserRuntime(options);
          } catch (error) {
            error.recoverable = true;
            error.propagation = true;
            throw error;
          }
        }
        : null),
      onObservation: async (observation) => {
        propagationObservations = [...propagationObservations, observation];
        current = await transitionSitePublication({ publicationDirectory: publication.client, current, patch: {
          propagation: {
            expectedIdentity: sitePublicationIdentity(current),
            observedIdentity: observation.observedIdentity,
            deploymentId: current.deploymentId || null,
            attempts: observation.attempt,
            observations: propagationObservations,
            lastObservedAt: observation.observedAt,
          },
        }});
      },
    });
    const productVerify = { version: current.productVersion, commit: current.productCommit, verifiedAt: publicVerify.verifiedAt };
    const contentVerify = { activeContentReleaseIds: publicVerify.activeContentReleaseIds, snapshotHash: publicVerify.snapshotHash, contentManifest: publicVerify.contentManifest, verifiedAt: publicVerify.verifiedAt };
    assertSitePublicationEvidence({ deployment: current.deployment || { deploymentId: current.deploymentId }, publicVerify, productVerify, contentVerify });
    if (publicationRun) {
      publicationRun = markPublicationReleased(publicationRun, publicVerify);
      await writePublicationRun({ sourceRoot, run: publicationRun });
    }
    return await finalizeSitePublication({ publicationDirectory: publication.client, publicVerify, sourceRoot }).then((finalized) => writePublicationRecord(publication.client, { ...finalized, productVerify, contentVerify }));
  } catch (error) {
    if (interruption) await interruption.catch(() => {});
    const state = error.recoverable === true ? "recoverable" : "failed";
    const propagation = error.propagationObservations?.length
      ? {
        expectedIdentity: error.expectedIdentity || sitePublicationIdentity(current),
        observedIdentity: error.observedIdentity || error.propagationObservations.at(-1)?.observedIdentity || null,
        deploymentId: current.deploymentId || null,
        attempts: error.propagationObservations.at(-1)?.attempt || null,
        observations: [...propagationObservations, ...error.propagationObservations.filter((item) => !propagationObservations.includes(item))],
        lastObservedAt: error.propagationObservations.at(-1)?.observedAt || null,
      }
      : current.propagation;
    const failure = {
      message: error.message,
      code: error.code || "SITE_PUBLICATION_TRANSPORT",
      phase: error.phase || error.runtimeEvidence?.phase || current.phase || (state === "recoverable" ? "recoverable" : "transport"),
      lastEvidence: error.runtimeEvidence || error.lastEvidence || current.runtimeEvidence || current.lastEvidence || { phase: current.phase || "transport" },
      at: new Date().toISOString(),
    };
    const patch = {
      recoveryId: current.recoveryId || publicationRecoveryId(publication.sitePublicationId, error.code || "transport"),
      ...(propagation
        ? { propagation, incident: { type: error.code || "SITE_PUBLICATION_TRANSPORT", expectedIdentity: propagation.expectedIdentity, observedIdentity: propagation.observedIdentity, deploymentId: propagation.deploymentId, attempts: propagation.attempts } }
        : error.observedIdentity
          ? { incident: { type: error.code || "SITE_PUBLICATION_TRANSPORT", expectedIdentity: sitePublicationIdentity(current), observedIdentity: error.observedIdentity, deploymentId: current.deploymentId || null } }
          : {}),
    };
    let failed = current;
    try {
      failed = await transitionSitePublication({
        publicationDirectory: publication.client,
        current,
        state,
        phase: state === "recoverable" ? "recoverable" : failure.phase,
        patch,
        failure,
      });
      current = failed;
    } catch {
      // Preserve the original transport error when a process is already
      // exiting; the signal path has attempted the same atomic transition.
      failed = { ...current, ...patch, state, phase: state === "recoverable" ? "recoverable" : failure.phase, failure };
    }
    if (publicationRun) {
      publicationRun = error.recoverable
        ? markPublicationRecoverable(publicationRun, { ...failure, propagation: propagation || null })
        : { ...publicationRun, state: "failed", recovery: { message: error.message, code: error.code || null, at: new Date().toISOString() }, updatedAt: new Date().toISOString() };
      await writePublicationRun({ sourceRoot, run: publicationRun }).catch(() => {});
      failed.publicationRun = publicationRun;
    }
    error.sitePublication = failed;
    throw error;
  } finally {
    for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler);
    await releaseSitePublicationLease(lease);
    if (uploadRoot) await uploadRoot.cleanup().catch(() => {});
  }
}

export { edgeoneProjectId };
