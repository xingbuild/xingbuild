#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, appendFile, cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertFixedPublishTarget,
  assertPublishAuthorization,
  publicUrl,
} from "./lib/publish-target.mjs";
import {
  assertValidObservation,
  hashFile,
  isFile,
  projectRoot,
} from "./lib/observation-content.mjs";
import { assertPracticeContent, validatePublishablePracticeBundle } from "./lib/practice-content.mjs";
import { assertBaseSiteArtifactCompatible, readBaseSiteArtifact, validateBaseSiteArtifact } from "./lib/base-site-artifact.mjs";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { contentRootDirectory } from "./lib/content-root.mjs";
import { createSitePublication, validateUploadQuota } from "./lib/site-publication.mjs";
import { planContentBatch } from "./lib/content-batch.mjs";
import { reconcileContentPackage } from "./lib/content-package-reconcile.mjs";
import { transportSitePublication } from "./lib/site-publication-coordinator.mjs";
import { CONTENT_RELEASE_RECEIPT_VERSION, readContentReleaseReceipt, receiptTargetCollections } from "./lib/content-release-receipt.mjs";
import { resolveContentLifecycleTimes } from "./lib/content-lifecycle-time.mjs";
import { getContentLifecycleAdapter, finalizeContentLifecycle, restoreContentLifecycle } from "./lib/content-lifecycle-adapter.mjs";
import { restoreContentSlot } from "./lib/content-slot-registry.mjs";
import {
  acquireContentReleasePackageLease,
  assertContentReleaseTransition,
  canResumeState,
  contentReleaseIdempotencyKey,
  releaseContentReleasePackageLease,
  writeJsonAtomically,
} from "./lib/content-release-state.mjs";
import {
  applyContentChangeSetDocuments,
  contentChangeSetOperations,
  hashValue,
  linkContentChangeSetRelease,
  logicalContentId,
  readContentChangeSet,
  readFieldValue,
  writeFieldValue,
} from "./lib/content-targets.mjs";
import { contentSetEntryFromCanonical, prepareContentSetCandidate as writeContentSetCandidate } from "./lib/content-set-candidate.mjs";
import { readActiveContentSet } from "./lib/content-set.mjs";
import { readCanonicalHomeContent } from "./lib/home-content-adapter.mjs";

export const root = projectRoot;
const edgeone = path.join(root, "node_modules", ".bin", "edgeone");
const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const kinds = new Set(["home", "content", "article", "practice", "profile", "businessObservation"]);

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

function run(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
}

function runCapture(command, args, cwd, env = process.env) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  return output;
}

function targetPath(kind, target) {
  if (kind === "home") return path.join("content", "home.json");
  if (kind === "content") return path.join("content", "observations", `${target}.json`);
  if (kind === "article") return path.join("content", "articles", `${target}.json`);
  if (kind === "profile") return path.join("content", "profile", `${target}.json`);
  if (kind === "businessObservation") return path.join("content", "business-observations", `${target}.json`);
  return path.join("content", "products", `${target}.json`);
}

function publicPath(kind, target) {
  if (kind === "home") return "/";
  if (kind === "content") return `/observations/${target}`;
  if (kind === "article") return "/business-observations";
  if (kind === "profile") return "/about";
  if (kind === "businessObservation") return "/";
  return "/products";
}

async function readTarget({ kind, target, sourceRoot }) {
  if (!kinds.has(kind) || !slugPattern.test(target)) throw new Error("content release requires one explicit valid target");
  const relative = targetPath(kind, target);
  if (kind === "home" && target === "home") {
    const canonical = await readCanonicalHomeContent({ sourceRoot });
    return { relative, file: canonical.filePath, value: canonical.value, sourceHash: canonical.sourceHash };
  }
  const file = path.join(contentRootDirectory({ sourceRoot }), relative.slice("content/".length));
  if (!(await isFile(file))) throw new Error(`content target is missing: ${relative}`);
  const value = JSON.parse(await readFile(file, "utf8"));
  if (kind === "content") {
    assertValidObservation(value, { expectedStatus: "published" });
    if (value.slug !== target) throw new Error(`content target slug mismatch: ${target}`);
  } else if (kind === "article") {
    if (value.slug !== target || value.status !== "published") throw new Error(`article target is not published: ${target}`);
  } else if (kind === "profile" || kind === "businessObservation") {
    if (value.id !== target) throw new Error(`${kind} target mismatch: ${target}`);
  } else {
    const bundle = await assertPracticeContent(target, { rootDirectory: sourceRoot, publishable: true });
    if (bundle.practice.id !== target) throw new Error(`practice target mismatch: ${target}`);
    return { relative, file, value, practiceBundle: bundle };
  }
  return { relative, file, value };
}

async function readReview({ kind, target, sourceRoot, content }) {
  const reviewFile = path.join(sourceRoot, ".content-workspace", "reviews", `${target}.json`);
  if (!(await isFile(reviewFile))) {
    if (kind === "content") throw new Error(`approved review is required for content target: ${target}`);
    return { reviewedAt: content.value.reviewedAt || content.value.updatedAt || null, review: null };
  }
  const review = JSON.parse(await readFile(reviewFile, "utf8"));
  if (review.status !== "approved") throw new Error(`content target is not approved: ${target}`);
  if (kind === "content") {
    const draftFile = path.join(sourceRoot, ".content-workspace", "drafts", `${target}.json`);
    const recoveryFile = path.join(sourceRoot, ".content-workspace", "recoveries", `${target}.json`);
    for (const file of [draftFile, recoveryFile]) if (!(await isFile(file))) throw new Error(`content lifecycle file is missing: ${path.relative(sourceRoot, file)}`);
    const expectedHash = await hashFile(draftFile);
    if (review.contentHash !== expectedHash || await hashFile(recoveryFile) !== expectedHash) {
      throw new Error(`content lifecycle hash mismatch: ${target}`);
    }
  }
  return { reviewedAt: review.reviewedAt || null, review };
}

function sourceIds(value) {
  return Array.isArray(value?.sources) ? value.sources.map((source) => typeof source === "string" ? source : source.id).filter(Boolean) : [];
}

async function updateReleaseState(packageInfo, state, extra = {}) {
  const manifestPath = packageInfo.manifestPath || path.join(packageInfo.packageDirectory, "content-release.json");
  const current = JSON.parse(await readFile(manifestPath, "utf8"));
  assertContentReleaseTransition(current.state || "prepared", state);
  const next = { ...current, ...extra, state, stateUpdatedAt: new Date().toISOString() };
  await writeJsonAtomically(manifestPath, next);
  await appendContentReleaseLog({ sourceRoot: packageInfo.sourceRoot || root, contentReleaseId: next.contentReleaseId, event: "state", data: { from: current.state || "prepared", to: state, ...extra } });
  return next;
}

