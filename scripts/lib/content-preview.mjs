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
import { pageDefinitions } from "../../src/content/pageDefinitions.js";

export const CONTENT_PREVIEW_MODE = "content-preview";
export const CONTENT_PREVIEW_SESSION_SCHEMA = "content-preview-session-v1";
export const CONTENT_PREVIEW_TARGET_IMPACT_SCHEMA = "content-preview-target-impact-v1";

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

function expectedContentReference(sourcePath) {
  if (sourcePath === "content/products/robotaxi.json") return { type: "practice", id: "robotaxi" };
  if (sourcePath === "content/home.json") return { type: "home", id: "home" };
  if (sourcePath === "content/profile/about.json") return { type: "profile", id: "about" };
  if (sourcePath.startsWith("content/articles/")) return { type: "evergreenArticle", id: "enterprise-operating-system" };
  return null;
}

function routeFromProjectionKey(projectionKey) {
  if (projectionKey.startsWith("home.")) return "/";
  if (projectionKey.startsWith("products.")) return "/products";
  return null;
}

function pageHasReference(definition, expected) {
  if (!expected) return true;
  return Object.values(definition?.contentRefs || {}).some((reference) => reference?.type === expected.type && reference?.id === expected.id);
}

/**
 * Resolve the actual page consumers from the registered projection routes and
 * the product page definitions. The registry remains the source of target
 * impact; page definitions only prove that each declared consumer exists and
 * references the same content object.
 */
export function resolveContentPreviewTargetImpact(target, { definitions = pageDefinitions } = {}) {
  const routes = [...new Set(target?.projectionRoutes || [])];
  if (routes.length === 0) throw new Error(`content preview target has no consumer routes: ${target?.targetId || "unknown"}`);
  const expected = expectedContentReference(target.sourcePath);
  const keyRoutes = new Set((target.projectionKeys || []).map(routeFromProjectionKey).filter(Boolean));
  for (const route of routes) {
    const definition = definitions.find((candidate) => candidate.route === route)
      || (route.startsWith("/observations/") ? definitions.find((candidate) => candidate.route === "/observations") : null);
    if (!definition) throw new Error(`content preview target route is not registered in page definitions: ${route}`);
    if (!pageHasReference(definition, expected)) {
      throw new Error(`content preview target route does not reference its source object: ${target.targetId} -> ${route}`);
    }
  }
  for (const route of keyRoutes) {
    if (!routes.includes(route)) throw new Error(`content preview projection key is outside declared consumer routes: ${target.targetId} -> ${route}`);
  }
  return Object.freeze({
    schemaVersion: CONTENT_PREVIEW_TARGET_IMPACT_SCHEMA,
    targetId: target.targetId,
    consumerRoutes: routes,
    consumerViews: routes.flatMap((route) => [
      { route, viewport: "web-1280" },
      { route, viewport: "mobile-390" },
    ]),
    projectionKeys: [...(target.projectionKeys || [])],
  });
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
  const sourceState = await readContentPreviewSourceState({
    sourcePath: sourceFile,
    fieldPath: target.fieldPath,
    valueType: target.valueType,
    projectionKeys: target.projectionKeys,
    maxLength: target.constraints?.maxLength || 400,
  });
  const baseline = await readContentPreviewBaseline({ rootDirectory });
  const registry = await readContentTargetRegistry({ rootDirectory });
  const impact = resolveContentPreviewTargetImpact(target);
  return {
    schemaVersion: CONTENT_PREVIEW_SESSION_SCHEMA,
    mode: CONTENT_PREVIEW_MODE,
    targetId: target.targetId,
    kind: target.kind,
    sourcePath: path.resolve(sourceFile),
    fieldPath: target.fieldPath,
    projectionRoutes: [...impact.consumerRoutes],
    consumerRoutes: [...impact.consumerRoutes],
    consumerViews: [...impact.consumerViews],
    projectionKeys: [...(target.projectionKeys || [])],
    valueType: target.valueType,
    sourceHash: sourceState.sourceHash,
    valueHash: sourceState.valueHash,
    currentValue: sourceState.currentValue,
    constraints: { ...(target.constraints || {}) },
    activeBaseline: baseline,
    registryPath: path.resolve(path.join(rootDirectory, "content/registry/content-targets.json")),
    registrySchemaVersion: registry.schemaVersion,
    readOnly: true,
  };
}

export async function readContentPreviewSourceState({ sourcePath, fieldPath, valueType, projectionKeys = [], maxLength = 400 } = {}) {
  const sourceDocument = await readJsonFile(sourcePath, "CONTENT_PREVIEW_SOURCE_MISSING");
  let current;
  try {
    current = readFieldValue(sourceDocument.value, fieldPath);
  } catch (error) {
    error.code ||= "CONTENT_PREVIEW_VALUE_INVALID";
    throw error;
  }
  if (valueType === RESPONSIVE_TEXT_SLOT_SCHEMA) {
    try {
      normalizeResponsiveTextSlot(current, { projections: projectionKeys, maxLength });
    } catch (error) {
      error.code ||= "CONTENT_PREVIEW_VALUE_INVALID";
      throw error;
    }
  } else if (typeof current !== "string") {
    const error = new Error("content preview target field is not a supported string");
    error.code = "CONTENT_PREVIEW_VALUE_INVALID";
    throw error;
  }
  return { sourceHash: sourceDocument.hash, valueHash: hashJson(current), currentValue: current };
}

