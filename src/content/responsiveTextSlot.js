/**
 * Bounded responsive text content.  A slot carries semantic text parts and
 * projection-level break hints; it never carries HTML, CSS or DOM selectors.
 */
export const RESPONSIVE_TEXT_SLOT_SCHEMA = "responsive-text-slot-v1";
export const RESPONSIVE_TEXT_PROFILES = Object.freeze(["web", "mobile"]);
const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const MARKUP_PATTERN = /<\/?[a-z][^>]*>|\b(?:class|style|id)\s*=|[.#][a-zA-Z][\w-]*\s*\{/i;

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be non-empty text`);
  if (CONTROL_PATTERN.test(value)) throw new Error(`${field} contains control characters`);
  if (MARKUP_PATTERN.test(value)) throw new Error(`${field} must be plain text without HTML/CSS/DOM syntax`);
  return value;
}

function projectionName(value) {
  if (typeof value !== "string" || !/^[a-z][a-zA-Z0-9-]*(?:\.[a-z][a-zA-Z0-9-]*)+$/.test(value)) {
    throw new Error(`responsive text projection is invalid: ${String(value)}`);
  }
  return value;
}

function normalizeBreakAfter(value, parts, profile, projection) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error(`${projection}.${profile}.breakAfter must be an array`);
  const ids = new Set(parts.map((part) => part.id));
  const seen = new Set();
  for (const id of value) {
    if (typeof id !== "string" || !ids.has(id)) throw new Error(`${projection}.${profile}.breakAfter references an unknown part: ${String(id)}`);
    if (seen.has(id)) throw new Error(`${projection}.${profile}.breakAfter contains duplicate part: ${id}`);
    if (id === parts.at(-1)?.id) throw new Error(`${projection}.${profile}.breakAfter cannot follow the final part`);
    seen.add(id);
  }
  return [...value];
}

function normalizeProjection(value, parts, projection) {
  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`responsive text projection must be an object: ${projection}`);
  }
  const allowed = new Set(RESPONSIVE_TEXT_PROFILES);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${projection} has unknown profile: ${key}`);
  return Object.fromEntries(RESPONSIVE_TEXT_PROFILES
    .filter((profile) => value[profile] != null)
    .map((profile) => [profile, { breakAfter: normalizeBreakAfter(value[profile]?.breakAfter, parts, profile, projection) }]));
}

/** Normalize a legacy string or a responsive-text-slot-v1 object. */
export function normalizeResponsiveTextSlot(value, { projections = undefined, maxParts = 32, maxLength = 4000 } = {}) {
  if (typeof value === "string") {
    text(value, "responsive text value");
    return { schemaVersion: RESPONSIVE_TEXT_SLOT_SCHEMA, parts: [{ id: "legacy", text: value }], projections: {} };
  }
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error("responsive text value must be a plain string or slot object");
  if (value.schemaVersion !== RESPONSIVE_TEXT_SLOT_SCHEMA) throw new Error(`responsive text schemaVersion must be ${RESPONSIVE_TEXT_SLOT_SCHEMA}`);
  if (!Array.isArray(value.parts) || value.parts.length === 0 || value.parts.length > maxParts) throw new Error("responsive text parts must be a non-empty bounded array");
  const ids = new Set();
  const parts = value.parts.map((part, index) => {
    if (part == null || typeof part !== "object" || Array.isArray(part)) throw new Error(`responsive text part ${index + 1} must be an object`);
    if (typeof part.id !== "string" || !ID_PATTERN.test(part.id)) throw new Error(`responsive text part ${index + 1} id must be kebab-case`);
    if (ids.has(part.id)) throw new Error(`responsive text part id is duplicated: ${part.id}`);
    ids.add(part.id);
    return { id: part.id, text: text(part.text, `responsive text part ${part.id}.text`) };
  });
  if (parts.reduce((total, part) => total + part.text.length, 0) > maxLength) throw new Error("responsive text exceeds maxLength");
  if (value.projections == null || typeof value.projections !== "object" || Array.isArray(value.projections)) throw new Error("responsive text projections must be an object");
  const registered = projections ? new Set(projections) : null;
  const normalizedProjections = {};
  for (const [rawProjection, projectionValue] of Object.entries(value.projections)) {
    const projection = projectionName(rawProjection);
    if (registered && !registered.has(projection)) throw new Error(`responsive text projection is not registered: ${projection}`);
    normalizedProjections[projection] = normalizeProjection(projectionValue, parts, projection);
  }
  return { schemaVersion: RESPONSIVE_TEXT_SLOT_SCHEMA, parts, projections: normalizedProjections };
}

export function isResponsiveTextSlot(value) {
  return Boolean(value && typeof value === "object" && value.schemaVersion === RESPONSIVE_TEXT_SLOT_SCHEMA && Array.isArray(value.parts));
}

export function responsiveTextValue(value, { projection = undefined, profile = "web", projections = undefined } = {}) {
  const slot = normalizeResponsiveTextSlot(value, { projections });
  if (!projection) return slot.parts.map((part) => part.text).join("");
  const normalizedProjection = slot.projections[projection];
  if (!normalizedProjection) return slot.parts.map((part) => part.text).join("");
  const breaks = new Set(normalizedProjection[profile]?.breakAfter || []);
  return slot.parts.map((part) => `${part.text}${breaks.has(part.id) ? "\n" : ""}`).join("");
}

export function responsiveTextSegments(value, { projection = undefined, profile = "web", projections = undefined } = {}) {
  const slot = normalizeResponsiveTextSlot(value, { projections });
  const breaks = new Set(slot.projections[projection]?.[profile]?.breakAfter || []);
  return slot.parts.flatMap((part) => breaks.has(part.id) ? [part.text, "\n"] : [part.text]);
}

export const normalizeResponsiveText = normalizeResponsiveTextSlot;
export const validateResponsiveTextSlot = normalizeResponsiveTextSlot;