async function markReleaseFailure(packageInfo, error) {
  try {
    const manifestPath = packageInfo.manifestPath || path.join(packageInfo.packageDirectory, "content-release.json");
    const current = JSON.parse(await readFile(manifestPath, "utf8"));
    const state = current.state === "released" ? "released" : "recoverable";
    const next = { ...current, state, failure: { message: error.message, at: new Date().toISOString() }, recoverable: state === "recoverable" };
    await writeJsonAtomically(manifestPath, next);
    await appendContentReleaseLog({ sourceRoot: packageInfo.sourceRoot || root, contentReleaseId: next.contentReleaseId, event: "failed", data: next.failure });
  } catch { /* preserve the original failure */ }
}

export async function finalizeContentRelease(packageInfo) {
  const contentRoot = contentRootDirectory({ sourceRoot: packageInfo.sourceRoot || root });
  const sourceFile = path.join(contentRoot, packageInfo.kind === "content" ? "observations" : packageInfo.kind === "article" ? "articles" : packageInfo.kind === "profile" ? "profile" : packageInfo.kind === "businessObservation" ? "business-observations" : "products", `${packageInfo.target}.json`);
  if (!(await isFile(sourceFile))) throw new Error(`independent content target is missing during finalize: ${packageInfo.target}`);
  const targetCollections = receiptTargetCollections(packageInfo, { packageDirectory: packageInfo.packageDirectory });
  const lifecycleTimes = resolveContentLifecycleTimes(packageInfo, {
    activeRecord: packageInfo.activeReceipt || null,
    finalize: true,
    now: packageInfo.now || (() => new Date().toISOString()),
  });
  const lifecycle = await finalizeContentLifecycle({
    sourceRoot: packageInfo.sourceRoot || root,
    packageInfo: { ...packageInfo, proofEnvelope: packageInfo.proofEnvelope || packageInfo.packageProof },
    publicEvidence: packageInfo.publicVerify || packageInfo.publicEvidence,
  });
  const lineageBinding = packageInfo.lineageBinding || null;
  const completion = {
    receiptVersion: CONTENT_RELEASE_RECEIPT_VERSION,
    contentReleaseId: packageInfo.contentReleaseId,
    logicalContentId: packageInfo.logicalContentId || logicalContentId({ kind: packageInfo.kind, target: packageInfo.target }),
    contentHash: packageInfo.contentHash,
    baseSiteArtifactId: packageInfo.baseSiteArtifactId,
    packageRevisionId: packageInfo.packageRevisionId || null,
    predecessorReceiptId: lineageBinding?.predecessorReceiptId || packageInfo.predecessorReceiptId || packageInfo.contentReplacement?.predecessorReceiptId || null,
    supersedesPackageId: lineageBinding?.predecessorPackageId || packageInfo.supersedesPackageId || packageInfo.contentReplacement?.supersedesPackageId || null,
    lineageBindingId: lineageBinding?.lineageBindingId || null,
    lineageBinding,
    changeSetId: packageInfo.changeSetId || null,
    changedTargets: packageInfo.changedTargets || [],
    operations: packageInfo.operations || [],
    revisionLineage: packageInfo.revisionLineage || null,
    beforeHash: packageInfo.beforeHash || packageInfo.proofEnvelope?.beforeHash || null,
    afterHash: packageInfo.afterHash || packageInfo.proofEnvelope?.afterHash || packageInfo.contentHash,
    proofEnvelope: packageInfo.proofEnvelope || packageInfo.packageProof || null,
    reviewEnvelope: packageInfo.reviewEnvelope || packageInfo.proofEnvelope?.reviewEnvelope || null,
    recoveryEnvelope: packageInfo.recoveryEnvelope || packageInfo.proofEnvelope?.recoveryEnvelope || null,
    kind: packageInfo.kind,
    target: packageInfo.target,
    targetPath: packageInfo.targetPath,
    sitePublicationId: packageInfo.sitePublicationId,
    deploymentId: packageInfo.deploymentId,
    productVersion: packageInfo.baseProductVersion,
    productCommit: packageInfo.baseProductCommit,
    ...lifecycleTimes,
    ...targetCollections,
    sourcePath: path.relative(packageInfo.sourceRoot || root, sourceFile),
    finalizedAt: lifecycleTimes.revisionReleasedAt,
    canonicalLifecycle: lifecycle,
  };
  const completionPath = path.join(packageInfo.packageDirectory, "completion.json");
  const factPath = path.join(contentRoot, "finalized", packageInfo.kind, `${packageInfo.target}.json`);
  try {
    await writeJsonAtomically(completionPath, completion);
    await writeJsonAtomically(factPath, completion);
  } catch (error) {
    await restoreContentLifecycle({ sourceRoot: packageInfo.sourceRoot || root, packageInfo, recoveryEnvelope: lifecycle.recoveryEnvelope }).catch(() => {});
    throw error;
  }
  return { completionPath, factPath, lifecycleTimes, lifecycle };
}

