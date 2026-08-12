import { readFile } from "node:fs/promises";
import path from "node:path";
import { createContentSet, normalizeContentSetEntry, readActiveContentSet, writeContentSet } from "./content-set.mjs";
import { contentFilePath, contentMediaManifestPath } from "./content-root.mjs";
import { hashValue } from "./content-targets.mjs";
import { homeContent as legacyHomeContent } from "../../src/content/siteContent.js";
import { homeContentSetEntry } from "./home-content-adapter.mjs";
import { validateRegisteredResponsiveTextValues } from "./content-targets.mjs";

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

export async function contentSetEntryFromCanonical({ sourceRoot = process.cwd(), kind, target, reviewProof = {}, sourceProof = [], mediaProof = [], legacyAuditId = null, contentValue = undefined, mediaManifest = undefined } = {}) {
  const normalizedKind = kind === "content" ? "observation" : kind;
  if (normalizedKind === "home") {
    await validateRegisteredResponsiveTextValues({ kind: "home", target, value: contentValue === undefined ? legacyHomeContent : contentValue, rootDirectory: sourceRoot });
    return homeContentSetEntry({
      value: contentValue === undefined ? legacyHomeContent : contentValue,
      sourceProof,
      reviewProof,
      legacyAuditId,
    });
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
  for (const entry of entries) merged.set(entry.entryId, normalizeContentSetEntry(entry));
  return createContentSet({
    entries: [...merged.values()],
    previousContentSetId,
    homeContent,
    createdAt,
    migration: { source: "normal-operation" },
  });
}

export async function prepareContentSetCandidate({ sourceRoot = process.cwd(), entries = [], homeContent = null, previousContentSetId, createdAt } = {}) {
  let activeContentSet = null;
  try { activeContentSet = (await readActiveContentSet({ sourceRoot })).contentSet; } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (homeContent) await validateRegisteredResponsiveTextValues({ kind: "home", target: "home", value: homeContent, rootDirectory: sourceRoot });
  const candidate = createContentSetCandidate({ activeContentSet, entries, homeContent: homeContent || activeContentSet?.homeContent || null, previousContentSetId, createdAt });
  return writeContentSet({ sourceRoot, contentSet: candidate });
}
