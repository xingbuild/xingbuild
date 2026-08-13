import { randomUUID, createHash } from "node:crypto";
import { lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { contentRootDirectory, projectRoot } from "./content-root.mjs";
import {
  hashValue,
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

export async function writeContentAuthoringTarget({ targetId, text, mobileText = undefined, sourceHash, valueHash: expectedValueHash = null, rootDirectory = projectRoot } = {}) {
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
  });
  const nextDocument = writeFieldValue(document, target.fieldPath, after);
  const serialized = `${JSON.stringify(nextDocument, null, 2)}\n`;
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
    sourceHash: hashBytes(serialized),
    valueHash: hashValue(after),
    beforeValueHash: actualValueHash,
    after,
  };
}

export async function readContentAuthoringRegistry({ rootDirectory = projectRoot } = {}) {
  const registry = await readContentTargetRegistry({ rootDirectory });
  return { registryId: registry.registryId, schemaVersion: registry.schemaVersion };
}
