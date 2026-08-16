import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { acquireContentReleasePackageLease, releaseContentReleasePackageLease } from "./content-release-state.mjs";
import { writeJsonAtomically } from "./content-release-state.mjs";
import {
  assertActiveContentProjection,
  contentTargetCollectionNames,
  createActiveContentProjection,
  createImmutableContentReceiptProjection,
  readContentReleaseReceipt,
  receiptTargetCollections,
} from "./content-release-receipt.mjs";
import { contentLogicalSlotId, validateContentReplacement } from "./content-replacement.mjs";
import { compareAndSwapContentSlot, contentReceiptId, contentLogicalContentId, ensureContentSlotRegistry, resolveContentSlotCandidate } from "./content-slot-registry.mjs";
import { assertContentSlotArtifactCompatible } from "./base-site-artifact.mjs";
import { assertBindingCandidate, createOrReusePublicationLineageBinding } from "./publication-lineage-binding.mjs";
import {
  contentManifestFromContentSet,
  readContentSet,
} from "./content-set.mjs";
import { createSiteSnapshot, productArtifactIdentity } from "./site-snapshot.mjs";
import { createPublicationRun, publicationRunIdForSnapshot, readPublicationRun, writePublicationRun } from "./publication-run.mjs";
import { readProductArtifact, resolveProductArtifactIdentity } from "./product-artifact.mjs";
import { writePublicationAssetManifest } from "./publication-assets.mjs";
import { assertPublicationPhaseAggregate, PUBLICATION_RUNTIME_EVIDENCE_V4 } from "./publication-evidence.mjs";
import { assertDurableSitePublicationRecord, sanitizeDurableSitePublicationRecord } from "./content-lifecycle-governance.mjs";
import { contentDataManifestHash, prepareContentOnlyMaterialization } from "./content-data-plane.mjs";
import {
  assertContentPublicationIntent,
  assertIntentReferences,
  readContentPublicationAuthority,
} from "./content-publication-intent.mjs";

export function sitePublicationId({ productVersion, productCommit, contentReleaseIds = [], contentSetId = null } = {}) {
  return [productVersion, productCommit, ...(contentSetId ? [contentSetId] : contentReleaseIds)].join("+");
}

export function sitePublicationIdempotencyKey({ sitePublicationId: id, snapshotHash = null } = {}) {
  if (typeof id !== "string" || !id) throw new Error("sitePublicationId is required");
  return createHash("sha256").update(`${id}:${snapshotHash || "site-publication-v1"}`).digest("hex");
}

export async function acquireSitePublicationLease({ publicationDirectory, leaseDirectory = publicationDirectory, sitePublicationId: id, snapshotHash = null, now, ttlMs } = {}) {
  return acquireContentReleasePackageLease({ packageDirectory: leaseDirectory, idempotencyKey: sitePublicationIdempotencyKey({ sitePublicationId: id, snapshotHash }), contentReleaseId: id, now, ttlMs });
}

export const releaseSitePublicationLease = releaseContentReleasePackageLease;

function inferredSourceRoot(releasesRoot) {
  const resolved = path.resolve(releasesRoot);
  return path.basename(path.dirname(resolved)) === ".content-workspace"
    ? path.resolve(resolved, "..", "..")
    : path.resolve(resolved, "..");
}

function resolveSourceRootForReleases(releasesRoot, sourceRoot) {
  const candidate = path.resolve(sourceRoot || inferredSourceRoot(releasesRoot));
  const releases = path.resolve(releasesRoot);
  return releases === candidate || releases.startsWith(`${candidate}${path.sep}`) ? candidate : inferredSourceRoot(releasesRoot);
}

export async function validateUploadQuota(directory, { maxFiles = 10000, maxFileBytes = 50 * 1024 * 1024, maxTotalBytes = 500 * 1024 * 1024 } = {}) {
  let files = 0;
  let totalBytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (entry.isFile()) {
        files += 1;
        const bytes = (await stat(file)).size;
        if (bytes > maxFileBytes) throw new Error(`upload quota exceeded: file ${entry.name} exceeds max single file size`);
        totalBytes += bytes;
        if (files > maxFiles || totalBytes > maxTotalBytes) throw new Error("upload quota exceeded");
      }
    }
  }
  await walk(directory);
  return { files, totalBytes };
}

export async function readActiveContentReleases(releasesRoot, { sourceRoot, productArtifactId = null } = {}) {
  const resolvedSourceRoot = resolveSourceRootForReleases(releasesRoot, sourceRoot);
  const registry = await ensureContentSlotRegistry({ sourceRoot: resolvedSourceRoot, releasesRoot });
  const active = [];
  for (const slot of registry.slots) {
    let packageDirectory = path.resolve(resolvedSourceRoot, slot.activePackageDirectory);
    if (!(await stat(path.join(packageDirectory, "content-release.json")).catch(() => null))) {
      // Registries created by the first v0.25.16 migration stored paths
      // relative to `.content-workspace`; accept that representation while
      // the new source-root-relative format is rolled forward.
      packageDirectory = path.resolve(resolvedSourceRoot, ".content-workspace", slot.activePackageDirectory);
    }
    const receipt = await readContentReleaseReceipt(packageDirectory);
    if (!receipt) throw new Error(`content slot registry active receipt is missing or not released: ${slot.logicalContentId}`);
    if (contentReceiptId(receipt) !== slot.activeReceiptId) {
      throw new Error(`content slot registry active receipt identity drift: ${slot.logicalContentId}`);
    }
    if (contentLogicalContentId(receipt) !== slot.logicalContentId) {
      throw new Error(`content slot registry logical identity drift: ${slot.logicalContentId}`);
    }
    const sourceDirectory = path.join(packageDirectory, "source");
    const completionBinding = receipt.completion?.lineageBinding || null;
    if (completionBinding) assertBindingCandidate(completionBinding, receipt);
    const receiptForProjection = {
      ...receipt,
      logicalContentId: slot.logicalContentId,
      receiptId: slot.activeReceiptId,
    };
    const mediaPaths = await collectMediaPaths(sourceDirectory);
    const projection = createActiveContentProjection({
      receipt: receiptForProjection,
      activeSlot: { ...slot, registryRevision: registry.registryRevision },
      lineageBinding: completionBinding,
      productArtifactId: productArtifactId || receipt.baseSiteArtifactId || slot.activeBaseSiteArtifactId || null,
      registryRevision: registry.registryRevision,
      mediaPaths,
    });
    active.push({
      ...receipt,
      logicalContentId: slot.logicalContentId,
      predecessorReceiptId: projection.predecessorReceiptId || null,
      supersedesPackageId: projection.supersedesPackageId || null,
      lineageBindingId: completionBinding?.lineageBindingId || receipt.completion?.lineageBindingId || null,
      lineageBinding: completionBinding,
      receiptId: slot.activeReceiptId,
      registrySlot: slot,
      receiptHash: receipt.receiptHash,
      projectionHash: projection.projectionHash,
      projection,
      packageDirectory,
      sourceDirectory,
      mediaPaths: projection.mediaPaths,
    });
  }
  return active.sort((a, b) => a.logicalContentId.localeCompare(b.logicalContentId));
}

