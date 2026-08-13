import { normalizeResponsiveTextSlot, responsiveTextValue, RESPONSIVE_TEXT_SLOT_SCHEMA } from "./responsive-text-slot.mjs";

export const CONTENT_AUTHORING_SCHEMA = "content-authoring-value-v1";
export const RICH_TEXT_LIST_SCHEMA = "content-rich-text-list-v1";

function normalizeLines(value, field) {
  if (typeof value !== "string") throw new Error(`${field} must be text`);
  const normalized = value.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (normalized.trim() === "") throw new Error(`${field} must be non-empty text`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error(`${field} contains unsupported control characters`);
  }
  if (normalized.split("\n").some((line) => line.trim() === "")) {
    throw new Error(`${field} cannot contain empty lines`);
  }
  return normalized;
}

function boundaries(value) {
  const lines = value.split("\n");
  const indexes = [];
  let offset = 0;
  for (let index = 0; index < lines.length - 1; index += 1) {
    offset += lines[index].length;
    indexes.push(offset);
  }
  return { lines, indexes };
}

function partId(index) {
  return `line-${index + 1}`;
}

/** Convert author-visible Web/Mobile text into the internal responsive slot. */
export function compileResponsiveAuthoringValue({ text, mobileText = undefined, projectionKeys = [], maxLength = 400, existingValue = undefined } = {}) {
  const web = normalizeLines(text, "web text");
  const mobile = mobileText == null || mobileText === "" ? web : normalizeLines(mobileText, "mobile text");
  const webSource = web.replaceAll("\n", "");
  const mobileSource = mobile.replaceAll("\n", "");
  if (webSource !== mobileSource) throw new Error("Web and Mobile text must contain the same characters; only line breaks may differ");
  if (webSource.length > maxLength) throw new Error(`text exceeds maxLength ${maxLength}`);
  if (existingValue) {
    try {
      const existing = decompileResponsiveAuthoringValue(existingValue, { projectionKeys });
      if (existing.text === web && existing.mobileText === mobile) return structuredClone(existingValue);
    } catch {
      // The normal compiler below is the source of truth for an invalid or
      // legacy value; callers still receive the same validation guarantees.
    }
  }
  const webShape = boundaries(web);
  const mobileShape = boundaries(mobile);
  const allBoundaries = [...new Set([...webShape.indexes, ...mobileShape.indexes])].sort((a, b) => a - b);
  const parts = [];
  const usedIds = new Set();
  let start = 0;
  for (const end of [...allBoundaries, webSource.length]) {
    const value = webSource.slice(start, end);
    if (!value) throw new Error("authoring text produced an empty part");
    const existingId = existingValue?.parts?.[parts.length]?.id;
    let id = typeof existingId === "string" && existingId.length > 0 ? existingId : partId(parts.length);
    let suffix = 2;
    while (usedIds.has(id)) id = `${partId(parts.length)}-${suffix++}`;
    usedIds.add(id);
    parts.push({ id, text: value });
    start = end;
  }
  const boundaryToPart = new Map();
  let offset = 0;
  for (const part of parts) {
    offset += part.text.length;
    boundaryToPart.set(offset, part.id);
  }
  const profileBreaks = (shape) => shape.indexes.map((index) => boundaryToPart.get(index)).filter(Boolean);
  const profiles = {
    web: { breakAfter: profileBreaks(webShape) },
    mobile: { breakAfter: profileBreaks(mobileShape) },
  };
  const projections = Object.fromEntries((projectionKeys || []).map((projection) => [projection, structuredClone(profiles)]));
  return { schemaVersion: RESPONSIVE_TEXT_SLOT_SCHEMA, parts, projections };
}

/** Convert an internal slot into the author-visible Web/Mobile text pair. */
export function decompileResponsiveAuthoringValue(value, { projectionKeys = [] } = {}) {
  const slot = normalizeResponsiveTextSlot(value, { projections: projectionKeys });
  const projection = projectionKeys[0] || Object.keys(slot.projections)[0];
  return {
    schemaVersion: CONTENT_AUTHORING_SCHEMA,
    valueType: RESPONSIVE_TEXT_SLOT_SCHEMA,
    text: responsiveTextValue(slot, { projection, profile: "web" }),
    mobileText: responsiveTextValue(slot, { projection, profile: "mobile" }),
    projection,
  };
}

export function decompileAuthoringValue(value, { valueType, projectionKeys = [] } = {}) {
  if (valueType === RESPONSIVE_TEXT_SLOT_SCHEMA) return decompileResponsiveAuthoringValue(value, { projectionKeys });
  if (valueType === RICH_TEXT_LIST_SCHEMA) {
    if (typeof value !== "string" && !Array.isArray(value)) throw new Error("rich text list must be a legacy string or an array of strings");
    const lines = typeof value === "string" ? [value] : value;
    if (lines.some((line) => typeof line !== "string" || line.trim() === "")) throw new Error("rich text list must contain non-empty strings");
    const text = lines.join("\n");
    return { schemaVersion: CONTENT_AUTHORING_SCHEMA, valueType: RICH_TEXT_LIST_SCHEMA, text, mobileText: text, projection: null };
  }
  if (typeof value !== "string") throw new Error("authoring value must be a string or responsive text slot");
  return { schemaVersion: CONTENT_AUTHORING_SCHEMA, valueType: "string", text: value, mobileText: null, projection: null };
}

export function compileAuthoringValue({ text, mobileText = undefined, valueType, projectionKeys = [], maxLength = 400, existingValue = undefined } = {}) {
  if (valueType === RESPONSIVE_TEXT_SLOT_SCHEMA) {
    return compileResponsiveAuthoringValue({ text, mobileText, projectionKeys, maxLength, existingValue });
  }
  if (valueType === RICH_TEXT_LIST_SCHEMA) {
    const normalized = normalizeLines(text, "rich text");
    if (normalized.length > maxLength) throw new Error(`text exceeds maxLength ${maxLength}`);
    if (!normalized.includes("\n") && typeof existingValue === "string") return normalized;
    if (!normalized.includes("\n") && Array.isArray(existingValue)) {
      // A multi-paragraph edit that is deliberately collapsed back to one
      // line can return to the legacy scalar representation. This makes the
      // workbench's restore-original flow byte-stable without migrating an
      // untouched legacy string.
      return existingValue.length > 1 ? normalized : [normalized];
    }
    return normalized.split("\n");
  }
  const result = normalizeLines(text, "text");
  if (result.length > maxLength) throw new Error(`text exceeds maxLength ${maxLength}`);
  return result;
}
