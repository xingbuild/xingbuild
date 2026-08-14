import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createContentSet, normalizeContentSetEntry, readActiveContentSet, contentSetPaths, validateContentSet } from "./content-set.mjs";
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

async function sourceHashForEntry({ sourceRoot, entry }) {
  const normalized = normalizeContentSetEntry(entry);
  const candidates = [
    path.join(sourceRoot, ".content-workspace", normalized.sourcePath),
    path.join(sourceRoot, normalized.sourcePath),
  ];
  for (const file of candidates) {
    try {
      return createHash("sha256").update(await readFile(file)).digest("hex");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  // Temporary/unit fixtures may not materialize a source file.  Hash the
  // normalized source value, never provenance/reference text.
  return hashValue({
    entryId: normalized.entryId,
    kind: normalized.kind,
    target: normalized.target,
    sourcePath: normalized.sourcePath,
    route: normalized.route,
    contentHash: normalized.contentHash,
    mediaProof: normalized.mediaProof,
  });
}

async function readExistingJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function writeCandidateAndChangeSetAtomically({ sourceRoot, contentSet, changeSet, failAfter = null } = {}) {
  const { setsDirectory } = contentSetPaths(sourceRoot);
  const candidateFile = path.join(setsDirectory, contentSet.contentSetId, "content-set.json");
  const changesDirectory = path.join(sourceRoot, ".content-workspace", "changes");
  const changeSetFile = path.join(changesDirectory, `${changeSet.changeSetId}.json`);
  const existingCandidate = await readExistingJson(candidateFile);
  const existingChangeSet = await readExistingJson(changeSetFile);
  if (existingCandidate) validateContentSet(existingCandidate);
  if (existingChangeSet) assertContentChangeSet(existingChangeSet);
  if (existingCandidate && existingCandidate.contentSetHash !== contentSet.contentSetHash) {
    throw new Error(`ContentSet immutable identity collision: ${contentSet.contentSetId}`);
  }
  if (existingChangeSet && existingChangeSet.changeSetHash !== changeSet.changeSetHash) {
    throw new Error(`ContentChangeSet immutable identity collision: ${changeSet.changeSetId}`);
  }
  if (existingCandidate && existingChangeSet) {
    return { candidateFile, changeSetFile, contentSet: existingCandidate, changeSet: existingChangeSet, contentSetReused: true, changeSetReused: true };
  }
  if (existingCandidate || existingChangeSet) {
    const error = new Error("ContentSet Candidate/ChangeSet partial state requires explicit recovery");
    error.code = "CONTENT_CANDIDATE_PARTIAL_STATE";
    throw error;
  }
  await mkdir(path.dirname(candidateFile), { recursive: true });
  await mkdir(changesDirectory, { recursive: true });
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const candidateTemporary = `${candidateFile}.${nonce}.tmp`;
  const changeTemporary = `${changeSetFile}.${nonce}.tmp`;
  const committed = [];
  try {
    await writeFile(candidateTemporary, `${JSON.stringify(contentSet, null, 2)}\n`);
    await writeFile(changeTemporary, `${JSON.stringify(changeSet, null, 2)}\n`);
    if (failAfter === "before-commit") throw new Error("injected candidate/change-set write failure");
    await rename(candidateTemporary, candidateFile);
    committed.push(candidateFile);
    if (failAfter === "candidate") throw new Error("injected candidate/change-set commit failure");
    await rename(changeTemporary, changeSetFile);
    committed.push(changeSetFile);
  } catch (error) {
    await unlink(candidateTemporary).catch(() => {});
    await unlink(changeTemporary).catch(() => {});
    for (const file of committed) await unlink(file).catch(() => {});
    await rmdir(path.dirname(candidateFile)).catch(() => {});
    throw error;
  }
  return { candidateFile, changeSetFile, contentSet, changeSet, contentSetReused: false, changeSetReused: false };
}

export async function prepareContentSetCandidate({ sourceRoot = process.cwd(), entries = [], homeContent = null, previousContentSetId, createdAt, productArtifactId = null, failAfter = null } = {}) {
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
    sourceHashes: Object.fromEntries(await Promise.all(candidate.entries.map(async (entry) => [entry.entryId, await sourceHashForEntry({ sourceRoot, entry })]))),
  });
  assertContentChangeSet(changeSet);
  if (changeSet.changes.length === 0 && activeContentSet) {
    return {
      file: null,
      contentSet: activeContentSet,
      contentSetReused: true,
      noChanges: true,
      changeSet: null,
      changeSetFile: null,
      changeSetReused: true,
    };
  }
  const written = await writeCandidateAndChangeSetAtomically({ sourceRoot, contentSet: candidate, changeSet, failAfter });
  return { file: written.candidateFile, contentSet: written.contentSet, contentSetReused: written.contentSetReused, changeSet: written.changeSet, changeSetFile: written.changeSetFile, changeSetReused: written.changeSetReused, noChanges: false };
}
