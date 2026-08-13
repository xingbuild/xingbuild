import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentRootDirectory, projectRoot } from "./content-root.mjs";
import {
  hashValue,
  assertUniqueContentIds,
  readContentTargetRegistry,
  readFieldValue,
  resolveContentSourceFile,
  resolveContentTarget,
  writeFieldValue,
} from "./content-targets.mjs";
import { compileAuthoringValue, decompileAuthoringValue } from "./content-authoring.mjs";
import { readContentPreviewSourceState, resolveContentPreviewTarget } from "./content-preview.mjs";

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

function consumerViewsFor(target) {
  return [...new Set(target?.projectionRoutes || [])].flatMap((route) => [
    { route, viewport: "web-1280" },
    { route, viewport: "mobile-390" },
  ]);
}

function changeSummary(before, after, target) {
  const beforeAuthoring = decompileAuthoringValue(before, {
    valueType: target.valueType,
    projectionKeys: target.projectionKeys,
  });
  const afterAuthoring = decompileAuthoringValue(after, {
    valueType: target.valueType,
    projectionKeys: target.projectionKeys,
  });
  const beforeParts = String(beforeAuthoring.text || "").split("\n");
  const afterParts = String(afterAuthoring.text || "").split("\n");
  return {
    valueType: target.valueType,
    changed: JSON.stringify(before) !== JSON.stringify(after),
    beforePartCount: beforeParts.length,
    afterPartCount: afterParts.length,
    beforeMobilePartCount: String(beforeAuthoring.mobileText || beforeAuthoring.text || "").split("\n").length,
    afterMobilePartCount: String(afterAuthoring.mobileText || afterAuthoring.text || "").split("\n").length,
  };
}

function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertSourceFile(sourceFile, rootDirectory) {
  const root = path.resolve(contentRootDirectory({ sourceRoot: rootDirectory }));
  if (!inside(root, sourceFile)) throw new Error("content authoring source must stay inside canonical ignored content");
  const info = await lstat(sourceFile);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("content authoring source must be a regular file");
}

export async function readContentAuthoringTarget(targetId, { rootDirectory = projectRoot } = {}) {
  const target = await resolveContentTarget(targetId, { rootDirectory });
  const context = await resolveContentPreviewTarget(targetId, { rootDirectory });
  const sourceFile = path.resolve(resolveContentSourceFile(target.sourcePath, { rootDirectory }));
  await assertSourceFile(sourceFile, rootDirectory);
  const sourceState = await readContentPreviewSourceState({
    sourcePath: sourceFile,
    fieldPath: target.fieldPath,
    valueType: target.valueType,
    projectionKeys: target.projectionKeys,
    maxLength: target.constraints?.maxLength || 400,
  });
  let authoring;
  let editable = target.kind !== "media-content";
  try {
    authoring = decompileAuthoringValue(sourceState.currentValue, {
      valueType: target.valueType,
      projectionKeys: target.projectionKeys,
    });
  } catch (error) {
    editable = false;
    authoring = { schemaVersion: "content-authoring-value-v1", valueType: target.valueType, text: "", mobileText: null, projection: null, error: error.message };
  }
  return {
    targetId,
    kind: target.kind,
    valueType: target.valueType,
    sourcePath: context.sourcePath,
    fieldPath: context.fieldPath,
    projectionRoutes: context.projectionRoutes,
    consumerViews: context.consumerViews,
    projectionKeys: context.projectionKeys,
    constraints: { ...(target.constraints || {}) },
    sourceHash: sourceState.sourceHash,
    valueHash: sourceState.valueHash,
    activeBaseline: context.activeBaseline,
    authoring,
    editable,
  };
}

export async function writeContentAuthoringTarget({ targetId, text, mobileText = undefined, sourceHash, valueHash: expectedValueHash = null, restoreSnapshot = null, rootDirectory = projectRoot } = {}) {
  const target = await resolveContentTarget(targetId, { rootDirectory });
  if (target.kind === "media-content") throw new Error("media targets are read-only in the text authoring workbench");
  const sourceFile = path.resolve(resolveContentSourceFile(target.sourcePath, { rootDirectory }));
  await assertSourceFile(sourceFile, rootDirectory);
  const sourceDocument = await readFile(sourceFile, "utf8");
  const actualSourceHash = hashBytes(sourceDocument);
  if (sourceHash && sourceHash !== actualSourceHash) {
    const error = new Error("content authoring source changed; reload the target before saving");
    error.code = "CONTENT_AUTHORING_SOURCE_CONFLICT";
    throw error;
  }
  let document;
  try { document = JSON.parse(sourceDocument); } catch (error) {
    error.code = "CONTENT_AUTHORING_SOURCE_INVALID_JSON";
    throw error;
  }
  assertUniqueContentIds(document, { sourcePath: sourceFile, targetId });
  const before = readFieldValue(document, target.fieldPath);
  const actualValueHash = hashValue(before);
  if (expectedValueHash && expectedValueHash !== actualValueHash) {
    const error = new Error("content authoring value changed; reload the target before saving");
    error.code = "CONTENT_AUTHORING_VALUE_CONFLICT";
    throw error;
  }
  const after = compileAuthoringValue({
    text,
    mobileText,
    valueType: target.valueType,
    projectionKeys: target.projectionKeys,
    maxLength: target.constraints?.maxLength || 400,
    existingValue: before,
  });
  const afterValueHash = hashValue(after);
  const consumerViews = consumerViewsFor(target);
  if (afterValueHash === actualValueHash) {
    return {
      targetId,
      valueType: target.valueType,
      sourceHash: actualSourceHash,
      valueHash: actualValueHash,
      beforeValueHash: actualValueHash,
      afterValueHash,
      after: before,
      consumerRoutes: [...(target.projectionRoutes || [])],
      consumerViews,
      changeSummary: changeSummary(before, after, target),
      unchanged: true,
    };
  }
  const nextDocument = writeFieldValue(document, target.fieldPath, after);
  const canRestoreSnapshot = restoreSnapshot
    && restoreSnapshot.sourceHash
    && restoreSnapshot.valueHash
    && restoreSnapshot.text
    && restoreSnapshot.valueHash === afterValueHash
    && restoreSnapshot.sourceHash !== actualSourceHash;
  const serialized = canRestoreSnapshot ? restoreSnapshot.text : `${JSON.stringify(nextDocument, null, 2)}\n`;
  const temporary = `${sourceFile}.preview-${randomUUID()}.tmp`;
  await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, sourceFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return {
    targetId,
    valueType: target.valueType,
    sourceHash: hashBytes(serialized),
    valueHash: afterValueHash,
    beforeValueHash: actualValueHash,
    afterValueHash,
    after,
    consumerRoutes: [...(target.projectionRoutes || [])],
    consumerViews,
    changeSummary: changeSummary(before, after, target),
    sourceRestored: Boolean(canRestoreSnapshot),
  };
}

export async function readContentAuthoringRegistry({ rootDirectory = projectRoot } = {}) {
  const registry = await readContentTargetRegistry({ rootDirectory });
  return { registryId: registry.registryId, schemaVersion: registry.schemaVersion };
}