async function attachLifecycleProof({ manifest, packageDirectory, sourceRoot, changeSet } = {}) {
  const adapter = getContentLifecycleAdapter(manifest.kind);
  const canonical = await adapter.resolveCanonical({ sourceRoot, target: manifest.target, logicalContentId: manifest.logicalContentId });
  const packageInfo = { ...manifest, packageDirectory, sourceRoot };
  let reviewEvidence;
  try {
    reviewEvidence = await adapter.resolveReviewEvidence({ sourceRoot, target: manifest.target, canonical, packageInfo });
  } catch (error) {
    // Older staging fixtures may carry approval only in operation provenance.
    // Reconcile remains strict and always requires the registered Practice
    // review file; this compatibility path is limited to prepare/build.
    if (manifest.kind !== "practice" || !/Practice review is missing/.test(error.message)) throw error;
    const operations = manifest.operations || [];
    reviewEvidence = {
      review: null,
      envelope: {
        reviewId: null,
        reviewedAt: null,
        logicalContentId: manifest.logicalContentId,
        changeSetId: manifest.changeSetId || null,
        afterHash: manifest.contentHash,
        status: "approved",
        source: "ChangeSet operation provenance",
        mediaIds: [...new Set(operations.map((operation) => operation.provenance?.mediaId || operation.afterValue || operation.after).filter(Boolean))].sort(),
      },
    };
  }
  let proofEnvelope;
  try {
    proofEnvelope = await adapter.createProof({ packageInfo, canonical, reviewEvidence, changeSet });
  } catch (error) {
    // A legacy rollback intent deliberately stages the original preimage before
    // applying its inverse operations; its operation beforeHashes therefore
    // describe the staged after snapshot, not the current canonical baseline.
    // Preserve that compatibility path while keeping normal reconcile strict.
    if (manifest.kind !== "practice" || !manifest.rollbackOf) throw error;
    const packageProduct = JSON.parse(await readFile(path.join(packageDirectory, "source", ".content-workspace", "content", "products", `${manifest.target}.json`), "utf8"));
    const packageMediaPath = path.join(packageDirectory, "source", ".content-workspace", "content", "media", manifest.target, "manifest.json");
    const packageMedia = await exists(packageMediaPath) ? JSON.parse(await readFile(packageMediaPath, "utf8")) : canonical.media;
    proofEnvelope = {
      type: "ContentPackageProof",
      version: 1,
      kind: "practice",
      target: manifest.target,
      logicalContentId: manifest.logicalContentId,
      beforeHash: canonical.beforeHash,
      afterHash: hashValue({ value: packageProduct, media: packageMedia }),
      beforeSnapshot: canonical.beforeSnapshot,
      afterSnapshot: { [`content/products/${manifest.target}.json`]: packageProduct, [`content/media/${manifest.target}/manifest.json`]: packageMedia },
      changeSetId: manifest.changeSetId || null,
      changedTargets: manifest.changedTargets || [],
      operations: manifest.operations || [],
      reviewEnvelope: reviewEvidence.envelope || null,
      recoveryEnvelope: { type: "operations-reverse", source: "rollback-intent" },
    };
  }
  const next = {
    ...manifest,
    beforeHash: proofEnvelope.beforeHash,
    afterHash: proofEnvelope.afterHash,
    proofEnvelope,
    reviewEnvelope: proofEnvelope.reviewEnvelope || null,
    recoveryEnvelope: proofEnvelope.recoveryEnvelope || null,
    afterSnapshot: proofEnvelope.afterSnapshot || null,
  };
  await writeJsonAtomically(path.join(packageDirectory, "content-release.json"), next);
  return next;
}

