import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPublicationPhaseEvidence } from "./publication-evidence.mjs";

export const PUBLICATION_ASSET_MANIFEST_VERSION = "publication-asset-manifest-v1";
const MIME_BY_EXTENSION = Object.freeze({
  ".css": "text/css", ".js": "text/javascript", ".mjs": "text/javascript", ".cjs": "text/javascript",
  ".json": "application/json", ".html": "text/html", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
});
const JS_MIMES = new Set(["text/javascript", "application/javascript", "application/x-javascript"]);

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function expectedMime(publicPath) { return MIME_BY_EXTENSION[path.extname(publicPath).toLowerCase()] || null; }
function normalizePublicPath(value, label = "asset") {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " path is missing");
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(value)) throw new Error(label + " must be same-origin: " + value);
  const pathname = decodeURIComponent(new URL(value, "https://xingbuild.invalid/").pathname);
  if (!pathname.startsWith("/")) throw new Error(label + " must be root-relative: " + value);
  const normalized = path.posix.normalize(pathname);
  if (normalized !== pathname || normalized.includes("..") || normalized === "/") throw new Error(label + " path escapes the publication root: " + value);
  return normalized;
}

export function parseIndexAssetReferences(html) {
  if (typeof html !== "string") throw new TypeError("index.html must be text");
  const references = [];
  for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) references.push({ path: normalizePublicPath(match[1], "script"), kind: "script" });
  for (const match of html.matchAll(/<link\b([^>]*?)>/gi)) {
    const tag = match[1];
    const isStylesheet = /\brel=["'][^"']*stylesheet[^"']*["']/i.test(tag);
    const isIcon = /\brel=["'][^"']*icon[^"']*["']/i.test(tag);
    if (!isStylesheet && !isIcon) continue;
    const href = tag.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (href) references.push({ path: normalizePublicPath(href, isStylesheet ? "stylesheet" : "icon"), kind: isStylesheet ? "style" : "media" });
  }
  for (const match of html.matchAll(/<(?:img|video|source|audio)\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)) references.push({ path: normalizePublicPath(match[1], "media"), kind: "media" });
  const byPath = new Map();
  for (const reference of references) {
    const previous = byPath.get(reference.path);
    if (previous && previous.kind !== reference.kind) throw new Error("asset reference kind drift: " + reference.path);
    byPath.set(reference.path, reference);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function assertInside(root, candidate, label) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) throw new Error(label + " escapes upload root: " + candidate);
  return resolved;
}

async function fileInfo(root, publicPath, kind = "asset") {
  const normalized = normalizePublicPath(publicPath, kind);
  const file = assertInside(root, path.join(root, normalized.slice(1)), kind);
  const info = await lstat(file).catch(() => null);
  if (!info) throw new Error(kind + " is missing from upload root: " + normalized);
  if (info.isSymbolicLink()) throw new Error(kind + " may not be a symlink: " + normalized);
  if (!info.isFile()) throw new Error(kind + " is not a regular file: " + normalized);
  const bytes = await readFile(file);
  const mime = expectedMime(normalized);
  if (!mime) throw new Error(kind + " has no registered MIME type: " + normalized);
  return { path: normalized, kind, bytes: bytes.byteLength, sha256: sha256(bytes), expectedMime: mime };
}

async function assertNoSymlinks(root, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const file = path.join(current, entry.name);
    const info = await lstat(file);
    if (info.isSymbolicLink()) throw new Error("upload root contains a symlink: " + path.relative(root, file));
    if (info.isDirectory()) await assertNoSymlinks(root, file);
  }
}

export async function createPublicationAssetManifest({ clientRoot, additionalPaths = [] } = {}) {
  if (typeof clientRoot !== "string" || !clientRoot) throw new Error("publication client root is required");
  const root = path.resolve(clientRoot);
  await assertNoSymlinks(root);
  const index = await fileInfo(root, "/index.html", "index");
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const paths = new Map(parseIndexAssetReferences(html).map((item) => [item.path, item.kind]));
  for (const value of additionalPaths || []) paths.set(normalizePublicPath(value, "media"), "media");
  const assets = [];
  for (const [publicPath, kind] of [...paths.entries()].sort(([a], [b]) => a.localeCompare(b))) assets.push(await fileInfo(root, publicPath, kind));
  const manifest = { schemaVersion: PUBLICATION_ASSET_MANIFEST_VERSION, index, assets };
  return Object.freeze({ ...manifest, manifestHash: sha256(JSON.stringify(manifest)) });
}

