import { readFile } from "node:fs/promises";
import path from "node:path";
import { createContentSet, normalizeContentSetEntry, readActiveContentSet, writeContentSet } from "./content-set.mjs";
import { contentFilePath, contentMediaManifestPath } from "./content-root.mjs";
import { hashValue } from "./content-targets.mjs";
import { homeContentHash, homeContentSetEntry, readCanonicalHomeContent } from "./home-content-adapter.mjs";
import { validateRegisteredResponsiveTextValues } from "./content-targets.mjs";
import { assertContentChangeSet, createContentChangeSet, writeContentChangeSet } from "./content-lifecycle-governance.mjs";

function sourcePathFor(kind, target) {
  if (kind === "home") return "content/home.json";
  if (kind === "observation" || kind === "content") return `content/observations/${target}.json`;
  if (kind === "article") return `content/articles/${target}.json`;
  if (kind === "profile") return `content/profile/${target}.json`;
  if (kind === "businessObservation") return `content/business-observations/${target}.json`;
  return `content/products/${target}.json`;
}

function routeFor(kind, target) {
  if (kind === "home") return "/";
  if (kind === "observation" || kind === "content") return `/observations/${target}`;
  if (kind === "article") return "/business-observations";
  if (kind === "profile") return "/about";
  if (kind === "businessObservation") return "/";
  return "/products";
}

export async function contentSetEntryFromCanonical({ sourceRoot = process.cwd(), kind, target, reviewProof = {}, sourceProof = [], mediaProof = [], legacyAuditId = null, contentValue = undefined, mediaManifest = undefined, allowStagedValue = false } = {}) {
  const normalizedKind = kind === "content" ? "observation" : kind;
  if (normalizedKind === "home") {
    // Always touch the canonical ignored source first. A supplied
    // `contentValue` may be a deterministic ChangeSet staging value, but it
    // can never turn the legacy product fallback into Candidate input.
    const canonical = await readCanonicalHomeContent({ sourceRoot });
    const value = contentValue === undefined ? canonical.value : contentValue;
    if (contentValue !== undefined && !allowStagedValue && homeContentHash(value) !== canonical.valueHash) {
      const error = new Error("Home Candidate value does not match canonical content/home.json");
      error.code = "CONTENT_HOME_SOURCE_MAPPING_MISMATCH";
      throw error;
    }
    await validateRegisteredResponsiveTextValues({ kind: "home", target, value, rootDirectory: sourceRoot });
    const normalized = canonical.value && contentValue === undefined ? canonical.value : value;
    const entry = homeContentSetEntry({
      value: normalized,
      sourceProof: ["canonical:content/home.json"],
      reviewProof,
      legacyAuditId,
    });
    if (entry.contentHash !== homeContentHash(normalized)) {
      const error = new Error("Home ContentSet entry normalized hash is not reproducible");
      error.code = "CONTENT_HOME_HASH_NOT_REPRODUCIBLE";
      throw error;
    }
    return entry;
  }
  const file = contentFilePath(normalizedKind === "observation" ? "content" : normalizedKind, target, { sourceRoot });
  const value = contentValue === undefined ? JSON.parse(await readFile(file, "utf8")) : contentValue;
  if (normalizedKind === "practice") await validateRegisteredResponsiveTextValues({ kind: "practice", target, value, rootDirectory: sourceRoot });
  let contentHash = hashValue(value);
  if (normalizedKind === "practice") {
    const media = mediaManifest === undefined
      ? JSON.parse(await readFile(contentMediaManifestPath(target, { sourceRoot }), "utf8"))
      : mediaManifest;
    contentHash = hashValue({ value, media });
    mediaProof = mediaProof.length ? mediaProof : (media.assets || []).filter((asset) => asset.publicStatus === "public").map((asset) => asset.src);
  }
  return normalizeContentSetEntry({
    entryId: `${normalizedKind}:${target}`,
    kind: normalizedKind,
    target,
    sourcePath: sourcePathFor(normalizedKind, target),
    route: routeFor(normalizedKind, target),
    contentHash,
    sourceProof,
    reviewProof,
    mediaProof,
    legacyAuditId,
  });
}

export function createContentSetCandidate({ activeContentSet, entries = [], previousContentSetId = activeContentSet?.contentSetId || null, homeContent = activeContentSet?.homeContent || null, createdAt } = {}) {
  const activeEntries = activeContentSet?.entries || [];
  const merged = new Map(activeEntries.map((entry) => [entry.entryId, entry]));
  const incomingIds = new Set();
  for (const entry of entries) {
    const normalized = normalizeContentSetEntry(entry);
    if (incomingIds.has(normalized.entryId)) {
      const error = new Error(`ContentSet Candidate duplicate entryId: ${normalized.entryId}`);
      error.code = "CONTENT_CANDIDATE_DUPLICATE_ENTRY";
      throw error;
    }
    incomingIds.add(normalized.entryId);
    merged.set(normalized.entryId, normalized);
  }
  return createContentSet({
    entries: [...merged.values()],
    previousContentSetId,
    homeContent,
    createdAt,
    migration: { source: "normal-operation" },
  });
}

export async function prepareContentSetCandidate({ sourceRoot = process.cwd(), entries = [], homeContent = null, previousContentSetId, createdAt, productArtifactId = null } = {}) {
  let activeContentSet = null;
  try { activeContentSet = (await readActiveContentSet({ sourceRoot })).contentSet; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const homeEntry = entries.find((entry) => entry?.entryId === "home:home" || (entry?.kind === "home" && entry?.target === "home"));
  let resolvedHomeContent = homeContent;
  if (homeEntry && resolvedHomeContent == null) {
    resolvedHomeContent = (await readCanonicalHomeContent({ sourceRoot })).value;
  }
  if (homeEntry && resolvedHomeContent != null) {
    await validateRegisteredResponsiveTextValues({ kind: "home", target: "home", value: resolvedHomeContent, rootDirectory: sourceRoot });
    const normalizedEntry = normalizeContentSetEntry(homeEntry);
    if (homeContentHash(resolvedHomeContent) !== normalizedEntry.contentHash) {
      const error = new Error("Home ContentSet entry does not match normalized Candidate homeContent");
      error.code = "CONTENT_HOME_ENTRY_VALUE_MISMATCH";
      throw error;
    }
  }
  if (resolvedHomeContent == null && activeContentSet?.homeContent) resolvedHomeContent = activeContentSet.homeContent;
  const candidate = createContentSetCandidate({ activeContentSet, entries, homeContent: resolvedHomeContent || null, previousContentSetId, createdAt });
  const changeSet = createContentChangeSet({
    beforeEntries: activeContentSet?.entries || [],
    afterEntries: candidate.entries,
    productArtifactId,
    createdAt,
  });
  assertContentChangeSet(changeSet);
  const written = await writeContentSet({ sourceRoot, contentSet: candidate });
  const changeSetWritten = await writeContentChangeSet({ sourceRoot, changeSet });
  return { ...written, changeSet: changeSetWritten.changeSet, changeSetFile: changeSetWritten.file, changeSetReused: changeSetWritten.reused };
}
