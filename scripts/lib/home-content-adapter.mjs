import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentRootDirectory } from "./content-root.mjs";
import { hashValue } from "./content-targets.mjs";
import { normalizeContentSetEntry } from "./content-set.mjs";
import { normalizeResponsiveTextSlot, RESPONSIVE_TEXT_SLOT_SCHEMA } from "./responsive-text-slot.mjs";

export const HOME_CONTENT_SOURCE_PATH = "content/home.json";

function hashBytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export const HOME_CONTENT_FIELDS = Object.freeze([
  "description",
  "homeTitle",
  "emptyStates.observations.message",
  "emptyStates.observations.description",
]);

export function normalizeHomeContent(value = {}) {
  const empty = value.emptyStates?.observations || {};
  for (const [field, candidate] of [
    ["description", value.description],
    ["homeTitle", value.homeTitle],
    ["emptyStates.observations.message", empty.message],
    ["emptyStates.observations.description", empty.description],
  ]) {
    if (field.startsWith("emptyStates.")) {
      if (typeof candidate !== "string" || candidate.trim() === "") throw new Error(`home content field is required: ${field}`);
    } else {
      try { normalizeResponsiveTextSlot(candidate, { maxLength: 400 }); }
      catch (error) { throw new Error(`home content field is invalid: ${field}: ${error.message}`); }
    }
  }
  const normalizeText = (candidate) => typeof candidate === "string" ? candidate : normalizeResponsiveTextSlot(candidate, { maxLength: 400 });
  return {
    description: normalizeText(value.description),
    homeTitle: normalizeText(value.homeTitle),
    emptyStates: {
      observations: {
        message: empty.message,
        description: empty.description,
      },
    },
  };
}
export function homeContentHash(value) {
  return hashValue(normalizeHomeContent(value));
}

/**
 * Read the only source allowed to enter a Home ContentSet Candidate. The
 * product-only `src/content/siteContent.js` fallback deliberately does not
 * participate in this path.
 */
export async function readCanonicalHomeContent({ sourceRoot = process.cwd() } = {}) {
  const file = path.join(contentRootDirectory({ sourceRoot }), "home.json");
  let source;
  try {
    source = await readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") error.code = "CONTENT_HOME_SOURCE_MISSING";
    throw error;
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch (cause) {
    const error = new Error(`canonical Home content JSON is invalid: ${file}`);
    error.code = "CONTENT_HOME_SOURCE_INVALID_JSON";
    error.cause = cause;
    throw error;
  }
  let normalizedValue;
  try {
    normalizedValue = normalizeHomeContent(value);
  } catch (cause) {
    const error = new Error(`canonical Home content value is invalid: ${file}`);
    error.code = "CONTENT_HOME_SOURCE_INVALID_VALUE";
    error.cause = cause;
    throw error;
  }
  return Object.freeze({
    sourcePath: HOME_CONTENT_SOURCE_PATH,
    filePath: path.resolve(file),
    sourceHash: hashBytes(source),
    value: normalizedValue,
    valueHash: homeContentHash(normalizedValue),
  });
}

export function homeContentSetEntry({ value, sourceProof = ["canonical:content/home.json"], reviewProof = { status: "approved" }, legacyAuditId = null } = {}) {
  const content = normalizeHomeContent(value);
  return normalizeContentSetEntry({
    entryId: "home:home",
    kind: "home",
    target: "home",
    sourcePath: HOME_CONTENT_SOURCE_PATH,
    route: "/",
    contentHash: homeContentHash(content),
    sourceProof,
    reviewProof,
    mediaProof: [],
    legacyAuditId,
  });
}

export function homeContentFromEntry(entry) {
  if (!entry || entry.kind !== "home" || entry.target !== "home") throw new Error("home ContentSet entry is missing or invalid");
  return {
    contentHash: entry.contentHash,
    entryId: entry.entryId,
    sourcePath: entry.sourcePath,
    route: entry.route,
  };
}