export async function writePublicationAssetManifest({ clientRoot, additionalPaths = [] } = {}) {
  const manifest = await createPublicationAssetManifest({ clientRoot, additionalPaths });
  await writeFile(path.join(clientRoot, "asset-manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  return manifest;
}

export async function readPublicationAssetManifest(clientRoot) {
  const value = JSON.parse(await readFile(path.join(clientRoot, "asset-manifest.json"), "utf8"));
  if (value.schemaVersion !== PUBLICATION_ASSET_MANIFEST_VERSION || !Array.isArray(value.assets) || !value.index) throw new Error("publication asset manifest schema is invalid");
  return value;
}

async function copyTreeWithoutSymlinks(source, destination, root = source) {
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new Error("refusing symlink in upload source: " + path.relative(root, source));
  if (info.isDirectory()) {
    await mkdir(destination, { recursive: true });
    for (const entry of await readdir(source)) await copyTreeWithoutSymlinks(path.join(source, entry), path.join(destination, entry), root);
    return;
  }
  if (!info.isFile()) throw new Error("unsupported upload source entry: " + path.relative(root, source));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, await readFile(source));
}

export async function preparePortableUploadRoot({ clientRoot, additionalPaths = [] } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-upload-root-"));
  try {
    await copyTreeWithoutSymlinks(path.resolve(clientRoot), root, path.resolve(clientRoot));
    const manifest = await writePublicationAssetManifest({ clientRoot: root, additionalPaths });
    return { root, manifest, async cleanup() { await rm(root, { recursive: true, force: true }); } };
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function isHtmlFallback(body) {
  const text = Buffer.from(body).toString("utf8").trimStart().slice(0, 512).toLowerCase();
  return text.startsWith("<!doctype html") || text.startsWith("<html") || text.includes("<html");
}
function contentTypeMatches(actual, expected) {
  const value = String(actual || "").split(";", 1)[0].trim().toLowerCase();
  return expected === "text/javascript" ? JS_MIMES.has(value) : value === expected;
}

function publicAssetError(message, details = {}) {
  const error = new Error(message);
  error.code = "SITE_PUBLICATION_ASSET_VERIFY";
  error.recoverable = true;
  error.propagation = true;
  error.observedIdentity = details;
  return error;
}

export async function verifyPublicPublicationAssets({ baseUrl, indexHtml, assetManifest, fetchImpl = fetch, onlyKinds = null, signal = null, publicationIdentity = null, attemptId = null } = {}) {
  if (!assetManifest || !Array.isArray(assetManifest.assets)) return { verified: false, skipped: true, reason: "asset manifest unavailable" };
  if (!publicationIdentity || !attemptId) {
    const error = new Error("publication asset verification requires publication identity and attemptId");
    error.code = "PUBLICATION_EVIDENCE_IDENTITY_REQUIRED";
    throw error;
  }
  const references = parseIndexAssetReferences(indexHtml);
  const expected = new Map(assetManifest.assets.map((item) => [item.path, item]));
  for (const reference of references) if (!expected.has(reference.path)) throw publicAssetError("public index references an unmanifested asset: " + reference.path, { assetPath: reference.path });
  const assets = {};
  const selected = onlyKinds?.length ? assetManifest.assets.filter((item) => onlyKinds.includes(item.kind)) : assetManifest.assets;
  for (const item of selected) {
    const response = await fetchImpl(new URL(item.path, baseUrl), {
      redirect: "follow", cache: "no-store",
      headers: { accept: `${item.expectedMime},*/*` },
      ...(signal ? { signal } : {}),
    });
    const body = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) throw publicAssetError("public asset " + item.path + " returned HTTP " + response.status, { assetPath: item.path, status: response.status });
    if (!contentTypeMatches(contentType, item.expectedMime)) throw publicAssetError("public asset " + item.path + " MIME mismatch: expected " + item.expectedMime + ", got " + (contentType || "missing"), { assetPath: item.path, status: response.status, contentType });
    if (isHtmlFallback(body)) throw publicAssetError("public asset " + item.path + " returned HTML fallback", { assetPath: item.path, status: response.status, contentType });
    const observed = { status: response.status, contentType, bytes: body.byteLength, sha256: sha256(body) };
    if (observed.bytes !== item.bytes || observed.sha256 !== item.sha256) throw publicAssetError("public asset " + item.path + " integrity mismatch", { assetPath: item.path, ...observed });
    assets[item.path] = { ...observed, verified: true };
  }
  return createPublicationPhaseEvidence({
    publicationIdentity,
    attemptId,
    phase: "verifying-assets",
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    result: "verified",
    verified: true,
    assets,
    manifestHash: assetManifest.manifestHash,
    skipped: false,
    lastEvidence: { assets, manifestHash: assetManifest.manifestHash, skipped: false },
  });
}