export async function prepareContentRelease({ kind, target, changeSetPath, baseSiteArtifact, artifactPath, sourceRoot = root } = {}) {
  const content = await readTarget({ kind, target, sourceRoot });
  const changeSet = changeSetPath
    ? await readContentChangeSet(changeSetPath, { rootDirectory: sourceRoot })
    : null;
  if (changeSet) {
    const expectedLogicalContentId = logicalContentId({ kind, target });
    if (changeSet.logicalContentId && changeSet.logicalContentId !== expectedLogicalContentId) {
      throw new Error(`content ChangeSet logicalContentId drift: expected ${expectedLogicalContentId}`);
    }
    const operations = contentChangeSetOperations(changeSet);
    const allowedSources = new Set([content.relative, "content/media/robotaxi/manifest.json", "content/products/robotaxi.json"]);
    if (operations.some((operation) => !allowedSources.has(operation.sourcePath))) {
      throw new Error("content ChangeSet source must be the explicit independent target document");
    }
    if (operations.some((operation) => operation.sourcePath === "content/media/robotaxi/manifest.json") && !content.practiceBundle?.manifest) {
      throw new Error("Robotaxi media ChangeSet requires the approved media manifest");
    }
    const documents = {
      [content.relative]: content.value,
      "content/media/robotaxi/manifest.json": content.practiceBundle?.manifest,
      "content/products/robotaxi.json": content.value,
    };
    const rollbackOperations = changeSet.rollbackOf?.operations || null;
    if (rollbackOperations) {
      for (const operation of rollbackOperations) {
        const document = documents[operation.sourcePath];
        if (!document) throw new Error(`rollback source document is missing for ${operation.targetId}`);
        let canonicalValue;
        try { canonicalValue = readFieldValue(document, operation.fieldPath); } catch (error) {
          if (operation.beforeValue === null && operation.fieldPath.startsWith("assets[id=")) canonicalValue = null;
          else throw error;
        }
        if (hashValue(canonicalValue) !== hashValue(operation.beforeValue)) {
          throw new Error(`rollback canonical baseline drift for ${operation.targetId}`);
        }
      }
    } else if (changeSet.rollbackOf?.originalBefore !== undefined) {
      let canonicalValue;
      const operation = operations[0];
      const document = documents[operation.sourcePath];
      try { canonicalValue = readFieldValue(document, operation.fieldPath); } catch (error) {
        if (changeSet.rollbackOf.originalBefore === null && operation.fieldPath.startsWith("assets[id=")) canonicalValue = null;
        else throw error;
      }
      if (canonicalValue !== changeSet.rollbackOf.originalBefore || hashValue(canonicalValue) !== hashValue(changeSet.rollbackOf.originalBefore)) {
        throw new Error(`rollback canonical baseline drift for ${operation.targetId}`);
      }
      // Legacy single-field rollback records the original preimage separately;
      // stage that forward value first, then apply the inverse operation with
      // its own beforeHash so the same atomic path handles old and new files.
      documents[operation.sourcePath] = writeFieldValue(documents[operation.sourcePath], operation.fieldPath, changeSet.rollbackOf.originalAfter);
    }
    const stagedDocuments = applyContentChangeSetDocuments(documents, changeSet);
    content.value = stagedDocuments[content.relative] || stagedDocuments["content/products/robotaxi.json"];
    if (content.practiceBundle?.manifest) content.practiceBundle.manifest = stagedDocuments["content/media/robotaxi/manifest.json"] || content.practiceBundle.manifest;
    if (content.practiceBundle) {
      const errors = validatePublishablePracticeBundle(content.value, content.practiceBundle.manifest, { expectedId: target });
      if (errors.length) throw new Error(`Practice ChangeSet validation failed: ${errors.join("; ")}`);
    }
  }
  const review = await readReview({ kind, target, sourceRoot, content });
  const contentHash = changeSet
    ? hashValue({ value: content.value, media: content.practiceBundle?.manifest || null })
    : await hashFile(content.file);
  // Content is an independent intent. An artifact may be supplied as provenance
  // for legacy packages, but it is never the build or transport base.
  const immutableArtifact = baseSiteArtifact || artifactPath
    ? assertBaseSiteArtifactCompatible(await readBaseSiteArtifact({ sourceRoot, baseSiteArtifact, artifactPath }))
    : null;
  const baseProductVersion = immutableArtifact?.productVersion || null;
  const baseProductCommit = immutableArtifact?.productCommit || null;
  const contentReleaseId = `${kind}-${target}-${contentHash.slice(0, 16)}`;
  const packageDirectory = path.join(sourceRoot, ".content-workspace", "releases", contentReleaseId);
  const idempotencyKey = contentReleaseIdempotencyKey({ contentReleaseId, contentHash, baseSiteArtifactId: immutableArtifact?.baseSiteArtifactId });
  const manifest = {
    contentReleaseId,
    logicalContentId: changeSet?.logicalContentId || logicalContentId({ kind, target }),
    kind,
    target,
    contentHash,
    sources: sourceIds(content.value),
    sourceRefs: changeSet?.sourceRefs || sourceIds(content.value),
    reviewedAt: review.reviewedAt,
    firstPublishedAt: null,
    revisionReleasedAt: null,
    publishedAt: null,
    deploymentId: null,
    publicVerify: null,
    baseSiteArtifactId: immutableArtifact?.baseSiteArtifactId || null,
    baseSiteArtifact: immutableArtifact || null,
    baseProductVersion,
    baseProductCommit,
    targetPath: publicPath(kind, target),
    changeSetId: changeSet?.changeSetId || changeSet?.changeId || null,
    changedTargets: changeSet?.changedTargets || (changeSet ? [changeSet.targetId] : []),
    operations: changeSet ? contentChangeSetOperations(changeSet).map(({ target: _target, ...operation }) => operation) : [],
    revisionLineage: changeSet ? { logicalContentId: changeSet.logicalContentId || logicalContentId({ kind, target }), supersedesPackageId: null, changeSetId: changeSet.changeSetId || changeSet.changeId || null } : null,
    releasePackage: path.posix.join(".content-workspace/releases", contentReleaseId),
    rollbackOf: changeSet?.rollbackOf || null,
    state: "prepared",
    idempotencyKey,
    attempts: 0,
    recoverable: false,
    failure: null,
  };
  await mkdir(packageDirectory, { recursive: true });
  const manifestPath = path.join(packageDirectory, "content-release.json");
  if (await exists(manifestPath)) {
    const existing = JSON.parse(await readFile(manifestPath, "utf8"));
    if (existing.contentHash !== contentHash || existing.target !== target || existing.kind !== kind || (existing.logicalContentId && existing.logicalContentId !== manifest.logicalContentId)) {
      throw new Error(`content release package identity conflict: ${contentReleaseId}`);
    }
    if (existing.baseSiteArtifactId && immutableArtifact && existing.baseSiteArtifactId !== immutableArtifact.baseSiteArtifactId || (existing.idempotencyKey && existing.idempotencyKey !== idempotencyKey && existing.baseSiteArtifactId === immutableArtifact?.baseSiteArtifactId)) {
      throw new Error(`content release immutable identity conflict: ${contentReleaseId}`);
    }
    Object.assign(manifest, existing, { idempotencyKey, state: existing.state || "prepared", attempts: existing.attempts || 0, recoverable: existing.recoverable || false, failure: existing.failure || null });
    await writeJsonAtomically(manifestPath, manifest);
  } else {
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  if (changeSet) {
    await linkContentChangeSetRelease(changeSet.file, {
      contentReleaseId,
      releasePackage: manifest.releasePackage,
      rootDirectory: sourceRoot,
    });
  }
  const sourceDirectory = path.join(packageDirectory, "source");
  const independentContentRoot = contentRootDirectory({ sourceRoot });
  if (!(await exists(independentContentRoot))) throw new Error("independent content root is missing");
  await cp(independentContentRoot, path.join(sourceDirectory, ".content-workspace", "content"), { recursive: true });
  const independentMediaRoot = path.join(independentContentRoot, "media");
  if (await exists(independentMediaRoot)) {
    for (const entry of await readdir(independentMediaRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) await cp(path.join(independentMediaRoot, entry.name), path.join(sourceDirectory, "public", "media", entry.name), { recursive: true, force: true });
    }
  }
  const sourceOverlayRelative = path.join(".content-workspace", "content", content.relative.slice("content/".length));
  const sourceFile = path.join(sourceDirectory, sourceOverlayRelative);
  await mkdir(path.dirname(sourceFile), { recursive: true });
  if (changeSet && contentChangeSetOperations(changeSet).some((operation) => operation.sourcePath === content.relative)) await writeFile(sourceFile, `${JSON.stringify(content.value, null, 2)}\n`);
  else await cp(content.file, sourceFile);
  if (kind === "practice") {
    const mediaManifest = path.join(sourceDirectory, ".content-workspace", "content", "media", target, "manifest.json");
    if (content.practiceBundle?.manifest && changeSet && contentChangeSetOperations(changeSet).some((operation) => operation.sourcePath === "content/media/robotaxi/manifest.json")) {
      await mkdir(path.dirname(mediaManifest), { recursive: true });
      await writeFile(mediaManifest, `${JSON.stringify(content.practiceBundle.manifest, null, 2)}\n`);
    } else if (await exists(path.join(contentRootDirectory({ sourceRoot }), "media", target, "manifest.json"))) {
      await mkdir(path.dirname(mediaManifest), { recursive: true });
      await cp(path.join(contentRootDirectory({ sourceRoot }), "media", target, "manifest.json"), mediaManifest);
    }
  }
  if (kind === "content" || kind === "practice") {
    const mediaRoot = path.join(contentRootDirectory({ sourceRoot }), "media", target);
    const publicMediaRoot = path.join(sourceRoot, "public", "media", target);
    if (await exists(mediaRoot)) await cp(mediaRoot, path.join(sourceDirectory, ".content-workspace", "content", "media", target), { recursive: true });
    if (await exists(publicMediaRoot)) await cp(publicMediaRoot, path.join(sourceDirectory, "public", "media", target), { recursive: true });
  }
  if (kind === "practice" && content.practiceBundle?.manifest && changeSet && contentChangeSetOperations(changeSet).some((operation) => operation.sourcePath === "content/media/robotaxi/manifest.json")) {
    const mediaManifest = path.join(sourceDirectory, ".content-workspace", "content", "media", target, "manifest.json");
    await mkdir(path.dirname(mediaManifest), { recursive: true });
    await writeFile(mediaManifest, `${JSON.stringify(content.practiceBundle.manifest, null, 2)}\n`);
  }
  const withProof = await attachLifecycleProof({ manifest, packageDirectory, sourceRoot, changeSet });
  if (withProof.state === "prepared") await appendContentReleaseLog({ sourceRoot, contentReleaseId, event: "prepared", data: { baseSiteArtifactId: immutableArtifact?.baseSiteArtifactId || null, changeSetId: changeSet?.changeId || null, intent: "independent-content" } });
  return { ...withProof, packageDirectory, manifestPath, sourceDirectory, sourceFile, sourceRoot };
}

// Batch planning is intentionally separate from transport: callers can inspect
// the deterministic plan before creating any SitePublication or deployment.
export function prepareContentBatch(intents, constraints) {
  return planContentBatch(intents, constraints);
}

async function appendContentReleaseLog({ sourceRoot, contentReleaseId, event, data = {} }) {
  const logDirectory = path.join(sourceRoot, ".content-workspace", "logs");
  await mkdir(logDirectory, { recursive: true });
  await appendFile(path.join(logDirectory, `${contentReleaseId}.jsonl`), `${JSON.stringify({ event, contentReleaseId, at: new Date().toISOString(), ...data })}\n`);
}

async function stageRepository({ packageInfo, sourceRoot }) {
  if (packageInfo.baseSiteArtifact?.materializationKind === "client") throw new Error("canonical content-only publication does not assemble from sourceDirectory; use ContentSet/ContentDataArtifact materialization");
  const baseSource = packageInfo.baseSiteArtifact?.sourceDirectory;
  if (!baseSource || path.resolve(baseSource) === path.resolve(sourceRoot)) throw new Error("content staging requires an immutable baseSiteArtifact source bundle");
  if (!(await isFile(path.join(baseSource, "package.json")))) throw new Error("baseSiteArtifact source bundle is not buildable");
  const staging = await fsMkdtemp("xingbuild-content-stage-");
  await cp(baseSource, staging, { recursive: true });
  await symlink(path.join(sourceRoot, "node_modules"), path.join(staging, "node_modules"), "dir");
  for (const entry of await readdir(packageInfo.sourceDirectory, { withFileTypes: true })) {
    await cp(path.join(packageInfo.sourceDirectory, entry.name), path.join(staging, entry.name), { recursive: true, force: true });
  }
  const independentMediaRoot = path.join(sourceRoot, ".content-workspace", "content", "media");
  if (await exists(independentMediaRoot)) {
    for (const entry of await readdir(independentMediaRoot, { withFileTypes: true })) {
      if (entry.isDirectory()) await cp(path.join(independentMediaRoot, entry.name), path.join(staging, "public", "media", entry.name), { recursive: true, force: true });
    }
  }
  return staging;
}

async function fsMkdtemp(prefix) {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function buildContentRelease({ packageInfo, sourceRoot = root } = {}) {
  if (!packageInfo?.packageDirectory) throw new Error("content build requires a prepared content package");
  const existingManifest = JSON.parse(await readFile(packageInfo.manifestPath, "utf8"));
  const existingClient = path.join(packageInfo.packageDirectory, "dist", "client");
  if (canResumeState(existingManifest.state, "built") && await exists(path.join(existingClient, "content-manifest.json"))) {
    return { ...packageInfo, ...existingManifest, client: existingClient, manifest: existingManifest };
  }
  if (!packageInfo.baseSiteArtifact) {
    const targetCollections = receiptTargetCollections(packageInfo, { packageDirectory: packageInfo.packageDirectory });
    const manifest = {
      ...existingManifest,
      ...targetCollections,
      intentType: "ContentReleaseIntent",
      buildType: "content-intent",
    };
    const builtReceipt = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "built", {
      ...targetCollections,
      intentType: "ContentReleaseIntent",
      buildType: "content-intent",
      attempts: (manifest.attempts || 0) + 1,
      recoverable: false,
      failure: null,
    });
    const packageClient = path.join(packageInfo.packageDirectory, "dist", "client");
    await mkdir(packageClient, { recursive: true });
    await writeFile(path.join(packageClient, "content-manifest.json"), `${JSON.stringify(builtReceipt, null, 2)}\n`);
    await writeJsonAtomically(path.join(packageInfo.packageDirectory, "content-intent.json"), { ...builtReceipt, sourceDirectory: packageInfo.sourceDirectory, preparedAt: new Date().toISOString() });
    return { ...packageInfo, ...builtReceipt, client: packageClient, manifest: builtReceipt };
  }
  if (packageInfo.baseSiteArtifact.materializationKind === "client") {
    /* Canonical content-only builds never reconstruct a ProductArtifact from
       sourceDirectory.  The immutable client is the only product input; the
       content receipt is layered in the package's temporary client copy and
       the Coordinator later materializes ContentDataArtifact references. */
    const immutableClient = path.resolve(sourceRoot, packageInfo.baseSiteArtifact.clientPath || "");
    if (!(await isFile(path.join(immutableClient, "release.json")))) {
      throw new Error("immutable ProductArtifact client materialization is missing release.json");
    }
    const targetCollections = receiptTargetCollections(packageInfo, { packageDirectory: packageInfo.packageDirectory });
    const manifest = { ...existingManifest, ...targetCollections };
    const builtReceipt = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "built", {
      ...targetCollections,
      attempts: (manifest.attempts || 0) + 1,
      recoverable: false,
      failure: null,
    });
    const packageClient = path.join(packageInfo.packageDirectory, "dist", "client");
    await rm(packageClient, { recursive: true, force: true });
    await mkdir(path.dirname(packageClient), { recursive: true });
    await cp(immutableClient, packageClient, { recursive: true, force: false });
    await writeFile(path.join(packageClient, "content-manifest.json"), `${JSON.stringify(builtReceipt, null, 2)}\n`);
    await appendContentReleaseLog({ sourceRoot, contentReleaseId: packageInfo.contentReleaseId, event: "built", data: { baseSiteArtifactId: packageInfo.baseSiteArtifactId, materializationKind: "client" } });
    return { ...packageInfo, ...builtReceipt, client: packageClient, manifest: builtReceipt, materializationKind: "client" };
  }
  const staging = await stageRepository({ packageInfo, sourceRoot });
  try {
    run("npm", ["run", "build"], staging, {
      ...process.env,
      XINGBUILD_PRODUCT_COMMIT: packageInfo.baseSiteArtifact.productCommit,
      XINGBUILD_PRODUCT_VERSION: packageInfo.baseSiteArtifact.productVersion,
      XINGBUILD_CONTENT_BUILD: "1",
    });
    const client = path.join(staging, "dist", "client");
    const targetCollections = receiptTargetCollections(packageInfo, { packageDirectory: packageInfo.packageDirectory });
    const manifest = {
      ...existingManifest,
      ...targetCollections,
    };
    const builtReceipt = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "built", { ...targetCollections, attempts: (manifest.attempts || 0) + 1, recoverable: false, failure: null });
    await writeFile(path.join(client, "content-manifest.json"), `${JSON.stringify(builtReceipt, null, 2)}\n`);
    const packageClient = path.join(packageInfo.packageDirectory, "dist", "client");
    await mkdir(path.dirname(packageClient), { recursive: true });
    await cp(client, packageClient, { recursive: true });
    await appendContentReleaseLog({ sourceRoot, contentReleaseId: packageInfo.contentReleaseId, event: "built", data: { baseSiteArtifactId: packageInfo.baseSiteArtifactId } });
    return { ...packageInfo, ...builtReceipt, client: packageClient, manifest: builtReceipt };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function verifyContentPackageOnce({ baseUrl = publicUrl, manifest, fetchImpl = fetch } = {}) {
  const publicBase = new URL(baseUrl);
  const [pageResponse, releaseResponse, manifestResponse, targetResponse] = await Promise.all([
    fetchImpl(publicBase, { redirect: "follow", cache: "no-store" }),
    fetchImpl(new URL("/release.json", publicBase), { redirect: "follow", cache: "no-store" }),
    fetchImpl(new URL("/content-manifest.json", publicBase), { redirect: "follow", cache: "no-store" }),
    fetchImpl(new URL(manifest.targetPath, publicBase), { redirect: "follow", cache: "no-store" }),
  ]);
  if (![pageResponse, releaseResponse, manifestResponse, targetResponse].every((response) => response.ok)) {
    throw new Error(`content public verification HTTP page=${pageResponse.status} release=${releaseResponse.status} manifest=${manifestResponse.status} target=${targetResponse.status}`);
  }
  const publicManifest = await manifestResponse.json();
  if (Array.isArray(manifest.activeContentReleaseIds)) {
    const actual = new Set(publicManifest.activeContentReleaseIds || []);
    const expected = new Set(manifest.activeContentReleaseIds);
    if (!actual.has(manifest.contentReleaseId) || [...expected].some((id) => !actual.has(id))) throw new Error("public combined manifest does not retain active content releases and candidate");
    if (manifest.target && !publicManifest.publishedSlugs?.includes(manifest.target) && !publicManifest.publishedArticleSlugs?.includes(manifest.target)) throw new Error("public combined manifest does not contain candidate target");
  } else if (publicManifest.contentReleaseId !== manifest.contentReleaseId || publicManifest.target !== manifest.target || publicManifest.contentHash !== manifest.contentHash) {
    throw new Error("public content manifest does not match the prepared content identity");
  }
  if (manifest.baseSiteArtifactId && publicManifest.baseSiteArtifactId !== manifest.baseSiteArtifactId) {
    throw new Error("public content manifest does not match the immutable baseSiteArtifact");
  }
  if (manifest.baseSiteArtifact) {
    const publicRelease = await releaseResponse.json();
    if (publicRelease.version !== manifest.baseSiteArtifact.productVersion || publicRelease.commit !== manifest.baseSiteArtifact.productCommit) {
      throw new Error("public release does not match the immutable baseSiteArtifact");
    }
  }
  const page = await pageResponse.text();
  const target = await targetResponse.text();
  if (!page.includes("<title>xingbuild") || !target.includes("<title>xingbuild")) throw new Error("public content pages do not identify xingbuild");
  return { contentReleaseId: manifest.contentReleaseId, activeContentReleaseIds: manifest.activeContentReleaseIds || [], target: manifest.target, publicUrl: new URL(manifest.targetPath, publicBase).href };
}

export async function verifyContentPackage({ manifest, baseUrl = publicUrl, fetchImpl = fetch, maxAttempts = 5, delayMs = 1000, sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  const startedAt = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return { ...(await verifyContentPackageOnce({ baseUrl, manifest, fetchImpl })), elapsedMs: Date.now() - startedAt, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts) break;
      await sleepImpl(delayMs * attempt);
    }
  }
  const error = new Error(`content public verification exhausted ${maxAttempts} attempts after ${Date.now() - startedAt}ms: ${lastError?.message || "unknown error"}`);
  error.recoverable = true;
  throw error;
}

