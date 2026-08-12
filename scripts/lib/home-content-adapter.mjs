import { hashValue } from "./content-targets.mjs";
import { normalizeContentSetEntry } from "./content-set.mjs";
import { normalizeResponsiveTextSlot, RESPONSIVE_TEXT_SLOT_SCHEMA } from "./responsive-text-slot.mjs";

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

export function homeContentSetEntry({ value, sourceProof = ["legacy:src/content/siteContent.js"], reviewProof = { status: "approved" }, legacyAuditId = null } = {}) {
  const content = normalizeHomeContent(value);
  return normalizeContentSetEntry({
    entryId: "home:home",
    kind: "home",
    target: "home",
    sourcePath: "content/home.json",
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
