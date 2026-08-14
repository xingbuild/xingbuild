/**
 * The shared long-form document boundary used by About and the evergreen
 * business observation.  Existing content files intentionally remain in their
 * legacy shape; this adapter gives both consumers the same in-memory contract
 * without rewriting source bytes or creating a second editor.
 */
export const LONG_FORM_DOCUMENT_SCHEMA = "long-form-document-v1";

const BLOCK_TYPES = new Set([
  "lead",
  "heading",
  "paragraph",
  "list",
  "definitionList",
  "callout",
  "figure",
  "architectureViews",
  "link",
]);

const hasText = (value) => typeof value === "string" && value.trim() !== "";

function normalizeText(value, field, { optional = false } = {}) {
  if (optional && (value == null || value === "" || (Array.isArray(value) && value.length === 0))) return null;
  if (typeof value === "string") {
    if (!optional && !hasText(value)) throw documentError("LONG_FORM_DOCUMENT_INVALID", `${field} must be non-empty text`);
    return value;
  }
  if (Array.isArray(value)) {
    if (!value.length || value.some((part) => typeof part !== "string" || !hasText(part))) {
      throw documentError("LONG_FORM_DOCUMENT_INVALID", `${field} must contain non-empty text parts`);
    }
    return [...value];
  }
  throw documentError("LONG_FORM_DOCUMENT_INVALID", `${field} must be text or text parts`);
}

function documentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertStableId(value, field) {
  if (!/^[a-z][a-z0-9-]*$/.test(String(value || ""))) {
    throw documentError("LONG_FORM_DOCUMENT_INVALID_ID", `${field} must be a stable kebab-case id`);
  }
}

function assertUniqueIds(items, field) {
  const seen = new Set();
  for (const [index, item] of (items || []).entries()) {
    const id = typeof item === "string" ? null : item?.id;
    if (id == null) continue;
    assertStableId(id, `${field}[${index}].id`);
    if (seen.has(id)) {
      throw documentError("LONG_FORM_DOCUMENT_DUPLICATE_ID", `${field} contains duplicate id "${id}"`);
    }
    seen.add(id);
  }
}

function normalizeBlock(block, index) {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}] must be an object`);
  }
  assertStableId(block.id, `blocks[${index}].id`);
  if (!BLOCK_TYPES.has(block.type)) {
    throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}] has unsupported type ${String(block.type)}`);
  }
  const normalized = { ...block };
  if (["lead", "paragraph", "callout"].includes(block.type)) {
    normalized.text = normalizeText(block.text, `blocks[${index}].text`);
  } else if (block.type === "heading") {
    normalized.text = normalizeText(block.text, `blocks[${index}].text`);
    if (block.level !== undefined && (!Number.isInteger(block.level) || block.level < 2 || block.level > 6)) {
      throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}].level must be an integer between 2 and 6`);
    }
  } else if (block.type === "list") {
    if (!Array.isArray(block.items) || block.items.length === 0) {
      throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}].items must be a non-empty array`);
    }
    assertUniqueIds(block.items, `blocks[${index}].items`);
    normalized.items = block.items.map((item, itemIndex) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}].items[${itemIndex}] is invalid`);
      return { ...item, text: normalizeText(item.text, `blocks[${index}].items[${itemIndex}].text`) };
    });
  } else if (block.type === "definitionList") {
    if (!Array.isArray(block.items) || block.items.length === 0) {
      throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}].items must be a non-empty array`);
    }
    assertUniqueIds(block.items, `blocks[${index}].items`);
    normalized.items = block.items.map((item, itemIndex) => {
      if (!item || typeof item !== "object") throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}].items[${itemIndex}] is invalid`);
      return {
        ...item,
        term: normalizeText(item.term, `blocks[${index}].items[${itemIndex}].term`),
        description: normalizeText(item.description, `blocks[${index}].items[${itemIndex}].description`),
      };
    });
  } else if (block.type === "figure") {
    if (!hasText(block.sourcePath) || !hasText(block.alt)) {
      throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}] figure sourcePath and alt are required`);
    }
    normalized.caption = block.caption == null ? null : normalizeText(block.caption, `blocks[${index}].caption`);
  } else if (block.type === "link") {
    normalized.text = normalizeText(block.text, `blocks[${index}].text`);
    if (!hasText(block.href)) throw documentError("LONG_FORM_DOCUMENT_INVALID", `blocks[${index}].href is required`);
  }
  return Object.freeze(normalized);
}

/**
 * Normalize a legacy profile/article document without changing its source
 * representation.  The returned object is safe for both renderers and
 * authoring/preview code to inspect.
 */
export function normalizeLongFormDocument(document, { documentId = null } = {}) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw documentError("LONG_FORM_DOCUMENT_INVALID", "long-form document must be an object");
  }
  const id = document.id || documentId;
  assertStableId(id, "document.id");
  if (!Array.isArray(document.blocks)) throw documentError("LONG_FORM_DOCUMENT_INVALID", "document.blocks must be an array");
  assertUniqueIds(document.blocks, "document.blocks");
  const normalized = {
    ...document,
    id,
    schemaVersion: LONG_FORM_DOCUMENT_SCHEMA,
    title: normalizeText(document.title, "document.title"),
    summary: normalizeText(document.summary, "document.summary", { optional: true }),
    blocks: document.blocks.map(normalizeBlock),
  };
  if (document.sources !== undefined && !Array.isArray(document.sources)) {
    throw documentError("LONG_FORM_DOCUMENT_INVALID", "document.sources must be an array");
  }
  return Object.freeze(normalized);
}

export function isLongFormDocument(value) {
  return Boolean(value && typeof value === "object" && value.schemaVersion === LONG_FORM_DOCUMENT_SCHEMA);
}