export function assertContentPackageIdentity(packageInfo, manifest) {
  if (manifest.contentReleaseId !== packageInfo.contentReleaseId || manifest.contentHash !== packageInfo.contentHash) throw new Error("content release package identity mismatch");
  if (packageInfo.logicalContentId && manifest.logicalContentId !== packageInfo.logicalContentId) throw new Error("content logical identity mismatch");
  if (manifest.changeSetId && (!Array.isArray(manifest.changedTargets) || !Array.isArray(manifest.operations) || manifest.changedTargets.length !== manifest.operations.length)) throw new Error("content ChangeSet lineage is incomplete");
  if (manifest.baseSiteArtifact && manifest.baseSiteArtifact.baseSiteArtifactId !== manifest.baseSiteArtifactId) throw new Error("content release embedded baseSiteArtifact identity mismatch; reconcile is required");
  if (manifest.packageRevisionId && manifest.packageRevisionId !== packageInfo.packageRevisionId) throw new Error("content package revision identity mismatch");
  if (manifest.proofEnvelope) {
    const proof = manifest.proofEnvelope;
    if (proof.logicalContentId !== manifest.logicalContentId || proof.kind !== manifest.kind || proof.target !== manifest.target) throw new Error("content package proof identity mismatch");
    if (proof.afterHash !== manifest.contentHash || (manifest.afterHash && manifest.afterHash !== proof.afterHash) || (manifest.beforeHash && manifest.beforeHash !== proof.beforeHash)) throw new Error("content package proof hash mismatch");
    if (proof.changeSetId !== (manifest.changeSetId || null)) throw new Error("content package proof ChangeSet identity mismatch");
    if (!proof.reviewEnvelope || proof.reviewEnvelope.logicalContentId !== manifest.logicalContentId || proof.reviewEnvelope.afterHash !== manifest.contentHash) throw new Error("content package proof review envelope is incomplete");
    if (!proof.recoveryEnvelope) throw new Error("content package proof recovery envelope is missing");
  }
  return true;
}

