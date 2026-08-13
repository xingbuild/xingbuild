import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { projectRoot } from "./observation-content.mjs";
import { contentRootDirectory } from "./content-root.mjs";
import { normalizeResponsiveTextSlot, RESPONSIVE_TEXT_SLOT_SCHEMA } from "./responsive-text-slot.mjs";

export const contentTargetsPath = "content/registry/content-targets.json";
export const changesDirectory = ".content-workspace/changes";
const targetIdPattern = /^products\.robotaxi\.(title|intro|boundary|why\.eyebrow|why\.item\.[a-z0-9-]+\.text|heroActions\.[a-z0-9-]+\.(label|href)|closing\.(title|summary|action\.(label|href))|module\.[a-z0-9-]+\.(label|shortDescription|loopRelation|action\.href|order))$/;
const mediaTargetIdPattern = /^(?:media\.robotaxi\.(asset\.[a-z0-9-]+\.(type|src|ratio|alt|caption)|module\.[a-z0-9-]+\.mediaId)|products\.robotaxi\.module\.[a-z0-9-]+\.mediaId)$/;
const siteTargetIdPattern = /^site\.(home|sharedCopy)\.[a-z0-9-]+$/;

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function canonical(value) {
  return JSON.stringify(value);
}

function sameValue(left, right) {
  return canonical(left) === canonical(right);
}

export function hashValue(value) {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Stable identity for a logical content object.  The content snapshot hash is
 * intentionally not part of this value: a later approved ChangeSet is a new
 * physical revision of the same object, not a new logical object.
 */
export function logicalContentId({ kind, target } = {}) {
  if (!hasText(kind) || !hasText(target)) throw new Error("logicalContentId requires kind and target");
  return `${kind}:${target}`;
}

function inferLogicalContentId(targets = [], explicit = null) {
  if (explicit) return explicit;
  const sourcePaths = new Set(targets.map((target) => target?.sourcePath));
  if (["content/products/robotaxi.json", "content/media/robotaxi/manifest.json"].some((sourcePath) => sourcePaths.has(sourcePath))) {
    return logicalContentId({ kind: "practice", target: "robotaxi" });
  }
  return null;
}

function safeRelativePath(value, { allowSrc = true } = {}) {
  if (!hasText(value) || path.isAbsolute(value) || value.includes("\\")) return false;
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return false;
  return allowSrc || !normalized.startsWith("src/");
}

export function validateContentTargetRegistry(registry) {
  if (!registry || registry.registryId !== "xingbuild-content-targets" || registry.schemaVersion !== 1) {
    throw new Error("content target registry identity or schemaVersion is invalid");
  }
  if (!Array.isArray(registry.targets) || !Array.isArray(registry.templates) || !Array.isArray(registry.excluded)) {
    throw new Error("content target registry must contain targets, templates and excluded arrays");
  }
  const ids = new Set();
  for (const target of registry.targets) {
    if (!hasText(target?.targetId) || ids.has(target.targetId)) throw new Error(`content target registry has duplicate targetId: ${target?.targetId || "missing"}`);
    ids.add(target.targetId);
    if (target.scope !== "field" || !safeRelativePath(target.sourcePath, { allowSrc: false })) throw new Error(`content target registry has unsafe target source: ${target.targetId}`);
    if (target.kind === "product-content" && target.targetId.startsWith("products.robotaxi.")) {
      const responsiveAllowed = /\.(?:intro|why\.eyebrow|why\.item\.[a-z0-9-]+\.text|module\.[a-z0-9-]+\.shortDescription)$/.test(target.targetId || "");
      const expectedRoutes = target.targetId === "products.robotaxi.intro" ? ["/", "/products"] : ["/products"];
      if (target.editable !== true || target.scope !== "field" || !["string", RESPONSIVE_TEXT_SLOT_SCHEMA].includes(target.valueType) || (target.valueType === RESPONSIVE_TEXT_SLOT_SCHEMA && !responsiveAllowed) || target.sourcePath !== "content/products/robotaxi.json" || JSON.stringify(target.projectionRoutes) !== JSON.stringify(expectedRoutes) || !targetIdPattern.test(target.targetId || "")) {
        throw new Error(`Robotaxi product target contract is invalid: ${target.targetId}`);
      }
    }
    parseFieldPath(target.fieldPath);
    if (!Array.isArray(target.projectionRoutes) || target.projectionRoutes.length === 0 || target.projectionRoutes.some((route) => !hasText(route) || !route.startsWith("/"))) {
      throw new Error(`content target registry has invalid projection routes: ${target.targetId}`);
    }
  }
  for (const template of registry.templates) {
    if (!safeRelativePath(template?.sourcePathTemplate, { allowSrc: false })) throw new Error("content target registry has unsafe template source");
    if (!hasText(template.targetIdPattern) || !hasText(template.fieldPathTemplate || template.fieldPath) || template.scope !== "field" || template.editable !== true || !["string", RESPONSIVE_TEXT_SLOT_SCHEMA].includes(template.valueType)) throw new Error("content target registry template contract is invalid");
    if (template.kind === "product-content" && !template.targetIdPattern.startsWith("products.robotaxi.")) throw new Error("Robotaxi product template contract is invalid");
    if (template.kind === "site-content" && !siteTargetIdPattern.test(template.targetIdPattern.replace(/\{[^}]+\}/g, "sample-field"))) throw new Error("Site content template contract is invalid");
    if (template.kind === "media-content" && (!/^(?:media\.robotaxi\.|products\.robotaxi\.module\.)/.test(template.targetIdPattern) || !["content/media/robotaxi/manifest.json", "content/products/robotaxi.json"].includes(template.sourcePathTemplate))) throw new Error("Robotaxi media template contract is invalid");
    parseFieldPath(String(template.fieldPathTemplate || template.fieldPath).replace(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g, "samplefield"));
  }
  for (const excluded of registry.excluded) {
    if (excluded.sourcePath && !safeRelativePath(excluded.sourcePath)) throw new Error("content target registry has unsafe excluded source");
  }
  return registry;
}