async function collectMediaPaths(sourceDirectory) {
  const mediaRoot = path.join(sourceDirectory || "", ".content-workspace", "content", "media");
  const paths = new Set();
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile() && entry.name.endsWith(".json")) {
        try {
          const value = JSON.parse(await readFile(file, "utf8"));
          for (const asset of value.assets || []) {
            if (typeof asset.src === "string" && asset.src.startsWith("/")) paths.add(asset.src);
          }
        } catch { /* non-media JSON is not a media manifest */ }
      }
    }
  }
  await walk(mediaRoot);
  return [...paths].sort();
}

function receiptSourceRelative(receipt) {
  const directory = receipt.kind === "content" ? "observations"
    : receipt.kind === "article" ? "articles"
      : receipt.kind === "profile" ? "profile"
        : receipt.kind === "businessObservation" ? "business-observations"
          : "products";
  return path.join(directory, `${receipt.target}.json`);
}

async function copyFileRequired(source, destination, errorMessage) {
  if (!(await stat(source).catch(() => null))) throw new Error(errorMessage);
  await mkdir(path.dirname(destination), { recursive: true });
  await cp(source, destination, { force: true });
}

async function assembleContentSources({ staging, activeContentReleases }) {
  const contentDestination = path.join(staging, ".content-workspace", "content");
  let contentSources = 0;
  for (const receipt of activeContentReleases) {
    const source = receipt.sourceDirectory || path.join(receipt.packageDirectory || "", "source");
    const contentRoot = path.join(source, ".content-workspace", "content");
    if (!(await stat(contentRoot).catch(() => null))) {
      throw new Error(`active content source is missing: ${receipt.contentReleaseId}`);
    }
    const relative = receiptSourceRelative(receipt);
    const sourceFile = path.join(contentRoot, relative);
    await copyFileRequired(sourceFile, path.join(contentDestination, relative), `active content target source is missing: ${receipt.contentReleaseId}`);
    if (!receipt.changeSetId) {
      const sourceHash = createHash("sha256").update(await readFile(sourceFile)).digest("hex");
      if (sourceHash !== receipt.contentHash) throw new Error(`active content source hash does not match receipt: ${receipt.contentReleaseId}`);
    }
    const mediaManifestRoot = path.join(contentRoot, "media", receipt.target);
    if (await stat(mediaManifestRoot).catch(() => null)) {
      await mkdir(path.join(contentDestination, "media", receipt.target), { recursive: true });
      await cp(mediaManifestRoot, path.join(contentDestination, "media", receipt.target), { recursive: true, force: true });
    }
    for (const mediaPath of receipt.mediaPaths || []) {
      if (!mediaPath.startsWith("/media/")) throw new Error(`active content media path is invalid: ${receipt.contentReleaseId}`);
      await copyFileRequired(
        path.join(source, "public", mediaPath.slice(1)),
        path.join(staging, "public", mediaPath.slice(1)),
        `active content media source is missing: ${receipt.contentReleaseId} ${mediaPath}`,
      );
    }
    contentSources += 1;
  }
  return contentSources;
}