export async function transportContentRelease({ packageInfo, argv = process.argv.slice(2), env = process.env } = {}) {
  const manifest = JSON.parse(await readFile(packageInfo.manifestPath, "utf8"));
  assertContentPackageIdentity(packageInfo, manifest);
  assertFixedPublishTarget(env);
  assertPublishAuthorization({ argv, env });
  const idempotencyKey = manifest.idempotencyKey || contentReleaseIdempotencyKey({ contentReleaseId: manifest.contentReleaseId, contentHash: manifest.contentHash, baseSiteArtifactId: manifest.baseSiteArtifactId });
  const lease = await acquireContentReleasePackageLease({ packageDirectory: packageInfo.packageDirectory, idempotencyKey, contentReleaseId: manifest.contentReleaseId });
  let completedPublication = null;
  try {
    if (manifest.state === "released" && manifest.publicVerify) {
      const receipt = await readContentReleaseReceipt(packageInfo.packageDirectory);
      if (!receipt) throw new Error("released content package is missing its ContentReleaseReceipt");
      return { ...manifest, receipt, publicVerify: manifest.publicVerify };
    }
    const currentProductClient = path.join(root, "dist", "client");
    const currentRelease = JSON.parse(await readFile(path.join(currentProductClient, "release.json"), "utf8"));
    const currentArtifactDocument = JSON.parse(await readFile(path.join(currentProductClient, "base-site-artifact.json"), "utf8"));
    const currentArtifact = currentRelease.schemaVersion === "product-artifact-release-v2"
      ? await readProductArtifact({ clientDirectory: currentProductClient, sourceRoot: root, version: currentRelease.productVersion, commit: currentRelease.productCommit })
      : currentArtifactDocument;
    const immutableRevisionBaseProvenance = Boolean(
      manifest.packageRevisionId
      && (manifest.baseSiteArtifact?.baseSiteArtifactId || manifest.baseSiteArtifact?.clientPath?.split("/").at(-3)) === manifest.baseSiteArtifactId,
    );
    if (manifest.baseSiteArtifactId
      && manifest.baseSiteArtifactId !== currentArtifact.baseSiteArtifactId
      && !immutableRevisionBaseProvenance) {
      throw new Error("content package baseSiteArtifact is not the current immutable product artifact; reconcile is required");
    }
    const publication = await createSitePublication({
      productClient: currentProductClient,
      releasesRoot: path.join(root, ".content-workspace", "releases"),
      publicationRoot: path.join(root, ".content-workspace", "site-publications"),
      additionalContentManifest: manifest,
      candidatePackageDirectory: packageInfo.packageDirectory,
      assemble: false,
      sourceRoot: root,
    });
    await validateUploadQuota(publication.client);
    completedPublication = await transportSitePublication({
      publication,
      sourceRoot: root,
      argv,
      env,
      edgeonePath: edgeone,
    });
    const projectedReceipt = completedPublication.publicVerify?.contentManifest?.contentReleaseReceipts?.find((item) => item.contentReleaseId === manifest.contentReleaseId) || null;
    const projectedLifecycleTimes = resolveContentLifecycleTimes(projectedReceipt || manifest, { now: () => "1970-01-01T00:00:00.000Z" });
    const transported = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "transported", {
      sitePublicationId: completedPublication.sitePublicationId,
      deploymentId: completedPublication.deploymentId,
      // A prepared immutable revision keeps its original package/base
      // provenance. The new ProductArtifact is recorded by SitePublication;
      // resume must not rewrite the revision manifest's identity fields.
      ...(immutableRevisionBaseProvenance ? {} : {
        baseSiteArtifactId: completedPublication.contentManifest?.baseSiteArtifactId || manifest.baseSiteArtifactId || null,
        baseProductVersion: currentRelease.productVersion || currentRelease.version,
        baseProductCommit: currentRelease.productCommit || currentRelease.commit,
      }),
      ...projectedLifecycleTimes,
      transportedAt: new Date().toISOString(),
      attempts: (manifest.attempts || 0) + 1,
      recoverable: false,
      failure: null,
    });
    const verifying = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "verifying", { deploymentId: transported.deploymentId, sitePublicationId: transported.sitePublicationId, publicVerify: completedPublication.publicVerify, recoverable: false });
    const verified = verifying;
    const finalized = await finalizeContentRelease({ ...packageInfo, ...verified, ...projectedLifecycleTimes, lineageBinding: completedPublication.lineageBinding || null });
    const finalizedManifest = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "finalized", { ...finalized.lifecycleTimes, completionPath: finalized.completionPath, recoverable: false });
    await writeJsonAtomically(path.join(packageInfo.packageDirectory, "dist", "client", "content-manifest.json"), finalizedManifest);
    const completed = await updateReleaseState({ ...packageInfo, manifestPath: packageInfo.manifestPath }, "released", { publicVerify: finalizedManifest.publicVerify, recoverable: false, failure: null });
    await appendContentReleaseLog({ sourceRoot: packageInfo.sourceRoot || root, contentReleaseId: packageInfo.contentReleaseId, event: "released", data: { deploymentId: completed.deploymentId } });
    return { ...completed, deployment: completedPublication.deployment, publicVerify: completed.publicVerify, sitePublicationId: completed.sitePublicationId };
  } catch (error) {
    const transition = completedPublication?.contentSlotTransition;
    if (transition?.type === "compare-and-swap" && transition.previousSlot) {
      await restoreContentSlot({
        sourceRoot: root,
        logicalContentId: transition.logicalContentId,
        expectedReceiptId: transition.activeReceiptId,
        previousSlot: transition.previousSlot,
      }).catch(() => {});
    }
    await markReleaseFailure(packageInfo, error);
    throw error;
  } finally {
    await releaseContentReleasePackageLease(lease);
  }
}

