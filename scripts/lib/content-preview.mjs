import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { contentRootDirectory, projectRoot } from "./content-root.mjs";
import {
  readContentTargetRegistry,
  readFieldValue,
  resolveContentSourceFile,
  resolveContentTarget,
} from "./content-targets.mjs";
import { validateContentSet } from "./content-set.mjs";
import { normalizeResponsiveTextSlot, RESPONSIVE_TEXT_SLOT_SCHEMA } from "./responsive-text-slot.mjs";

export const CONTENT_PREVIEW_MODE = "content-preview";
export const CONTENT_PREVIEW_SESSION_SCHEMA = "content-preview-session-v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value) {
  return sha256(JSON.stringify(value));
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`content preview ${field} is required`);
  return value;
}

function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function readJsonFile(file, code) {
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    error.code = error.code === "ENOENT" ? code : error.code;
    throw error;
  }
  try {
    return { value: JSON.parse(source), source, hash: sha256(source) };
  } catch (error) {
    const failure = new Error(`content preview source JSON is invalid: ${file}`);
    failure.code = "CONTENT_PREVIEW_SOURCE_INVALID_JSON";
    failure.cause = error;
    throw failure;
  }
}

/**
 * Read the active ContentSet only as a baseline. This function deliberately
 * has no write path and does not resolve receipts, candidates or recoveries.
 */
export async function readContentPreviewBaseline({ rootDirectory = projectRoot } = {}) {
  const activePath = path.join(rootDirectory, ".content-workspace", "content-state", "active.json");
  const activeDocument = await readJsonFile(activePath, "CONTENT_PREVIEW_ACTIVE_POINTER_MISSING");
  const pointer = activeDocument.value;
  if (pointer?.schemaVersion !== "content-set-active-v1") {
    throw new Error("content preview active pointer schema is invalid");
  }
  requiredText(pointer.activeContentSetId, "activeContentSetId");
  if (!/^(?:content-set-)?[a-f0-9]{64}$/.test(pointer.activeContentSetId)) {
    throw new Error("content preview activeContentSetId is invalid");
  }
  requiredText(pointer.contentSetHash, "contentSetHash");
  const contentSetPath = path.join(
    rootDirectory,
    ".content-workspace",
    "content-state",
    "sets",
    pointer.activeContentSetId,
    "content-set.json",
  );
  const contentSetDocument = await readJsonFile(contentSetPath, "CONTENT_PREVIEW_ACTIVE_CONTENT_SET_MISSING");
  try {
    validateContentSet(contentSetDocument.value);
  } catch (error) {
    error.code ||= "CONTENT_PREVIEW_ACTIVE_CONTENT_SET_INVALID";
    throw error;
  }
  if (contentSetDocument.value.contentSetId !== pointer.activeContentSetId
    || contentSetDocument.value.contentSetHash !== pointer.contentSetHash) {
    throw new Error("content preview active ContentSet identity does not match active pointer");
  }
  return {
    readOnly: true,
    schemaVersion: "content-set-active-v1",
    activeContentSetId: pointer.activeContentSetId,
    contentSetHash: pointer.contentSetHash,
    activePointerPath: path.resolve(activePath),
    activePointerHash: activeDocument.hash,
    contentSetPath: path.resolve(contentSetPath),
    contentSetFileHash: contentSetDocument.hash,
    entryCount: contentSetDocument.value.entries.length,
    updatedAt: pointer.updatedAt || null,
  };
}

function validateSourcePath(sourceFile, { rootDirectory }) {
  const contentRoot = path.resolve(contentRootDirectory({ sourceRoot: rootDirectory }));
  if (!within(contentRoot, sourceFile)) {
    const error = new Error("content preview source must remain inside canonical ignored content");
    error.code = "CONTENT_PREVIEW_SOURCE_UNSAFE";
    throw error;
  }
}

async function assertRegularSourceFile(sourceFile) {
  let info;
  try {
    info = await lstat(sourceFile);
  } catch (error) {
    if (error.code === "ENOENT") {
      const failure = new Error(`content preview source file is missing: ${sourceFile}`);
      failure.code = "CONTENT_PREVIEW_SOURCE_MISSING";
      throw failure;
    }
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    const error = new Error(`content preview source file is not a regular file: ${sourceFile}`);
    error.code = "CONTENT_PREVIEW_SOURCE_UNSAFE";
    throw error;
  }
}