function contentSetSourceFile(sourceRoot, entry) {
  const relative = String(entry.sourcePath || "").replace(/^content\//, "");
  if (!relative || relative.startsWith("../") || path.isAbsolute(relative)) {
    throw new Error(`ContentSet sourcePath is unsafe: ${entry.entryId}`);
  }
  return path.join(sourceRoot, ".content-workspace", "content", relative);
}

async function assembleContentSetSources({ staging, sourceRoot, contentSet }) {
  const contentDestination = path.join(staging, ".content-workspace", "content");
  let contentSources = 0;
  for (const entry of contentSet.entries) {
    if (entry.kind === "home") {
      if (!contentSet.homeContent) throw new Error("ContentSet home entry is missing immutable homeContent payload");
      await mkdir(contentDestination, { recursive: true });
      await writeFile(path.join(contentDestination, "home.json"), `${JSON.stringify(contentSet.homeContent, null, 2)}\n`);
      contentSources += 1;
      continue;
    }
    const sourceFile = contentSetSourceFile(sourceRoot, entry);
    const relative = String(entry.sourcePath).replace(/^content\//, "");
    await copyFileRequired(sourceFile, path.join(contentDestination, relative), `ContentSet source is missing: ${entry.entryId}`);
    if (entry.kind === "practice") {
      const mediaDirectory = path.join(sourceRoot, ".content-workspace", "content", "media", entry.target);
      if (await stat(mediaDirectory).catch(() => null)) {
        await mkdir(path.join(contentDestination, "media", entry.target), { recursive: true });
        await cp(mediaDirectory, path.join(contentDestination, "media", entry.target), { recursive: true, force: true });
        const publicMediaDirectory = path.join(staging, "public", "media", entry.target);
        await mkdir(path.dirname(publicMediaDirectory), { recursive: true });
        await cp(mediaDirectory, publicMediaDirectory, { recursive: true, force: true });
      }
    }
    for (const mediaPath of entry.mediaProof || []) {
      if (!mediaPath.startsWith("/media/")) throw new Error(`ContentSet media proof path is invalid: ${entry.entryId}`);
      const relativeMedia = mediaPath.slice("/media/".length);
      const sourceMedia = path.join(sourceRoot, ".content-workspace", "content", "media", relativeMedia);
      const destinationMedia = path.join(staging, "public", "media", relativeMedia);
      await copyFileRequired(sourceMedia, destinationMedia, `ContentSet media source is missing: ${entry.entryId} ${mediaPath}`);
    }
    contentSources += 1;
  }
  return contentSources;
}

async function buildAssembledClient({ productClient, outputRoot, activeContentReleases, sourceRoot }) {
  const productArtifactPath = path.join(productClient, "base-site-artifact.json");
  const productArtifact = JSON.parse(await readFile(productArtifactPath, "utf8"));
  if (!productArtifact.sourceDirectory || !(await stat(productArtifact.sourceDirectory).catch(() => null))) {
    throw new Error("site publication requires the current immutable product artifact source directory");
  }
  const staging = await mkdtemp(path.join(os.tmpdir(), "xingbuild-site-publication-"));
  try {
    await cp(productArtifact.sourceDirectory, staging, { recursive: true });
    const nodeModules = path.join(sourceRoot, "node_modules");
    if (await stat(nodeModules).catch(() => null)) await symlink(nodeModules, path.join(staging, "node_modules"), "dir");
    await assembleContentSources({ staging, activeContentReleases });
    const productRelease = JSON.parse(await readFile(path.join(productClient, "release.json"), "utf8"));
    const result = spawnSync("npm", ["run", "build"], {
      cwd: staging,
      encoding: "utf8",
      env: { ...process.env, XINGBUILD_CONTENT_BUILD: "1", XINGBUILD_PRODUCT_VERSION: productRelease.version, XINGBUILD_PRODUCT_COMMIT: productRelease.commit },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (output) process.stdout.write(output);
    if (result.status !== 0) throw new Error(`site publication assembly build failed with status ${result.status ?? "unknown"}`);
    const assembledClient = path.join(staging, "dist", "client");
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputRoot, { recursive: true });
    await cp(assembledClient, outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, "base-site-artifact.json"), `${JSON.stringify(productArtifact, null, 2)}\n`);
    return { productRelease, productArtifact, client: outputRoot };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function buildAssembledClientFromContentSet({ productClient, outputRoot, contentSet, productArtifact, sourceRoot }) {
  const staging = await mkdtemp(path.join(os.tmpdir(), "xingbuild-site-publication-"));
  try {
    await cp(productArtifact.documents.baseSiteArtifact.sourceDirectory, staging, { recursive: true });
    const nodeModules = path.join(sourceRoot, "node_modules");
    if (await stat(nodeModules).catch(() => null)) await symlink(nodeModules, path.join(staging, "node_modules"), "dir");
    await assembleContentSetSources({ staging, sourceRoot, contentSet });
    const result = spawnSync("npm", ["run", "build"], {
      cwd: staging,
      encoding: "utf8",
      env: {
        ...process.env,
        XINGBUILD_CONTENT_BUILD: "1",
        XINGBUILD_PRODUCT_VERSION: productArtifact.productVersion,
        XINGBUILD_PRODUCT_COMMIT: productArtifact.productCommit,
      },
    });
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    if (output) process.stdout.write(output);
    if (result.status !== 0) throw new Error(`site publication ContentSet assembly build failed with status ${result.status ?? "unknown"}`);
    const assembledClient = path.join(staging, "dist", "client");
    await rm(outputRoot, { recursive: true, force: true });
    await mkdir(outputRoot, { recursive: true });
    await cp(assembledClient, outputRoot, { recursive: true });
    await writeFile(path.join(outputRoot, "base-site-artifact.json"), `${JSON.stringify(productArtifact.documents.baseSiteArtifact, null, 2)}\n`);
    return { client: outputRoot };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export function assertContentManifestComplete(manifest, receipts) {
  const projections = receipts.map((item) => item.projection || item).map((item) => assertActiveContentProjection(item));
  const ids = projections.map((item) => item.contentReleaseId).sort();
  const actualIds = [...new Set(manifest.activeContentReleaseIds || [])].sort();
  if (JSON.stringify(actualIds) !== JSON.stringify(ids)) throw new Error("content manifest activeContentReleaseIds are incomplete");
  if (manifest.activeReceiptIds != null) {
    const expectedReceiptIds = projections.map((item) => item.receiptId || contentReceiptId(item)).sort();
    const actualReceiptIds = [...new Set(manifest.activeReceiptIds || [])].sort();
    if (JSON.stringify(actualReceiptIds) !== JSON.stringify(expectedReceiptIds)) throw new Error("content manifest activeReceiptIds are incomplete");
  }
  for (const field of contentTargetCollectionNames) {
    const expected = [...new Set(projections.flatMap((item) => item[field] || []))].sort();
    const actual = [...new Set(manifest[field] || [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`content manifest ${field} does not match ContentReleaseReceipts`);
  }
  const projected = manifest.contentReleaseReceipts || [];
  if (projected.length !== projections.length) throw new Error("content manifest receipt projection is incomplete");
  for (const receipt of projections) {
    const item = projected.find((value) => value.contentReleaseId === receipt.contentReleaseId);
    if (!item || item.receiptHash !== receipt.receiptHash || item.projectionHash !== receipt.projectionHash || item.contentHash !== receipt.contentHash || item.kind !== receipt.kind || item.target !== receipt.target || (item.logicalContentId || null) !== (receipt.logicalContentId || null) || JSON.stringify(item.changedTargets || []) !== JSON.stringify(receipt.changedTargets || [])) {
      throw new Error(`content manifest receipt identity mismatch: ${receipt.contentReleaseId}`);
    }
    assertActiveContentProjection(item);
  }
  return true;
}

export function createActiveContentSet(receipts = []) {
  const activeContentReleases = [...receipts].sort((a, b) => a.contentReleaseId.localeCompare(b.contentReleaseId));
  const projections = activeContentReleases.map((item) => {
    if (item.projection) return assertActiveContentProjection(item.projection);
    return createActiveContentProjection({
      receipt: item,
      productArtifactId: item.baseSiteArtifactId || null,
      registryRevision: item.registrySlot?.registryRevision || null,
      mediaPaths: item.mediaPaths || [],
    });
  });
  const collections = Object.fromEntries(contentTargetCollectionNames.map((field) => [
    field,
    [...new Set(projections.flatMap((item) => item[field] || []))].sort(),
  ]));
  const activeContentSet = {
    ...collections,
    activeContentReleaseIds: projections.map((item) => item.contentReleaseId),
    activeReceiptIds: projections.map((item) => item.receiptId || contentReceiptId(item)).sort(),
    mediaPaths: [...new Set(projections.flatMap((item) => item.mediaPaths || []))].sort(),
    activeContentProjections: projections,
    contentReleaseReceipts: projections,
  };
  assertContentManifestComplete(activeContentSet, projections);
  return { activeContentReleases, ...activeContentSet };
}

async function readAuthoritativeContentSet(sourceRoot) {
  try {
    // After cutover the tuple is the only active authority. The legacy
    // active.json reader remains available only through the explicit
    // readContentPublicationAuthority bootstrap fallback.
    return (await readContentPublicationAuthority({ sourceRoot, allowLegacy: true })).contentSet;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function contentSetPublicationOutput({ publicationRoot, outputRoot, productRelease, productCommit, snapshotHash }) {
  return publicationRoot
    ? path.join(publicationRoot, `${productRelease.version}-${productCommit.slice(0, 12)}-${snapshotHash.slice(0, 16)}`)
    : outputRoot;
}

async function createContentSetSitePublication({
  productClient,
  outputRoot,
  publicationRoot = null,
  sourceRoot,
  assemble = false,
  contentSetId = null,
  contentSet: suppliedContentSet = null,
  contentDataArtifact: suppliedContentDataArtifact = null,
  activeTuple: suppliedActiveTuple = null,
  contentPublicationIntent = null,
} = {}) {
  if (assemble) throw new Error("canonical ContentSet SitePublication is client-only; sourceDirectory assembly is legacy/audit-only");
  const productArtifact = await readProductArtifact({
    clientDirectory: productClient,
    sourceRoot,
  });
  let contentSet = suppliedContentSet;
  let contentDataArtifact = suppliedContentDataArtifact;
  let activeTuple = suppliedActiveTuple;
  let intent = contentPublicationIntent;
  if (intent) {
    assertContentPublicationIntent(intent);
    const refs = await assertIntentReferences({ sourceRoot, intent });
    if (refs.intent.productArtifact.productArtifactId !== productArtifact.productArtifactId || refs.intent.productArtifact.productArtifactHash !== productArtifact.productArtifactHash) throw new Error("ContentPublicationIntent ProductArtifact does not match SitePublication client");
    contentSet = refs.contentSet;
    contentDataArtifact = refs.artifact;
    activeTuple = intent.activeTuple;
  }
  if (contentSetId) contentSet = await readContentSet({ sourceRoot, contentSetId });
  if (!contentSet && !intent) {
    const authority = await readContentPublicationAuthority({ sourceRoot, allowLegacy: false });
    contentSet = authority.contentSet;
    contentDataArtifact = authority.artifact;
    activeTuple = authority.tuple;
  }
  if (!contentSet || !contentDataArtifact || !activeTuple) {
    const error = new Error("canonical ContentSet SitePublication requires ContentDataArtifact and active tuple");
    error.code = "SITE_PUBLICATION_DATA_PLANE_REQUIRED";
    throw error;
  }
  activeTuple = {
    ...activeTuple,
    manifestUrl: activeTuple.manifestUrl || `/content-data/${contentDataArtifact.contentDataArtifactId}/content-data-manifest.json`,
  };
  const snapshot = createSiteSnapshot({
    productArtifact,
    contentSet,
    contentDataArtifact: {
      contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
      contentDataHash: contentDataArtifact.contentDataHash,
      manifestHash: activeTuple.manifestHash || null,
    },
    activeTuple,
    requireContentData: true,
    previousSnapshotId: null,
  });
  if (productArtifact.artifactContractVersion === "product-artifact-v2") {
    if (!activeTuple.manifestHash || activeTuple.manifestHash !== contentDataManifestHash(snapshot.contentManifest)) {
      throw new Error("canonical ContentData active tuple manifest hash is required and must bind the public manifest");
    }
  }
  // The adapter may retain immutable source documents for assembly, but every
  // persisted/runtime publication object receives only the normalized flat
  // ProductArtifactIdentity.  Raw manifests never become a second identity
  // shape downstream of the adapter boundary.
  const productIdentity = snapshot.productArtifact;
  const id = sitePublicationId({
    productVersion: productArtifact.productVersion,
    productCommit: productArtifact.productCommit,
    contentSetId: contentSet.contentSetId,
  });
  const contentManifest = {
    ...snapshot.contentManifest,
    sitePublicationId: id,
    siteSnapshotId: snapshot.siteSnapshotId,
    snapshotHash: snapshot.snapshotHash,
    contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
    contentDataHash: contentDataArtifact.contentDataHash,
    activeTupleHash: activeTuple.tupleHash,
    contentDataManifestHash: activeTuple.manifestHash || null,
  };
  const resolvedOutputRoot = contentSetPublicationOutput({
    publicationRoot,
    outputRoot,
    productRelease: { version: productArtifact.productVersion },
    productCommit: productArtifact.productCommit,
    snapshotHash: snapshot.snapshotHash,
  });
  if (!resolvedOutputRoot) throw new Error("SitePublication outputRoot or publicationRoot is required");
  let existingPublication = null;
  try { existingPublication = JSON.parse(await readFile(path.join(resolvedOutputRoot, "site-publication.json"), "utf8")); } catch { /* first assembly */ }
  if (existingPublication && (existingPublication.sitePublicationId !== id || existingPublication.snapshotHash !== snapshot.snapshotHash)) {
    throw new Error("persisted ContentSet SitePublication identity drift");
  }
  if (existingPublication?.deploymentId && existingPublication.sitePublicationId !== id) {
    throw new Error("refusing to overwrite a deployed ContentSet SitePublication with a different identity");
  }
  let dataMaterialization = null;
  try {
    dataMaterialization = await prepareContentOnlyMaterialization({
      productClient,
      sourceRoot,
      artifact: contentDataArtifact,
      activeTuple,
      contentSet,
      productArtifact,
      // The immutable data manifest binds the canonical ContentSet manifest;
      // sitePublicationId/snapshotHash are operational fields and must not
      // change the tuple's data identity.
      manifest: snapshot.contentManifest,
    });
    await dataMaterialization.validate();
    await rm(resolvedOutputRoot, { recursive: true, force: true });
    await mkdir(resolvedOutputRoot, { recursive: true });
    await cp(dataMaterialization.root, resolvedOutputRoot, { recursive: true });
  } finally {
    if (dataMaterialization) await dataMaterialization.cleanup().catch(() => {});
  }
  const assetManifest = await stat(path.join(resolvedOutputRoot, "index.html")).catch(() => null)
    ? await writePublicationAssetManifest({ clientRoot: resolvedOutputRoot, additionalPaths: contentManifest.mediaPaths || [] })
    : null;
  await writeJsonAtomically(path.join(resolvedOutputRoot, "content-manifest.json"), contentManifest);
  let publicationRun;
  try {
    publicationRun = await readPublicationRun({ sourceRoot, publicationRunId: publicationRunIdForSnapshot(snapshot.siteSnapshotId) });
    if (publicationRun.siteSnapshotId !== snapshot.siteSnapshotId || publicationRun.snapshotHash !== snapshot.snapshotHash) {
      throw new Error("persisted PublicationRun SiteSnapshot identity drift");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    publicationRun = createPublicationRun({ siteSnapshot: snapshot });
    await writePublicationRun({ sourceRoot, run: publicationRun });
  }
  const persistedIdentityMatches = existingPublication?.sitePublicationId === id && existingPublication?.snapshotHash === snapshot.snapshotHash;
  const persisted = {
    sitePublicationId: id,
    productArtifact: productIdentity,
    productVersion: productIdentity.productVersion,
    productCommit: productIdentity.productCommit,
    productArtifactId: productIdentity.productArtifactId,
    baseSiteArtifactId: productIdentity.baseSiteArtifactId,
    productArtifactHash: productIdentity.productArtifactHash || null,
    contentReleaseIds: [],
    contentSetId: contentSet.contentSetId,
    contentSetHash: contentSet.contentSetHash,
    contentDataArtifactId: contentDataArtifact.contentDataArtifactId,
    contentDataHash: contentDataArtifact.contentDataHash,
    activeTupleHash: activeTuple.tupleHash,
    activeTuple,
    expectedPreviousTupleHash: intent?.expectedPreviousTupleHash ?? null,
    ...(intent ? { contentPublicationIntentId: intent.intentId, contentPublicationIntentHash: intent.intentHash } : {}),
    siteSnapshotId: snapshot.siteSnapshotId,
    siteSnapshot: snapshot,
    snapshotHash: snapshot.snapshotHash,
    publicationRunId: publicationRun.publicationRunId,
    publicationRun,
    contentManifest,
    ...(assetManifest ? { assetManifest } : {}),
    contentPackageRevisionIds: [],
    publicationIdempotencyKey: sitePublicationIdempotencyKey({ sitePublicationId: id, snapshotHash: snapshot.snapshotHash }),
    deploymentId: null,
    publicVerify: null,
    ...(persistedIdentityMatches ? existingPublication : {}),
    client: undefined,
    state: persistedIdentityMatches && ["recoverable", "propagating", "deploying", "verifying", "released", "rolled-back"].includes(existingPublication?.state)
      ? existingPublication.state
      : "assembled",
    stateRevision: existingPublication?.stateRevision || 0,
    assembledAt: existingPublication?.assembledAt || new Date().toISOString(),
  };
  const durable = assertDurableSitePublicationRecord(sanitizeDurableSitePublicationRecord(persisted));
  await writeJsonAtomically(path.join(resolvedOutputRoot, "site-publication.json"), durable);
  if (durable.deployment?.deploymentId) await writeJsonAtomically(path.join(resolvedOutputRoot, "deployment.json"), durable.deployment);
  return { ...persisted, client: resolvedOutputRoot, contentSet, activeContentReleases: contentSet.entries };
}

export async function createSitePublication({ productClient, releasesRoot, outputRoot, publicationRoot = null, additionalContentManifest = null, candidatePackageDirectory = null, candidateContentSetId = null, contentSet = null, contentDataArtifact = null, activeTuple = null, contentPublicationIntent = null, assemble = false, sourceRoot = process.cwd() } = {}) {
  sourceRoot = resolveSourceRootForReleases(releasesRoot, sourceRoot);
  let productReleaseSchema = null;
  let productReleaseVersion = null;
  try {
    const release = JSON.parse(await readFile(path.join(productClient, "release.json"), "utf8"));
    productReleaseSchema = release?.schemaVersion || null;
    productReleaseVersion = release?.productVersion || release?.version || null;
  } catch { /* strict reader below reports the missing input */ }
  const legacyProductInput = productReleaseSchema !== "product-artifact-release-v2";
  const authoritativeContentSet = await readAuthoritativeContentSet(sourceRoot);
  // ProductArtifact release-v2 is the stable canonical input contract.  The
  // current version string must not choose a different publication path;
  // only the explicitly legacy/audit release shape may use the adapter below.
  // The content-data contract is an immutable release-schema marker.  Older
  // ProductArtifact v2 roots remain read-only migration/audit inputs until a
  // caller explicitly supplies the tuple-bound ContentSet refs; no product
  // version string selects this path.
  let releaseContract = null;
  try { releaseContract = JSON.parse(await readFile(path.join(productClient, "release.json"), "utf8")); } catch { /* strict readers below report missing input */ }
  const requiresDataPlane = productReleaseSchema === "product-artifact-release-v2"
    && (releaseContract?.contentDataContractVersion === "content-data-publication-v1"
      || Boolean(contentSet || contentDataArtifact || activeTuple || contentPublicationIntent || candidateContentSetId));
  if (!legacyProductInput && requiresDataPlane) {
    return createContentSetSitePublication({ productClient, outputRoot, publicationRoot, sourceRoot, assemble, contentSetId: candidateContentSetId, contentSet, contentDataArtifact, activeTuple, contentPublicationIntent });
  }
  if (!legacyProductInput && !authoritativeContentSet && !candidateContentSetId) {
    throw new Error("ContentSet active pointer is required for canonical ProductArtifact SitePublication; legacy receipts are migration/audit-only");
  }
  const productRelease = JSON.parse(await readFile(path.join(productClient, "release.json"), "utf8"));
  let productArtifact = null;
  try {
    productArtifact = await readProductArtifact({
      clientDirectory: productClient,
      sourceRoot,
      version: productRelease.version,
      commit: productRelease.commit,
    });
  } catch (error) {
    // This branch is retained only for isolated legacy/audit fixtures. The
    // canonical ContentSet path above always reads strict product-artifact-v2
    // and never reaches this adapter. Legacy receipts may be inspected using
    // their immutable source provenance, but they cannot enter the normal
    // ProductArtifact/content-data publication path.
    if (!/base-site-artifact\.json is missing or unreadable|release root schema mismatch/.test(error.message)) throw error;
    try {
      const legacyRelease = JSON.parse(await readFile(path.join(productClient, "release.json"), "utf8"));
      const legacyManifest = JSON.parse(await readFile(path.join(productClient, "content-manifest.json"), "utf8"));
      const legacyBase = JSON.parse(await readFile(path.join(productClient, "base-site-artifact.json"), "utf8"));
      productArtifact = resolveProductArtifactIdentity({
        release: { ...legacyRelease, baseSiteArtifactId: legacyRelease.baseSiteArtifactId || legacyBase.baseSiteArtifactId },
        contentManifest: legacyManifest,
        baseSiteArtifact: legacyBase,
      }, { version: legacyRelease.version, commit: legacyRelease.commit });
    } catch (legacyError) {
      if (error.message.includes("base-site-artifact.json is missing or unreadable")) {
        // The old receipt-only test/migration shape has no ProductArtifact
        // descriptor.  It remains an audit adapter with no product authority.
        productArtifact = null;
      } else {
        throw legacyError;
      }
    }
  }
  const productIdentity = productArtifact ? productArtifactIdentity(productArtifact) : null;
  const slotRegistry = await ensureContentSlotRegistry({ sourceRoot, releasesRoot });
  const activeContentReleases = await readActiveContentReleases(releasesRoot, {
    sourceRoot,
    productArtifactId: productArtifact?.baseSiteArtifactId || null,
  });
  const requiredKinds = [...new Set([
    ...activeContentReleases.map((item) => item.kind),
    ...(additionalContentManifest?.kind ? [additionalContentManifest.kind] : []),
  ])];
  if (productArtifact) {
    assertContentSlotArtifactCompatible(productArtifact.documents.baseSiteArtifact, {
      registryMode: slotRegistry.mode || "legacy",
      requiredKinds,
    });
  }
  let replacement = null;
  let candidateLineageBinding = null;
  let candidatePackageProjection = null;
  let replacementSlot = null;
  if (additionalContentManifest?.contentReleaseId && additionalContentManifest.contentHash && additionalContentManifest.target) {
    const sourceDirectory = candidatePackageDirectory ? path.join(candidatePackageDirectory, "source") : null;
    const candidateLogicalSlot = contentLogicalSlotId(additionalContentManifest);
    candidatePackageProjection = createImmutableContentReceiptProjection(additionalContentManifest, {
      baseSiteArtifactId: additionalContentManifest.baseSiteArtifactId || null,
      preserveReceiptHash: false,
    });
    const activeIndex = activeContentReleases.findIndex((item) => contentLogicalSlotId(item) === candidateLogicalSlot);
    let lifecycleTimes = null;
    if (activeIndex !== -1) {
      const resolvedCandidate = resolveContentSlotCandidate({ registry: slotRegistry, candidate: additionalContentManifest, allowLegacySelfReference: true });
      replacementSlot = resolvedCandidate.slot;
      replacement = await validateContentReplacement({
        candidate: additionalContentManifest,
        candidatePackageDirectory,
        activeReceipt: activeContentReleases[activeIndex],
        activeSlot: resolvedCandidate.slot,
        registry: slotRegistry,
        productArtifactId: productArtifact?.baseSiteArtifactId || null,
        sourceRoot,
        allowBaseArtifactRebind: Boolean(additionalContentManifest.packageRevisionId && additionalContentManifest.baseSiteArtifactId !== (productArtifact?.baseSiteArtifactId || null)),
      });
      lifecycleTimes = replacement.lifecycleTimes;
    }
    const candidateEntry = {
      ...additionalContentManifest,
      ...candidatePackageProjection,
      ...lifecycleTimes,
      predecessorReceiptId: replacement?.predecessorReceiptId || null,
      packageDirectory: candidatePackageDirectory,
      sourceDirectory,
      mediaPaths: await collectMediaPaths(sourceDirectory),
      receiptStatus: "candidate",
    };
    if (activeIndex === -1) {
      activeContentReleases.push(candidateEntry);
    } else {
      activeContentReleases.splice(activeIndex, 1, { ...candidateEntry, receiptStatus: "replacement-candidate", replacement });
    }
  }
  activeContentReleases.sort((a, b) => a.contentReleaseId.localeCompare(b.contentReleaseId));
  const candidate = additionalContentManifest?.contentReleaseId ? activeContentReleases.find((item) => item.contentReleaseId === additionalContentManifest.contentReleaseId) : null;
  const publicationContentIdentities = activeContentReleases.map((item) => item.packageRevisionId ? `${item.contentReleaseId}@${item.packageRevisionId}` : item.contentReleaseId);
  const id = sitePublicationId({ productVersion: productRelease.version, productCommit: productRelease.commit, contentReleaseIds: publicationContentIdentities });
  const candidateBeforeBinding = additionalContentManifest?.contentReleaseId
    ? activeContentReleases.find((item) => item.contentReleaseId === additionalContentManifest.contentReleaseId) || null
    : null;
  if (candidateBeforeBinding?.packageRevisionId && replacement) {
    const resolvedBinding = await createOrReusePublicationLineageBinding({
      sourceRoot,
      sitePublicationId: id,
      candidate: candidateBeforeBinding,
      registry: slotRegistry,
      expectedRegistryRevision: slotRegistry.registryRevision,
    });
    candidateLineageBinding = Object.fromEntries([
      "bindingVersion",
      "sitePublicationId",
      "logicalContentId",
      "packageRevisionId",
      "candidateContentReleaseId",
      "predecessorReceiptId",
      "predecessorPackageId",
      "registryRevision",
      "lineageBindingId",
      "bindingHash",
      "createdAt",
    ].map((field) => [field, resolvedBinding[field]]));
    const candidateProjection = createActiveContentProjection({
      receipt: candidateBeforeBinding,
      activeSlot: replacementSlot,
      lineageBinding: candidateLineageBinding,
      productArtifactId: productArtifact?.baseSiteArtifactId || null,
      registryRevision: slotRegistry.registryRevision,
      mediaPaths: candidateBeforeBinding.mediaPaths || [],
    });
    const boundCandidate = {
      ...candidateBeforeBinding,
      ...candidateProjection,
      receiptHash: candidatePackageProjection?.receiptHash || candidateBeforeBinding.receiptHash,
      projection: candidateProjection,
      lineageBinding: candidateLineageBinding,
      lineageBindingId: candidateLineageBinding.lineageBindingId,
      predecessorReceiptId: candidateLineageBinding.predecessorReceiptId,
      supersedesPackageId: candidateLineageBinding.predecessorPackageId,
    };
    const candidateIndex = activeContentReleases.findIndex((item) => item.contentReleaseId === candidateBeforeBinding.contentReleaseId);
    activeContentReleases.splice(candidateIndex, 1, { ...boundCandidate, receiptStatus: "replacement-candidate", replacement: { ...replacement, lineageBindingId: candidateLineageBinding.lineageBindingId, bindingHash: candidateLineageBinding.bindingHash, predecessorReceiptId: candidateLineageBinding.predecessorReceiptId, predecessorPackageSlotId: candidateLineageBinding.predecessorPackageId } });
    replacement = { ...replacement, lineageBindingId: candidateLineageBinding.lineageBindingId, bindingHash: candidateLineageBinding.bindingHash, predecessorReceiptId: candidateLineageBinding.predecessorReceiptId, predecessorPackageSlotId: candidateLineageBinding.predecessorPackageId, supersedesPackageId: candidateLineageBinding.predecessorPackageId };
  } else if (candidateBeforeBinding) {
    const candidateProjection = createActiveContentProjection({
      receipt: candidateBeforeBinding,
      productArtifactId: productArtifact?.baseSiteArtifactId || null,
      registryRevision: slotRegistry.registryRevision,
      mediaPaths: candidateBeforeBinding.mediaPaths || [],
    });
    const candidateIndex = activeContentReleases.findIndex((item) => item.contentReleaseId === candidateBeforeBinding.contentReleaseId);
    activeContentReleases.splice(candidateIndex, 1, {
      ...candidateBeforeBinding,
      ...candidateProjection,
      receiptHash: candidatePackageProjection?.receiptHash || candidateBeforeBinding.receiptHash,
      projection: candidateProjection,
    });
  }
  const activeContentSet = createActiveContentSet(activeContentReleases);
  const contentManifest = {
    version: productRelease.version,
    commit: productRelease.commit,
    ...Object.fromEntries(contentTargetCollectionNames.map((field) => [field, activeContentSet[field]])),
    activeContentReleaseIds: activeContentSet.activeContentReleaseIds,
    activeReceiptIds: activeContentSet.activeReceiptIds,
    mediaPaths: activeContentSet.mediaPaths,
    ...(productIdentity ? {
      productArtifactId: productIdentity.productArtifactId,
      baseSiteArtifactId: productIdentity.baseSiteArtifactId,
      productArtifactHash: productIdentity.productArtifactHash || null,
      releaseManifestHash: productIdentity.releaseManifestHash || null,
      contentManifestHash: productIdentity.contentManifestHash || null,
      artifactContentHash: productIdentity.artifactContentHash || null,
      sourceBundleHash: productIdentity.sourceBundleHash || null,
    } : {}),
    activeContentProjections: activeContentSet.activeContentProjections,
    contentReleaseReceipts: activeContentSet.contentReleaseReceipts,
    candidateContentReleaseId: candidate?.contentReleaseId || null,
    candidatePackageRevisionId: candidate?.packageRevisionId || null,
    candidateTarget: candidate?.target || null,
    candidateTargetPath: candidate?.targetPath || null,
    contentReplacement: replacement,
    lineageBindingId: candidateLineageBinding?.lineageBindingId || null,
    lineageBinding: candidateLineageBinding,
  };
  assertContentManifestComplete(contentManifest, activeContentReleases);
  const snapshotHash = createHash("sha256").update(JSON.stringify({ productArtifact: productIdentity, contentManifest })).digest("hex");
  Object.assign(contentManifest, { sitePublicationId: id, snapshotHash });
  const publication = {
    sitePublicationId: id,
    productArtifact: productIdentity || null,
    productVersion: productRelease.version,
    productCommit: productRelease.commit,
    productArtifactId: productIdentity?.productArtifactId || null,
    baseSiteArtifactId: productIdentity?.baseSiteArtifactId || null,
    productArtifactHash: productIdentity?.productArtifactHash || null,
    contentReleaseIds: contentManifest.activeContentReleaseIds,
    candidateContentReleaseId: candidate?.contentReleaseId || null,
    candidatePackageRevisionId: candidate?.packageRevisionId || null,
    candidatePackageDirectory: candidatePackageDirectory ? path.relative(sourceRoot, candidatePackageDirectory) : null,
    contentReplacement: replacement,
    targetPath: candidate?.targetPath || null,
    contentManifest,
    activeContentProjections: activeContentSet.activeContentProjections,
    snapshotHash,
    contentPackageRevisionIds: activeContentReleases.map((item) => item.packageRevisionId).filter(Boolean),
    contentSlotRegistryRevision: slotRegistry.registryRevision,
    lineageBindingId: candidateLineageBinding?.lineageBindingId || null,
    lineageBinding: candidateLineageBinding,
    publicationIdempotencyKey: sitePublicationIdempotencyKey({ sitePublicationId: id, snapshotHash }),
    deploymentId: null,
    publicVerify: null,
  };
  const resolvedOutputRoot = publicationRoot
    ? path.join(publicationRoot, `${productRelease.version}-${productRelease.commit.slice(0, 12)}-${snapshotHash.slice(0, 16)}`)
    : outputRoot;
  if (!resolvedOutputRoot) throw new Error("SitePublication outputRoot or publicationRoot is required");
  let existingPublication = null;
  try { existingPublication = JSON.parse(await readFile(path.join(resolvedOutputRoot, "site-publication.json"), "utf8")); } catch { /* first assembly */ }
  if (existingPublication?.sitePublicationId === id && existingPublication.snapshotHash !== snapshotHash) {
    throw new Error("persisted SitePublication snapshot identity drift");
  }
  if (existingPublication?.sitePublicationId !== id && existingPublication?.deploymentId) {
    throw new Error("refusing to overwrite a deployed SitePublication with a different identity");
  }
  if (assemble) {
    await buildAssembledClient({ productClient, outputRoot: resolvedOutputRoot, activeContentReleases, sourceRoot });
  } else {
    await rm(resolvedOutputRoot, { recursive: true, force: true });
    await mkdir(resolvedOutputRoot, { recursive: true });
    await cp(productClient, resolvedOutputRoot, { recursive: true });
  }
  const assetManifest = await stat(path.join(resolvedOutputRoot, "index.html")).catch(() => null)
    ? await writePublicationAssetManifest({ clientRoot: resolvedOutputRoot, additionalPaths: contentManifest.mediaPaths || [] })
    : null;
  await writeJsonAtomically(path.join(resolvedOutputRoot, "content-manifest.json"), contentManifest);
  const persistedIdentityMatches = existingPublication?.sitePublicationId === publication.sitePublicationId && existingPublication?.snapshotHash === publication.snapshotHash;
  const persisted = {
    ...publication,
    ...(assetManifest ? { assetManifest } : {}),
    ...(persistedIdentityMatches ? existingPublication : {}),
    client: undefined,
    state: persistedIdentityMatches && ["recoverable", "propagating", "deploying", "verified", "released"].includes(existingPublication?.state) ? existingPublication.state : "assembled",
    stateRevision: existingPublication?.stateRevision || 0,
    assembledAt: new Date().toISOString(),
  };
  const durable = assertDurableSitePublicationRecord(sanitizeDurableSitePublicationRecord(persisted));
  await writeJsonAtomically(path.join(resolvedOutputRoot, "site-publication.json"), durable);
  if (durable.deployment?.deploymentId) {
    await writeJsonAtomically(path.join(resolvedOutputRoot, "deployment.json"), durable.deployment);
  }
  return { ...persisted, client: resolvedOutputRoot, activeContentReleases };
}

export function assertSitePublicationEvidence({ deployment, publicVerify, productVerify, contentVerify } = {}) {
  if (!deployment || typeof deployment !== "object" || !deployment.deploymentId) throw new Error("site publication requires machine-readable deployment JSON");
  if (!publicVerify || !Object.keys(publicVerify).length || !productVerify || !Object.keys(productVerify).length || !contentVerify || !Object.keys(contentVerify).length) throw new Error("site publication requires product and content public verification evidence");
  if (publicVerify.assets && !publicVerify.assets.skipped && publicVerify.assets.verified !== true) throw new Error("site publication requires public static asset verification evidence");
  if (publicVerify.browserRuntime && !publicVerify.browserRuntime.skipped && publicVerify.browserRuntime.verified !== true) throw new Error("site publication requires public browser runtime verification evidence");
  if (publicVerify.assets && !publicVerify.assets.skipped && publicVerify.verificationEvidence?.schemaVersion !== PUBLICATION_RUNTIME_EVIDENCE_V4) {
    throw new Error("site publication requires publication-runtime-evidence-v4 aggregate");
  }
  if (publicVerify.verificationEvidence?.schemaVersion === PUBLICATION_RUNTIME_EVIDENCE_V4) {
    assertPublicationPhaseAggregate(publicVerify.verificationEvidence);
  }
  return true;
}