export async function resumeContentRelease({ packageDirectory, argv = ["--authorize-publish"], env = process.env } = {}) {
  if (!packageDirectory) throw new Error("content release resume requires packageDirectory");
  const manifestPath = path.join(packageDirectory, "content-release.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (!manifest.contentReleaseId || !manifest.contentHash) throw new Error("content release resume requires immutable content intent identity");
  return transportContentRelease({ packageInfo: { ...manifest, manifestPath, packageDirectory, client: path.join(packageDirectory, "dist", "client"), sourceRoot: root }, argv, env });
}

export async function publishLegacyContent({ kind, target, changeSetPath, baseSiteArtifact, artifactPath, argv = process.argv.slice(2), env = process.env } = {}) {
  const prepared = await prepareContentRelease({ kind, target, changeSetPath, baseSiteArtifact, artifactPath });
  const built = await buildContentRelease({ packageInfo: prepared });
  return transportContentRelease({ packageInfo: built, argv, env });
}

async function prepareContentSetEntry({ kind, target, changeSetPath = null, sourceRoot = root } = {}) {
  const content = await readTarget({ kind, target, sourceRoot });
  const reviewEvidence = await readReview({ kind, target, sourceRoot, content });
  let contentValue = content.value;
  let mediaManifest = content.practiceBundle?.manifest;
  if (changeSetPath) {
    const changeSet = await readContentChangeSet(changeSetPath, { rootDirectory: sourceRoot });
    const documents = {
      [content.relative]: content.value,
      "content/products/robotaxi.json": content.value,
      "content/media/robotaxi/manifest.json": mediaManifest,
    };
    const staged = applyContentChangeSetDocuments(documents, changeSet);
    contentValue = staged[content.relative] || staged["content/products/robotaxi.json"] || content.value;
    mediaManifest = staged["content/media/robotaxi/manifest.json"] || mediaManifest;
  }
  const entry = await contentSetEntryFromCanonical({
    sourceRoot,
    kind,
    target,
    contentValue,
    mediaManifest,
    sourceProof: kind === "home"
      ? ["canonical:content/home.json"]
      : sourceIds(content.value),
    allowStagedValue: Boolean(changeSetPath),
    reviewProof: {
      reviewId: reviewEvidence.review?.reviewId || null,
      reviewedAt: reviewEvidence.reviewedAt || null,
      status: "approved",
    },
    legacyAuditId: null,
  });
  return { entry, contentValue };
}

export async function prepareContentSetCandidate({ kind, target, changeSetPath = null, sourceRoot = root } = {}) {
  const prepared = await prepareContentSetEntry({ kind, target, changeSetPath, sourceRoot });
  const homePayload = kind === "home" ? prepared.contentValue : null;
  return writeContentSetCandidate({ sourceRoot, entries: [prepared.entry], homeContent: homePayload });
}

/**
 * Prepare one immutable ContentSet Candidate for a confirmed batch. The
 * physical content publisher may later consume this single identity; preview
 * and preparation never activate it or create a deployment.
 */
export async function prepareContentSetCandidateBatch({ targets = [], sourceRoot = root } = {}) {
  if (!Array.isArray(targets) || targets.length === 0) throw new Error("content batch requires at least one target");
  const prepared = [];
  const seen = new Set();
  for (const spec of targets) {
    const key = `${spec?.kind || ""}:${spec?.target || ""}`;
    if (seen.has(key)) throw new Error(`content batch duplicate target: ${key}`);
    seen.add(key);
    prepared.push(await prepareContentSetEntry({
      kind: spec?.kind,
      target: spec?.target,
      changeSetPath: spec?.changeSetPath || null,
      sourceRoot,
    }));
  }
  const home = prepared.find((item) => item.entry.entryId === "home:home");
  return writeContentSetCandidate({
    sourceRoot,
    entries: prepared.map((item) => item.entry),
    homeContent: home?.contentValue || null,
  });
}

export async function publishContentSet({ kind, target, changeSetPath = null, argv = process.argv.slice(2), env = process.env, sourceRoot = root } = {}) {
  const prepared = await prepareContentSetCandidate({ kind, target, changeSetPath, sourceRoot });
  const productClient = path.join(sourceRoot, "dist", "client");
  const publication = await createSitePublication({
    productClient,
    releasesRoot: path.join(sourceRoot, ".content-workspace", "releases"),
    publicationRoot: path.join(sourceRoot, ".content-workspace", "site-publications"),
    candidateContentSetId: prepared.contentSet.contentSetId,
    assemble: false,
    sourceRoot,
  });
  await validateUploadQuota(publication.client);
  return transportSitePublication({ publication, sourceRoot, argv, env, edgeonePath: path.join(sourceRoot, "node_modules", ".bin", "edgeone") });
}

export async function publishContent(options = {}) {
  if (options.env?.XINGBUILD_LEGACY_RUNTIME === "1") return publishLegacyContent(options);
  return publishContentSet(options);
}

async function main(argv = process.argv.slice(2)) {
  const valueFor = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || null : null;
  };
  const kind = valueFor("--kind") || "content";
  const target = valueFor("--slug") || valueFor("--id");
  const changeSetPath = valueFor("--change-set");
  const artifactPath = valueFor("--base-site-artifact");
  const packageDirectory = valueFor("--package");
  const contentReleaseId = valueFor("--release");
  const batchPath = valueFor("--batch");
  if (batchPath) {
    if (!argv.includes("--prepare") && !argv.includes("--build")) {
      throw new Error("content batch only supports explicit --prepare or --build; publish remains a separate authorized action");
    }
    const batch = JSON.parse(await readFile(path.resolve(root, batchPath), "utf8"));
    const result = await prepareContentSetCandidateBatch({ targets: batch, sourceRoot: root });
    console.log(`ContentSet batch candidate ${argv.includes("--build") ? "built" : "prepared"}: ${result.contentSet.contentSetId}`);
    return;
  }
  if (argv.includes("--reconcile")) {
    if (!contentReleaseId || !artifactPath) throw new Error("Usage: node scripts/content-release.mjs --reconcile --release <contentReleaseId> --base-site-artifact <immutableBaseSiteArtifactId>");
    const reconciled = await reconcileContentPackage({ sourceRoot: root, contentReleaseId, baseSiteArtifactId: artifactPath });
    const plan = prepareContentBatch([{ ...reconciled, review: { approved: true }, fileCount: 1, totalBytes: 0, maxFileBytes: 0 }]);
    await writeJsonAtomically(path.join(reconciled.packageDirectory, "content-batch-plan.json"), plan);
    console.log(JSON.stringify({ contentReleaseId: reconciled.contentReleaseId, packageRevisionId: reconciled.packageRevisionId, packageDirectory: reconciled.packageDirectory, planId: plan.planId, reused: reconciled.reused }));
    return;
  }
  if (argv.includes("--resume")) {
    if (!packageDirectory) throw new Error("Usage: node scripts/content-release.mjs --resume --package <dir> [--authorize-publish]");
    const result = await resumeContentRelease({ packageDirectory, argv });
    console.log(JSON.stringify({ contentReleaseId: result.contentReleaseId, sitePublicationId: result.sitePublicationId || null, deploymentId: result.deploymentId || null, publicVerify: result.publicVerify || null }));
    return;
  }
  if (!kinds.has(kind) || !target || !slugPattern.test(target)) throw new Error("Usage: node scripts/content-release.mjs [--prepare|--build] --kind <content|article|practice|profile|businessObservation> --slug <slug>|--id <id> [--change-set <ignored ChangeSet>] [--authorize-publish]");
  if (argv.includes("--prepare")) {
    const result = await prepareContentSetCandidate({ kind, target, changeSetPath });
    console.log(`ContentSet candidate prepared: ${result.contentSet.contentSetId}`);
    return;
  }
  if (argv.includes("--build")) {
    const result = await prepareContentSetCandidate({ kind, target, changeSetPath });
    console.log(`ContentSet candidate built: ${result.contentSet.contentSetId}`);
    return;
  }
  const result = await publishContentSet({ kind, target, changeSetPath, argv });
  console.log(`ContentSet publication completed: ${result.sitePublicationId}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { await main(); } catch (error) {
    console.error(`内容发布已停止：${error.message}`);
    process.exitCode = 1;
  }
}