export async function resolveContentPreviewTarget(targetId, { rootDirectory = projectRoot } = {}) {
  if (process.env.XINGBUILD_CONTENT_ROOT) {
    const error = new Error("content preview does not allow XINGBUILD_CONTENT_ROOT overrides");
    error.code = "CONTENT_PREVIEW_SOURCE_UNSAFE";
    throw error;
  }
  const target = await resolveContentTarget(targetId, { rootDirectory });
  if (target.valueType === RESPONSIVE_TEXT_SLOT_SCHEMA
    && (!Array.isArray(target.projectionKeys)
      || target.projectionKeys.length === 0
      || target.projectionKeys.some((projection) => typeof projection !== "string" || projection.trim() === ""))) {
    throw new Error(`content preview target has no registered projectionKeys: ${target.targetId}`);
  }
  const sourceFile = path.resolve(resolveContentSourceFile(target.sourcePath, { rootDirectory }));
  validateSourcePath(sourceFile, { rootDirectory });
  await assertRegularSourceFile(sourceFile);
  const sourceDocument = await readJsonFile(sourceFile, "CONTENT_PREVIEW_SOURCE_MISSING");
  const current = readFieldValue(sourceDocument.value, target.fieldPath);
  if (target.valueType === RESPONSIVE_TEXT_SLOT_SCHEMA) {
    normalizeResponsiveTextSlot(current, {
      projections: target.projectionKeys || [],
      maxLength: target.constraints?.maxLength || 400,
    });
  } else if (typeof current !== "string") {
    throw new Error(`content preview target field is not a supported string: ${target.targetId}`);
  }
  const baseline = await readContentPreviewBaseline({ rootDirectory });
  const registry = await readContentTargetRegistry({ rootDirectory });
  return {
    schemaVersion: CONTENT_PREVIEW_SESSION_SCHEMA,
    mode: CONTENT_PREVIEW_MODE,
    targetId: target.targetId,
    kind: target.kind,
    sourcePath: path.resolve(sourceFile),
    fieldPath: target.fieldPath,
    projectionRoutes: [...target.projectionRoutes],
    projectionKeys: [...(target.projectionKeys || [])],
    valueType: target.valueType,
    sourceHash: sourceDocument.hash,
    valueHash: hashJson(current),
    currentValue: current,
    constraints: { ...(target.constraints || {}) },
    activeBaseline: baseline,
    registryPath: path.resolve(path.join(rootDirectory, "content/registry/content-targets.json")),
    registrySchemaVersion: registry.schemaVersion,
    readOnly: true,
  };
}

export function sessionEnvironment(context, { identity, taskId = process.env.XBUILD_TASK_ID || "local" } = {}) {
  const baseline = context.activeBaseline;
  return {
    XINGBUILD_CONTENT_BUILD: "1",
    XINGBUILD_PREVIEW_MODE: CONTENT_PREVIEW_MODE,
    XINGBUILD_PREVIEW_CWD: identity.cwd,
    XINGBUILD_PREVIEW_COMMIT: identity.commit,
    XINGBUILD_PREVIEW_VERSION: identity.version,
    XINGBUILD_PREVIEW_TASK_ID: taskId,
    XINGBUILD_PREVIEW_OPEN_PATH: `/__xingbuild/content-preview?target-id=${encodeURIComponent(context.targetId)}`,
    XINGBUILD_CONTENT_PREVIEW_TARGET_ID: context.targetId,
    XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH: context.sourcePath,
    XINGBUILD_CONTENT_PREVIEW_FIELD_PATH: context.fieldPath,
    XINGBUILD_CONTENT_PREVIEW_ROUTES: JSON.stringify(context.projectionRoutes),
    XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS: JSON.stringify(context.projectionKeys),
    XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE: JSON.stringify(baseline),
  };
}

export function sessionOutput(context, { identity, pid = null, port = 4317, taskId = process.env.XBUILD_TASK_ID || "local" } = {}) {
  return {
    schemaVersion: CONTENT_PREVIEW_SESSION_SCHEMA,
    mode: CONTENT_PREVIEW_MODE,
    cwd: identity.cwd,
    commit: identity.commit,
    version: identity.version,
    taskId,
    pid,
    port,
    targetId: context.targetId,
    sourcePath: context.sourcePath,
    fieldPath: context.fieldPath,
    projectionRoutes: context.projectionRoutes,
    projectionKeys: context.projectionKeys,
    activeBaseline: context.activeBaseline,
    readOnly: true,
    statusText: "本地内容预览 · 未审核 · 未发布",
  };
}
