import { access, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { projectRoot } from "./observation-content.mjs";
import { contentRootDirectory } from "./content-root.mjs";
import { isPublicPracticeMedia } from "../../src/content/practiceMediaLifecycle.js";
import { normalizeResponsiveTextSlot } from "./responsive-text-slot.mjs";
import { validateRegisteredResponsiveTextValues } from "./content-targets.mjs";


const slugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const absoluteHttpsPattern = /^https:\/\/[^\s]+$/;
const practiceActionHost = "robotaxi.xingbuild.top";
const sha256Pattern = /^[a-f0-9]{64}$/;
const approvedMediaRoles = new Set(["current_system_evidence", "in_progress_context"]);
const manifestReviewStatuses = new Set(["approved", "superseded"]);
const manifestPublicStatuses = new Set(["public", "internal"]);
const publicationStatuses = new Set(["active", "suspended"]);
const assetReviewStatuses = new Set(["approved", "pending_review", "revoked"]);
const assetApprovalStatuses = new Set(["approved", "paused", "revoked"]);
export const mediaAssetTypes = new Set(["image", "video"]);

export const practiceIdPattern = slugPattern;
export const supportedPracticeIds = new Set(["robotaxi"]);

function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

async function fileExists(file) {
  try { await access(file); return true; } catch { return false; }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validResponsiveOrText(value, field, errors, { maxLength = 400 } = {}) {
  try { normalizeResponsiveTextSlot(value, { maxLength }); }
  catch (error) { errors.push(`${field} must be a valid string or responsive-text-slot-v1: ${error.message}`); }
}

function validateAction(errors, action, field) {
  if (action === undefined) return;
  if (!isObject(action)) {
    errors.push(`${field} must be an object`);
    return;
  }
  const allowed = new Set(["href"]);
  for (const key of Object.keys(action)) if (!allowed.has(key)) errors.push(`${field}.${key} is not allowed`);
  if (!hasText(action.href) || !absoluteHttpsPattern.test(action.href)) {
    errors.push(`${field}.href must be an absolute https URL`);
    return;
  }
  try {
    const parsed = new URL(action.href);
    if (parsed.username || parsed.password) {
      errors.push(`${field}.href must not include credentials`);
    }
    if (parsed.hostname !== practiceActionHost) errors.push(`${field}.href must use the registered ${practiceActionHost} host`);
  } catch {
    errors.push(`${field}.href must be a valid URL`);
  }
}

function validateApprovalRecord(errors, approvalRecord, field) {
  if (!isObject(approvalRecord)) {
    errors.push(`${field} must be an object`);
    return;
  }
  for (const key of ["approvalId", "approvalStatus", "authority", "approvedAt", "scope"]) {
    if (!hasText(approvalRecord[key])) errors.push(`${field}.${key} must be a non-empty string`);
  }
  if (approvalRecord.approvalStatus !== "approved") errors.push(`${field}.approvalStatus must be approved`);
}

function validateCurrentPublication(errors, currentPublication, field) {
  if (!isObject(currentPublication)) {
    errors.push(`${field} must be an object`);
    return;
  }
  for (const key of ["status", "effectiveAt", "authority", "reason"]) {
    if (!hasText(currentPublication[key])) errors.push(`${field}.${key} must be a non-empty string`);
  }
  if (!publicationStatuses.has(currentPublication.status)) errors.push(`${field}.status is invalid`);
}

function validateReviewRecord(errors, reviewRecord, field) {
  if (reviewRecord === undefined) return;
  if (!isObject(reviewRecord)) {
    errors.push(`${field} must be an object`);
    return;
  }
  for (const key of ["reviewId", "status", "effectiveAt", "authority", "reason"]) {
    if (!hasText(reviewRecord[key])) errors.push(`${field}.${key} must be a non-empty string`);
  }
  if (!assetApprovalStatuses.has(reviewRecord.status)) errors.push(`${field}.status is invalid`);
}

export function isPublicMediaAsset(manifest, asset) {
  return isPublicPracticeMedia(manifest, asset);
}

export function assertSupportedPracticeId(practiceId) {
  if (!practiceIdPattern.test(practiceId || "")) {
    throw new Error("Practice id must be a non-empty kebab-case value");
  }
  if (!supportedPracticeIds.has(practiceId)) {
    throw new Error(`Practice id is not currently supported: ${practiceId}`);
  }
}

export function practiceContentPaths(practiceId, { rootDirectory = projectRoot } = {}) {
  assertSupportedPracticeId(practiceId);
  const contentRoot = contentRootDirectory({ sourceRoot: rootDirectory });
  return {
    practiceFile: path.join(contentRoot, "products", `${practiceId}.json`),
    manifestFile: path.join(contentRoot, "media", practiceId, "manifest.json"),
    practicePath: `content/products/${practiceId}.json`,
    manifestPath: `content/media/${practiceId}/manifest.json`,
  };
}

function isNormalizedPublicMediaPath(location, directory) {
  return hasText(location)
    && location.startsWith(`${directory}/`)
    && !location.includes("\\")
    && !location.split("/").includes("..")
    && path.posix.normalize(location) === location;
}

function isNormalizedArchivePath(location, practiceId) {
  const archiveDirectory = `content/media/${practiceId}/archive`;
  return hasText(location)
    && !path.posix.isAbsolute(location)
    && location.startsWith(`${archiveDirectory}/`)
    && !location.includes("\\")
    && !location.split("/").includes("..")
    && path.posix.normalize(location) === location;
}

function safeMediaFileLocation(asset, manifest) {
  if (asset?.src !== undefined) {
    if (isNormalizedPublicMediaPath(asset.src, manifest?.directory || "")) return { location: `public${asset.src}` };
    return { error: `media asset ${asset?.id || "(unknown)"} has an unsafe public src path` };
  }
  const practiceId = /^\/media\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(manifest?.directory || "")?.[1];
  if (practiceId && isNormalizedArchivePath(asset?.archivePath, practiceId)) return { location: asset.archivePath };
  return { error: `media asset ${asset?.id || "(unknown)"} has an unsafe archive path` };
}

export function referencedPracticeMediaAssets(practice, manifest) {
  const assets = new Map((manifest?.assets || []).map((asset) => [asset.id, asset]));
  const mediaIds = new Set((practice?.modules || []).map((module) => module.mediaId).filter(hasText));
  return [...mediaIds].map((mediaId) => assets.get(mediaId)).filter(Boolean);
}

export function mediaPathsForPractice(practice, manifest) {
  return referencedPracticeMediaAssets(practice, manifest)
    .filter((asset) => isNormalizedPublicMediaPath(asset.src, manifest?.directory || ""))
    .map((asset) => `public${asset.src}`);
}

export function validatePublishablePracticeBundle(practice, manifest, { expectedId } = {}) {
  const errors = validatePracticeBundle(practice, manifest);
  if (expectedId && practice?.id !== expectedId) errors.push(`practice.id must be ${expectedId}`);
  if (manifest?.reviewStatus !== "approved") errors.push("target media manifest reviewStatus must be approved");
  if (manifest?.publicStatus !== "public") errors.push("target media manifest publicStatus must be public");
  if (manifest?.currentPublication?.status !== "active") errors.push("target media manifest currentPublication.status must be active");
  if (!practice?.modules?.length) errors.push("Practice publication requires at least one module");
  for (const asset of referencedPracticeMediaAssets(practice, manifest)) {
    const label = asset?.id || "(unknown)";
    if (asset?.reviewStatus !== "approved") errors.push(`media asset ${label} reviewStatus must be approved`);
    if (asset?.publicStatus !== "public") errors.push(`media asset ${label} publicStatus must be public`);
    if (asset?.provenance?.approvalStatus !== "approved") errors.push(`media asset ${label} provenance approvalStatus must be approved`);
    if (typeof asset?.src !== "string" || !asset.src.startsWith(manifest?.directory || "")) {
      errors.push(`media asset ${label} src must belong to ${manifest?.directory || "the target media directory"}`);
    }
  }
  return errors;
}

export async function validatePracticeMediaFiles(manifest, { readBytes, practice } = {}) {
  const errors = [];
  const assets = practice ? referencedPracticeMediaAssets(practice, manifest) : manifest.assets || [];
  for (const asset of assets) {
    const { location, error } = safeMediaFileLocation(asset, manifest);
    if (error) {
      errors.push(error);
      continue;
    }
    try {
      const actualHash = createHash("sha256").update(await readBytes(location)).digest("hex");
      if (actualHash !== asset.assetSha256) errors.push(`media asset hash mismatch: ${location}`);
    } catch {
      errors.push(`media asset file is missing: ${location}`);
    }
  }
  return errors;
}

export function evaluatePracticeCommitReadiness({
  practiceId,
  files,
  practice,
  manifest,
}) {
  const errors = [];
  try { assertSupportedPracticeId(practiceId); } catch (error) { errors.push(error.message); }
  const normalized = files.filter(Boolean).map((file) => file.replace(/\\/g, "/"));
  const practicePath = `content/products/${practiceId}.json`;
  const manifestPath = `content/media/${practiceId}/manifest.json`;
  const mediaPaths = new Set(mediaPathsForPractice(practice, manifest));
  const allowed = new Set([
    practicePath,
    manifestPath,
    ...mediaPaths,
  ]);
  const rejected = normalized.filter((file) => !allowed.has(file));
  if (!normalized.includes(practicePath)) errors.push(`Practice commit must contain ${practicePath}`);
  if (rejected.length) errors.push(`Practice commit contains forbidden files: ${rejected.join(", ")}`);
  if (normalized.some((file) => mediaPaths.has(file)) && !normalized.includes(manifestPath)) {
    errors.push(`Practice media files require ${manifestPath}`);
  }
  return { ready: errors.length === 0, errors, practicePath, manifestPath, phase: "content-prepare" };
}

export function validatePracticeBundle(practice, manifest) {
  const errors = [];
  if (!isObject(practice)) return ["practice must be an object"];
  if (!isObject(manifest)) return ["media manifest must be an object"];

  const practiceAllowed = new Set(["id", "route", "navLabel", "title", "intro", "boundary", "why", "observationQuery", "modules"]);
  for (const key of Object.keys(practice)) if (!practiceAllowed.has(key)) errors.push(`practice.${key} is not allowed`);
  for (const field of ["id", "route", "navLabel", "title", "boundary"]) if (!hasText(practice[field])) errors.push(`practice.${field} must be a non-empty string`);
  validResponsiveOrText(practice.intro, "practice.intro", errors, { maxLength: 400 });
  if (practice.why !== undefined) {
    if (!isObject(practice.why)) errors.push("practice.why must be an object");
    else {
      if (practice.why.eyebrow !== undefined) validResponsiveOrText(practice.why.eyebrow, "practice.why.eyebrow", errors, { maxLength: 80 });
      if (!Array.isArray(practice.why.items)) errors.push("practice.why.items must be an array");
      else for (const item of practice.why.items) {
        if (!slugPattern.test(item?.id || "")) errors.push("practice.why item id must be kebab-case");
        validResponsiveOrText(item?.text, `practice.why.items.${item?.id || "unknown"}.text`, errors, { maxLength: 400 });
      }
    }
  }
  if (!slugPattern.test(practice.id || "")) errors.push("practice.id must be kebab-case");
  if (practice.route !== "/products") errors.push("practice.route must be /products");
  if (!Array.isArray(practice.modules)) errors.push("practice.modules must be an array");

  const manifestAllowed = new Set([
    "id", "version", "directory", "reviewStatus", "publicStatus", "approvalRecord", "currentPublication", "provenance", "assets",
  ]);
  for (const key of Object.keys(manifest)) if (!manifestAllowed.has(key)) errors.push(`mediaManifest.${key} is not allowed`);
  for (const field of ["id", "version", "directory", "reviewStatus", "publicStatus"]) {
    if (!hasText(manifest[field])) errors.push(`mediaManifest.${field} must be a non-empty string`);
  }
  if (manifest.directory !== "/media/robotaxi") errors.push("mediaManifest.directory must be /media/robotaxi");
  if (!manifestReviewStatuses.has(manifest.reviewStatus)) errors.push("mediaManifest.reviewStatus is invalid");
  if (!manifestPublicStatuses.has(manifest.publicStatus)) errors.push("mediaManifest.publicStatus is invalid");
  validateApprovalRecord(errors, manifest.approvalRecord, "mediaManifest.approvalRecord");
  validateCurrentPublication(errors, manifest.currentPublication, "mediaManifest.currentPublication");
  if (!isObject(manifest.provenance)) {
    errors.push("mediaManifest.provenance must be an object");
  } else {
    const allowed = new Set(["repository", "manifestPath", "version", "commit", "sourceDraftManifestSha256"]);
    for (const key of Object.keys(manifest.provenance)) if (!allowed.has(key)) errors.push(`mediaManifest.provenance.${key} is not allowed`);
    for (const key of allowed) if (!hasText(manifest.provenance[key])) errors.push(`mediaManifest.provenance.${key} must be a non-empty string`);
    if (!sha256Pattern.test(manifest.provenance.sourceDraftManifestSha256 || "")) errors.push("mediaManifest.provenance.sourceDraftManifestSha256 must be a SHA-256 hash");
  }
  if (!Array.isArray(manifest.assets)) errors.push("mediaManifest.assets must be an array");

  const assets = new Map();
  for (const [index, asset] of (manifest.assets || []).entries()) {
    const field = `mediaManifest.assets[${index}]`;
    if (!isObject(asset)) {
      errors.push(`${field} must be an object`);
      continue;
    }
    const allowed = new Set(["id", "type", "src", "archivePath", "altZh", "ratio", "assetSha256", "reviewStatus", "publicStatus", "provenance", "reviewRecord", "mime", "duration", "poster"]);
    for (const key of Object.keys(asset)) if (!allowed.has(key)) errors.push(`${field}.${key} is not allowed`);
    for (const key of ["id", "type", "altZh", "ratio", "assetSha256", "reviewStatus", "publicStatus"]) {
      if (!hasText(asset[key])) errors.push(`${field}.${key} must be a non-empty string`);
    }
    if (!slugPattern.test(asset.id || "")) errors.push(`${field}.id must be kebab-case`);
    if (assets.has(asset.id)) errors.push(`duplicate media asset id: ${asset.id}`);
    if (asset.src !== undefined && !isNormalizedPublicMediaPath(asset.src, manifest.directory)) errors.push(`${field}.src must stay safely under ${manifest.directory}`);
    if (asset.archivePath !== undefined && !isNormalizedArchivePath(asset.archivePath, practice.id)) errors.push(`${field}.archivePath must stay safely under content/media/${practice.id}/archive`);
    if (isPublicMediaAsset(manifest, asset) && asset.archivePath !== undefined) errors.push(`${field}.archivePath is only for non-public media`);
    if (!isPublicMediaAsset(manifest, asset) && !hasText(asset.archivePath)) errors.push(`${field}.archivePath must preserve non-public media`);
    if (!mediaAssetTypes.has(asset.type)) errors.push(`${field}.type must be image or video`);
    if (!/^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/.test(asset.ratio || "")) errors.push(`${field}.ratio must declare a numeric width:height ratio`);
    if (asset.mime !== undefined && (!hasText(asset.mime) || !["image/", "video/"].some((prefix) => asset.mime.startsWith(prefix)))) errors.push(`${field}.mime must be an image/* or video/* MIME type`);
    if (asset.type === "video" && asset.mime !== undefined && !asset.mime.startsWith("video/")) errors.push(`${field}.mime must match video type`);
    if (asset.type === "image" && asset.mime !== undefined && !asset.mime.startsWith("image/")) errors.push(`${field}.mime must match image type`);
    if (!sha256Pattern.test(asset.assetSha256 || "")) errors.push(`${field}.assetSha256 must be a SHA-256 hash`);
    if (!assetReviewStatuses.has(asset.reviewStatus)) errors.push(`${field}.reviewStatus is invalid`);
    if (!manifestPublicStatuses.has(asset.publicStatus)) errors.push(`${field}.publicStatus is invalid`);
    if (!isObject(asset.provenance)) {
      errors.push(`${field}.provenance must be an object`);
    } else {
      const provenanceAllowed = new Set(["mediaRole", "stateBoundary", "robotaxiVersion", "commit", "approvalStatus"]);
      for (const key of Object.keys(asset.provenance)) if (!provenanceAllowed.has(key)) errors.push(`${field}.provenance.${key} is not allowed`);
      for (const key of provenanceAllowed) if (!hasText(asset.provenance[key])) errors.push(`${field}.provenance.${key} must be a non-empty string`);
      if (!approvedMediaRoles.has(asset.provenance.mediaRole)) errors.push(`${field}.provenance.mediaRole is not approved`);
      if (!assetApprovalStatuses.has(asset.provenance.approvalStatus)) errors.push(`${field}.provenance.approvalStatus is invalid`);
    }
    validateReviewRecord(errors, asset.reviewRecord, `${field}.reviewRecord`);
    assets.set(asset.id, asset);
  }

  const moduleIds = new Set();
  for (const [index, module] of (practice.modules || []).entries()) {
    const field = `practice.modules[${index}]`;
    if (!isObject(module)) {
      errors.push(`${field} must be an object`);
      continue;
    }
    const allowed = new Set(["id", "group", "label", "shortDescription", "loopRelation", "mediaId", "action"]);
    for (const key of Object.keys(module)) if (!allowed.has(key)) errors.push(`${field}.${key} is not allowed`);
    for (const key of ["id", "group", "label", "loopRelation"]) if (!hasText(module[key])) errors.push(`${field}.${key} must be a non-empty string`);
    validResponsiveOrText(module.shortDescription, `${field}.shortDescription`, errors, { maxLength: 400 });
    if (!slugPattern.test(module.id || "")) errors.push(`${field}.id must be kebab-case`);
    if (moduleIds.has(module.id)) errors.push(`duplicate practice module id: ${module.id}`);
    moduleIds.add(module.id);
    if (module.mediaId !== undefined) {
      if (!hasText(module.mediaId)) errors.push(`${field}.mediaId must be a non-empty string when provided`);
      else if (!assets.has(module.mediaId)) errors.push(`${field}.mediaId references missing media record`);
    }
    validateAction(errors, module.action, `${field}.action`);
  }
  return errors;
}

export async function assertCurrentPracticeContent() {
  return assertPracticeContent("robotaxi");
}

export async function assertPracticeContent(practiceId, { rootDirectory = projectRoot, publishable = false } = {}) {
  const paths = practiceContentPaths(practiceId, { rootDirectory });
  const [practice, manifest] = await Promise.all([readJson(paths.practiceFile), readJson(paths.manifestFile)]);
  const errors = publishable
    ? validatePublishablePracticeBundle(practice, manifest, { expectedId: practiceId })
    : validatePracticeBundle(practice, manifest);
  errors.push(...await validatePracticeMediaFiles(manifest, {
    practice: publishable ? practice : undefined,
    readBytes: async (location) => {
      const file = location.startsWith("content/")
        ? path.join(contentRootDirectory({ sourceRoot: rootDirectory }), location.slice("content/".length))
        : location.startsWith("public/media/") && await fileExists(path.join(contentRootDirectory({ sourceRoot: rootDirectory }), "media", location.slice("public/media/".length)))
          ? path.join(contentRootDirectory({ sourceRoot: rootDirectory }), "media", location.slice("public/media/".length))
          : path.join(rootDirectory, location);
      return readFile(file);
    },
  }));
  try {
    await validateRegisteredResponsiveTextValues({ kind: "practice", target: practiceId, value: practice, rootDirectory });
  } catch (error) {
    errors.push(`responsive text registry: ${error.message}`);
  }
  if (errors.length) throw new Error(errors.map((error) => `- ${error}`).join("\n"));
  return { practice, manifest };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}
