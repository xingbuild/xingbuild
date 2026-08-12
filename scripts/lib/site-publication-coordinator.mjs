import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, rm } from "node:fs/promises";
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
import { PUBLICATION_RUNTIME_VERSION, verifyPublicBrowserRuntime } from "./publication-runtime.mjs";
import { assertProductArtifactIdentityShape } from "./product-artifact.mjs";
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
  return {
    sitePublicationId: publication.sitePublicationId || null,
    snapshotHash: publication.snapshotHash || null,
    ...publicationProductArtifactIdentity(publication),
    version: publication.productVersion || publication.productArtifact?.productVersion || null,
    commit: publication.productCommit || publication.productArtifact?.productCommit || null,
  };
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

export async function finalizeSitePublication({ publicationDirectory, publicVerify, sourceRoot = null } = {}) {
  let current = await readSitePublicationRecord(publicationDirectory);
  if (!current.deploymentId || !publicVerify) throw new Error("SitePublication finalize requires deploymentId and publicVerify");
  if (publicVerify.sitePublicationId !== current.sitePublicationId || publicVerify.snapshotHash !== current.snapshotHash) {
    throw new Error("SitePublication finalize evidence identity mismatch");
  }
  if (publicVerify.verificationEvidence?.schemaVersion === PUBLICATION_RUNTIME_VERSION) {
    const phases = publicVerify.verificationEvidence.phases || {};
    if (publicVerify.verificationEvidence.result !== "verified"
      || phases.assets?.result !== "verified"
      || phases.media?.result !== "verified"
      || (phases.app && phases.app.result !== "verified")) {
      throw new Error("SitePublication finalize requires complete v3 assets/app/media evidence");
    }
  }
  const resolvedSourceRoot = sourceRoot || path.resolve(publicationDirectory, "..", "..", "..");
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
  await writeJsonAtomically(path.join(publicationDirectory, "site-publication.json"), value);
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
  return {
    schemaVersion: PUBLICATION_RUNTIME_VERSION,
    publicationIdentity: sitePublicationIdentity(publication),
    attemptId,
    phase,
    startedAt: new Date().toISOString(),
    ...extra,
  };
}

function recoverablePhaseError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.recoverable = true;
  error.propagation = true;
  error.observedIdentity = details;
  return error;
}