export function changeFileName(changeId) {
  return `${String(changeId).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export function resolveContentSourceFile(sourcePath, { rootDirectory = projectRoot } = {}) {
  if (typeof sourcePath !== "string") throw new Error("content sourcePath is required");
  const normalized = path.posix.normalize(sourcePath);
  if (normalized.startsWith("content/") && !normalized.startsWith("content/registry/")) {
    return path.join(contentRootDirectory({ sourceRoot: rootDirectory }), normalized.slice("content/".length));
  }
  return path.join(rootDirectory, normalized);
}

export async function readContentTargetRegistry({ rootDirectory = projectRoot } = {}) {
  const file = path.join(rootDirectory, contentTargetsPath);
  return validateContentTargetRegistry(JSON.parse(await readFile(file, "utf8")));
}

function targetAllowed(target) {
  return target?.editable === true
    && ((target?.kind === "product-content" && targetIdPattern.test(target.targetId || ""))
      || (target?.kind === "site-content" && siteTargetIdPattern.test(target.targetId || ""))
      || (target?.kind === "media-content" && mediaTargetIdPattern.test(target.targetId || "")));
}

function instantiateTemplate(template, targetId) {
  const names = [...String(template.targetIdPattern).matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)].map((match) => match[1]);
  const pattern = new RegExp(`^${String(template.targetIdPattern).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\{[a-zA-Z][a-zA-Z0-9_]*\\\}/g, "([a-z0-9-]+)")}$`);
  const match = pattern.exec(targetId);
  if (!match) return null;
  const values = Object.fromEntries(names.map((name, index) => [name, match[index + 1]]));
  const replace = (value) => String(value).replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_, name) => values[name]);
  return { ...template, targetId, sourcePath: replace(template.sourcePathTemplate), fieldPath: replace(template.fieldPathTemplate || template.fieldPath), projectionRoutes: (template.projectionRoutes || []).map(replace), projectionKeys: (template.projectionKeys || []).map(replace) };
}

export async function resolveContentTarget(targetId, { rootDirectory = projectRoot } = {}) {
  if (!hasText(targetId)) throw new Error("content targetId is required");
  const registry = await readContentTargetRegistry({ rootDirectory });
  const target = (registry.targets || []).find((entry) => entry.targetId === targetId)
    || (registry.templates || []).map((entry) => instantiateTemplate(entry, targetId)).find(Boolean);
  if (!target) throw new Error(`content target is not registered: ${targetId}`);
  if (!target.editable || target.scope !== "field" || !["site-content", "product-content", "media-content", "observation", "article", "profile", "businessObservation"].includes(target.kind)) throw new Error(`content target is outside the approved field scope: ${targetId}`);
  if (target.sourcePath.startsWith("src/") || target.fieldPath.includes("[") && !target.fieldPath.includes("[id=")) {
    throw new Error(`content target has an unsafe source or field path: ${targetId}`);
  }
  return target;
}

/** Validate slot values against the target registry at the content boundary. */
export async function validateRegisteredResponsiveTextValues({ kind, target, value, rootDirectory = projectRoot } = {}) {
  const checks = [];
  if (kind === "home") {
    checks.push(["site.home.homeTitle", value?.homeTitle], ["site.home.description", value?.description]);
  } else if (kind === "practice") {
    checks.push(["products.robotaxi.intro", value?.intro]);
    if (value?.why?.eyebrow !== undefined) checks.push(["products.robotaxi.why.eyebrow", value.why.eyebrow]);
    for (const item of value?.why?.items || []) checks.push([`products.robotaxi.why.item.${item.id}.text`, item.text]);
    for (const module of value?.modules || []) checks.push([`products.robotaxi.module.${module.id}.shortDescription`, module.shortDescription]);
  }
  let registry;
  try { registry = await readContentTargetRegistry({ rootDirectory }); }
  catch (error) {
    if (error.code === "ENOENT" && checks.every(([, candidate]) => typeof candidate === "string")) return true;
    if (error.code === "ENOENT") throw new Error("responsive text target registry is required for slot values");
    throw error;
  }
  for (const [targetId, candidate] of checks) {
    const registered = (registry.targets || []).find((entry) => entry.targetId === targetId)
      || (registry.templates || []).map((entry) => instantiateTemplate(entry, targetId)).find(Boolean);
    if (!registered) throw new Error(`responsive text target is not registered: ${targetId}`);
    if (registered.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA) continue;
    normalizeResponsiveTextSlot(candidate, { projections: registered.projectionKeys || [], maxLength: registered.constraints?.maxLength || 400 });
  }
  return true;
}

export async function createContentTargetCard(targetId, { rootDirectory = projectRoot } = {}) {
  const target = await resolveContentTarget(targetId, { rootDirectory });
  const document = JSON.parse(await readFile(resolveContentSourceFile(target.sourcePath, { rootDirectory }), "utf8"));
  let current;
  try { current = readFieldValue(document, target.fieldPath); } catch (error) {
    if (target.kind === "media-content" && (target.fieldPath.startsWith("assets[id=") || target.fieldPath.includes("].mediaId"))) current = null;
    else throw error;
  }
  if (current !== null && typeof current !== "string" && target.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA) throw new Error(`registered target is not a supported field: ${targetId}`);
  return {
    targetId: target.targetId,
    scope: target.scope,
    kind: target.kind,
    sourcePath: target.sourcePath,
    fieldPath: target.fieldPath,
    current,
    beforeHash: hashValue(current),
    affectedRoutes: [...target.projectionRoutes],
    constraints: { ...(target.constraints || {}) },
    requires: [...(target.requires || [])],
    boundary: "仅允许该注册字段的字段级内容变更。",
  };
}

export function parseFieldPath(fieldPath) {
  if (!hasText(fieldPath) || fieldPath.includes("..") || fieldPath.includes("[") && !fieldPath.includes("[id=")) {
    throw new Error(`unsupported fieldPath: ${fieldPath || "missing"}`);
  }
  const segments = fieldPath.split(".");
  const parsed = segments.map((segment) => /^([a-zA-Z][a-zA-Z0-9_]*)(?:\[id=([a-z0-9-]+)\])?$/.exec(segment));
  if (parsed.some((segment) => !segment)) {
    throw new Error(`fieldPath must use explicit fields and stable id selectors: ${fieldPath}`);
  }
  return parsed.flatMap((segment) => segment[2] ? [segment[1], { id: segment[2] }] : [segment[1]]);
}

export function readFieldValue(document, fieldPath) {
  let cursor = document;
  for (const part of parseFieldPath(fieldPath)) {
    if (part && typeof part === "object" && "id" in part) {
      if (!Array.isArray(cursor)) throw new Error(`fieldPath selector is not applied to an array: ${fieldPath}`);
      cursor = cursor.find((entry) => entry?.id === part.id);
    } else {
      cursor = cursor?.[part];
    }
    if (cursor === undefined) throw new Error(`fieldPath does not resolve: ${fieldPath}`);
  }
  return cursor;
}

export function writeFieldValue(document, fieldPath, value) {
  const parts = parseFieldPath(fieldPath);
  const result = structuredClone(document);
  let cursor = result;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part && typeof part === "object" && "id" in part) {
      if (!Array.isArray(cursor)) throw new Error(`fieldPath selector is not applied to an array: ${fieldPath}`);
      let next = cursor.find((entry) => entry?.id === part.id);
      if (!next) {
        if (!String(fieldPath).startsWith("assets[id=")) throw new Error(`fieldPath selector does not resolve: ${fieldPath}`);
        next = { id: part.id };
        cursor.push(next);
      }
      cursor = next;
    } else {
      cursor = cursor?.[part];
    }
    if (cursor === undefined || cursor === null) throw new Error(`fieldPath does not resolve: ${fieldPath}`);
  }
  const last = parts.at(-1);
  if (last && typeof last === "object") throw new Error(`fieldPath must end in a field: ${fieldPath}`);
  if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) throw new Error(`fieldPath parent is not an object: ${fieldPath}`);
  cursor[last] = value;
  return result;
}

function validateAfter(target, after) {
  if (after === null && target.kind === "media-content" && target.fieldPath.startsWith("assets[id=")) return;
  if (target.valueType === RESPONSIVE_TEXT_SLOT_SCHEMA) {
    try { normalizeResponsiveTextSlot(after, { projections: target.projectionKeys }); }
    catch (error) { throw new Error(`${target.targetId} after responsive text is invalid: ${error.message}`); }
    return;
  }
  if (typeof after !== "string") throw new Error("ChangeSet after must be a string field value");
  const constraints = target.constraints || {};
  if (constraints.nonEmpty && !hasText(after)) throw new Error(`${target.targetId} after must be non-empty`);
  if (constraints.maxLength && after.length > constraints.maxLength) throw new Error(`${target.targetId} after exceeds maxLength`);
  if (constraints.httpsOnly) {
    let url;
    try { url = new URL(after); } catch { throw new Error(`${target.targetId} after must be a valid HTTPS URL`); }
    if (url.protocol !== "https:") throw new Error(`${target.targetId} after must use HTTPS`);
  }
  if (Array.isArray(constraints.enum) && !constraints.enum.includes(after)) throw new Error(`${target.targetId} after is outside the registered enum`);
}

function operationAfter(operation) {
  return Object.prototype.hasOwnProperty.call(operation || {}, "afterValue") ? operation.afterValue : operation?.after;
}

function operationBefore(operation) {
  return Object.prototype.hasOwnProperty.call(operation || {}, "beforeValue") ? operation.beforeValue : operation?.before;
}

function operationSourceRefs(operation, fallback = []) {
  return Array.isArray(operation?.sourceRefs) ? operation.sourceRefs : fallback;
}

function normalizeTargetValue(target, value) {
  if (target?.valueType === RESPONSIVE_TEXT_SLOT_SCHEMA && typeof value !== "string") {
    return normalizeResponsiveTextSlot(value, { projections: target.projectionKeys, maxLength: target.constraints?.maxLength || 400 });
  }
  return value;
}

function operationDescriptor(operation, target, { before, after } = {}) {
  const resolvedBefore = before === undefined ? operationBefore(operation) : before;
  const resolvedAfter = after === undefined ? operationAfter(operation) : after;
  return {
    targetId: target.targetId,
    sourcePath: target.sourcePath,
    fieldPath: target.fieldPath,
    valueType: target.valueType || "string",
    beforeHash: operation.beforeHash || hashValue(resolvedBefore),
    before: resolvedBefore,
    beforeValue: resolvedBefore,
    after: resolvedAfter,
    afterValue: resolvedAfter,
    afterHash: operation.afterHash || hashValue(resolvedAfter),
    affectedRoutes: [...(operation.affectedRoutes || target.projectionRoutes || [])],
    sourceRefs: [...operationSourceRefs(operation)],
    provenance: operation.provenance || null,
    requires: [...(operation.requires || target.requires || [])],
    logicalContentId: operation.logicalContentId || inferLogicalContentId([target]),
    boundary: operation.boundary || null,
    authority: operation.authority || null,
  };
}

/** Return the canonical operations array while retaining legacy single-field input. */
export function contentChangeSetOperations(changeSet) {
  if (Array.isArray(changeSet?.operations)) return changeSet.operations;
  if (changeSet?.targetId) {
    return [{
      targetId: changeSet.targetId,
      sourcePath: changeSet.sourcePath,
      fieldPath: changeSet.fieldPath,
      valueType: changeSet.valueType || "string",
      beforeHash: changeSet.beforeHash,
      before: changeSet.before,
      beforeValue: changeSet.before,
      after: changeSet.after,
      afterValue: changeSet.after,
      afterHash: changeSet.afterHash || hashValue(changeSet.after),
      affectedRoutes: changeSet.affectedRoutes,
      sourceRefs: changeSet.sourceRefs,
      provenance: changeSet.provenance || null,
      requires: changeSet.requires,
      boundary: changeSet.boundary,
      authority: changeSet.authority,
    }];
  }
  return [];
}

function validateLogicalContentId(value) {
  if (value !== undefined && (!hasText(value) || !/^[a-zA-Z][a-zA-Z0-9_-]*:[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value))) {
    throw new Error("ChangeSet logicalContentId is invalid");
  }
}

function validateOperation(operation, target, { index = 0, fallbackSourceRefs = [], fallbackBoundary = null, fallbackAuthority = null } = {}) {
  if (!operation || !hasText(operation.targetId)) throw new Error(`ChangeSet operation ${index + 1} targetId is required`);
  if (!target) throw new Error(`ChangeSet operation ${index + 1} target registry entry is required`);
  if (operation.targetId !== target.targetId || (operation.sourcePath && operation.sourcePath !== target.sourcePath) || (operation.fieldPath && operation.fieldPath !== target.fieldPath)) {
    throw new Error(`ChangeSet operation ${index + 1} target or field path does not match the registry`);
  }
  const after = operationAfter(operation);
  const before = operationBefore(operation);
  if (!/^[a-f0-9]{64}$/.test(operation.beforeHash || "")) throw new Error(`ChangeSet operation ${index + 1} beforeHash must be sha256`);
  if (!/^[a-f0-9]{64}$/.test(operation.afterHash || hashValue(after))) throw new Error(`ChangeSet operation ${index + 1} afterHash must be sha256`);
  if (operation.afterHash && operation.afterHash !== hashValue(after)) throw new Error(`ChangeSet operation ${index + 1} afterHash does not match afterValue`);
  const sourceRefs = operationSourceRefs(operation, fallbackSourceRefs);
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0 || sourceRefs.some((source) => !hasText(source))) throw new Error(`ChangeSet operation ${index + 1} sourceRefs are required`);
  const boundary = operation.boundary || fallbackBoundary;
  const authority = operation.authority || fallbackAuthority;
  if (!hasText(boundary) || !hasText(authority)) throw new Error(`ChangeSet operation ${index + 1} boundary and authority are required`);
  if (operation.valueType && operation.valueType !== target.valueType) throw new Error(`ChangeSet operation ${index + 1} valueType does not match the registry`);
  if (target.kind === "media-content" && (target.requires || []).some((requirement) => ["media-approval", "media-provenance"].includes(requirement))) {
    if (!operation.provenance || operation.provenance.approvalStatus !== "approved" || !hasText(operation.provenance.source)) {
      throw new Error(`ChangeSet operation ${index + 1} media approval/provenance is required`);
    }
  }
  if (target.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA && (Array.isArray(after) || (after && typeof after === "object"))) throw new Error("ChangeSet cannot replace an array or object");
  validateAfter(target, after);
  if (target.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA && before !== undefined && before !== null && typeof before !== "string") throw new Error(`ChangeSet operation ${index + 1} before must match the registered value type`);
  const normalizedBefore = before && typeof before === "object" ? normalizeTargetValue(target, before) : before;
  const normalizedAfter = normalizeTargetValue(target, after);
  return { ...operation, ...operationDescriptor({ ...operation, afterHash: operation.afterHash || hashValue(normalizedAfter) }, target, { before: normalizedBefore, after: normalizedAfter }), sourceRefs, boundary, authority };
}

/** Validate and normalize a multi-operation ChangeSet using registry targets. */
export async function validateContentChangeSetOperations(changeSet, { rootDirectory = projectRoot } = {}) {
  if (!changeSet || changeSet.scope !== "field-set") throw new Error("ChangeSet scope must be field-set");
  if (!hasText(changeSet.changeSetId || changeSet.changeId)) throw new Error("ChangeSet identity is required");
  validateLogicalContentId(changeSet.logicalContentId);
  const rawOperations = contentChangeSetOperations(changeSet);
  if (!Array.isArray(rawOperations) || rawOperations.length === 0) throw new Error("ChangeSet operations are required");
  const seen = new Set();
  const operations = [];
  for (let index = 0; index < rawOperations.length; index += 1) {
    const raw = rawOperations[index];
    if (seen.has(raw?.targetId)) throw new Error(`ChangeSet duplicate target: ${raw?.targetId || "missing"}`);
    seen.add(raw?.targetId);
    const target = await resolveContentTarget(raw?.targetId, { rootDirectory });
    operations.push(validateOperation(raw, target, {
      index,
      fallbackSourceRefs: changeSet.sourceRefs,
      fallbackBoundary: changeSet.boundary,
      fallbackAuthority: changeSet.authority,
    }));
  }
  const inferred = inferLogicalContentId(operations, changeSet.logicalContentId);
  if (!inferred) throw new Error("ChangeSet logicalContentId is required");
  const operationLogicalIds = operations.map((operation) => operation.logicalContentId).filter(Boolean);
  if (operationLogicalIds.some((value) => value !== inferred)) throw new Error("ChangeSet operations cross logical content identities");
  return {
    ...changeSet,
    scope: "field-set",
    changeSetId: changeSet.changeSetId || changeSet.changeId,
    changeId: changeSet.changeId || changeSet.changeSetId,
    logicalContentId: inferred,
    operations,
    changedTargets: operations.map((operation) => operation.targetId),
  };
}

export async function createContentChangeSet({
  targetId,
  after,
  beforeHash,
  sourceRefs,
  boundary,
  authority,
  rootDirectory = projectRoot,
  changeId,
  changeSetId,
  logicalContentId: requestedLogicalContentId,
  operations,
} = {}) {
  if (Array.isArray(operations)) {
    if (operations.length === 0) throw new Error("ChangeSet operations are required");
    const resolved = [];
    const seen = new Set();
    for (let index = 0; index < operations.length; index += 1) {
      const operation = operations[index] || {};
      if (seen.has(operation.targetId)) throw new Error(`ChangeSet duplicate target: ${operation.targetId || "missing"}`);
      seen.add(operation.targetId);
      const target = await resolveContentTarget(operation.targetId, { rootDirectory });
      const sourceFile = resolveContentSourceFile(target.sourcePath, { rootDirectory });
      const document = JSON.parse(await readFile(sourceFile, "utf8"));
      let before;
      try { before = readFieldValue(document, target.fieldPath); } catch (error) {
        if (target.kind === "media-content" && (target.fieldPath.startsWith("assets[id=") || target.fieldPath.includes("].mediaId"))) before = null;
        else throw error;
      }
      if (before !== null && typeof before !== "string" && target.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA) throw new Error(`registered target is not a supported field: ${operation.targetId}`);
      const nextAfter = normalizeTargetValue(target, operationAfter(operation));
      validateAfter(target, nextAfter);
      const actualBeforeHash = hashValue(before);
      if (operation.beforeHash && operation.beforeHash !== actualBeforeHash) throw new Error(`ChangeSet beforeHash conflict for ${operation.targetId}`);
      const operationSourceRefs = operation.sourceRefs || sourceRefs;
      const operationBoundary = operation.boundary || boundary;
      const operationAuthority = operation.authority || authority;
      if (!Array.isArray(operationSourceRefs) || operationSourceRefs.length === 0 || operationSourceRefs.some((source) => !hasText(source))) throw new Error(`ChangeSet operation ${index + 1} sourceRefs are required`);
      if (!hasText(operationBoundary) || !hasText(operationAuthority)) throw new Error(`ChangeSet operation ${index + 1} boundary and authority are required`);
      if (target.kind === "media-content" && (target.requires || []).some((requirement) => ["media-approval", "media-provenance"].includes(requirement))
        && (!operation.provenance || operation.provenance.approvalStatus !== "approved" || !hasText(operation.provenance.source))) {
        throw new Error(`ChangeSet operation ${index + 1} media approval/provenance is required`);
      }
      resolved.push({
        ...operationDescriptor({ ...operation, sourceRefs: operationSourceRefs, boundary: operationBoundary, authority: operationAuthority }, target, { before, after: nextAfter }),
        logicalContentId: operation.logicalContentId || inferLogicalContentId([target], requestedLogicalContentId),
        target,
      });
    }
    const inferred = inferLogicalContentId(resolved, requestedLogicalContentId);
    if (!inferred) throw new Error("ChangeSet logicalContentId is required");
    if (resolved.some((operation) => operation.logicalContentId && operation.logicalContentId !== inferred)) throw new Error("ChangeSet operations cross logical content identities");
    const canonicalOperations = resolved.map(({ target: _target, ...operation }) => operation);
    const deterministicInput = { logicalContentId: inferred, operations: canonicalOperations.map((operation) => ({
      targetId: operation.targetId,
      beforeHash: operation.beforeHash,
      afterHash: operation.afterHash,
      afterValue: operation.afterValue,
      sourcePath: operation.sourcePath,
      fieldPath: operation.fieldPath,
    })) };
    const nextChangeSetId = changeSetId || changeId || `changeset-${hashValue(deterministicInput).slice(0, 24)}`;
    const changeSet = {
      changeSetId: nextChangeSetId,
      changeId: nextChangeSetId,
      scope: "field-set",
      logicalContentId: inferred,
      operations: canonicalOperations,
      changedTargets: canonicalOperations.map((operation) => operation.targetId),
      affectedRoutes: [...new Set(canonicalOperations.flatMap((operation) => operation.affectedRoutes || []))].sort(),
      sourceRefs: [...new Set(canonicalOperations.flatMap((operation) => operation.sourceRefs || []))],
      boundary: boundary || "仅允许登记目标字段的原子多字段内容变更。",
      authority: authority || "registered-approved-content",
      baseProductVersion: null,
      recovery: {
        type: "operations-reverse",
        rollbackChangeId: `${nextChangeSetId}-rollback`,
        operations: [...canonicalOperations].reverse().map((operation) => ({
          ...operation,
          beforeHash: operation.afterHash,
          before: operation.afterValue,
          beforeValue: operation.afterValue,
          after: operation.beforeValue,
          afterValue: operation.beforeValue,
          afterHash: hashValue(operation.beforeValue),
        })),
      },
    };
    return { ...changeSet, operations: canonicalOperations.map((operation) => ({ ...operation, target: resolved.find((value) => value.targetId === operation.targetId)?.target })) };
  }
  const target = await resolveContentTarget(targetId, { rootDirectory });
  if (!Array.isArray(sourceRefs) || sourceRefs.length === 0 || sourceRefs.some((source) => !hasText(source))) {
    throw new Error("ChangeSet sourceRefs must contain at least one non-empty source");
  }
  if (!hasText(boundary)) throw new Error("ChangeSet boundary is required");
  if (!hasText(authority)) throw new Error("ChangeSet authority is required");
  validateAfter(target, after);
  const sourceFile = resolveContentSourceFile(target.sourcePath, { rootDirectory });
  const document = JSON.parse(await readFile(sourceFile, "utf8"));
  let before;
  try { before = readFieldValue(document, target.fieldPath); } catch (error) {
    if (target.kind === "media-content" && (target.fieldPath.startsWith("assets[id=") || target.fieldPath.includes("].mediaId"))) before = null;
    else throw error;
  }
  if (before !== null && typeof before !== "string" && target.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA) throw new Error(`registered target is not a supported field: ${targetId}`);
  const actualBeforeHash = hashValue(before);
  if (beforeHash && beforeHash !== actualBeforeHash) throw new Error(`ChangeSet beforeHash conflict for ${targetId}`);
  const normalizedAfter = normalizeTargetValue(target, after);
  const nextChangeId = changeId || `change-${targetId.replace(/[^a-zA-Z0-9-]/g, "-")}-${hashValue(normalizedAfter).slice(0, 16)}`;
  const changeSet = {
    changeSetId: nextChangeId,
    changeId: nextChangeId,
    targetId: target.targetId,
    scope: "field",
    logicalContentId: inferLogicalContentId([target], requestedLogicalContentId),
    sourcePath: target.sourcePath,
    fieldPath: target.fieldPath,
    beforeHash: actualBeforeHash,
    before,
    after: normalizedAfter,
    afterHash: hashValue(normalizedAfter),
    affectedRoutes: [...target.projectionRoutes],
    sourceRefs: [...sourceRefs],
    boundary,
    authority,
    baseProductVersion: null,
    recovery: {
      type: "field-reverse",
      rollbackChangeId: `${nextChangeId}-rollback`,
      originalBefore: before,
      originalAfter: normalizedAfter,
    },
  };
  changeSet.operations = [operationDescriptor(changeSet, target, { before, after: normalizedAfter })];
  changeSet.changedTargets = [target.targetId];
  return { ...changeSet, target };
}

export function validateContentChangeSet(changeSet, { target } = {}) {
  if (changeSet?.scope === "field-set") {
    if (!hasText(changeSet.changeSetId || changeSet.changeId)) throw new Error("ChangeSet identity is required");
    validateLogicalContentId(changeSet.logicalContentId);
    const operations = contentChangeSetOperations(changeSet);
    if (!Array.isArray(operations) || operations.length === 0) throw new Error("ChangeSet operations are required");
    const seen = new Set();
    for (const [index, operation] of operations.entries()) {
      if (!hasText(operation?.targetId)) throw new Error(`ChangeSet operation ${index + 1} targetId is required`);
      if (seen.has(operation.targetId)) throw new Error(`ChangeSet duplicate target: ${operation.targetId}`);
      seen.add(operation.targetId);
      if (!/^[a-f0-9]{64}$/.test(operation.beforeHash || "")) throw new Error(`ChangeSet operation ${index + 1} beforeHash must be sha256`);
      const after = operationAfter(operation);
      if (!/^[a-f0-9]{64}$/.test(operation.afterHash || hashValue(after))) throw new Error(`ChangeSet operation ${index + 1} afterHash must be sha256`);
      if (operation.afterHash && operation.afterHash !== hashValue(after)) throw new Error(`ChangeSet operation ${index + 1} afterHash does not match afterValue`);
      if (!Array.isArray(operation.sourceRefs) || operation.sourceRefs.length === 0 || operation.sourceRefs.some((source) => !hasText(source))) throw new Error(`ChangeSet operation ${index + 1} sourceRefs are required`);
      if (!hasText(operation.boundary || changeSet.boundary) || !hasText(operation.authority || changeSet.authority)) throw new Error(`ChangeSet operation ${index + 1} boundary and authority are required`);
    }
    if (changeSet.changedTargets && JSON.stringify(changeSet.changedTargets) !== JSON.stringify(operations.map((operation) => operation.targetId))) throw new Error("ChangeSet changedTargets are incomplete");
    return changeSet;
  }
  if (!changeSet || changeSet.scope !== "field") throw new Error("ChangeSet scope must be field");
  if (!hasText(changeSet.changeId) || !hasText(changeSet.targetId)) throw new Error("ChangeSet identity is required");
  if (!target) throw new Error("ChangeSet target registry entry is required");
  if (changeSet.targetId !== target.targetId || changeSet.sourcePath !== target.sourcePath || changeSet.fieldPath !== target.fieldPath) {
    throw new Error("ChangeSet target or field path does not match the registry");
  }
  if (JSON.stringify(changeSet.affectedRoutes) !== JSON.stringify(target.projectionRoutes)) throw new Error("ChangeSet affectedRoutes do not match the registry");
  if (!/^[a-f0-9]{64}$/.test(changeSet.beforeHash || "")) throw new Error("ChangeSet beforeHash must be sha256");
  if (!Array.isArray(changeSet.sourceRefs) || changeSet.sourceRefs.length === 0 || changeSet.sourceRefs.some((source) => !hasText(source))) throw new Error("ChangeSet sourceRefs are required");
  if (!hasText(changeSet.boundary) || !hasText(changeSet.authority)) throw new Error("ChangeSet boundary and authority are required");
  if (target.valueType !== RESPONSIVE_TEXT_SLOT_SCHEMA && (Array.isArray(changeSet.after) || (changeSet.after && typeof changeSet.after === "object"))) throw new Error("ChangeSet cannot replace an array or object");
  validateAfter(target, changeSet.after);
  if (changeSet.recovery) {
    if (changeSet.recovery.type !== "field-reverse" || !hasText(changeSet.recovery.rollbackChangeId) || !sameValue(changeSet.recovery.originalBefore, changeSet.before) || !sameValue(changeSet.recovery.originalAfter, changeSet.after)) {
      throw new Error("ChangeSet recovery descriptor is invalid");
    }
  }
  if (changeSet.contentReleaseId !== undefined && !hasText(changeSet.contentReleaseId)) throw new Error("ChangeSet contentReleaseId is invalid");
  if (changeSet.releasePackage !== undefined && (!hasText(changeSet.releasePackage) || !changeSet.releasePackage.startsWith(`${path.posix.normalize(".content-workspace/releases")}/`))) {
    throw new Error("ChangeSet releasePackage must stay inside .content-workspace/releases");
  }
  if (changeSet.rollbackOf) {
    if (!hasText(changeSet.rollbackOf.changeId) || !hasText(changeSet.rollbackOf.contentReleaseId) || !hasText(changeSet.rollbackOf.releasePackage) || !sameValue(changeSet.rollbackOf.originalBefore, changeSet.after) || !sameValue(changeSet.rollbackOf.originalAfter, changeSet.before)) {
      throw new Error("rollback ChangeSet must link its source content release and preimage");
    }
  }
  return changeSet;
}

export async function writeContentChangeSet(changeSet, { rootDirectory = projectRoot } = {}) {
  let normalized = changeSet;
  if (changeSet?.scope === "field-set") normalized = await validateContentChangeSetOperations(changeSet, { rootDirectory });
  else {
    const target = await resolveContentTarget(changeSet?.targetId, { rootDirectory });
    validateContentChangeSet(changeSet, { target });
  }
  const { target: _target, file: _file, ...persisted } = normalized;
  if (Array.isArray(persisted.operations)) persisted.operations = persisted.operations.map(({ target: _operationTarget, ...operation }) => operation);
  const directory = path.join(rootDirectory, changesDirectory);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, changeFileName(normalized.changeSetId || normalized.changeId));
  if (await exists(file)) {
    const existing = JSON.parse(await readFile(file, "utf8"));
    if (JSON.stringify(existing) !== JSON.stringify(persisted)) throw new Error(`ChangeSet identity conflict: ${normalized.changeSetId || normalized.changeId}`);
  } else {
    await writeFile(file, `${JSON.stringify(persisted, null, 2)}\n`);
  }
  return { ...normalized, file };
}

export async function linkContentChangeSetRelease(changeSetPath, { contentReleaseId, releasePackage, rootDirectory = projectRoot } = {}) {
  const changeSet = await readContentChangeSet(changeSetPath, { rootDirectory });
  if (!hasText(contentReleaseId) || !hasText(releasePackage)) throw new Error("content release association requires contentReleaseId and releasePackage");
  const relativePackage = path.posix.normalize(releasePackage.split(path.sep).join("/"));
  if (!relativePackage.startsWith(".content-workspace/releases/")) throw new Error("content release package must stay inside .content-workspace/releases");
  const persisted = {
    ...changeSet,
    target: undefined,
    file: undefined,
    contentReleaseId,
    releasePackage: relativePackage,
    recovery: {
      ...changeSet.recovery,
      contentReleaseId,
      releasePackage: relativePackage,
    },
  };
  const { target: _target, file: _file, ...json } = persisted;
  await writeFile(changeSet.file, `${JSON.stringify(json, null, 2)}\n`);
  return { ...changeSet, ...json, target: changeSet.target, file: changeSet.file };
}

export async function createRollbackChangeSet(changeSetPath, { rootDirectory = projectRoot, changeId } = {}) {
  const original = await readContentChangeSet(changeSetPath, { rootDirectory });
  if (!hasText(original.contentReleaseId) || !hasText(original.releasePackage)) {
    throw new Error("rollback requires a prepared contentReleaseId and releasePackage association");
  }
  if (original.scope === "field-set") {
    const rollbackId = changeId || original.recovery?.rollbackChangeId || `${original.changeSetId || original.changeId}-rollback`;
    const operations = [...original.operations].reverse().map((operation) => ({
      ...operation,
      beforeHash: operation.afterHash,
      before: operation.afterValue,
      beforeValue: operation.afterValue,
      after: operation.beforeValue,
      afterValue: operation.beforeValue,
      afterHash: hashValue(operation.beforeValue),
      sourceRefs: [...(operation.sourceRefs || []), `rollback:${original.changeSetId || original.changeId}`],
    }));
    const rollback = {
      changeSetId: rollbackId,
      changeId: rollbackId,
      scope: "field-set",
      logicalContentId: original.logicalContentId,
      operations,
      changedTargets: operations.map((operation) => operation.targetId),
      affectedRoutes: [...new Set(operations.flatMap((operation) => operation.affectedRoutes || []))].sort(),
      sourceRefs: [...new Set(operations.flatMap((operation) => operation.sourceRefs || []))],
      boundary: original.boundary,
      authority: original.authority,
      contentReleaseId: original.contentReleaseId,
      releasePackage: original.releasePackage,
      rollbackOf: {
        changeSetId: original.changeSetId || original.changeId,
        changeId: original.changeId,
        contentReleaseId: original.contentReleaseId,
        releasePackage: original.releasePackage,
        logicalContentId: original.logicalContentId,
        operations: original.operations,
      },
      recovery: { type: "operations-reverse", rollbackChangeId: `${rollbackId}-rollback`, operations: original.operations },
    };
    return writeContentChangeSet(rollback, { rootDirectory });
  }
  const rollback = {
    changeId: changeId || original.recovery?.rollbackChangeId || `${original.changeId}-rollback`,
    targetId: original.targetId,
    scope: "field",
    sourcePath: original.sourcePath,
    fieldPath: original.fieldPath,
    beforeHash: hashValue(original.after),
    before: original.after,
    after: original.before,
    affectedRoutes: [...original.affectedRoutes],
    sourceRefs: [...original.sourceRefs, `rollback:${original.changeId}`],
    boundary: original.boundary,
    authority: original.authority,
    rollbackOf: {
      changeId: original.changeId,
      contentReleaseId: original.contentReleaseId,
      releasePackage: original.releasePackage,
      originalBefore: original.before,
      originalAfter: original.after,
    },
    recovery: {
      type: "field-reverse",
      rollbackChangeId: `${original.changeId}-rollback-rollback`,
      originalBefore: original.after,
      originalAfter: original.before,
    },
  };
  return writeContentChangeSet(rollback, { rootDirectory });
}

export async function readContentChangeSet(changeSetPath, { rootDirectory = projectRoot } = {}) {
  if (!hasText(changeSetPath)) throw new Error("ChangeSet path is required");
  const resolved = path.resolve(rootDirectory, changeSetPath);
  const allowedRoot = path.resolve(rootDirectory, changesDirectory);
  if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error("ChangeSet must be inside .content-workspace/changes");
  const changeSet = JSON.parse(await readFile(resolved, "utf8"));
  if (changeSet.scope === "field-set") {
    const normalized = await validateContentChangeSetOperations(changeSet, { rootDirectory });
    return { ...normalized, file: resolved };
  }
  const target = await resolveContentTarget(changeSet.targetId, { rootDirectory });
  validateContentChangeSet(changeSet, { target });
  return { ...changeSet, target, file: resolved };
}

export function applyContentChangeSet(document, changeSet) {
  if (Array.isArray(changeSet?.operations)) {
    const operations = changeSet.operations;
    const sourcePaths = new Set(operations.map((operation) => operation.sourcePath).filter(Boolean));
    if (sourcePaths.size > 1) throw new Error("ChangeSet operations span multiple source documents; use applyContentChangeSetDocuments");
    let result = structuredClone(document);
    for (const operation of operations) result = applyContentChangeSet(result, { ...operation, target: operation.target || { kind: "media-content", fieldPath: operation.fieldPath, targetId: operation.targetId } });
    return result;
  }
  const target = changeSet.target || changeSet;
  let before;
  try { before = readFieldValue(document, target.fieldPath); } catch (error) {
    if (target.kind === "media-content" && (target.fieldPath.startsWith("assets[id=") || target.fieldPath.includes("].mediaId"))) before = null;
    else throw error;
  }
  if (hashValue(before) !== changeSet.beforeHash) throw new Error(`ChangeSet beforeHash conflict for ${changeSet.targetId}`);
  if (changeSet.after === null && target.fieldPath.startsWith("assets[id=")) return removeFieldValue(document, target.fieldPath);
  return writeFieldValue(document, target.fieldPath, changeSet.after);
}

/**
 * Apply every operation to a cloned document set.  No caller-visible document
 * is changed when any precondition fails; this is the staging/rollback atomic
 * boundary used by content-release prepare.
 */
export function applyContentChangeSetDocuments(documents, changeSet) {
  const operations = contentChangeSetOperations(changeSet);
  if (!operations.length) throw new Error("ChangeSet operations are required");
  const result = documents instanceof Map ? new Map([...documents].map(([key, value]) => [key, structuredClone(value)])) : Object.fromEntries(Object.entries(documents || {}).map(([key, value]) => [key, structuredClone(value)]));
  const get = (sourcePath) => result instanceof Map ? result.get(sourcePath) : result[sourcePath];
  const set = (sourcePath, value) => { if (result instanceof Map) result.set(sourcePath, value); else result[sourcePath] = value; };
  for (const operation of operations) {
    const sourcePath = operation.sourcePath;
    if (!sourcePath) throw new Error(`ChangeSet operation sourcePath is missing: ${operation.targetId}`);
    const document = get(sourcePath);
    if (document === undefined) throw new Error(`ChangeSet source document is missing: ${sourcePath}`);
    const target = operation.target || { kind: "media-content", fieldPath: operation.fieldPath, targetId: operation.targetId };
    set(sourcePath, applyContentChangeSet(document, { ...operation, after: operationAfter(operation), beforeHash: operation.beforeHash, target }));
  }
  return result;
}

export function removeFieldValue(document, fieldPath) {
  const parts = parseFieldPath(fieldPath);
  const result = structuredClone(document);
  let cursor = result;
  let selectedArray = null;
  let selectedIndex = -1;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    if (part && typeof part === "object" && "id" in part) {
      if (!Array.isArray(cursor)) throw new Error(`fieldPath selector is not applied to an array: ${fieldPath}`);
      selectedArray = cursor;
      selectedIndex = cursor.findIndex((entry) => entry?.id === part.id);
      if (selectedIndex < 0) return result;
      cursor = cursor[selectedIndex];
    } else cursor = cursor?.[part];
  }
  const last = parts.at(-1);
  if (cursor && typeof cursor === "object" && !Array.isArray(cursor)) delete cursor[last];
  if (selectedArray && selectedIndex >= 0 && Object.keys(selectedArray[selectedIndex]).length === 1 && Object.prototype.hasOwnProperty.call(selectedArray[selectedIndex], "id")) selectedArray.splice(selectedIndex, 1);
  return result;
}