export function createContentPreviewRevisionState(context, { revision = 0 } = {}) {
  return {
    status: "ready",
    revision,
    sourceHash: context.sourceHash,
    valueHash: context.valueHash,
    lastValidSourceHash: context.sourceHash,
    lastValidValueHash: context.valueHash,
    lastError: null,
  };
}

export function reduceContentPreviewTargetUpdate({ state, targetId, consumerRoutes, sourceState = null, error = null, now = new Date().toISOString() } = {}) {
  const current = state || {};
  if (error) {
    const next = { ...current, status: "invalid", lastError: { code: error.code || "CONTENT_PREVIEW_VALUE_INVALID", message: error.message }, lastObservedAt: now };
    return {
      state: next,
      event: {
        targetId,
        status: "invalid",
        sessionStatus: "invalid",
        refresh: false,
        revision: current.revision || 0,
        sourceHash: null,
        beforeValueHash: current.lastValidValueHash || current.valueHash || null,
        afterValueHash: null,
        consumerRoutes: [...(consumerRoutes || [])],
        error: next.lastError,
        observedAt: now,
      },
    };
  }
  if (!sourceState) {
    const next = { ...current, status: "outside-selected-target", lastObservedAt: now };
    return {
      state: next,
      event: {
        targetId,
        status: "outside-selected-target",
        sessionStatus: "outside-selected-target",
        refresh: false,
        revision: current.revision || 0,
        sourceHash: current.sourceHash || current.lastValidSourceHash || null,
        beforeValueHash: current.lastValidValueHash || current.valueHash || null,
        afterValueHash: current.lastValidValueHash || current.valueHash || null,
        consumerRoutes: [...(consumerRoutes || [])],
        error: null,
        observedAt: now,
      },
    };
  }
  const changed = sourceState.valueHash !== (current.lastValidValueHash || current.valueHash);
  const recovering = current.status === "invalid";
  const sourceChanged = sourceState.sourceHash !== (current.lastValidSourceHash || current.sourceHash);
  if (!changed && sourceChanged && !recovering) {
    const next = {
      ...current,
      status: "outside-selected-target",
      sourceHash: sourceState.sourceHash,
      lastValidSourceHash: sourceState.sourceHash,
      lastObservedAt: now,
    };
    return {
      state: next,
      event: {
        targetId,
        status: "outside-selected-target",
        sessionStatus: "outside-selected-target",
        refresh: false,
        revision: current.revision || 0,
        sourceHash: sourceState.sourceHash,
        beforeValueHash: current.lastValidValueHash || current.valueHash || null,
        afterValueHash: sourceState.valueHash,
        consumerRoutes: [...(consumerRoutes || [])],
        error: null,
        observedAt: now,
      },
    };
  }
  const refresh = changed;
  const next = {
    ...current,
    status: changed || recovering ? "valid-updated" : "ready",
    sourceHash: sourceState.sourceHash,
    valueHash: sourceState.valueHash,
    lastValidSourceHash: sourceState.sourceHash,
    lastValidValueHash: sourceState.valueHash,
    lastError: null,
    lastObservedAt: now,
    revision: changed ? (current.revision || 0) + 1 : (current.revision || 0),
  };
  return {
    state: next,
    event: {
      targetId,
      status: "valid",
      sessionStatus: next.status,
      refresh,
      revision: next.revision,
      sourceHash: sourceState.sourceHash,
      beforeValueHash: current.lastValidValueHash || current.valueHash || null,
      afterValueHash: sourceState.valueHash,
      consumerRoutes: [...(consumerRoutes || [])],
      error: null,
      observedAt: now,
    },
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
    XINGBUILD_CONTENT_PREVIEW_VALUE_TYPE: context.valueType,
    XINGBUILD_CONTENT_PREVIEW_MAX_LENGTH: String(context.constraints?.maxLength || 400),
    XINGBUILD_CONTENT_PREVIEW_ROUTES: JSON.stringify(context.projectionRoutes),
    XINGBUILD_CONTENT_PREVIEW_CONSUMER_ROUTES: JSON.stringify(context.consumerRoutes || context.projectionRoutes),
    XINGBUILD_CONTENT_PREVIEW_CONSUMER_VIEWS: JSON.stringify(context.consumerViews || []),
    XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS: JSON.stringify(context.projectionKeys),
    XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH: context.sourceHash,
    XINGBUILD_CONTENT_PREVIEW_VALUE_HASH: context.valueHash,
    XINGBUILD_CONTENT_PREVIEW_REVISION: "0",
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
    consumerRoutes: context.consumerRoutes || context.projectionRoutes,
    consumerViews: context.consumerViews || [],
    projectionKeys: context.projectionKeys,
    activeBaseline: context.activeBaseline,
    readOnly: true,
    statusText: "本地内容预览 · 未审核 · 未发布",
  };
}