async function verifyMediaPhase({ publication, base, indexHtml, assetManifest, mediaPaths, fetchImpl, signal } = {}) {
  if (signal?.aborted) throw recoverablePhaseError("SITE_PUBLICATION_MEDIA_ABORTED", "public media verification was aborted", { phase: "verifying-media" });
  const required = [...new Set(mediaPaths || [])];
  const startedAt = new Date().toISOString();
  if (!required.length) return { schemaVersion: PUBLICATION_RUNTIME_VERSION, phase: "verifying-media", startedAt, finishedAt: new Date().toISOString(), media: {}, result: "verified", verified: true };
  if (assetManifest?.assets) {
    const entries = new Map(assetManifest.assets.map((item) => [item.path, item]));
    const missing = required.filter((item) => !entries.has(item));
    if (missing.length) throw recoverablePhaseError("SITE_PUBLICATION_MEDIA_ASSET_UNMANIFESTED", `public media is absent from the asset manifest: ${missing.join(", ")}`, { phase: "verifying-media", missing });
    const verified = await verifyPublicPublicationAssets({ baseUrl: base, indexHtml, assetManifest, fetchImpl, onlyKinds: ["media"], signal });
    const media = {};
    for (const item of required) media[item] = { ...(verified.assets[item] || {}), browserProbe: "not-probed", verified: true };
    return { schemaVersion: PUBLICATION_RUNTIME_VERSION, phase: "verifying-media", startedAt, finishedAt: new Date().toISOString(), media, result: "verified", verified: true };
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
  return { schemaVersion: PUBLICATION_RUNTIME_VERSION, phase: "verifying-media", startedAt, finishedAt: new Date().toISOString(), media, result: "verified", verified: true };
}

export async function verifyPublicSitePublication({ publication, baseUrl = publicUrl, fetchImpl = fetch, browserRuntimeVerify = null, attemptId = null, onEvidence = null, signal = null } = {}) {
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
    const assetsStartedAt = new Date().toISOString();
    const assets = await verifyPublicPublicationAssets({ baseUrl: base, indexHtml, assetManifest, fetchImpl, onlyKinds: ["script", "style", "icon"], signal });
    await onEvidence?.({ phase: "verifying-assets", result: phaseEnvelope(publication, resolvedAttemptId, "verifying-assets", { startedAt: assetsStartedAt, finishedAt: new Date().toISOString(), assets, result: "verified", verified: assets.verified !== false }) });
    const browserRuntime = browserRuntimeVerify
      ? await browserRuntimeVerify({ baseUrl: base, routes: [...routes], taskId: "site-publication-public-verify", publicationIdentity: sitePublicationIdentity(publication), attemptId: resolvedAttemptId, onEvidence, signal })
      : null;
    const mediaPhase = await verifyMediaPhase({ publication, base, indexHtml, assetManifest, mediaPaths: publication.contentManifest?.mediaPaths || [], fetchImpl, signal });
    await onEvidence?.({ phase: "verifying-media", result: mediaPhase });
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
      assets,
      browserRuntime,
      media: mediaPhase.media,
      ...(assets.skipped ? {} : { verificationEvidence: {
        schemaVersion: PUBLICATION_RUNTIME_VERSION,
        publicationIdentity: sitePublicationIdentity(publication),
        attemptId: resolvedAttemptId,
        phases: { assets, app: browserRuntime || { result: "skipped", verified: true }, media: mediaPhase },
        phase: "verified", result: "verified", verified: true,
      } }),
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
  const assetsStartedAt = new Date().toISOString();
  const assets = await verifyPublicPublicationAssets({ baseUrl: base, indexHtml, assetManifest, fetchImpl, onlyKinds: ["script", "style", "icon"], signal });
  await onEvidence?.({ phase: "verifying-assets", result: phaseEnvelope(publication, resolvedAttemptId, "verifying-assets", { startedAt: assetsStartedAt, finishedAt: new Date().toISOString(), assets, result: "verified", verified: assets.verified !== false }) });
  const browserRuntime = browserRuntimeVerify
    ? await browserRuntimeVerify({ baseUrl: base, routes: [...routes], taskId: "site-publication-public-verify", publicationIdentity: sitePublicationIdentity(publication), attemptId: resolvedAttemptId, onEvidence, signal })
    : null;
  const mediaPhase = await verifyMediaPhase({ publication, base, indexHtml, assetManifest, mediaPaths: publication.contentManifest?.mediaPaths || publication.mediaPaths || [], fetchImpl, signal });
  await onEvidence?.({ phase: "verifying-media", result: mediaPhase });
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
    assets,
    browserRuntime,
    media: mediaPhase.media,
    ...(assets.skipped ? {} : { verificationEvidence: {
      schemaVersion: PUBLICATION_RUNTIME_VERSION,
      publicationIdentity: sitePublicationIdentity(publication),
      attemptId: resolvedAttemptId,
      phases: { assets, app: browserRuntime || { result: "skipped", verified: true }, media: mediaPhase },
      phase: "verified", result: "verified", verified: true,
    } }),
    verifiedAt: new Date().toISOString(),
  };
}

export async function waitForPublicSitePublication({ publication, baseUrl = publicUrl, fetchImpl = fetch, browserRuntimeVerify = null, maxAttempts = 30, initialDelayMs = 1000, maxDelayMs = 10000, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), onObservation = async () => {}, onEvidence = null, attemptId = null, signal = null } = {}) {
  let lastError;
  const observations = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { ...(await verifyPublicSitePublication({ publication, baseUrl, fetchImpl, browserRuntimeVerify, onEvidence, attemptId: attemptId || `attempt-${attempt}`, signal })), attempts: attempt, propagationObservations: observations };
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

export async function transportSitePublication({ publication, sourceRoot, argv = [], env = process.env, edgeonePath, baseUrl = publicUrl, fetchImpl = fetch, runCaptureImpl = runCapture, maxAttempts = 30, initialDelayMs = 1000, maxDelayMs = 10000, sleepImpl } = {}) {
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
    || (persisted.productArtifactHash || null) !== (productArtifact.productArtifactHash || null))) {
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
      browserRuntimeVerify: fetchImpl === fetch
        ? async (options) => {
          try {
            return await verifyPublicBrowserRuntime(options);
          } catch (error) {
            error.recoverable = true;
            error.propagation = true;
            throw error;
          }
        }
        : null,
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
