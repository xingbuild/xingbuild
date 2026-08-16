import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/* Scope is classification only. Git's index tree is the byte authority. */
export const SCOPE_SCHEMA_VERSION = "release-scope-v1";
export const SCOPE_CLASSIFICATIONS = new Set(["implementation", "record-only", "excludedExternal"]);
export const SCOPE_MANIFEST_ROOT = "docs/iterations/scopes";
const VERSION = /^v\d+\.\d+\.\d+$/;
const COMMIT = /^[a-f0-9]{40}$/;

function byteCompare(left, right) { return Buffer.from(String(left)).compare(Buffer.from(String(right))); }
function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort(byteCompare).map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function canonicalJson(value) { return `${canonicalize(value)}\n`; }
export function sha256Bytes(value) { return createHash("sha256").update(value).digest("hex"); }
export function scopeManifestRelativePath(version) {
  if (!VERSION.test(version)) throw new Error(`invalid release scope version: ${version}`);
  return `${SCOPE_MANIFEST_ROOT}/${version}.json`;
}
export function normalizeScopeEntries(entries = [], manifestPath = "") {
  return [...entries].filter((entry) => entry && (entry.path || entry.to || entry.from) !== manifestPath).sort((a, b) => byteCompare(a.path || a.to || a.from, b.path || b.to || b.from));
}
export function computeScopeDigest(entries, manifestPath) { return sha256Bytes(canonicalJson(normalizeScopeEntries(entries, manifestPath))); }

function git(root, args, { allowFailure = false, encoding = "utf8" } = {}) {
  try { return execFileSync("git", args, { cwd: root, encoding }); }
  catch (error) { if (allowFailure) return encoding === "buffer" ? Buffer.alloc(0) : ""; throw error; }
}
function parseNameStatus(output) {
  const tokens = (Buffer.isBuffer(output) ? output.toString("utf8") : String(output)).split("\0");
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) records.push({ status: status[0], from: tokens[index++], path: tokens[index++] });
    else records.push({ status: status[0], path: tokens[index++] });
  }
  return records.filter((entry) => entry.path || entry.from);
}
function mergePathState(states, record, source) {
  for (const name of (record.status === "R" ? [record.from, record.path] : [record.path])) {
    if (!name) continue;
    const current = states.get(name) || { path: name, sources: new Set(), statuses: new Set(), staged: false, unstaged: false, untracked: false };
    current.sources.add(source); current.statuses.add(record.status);
    if (source === "staged") current.staged = true;
    if (source === "unstaged") current.unstaged = true;
    states.set(name, current);
  }
}
export function scanGitScope(root) {
  const states = new Map();
  for (const record of parseNameStatus(git(root, ["diff", "--cached", "--name-status", "-z"]))) mergePathState(states, record, "staged");
  for (const record of parseNameStatus(git(root, ["diff", "--name-status", "-z"]))) mergePathState(states, record, "unstaged");
  for (const file of String(git(root, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)) {
    const state = states.get(file) || { path: file, sources: new Set(), statuses: new Set(), staged: false, unstaged: false, untracked: false };
    state.sources.add("untracked"); state.statuses.add("??"); state.untracked = true; states.set(file, state);
  }
  return states;
}
function pathSafe(value) { return typeof value === "string" && value && path.posix.normalize(value) === value && !value.startsWith("../") && !value.includes("/../") && !value.startsWith("/"); }
export function commitPaths(root, commit) {
  const records = parseNameStatus(git(root, ["diff-tree", "--no-commit-id", "--name-status", "--find-renames", "-r", "-z", commit]));
  const result = new Set();
  for (const record of records) { if (record.from) result.add(record.from); if (record.path) result.add(record.path); }
  return result;
}
export function readPostCommitScopeEvidence(root, version) {
  const evidencePath = path.join(root, ".content-workspace", "qa", version, "release-scope-postcommit.json");
  if (!existsSync(evidencePath)) throw new Error(`post-commit scope evidence missing: ${evidencePath}`);
  const bytes = readFileSync(evidencePath); let evidence;
  try { evidence = JSON.parse(bytes.toString("utf8")); } catch (error) { throw new Error(`post-commit scope evidence invalid JSON: ${error.message}`); }
  return { evidence, evidencePath, bytes: bytes.length, evidenceHash: sha256Bytes(bytes) };
}

export function readScopeManifest(root, version) {
  const relativePath = scopeManifestRelativePath(version); const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`release scope manifest missing: ${relativePath}`);
  let manifest; try { manifest = JSON.parse(readFileSync(absolutePath, "utf8")); } catch (error) { throw new Error(`release scope manifest invalid JSON: ${error.message}`); }
  if (manifest.schemaVersion !== SCOPE_SCHEMA_VERSION) throw new Error(`release scope manifest schema mismatch: ${manifest.schemaVersion || "missing"}`);
  if (manifest.version !== version) throw new Error(`release scope manifest version mismatch: ${manifest.version || "missing"}`);
  if (manifest.phase !== "pre-commit") throw new Error(`release scope manifest must be pre-commit phase, got ${manifest.phase || "missing"}`);
  if (!COMMIT.test(manifest.baseHead || "")) throw new Error("release scope manifest baseHead is invalid");
  if (manifest.scopeManifestPath !== relativePath) throw new Error("release scope manifest path identity mismatch");
  const entries = Array.isArray(manifest.paths) ? manifest.paths : []; const seen = new Set(); const current = version === "v0.28.1";
  for (const entry of entries) {
    if (!entry || !pathSafe(entry.path)) throw new Error("release scope manifest contains unsafe path");
    if (seen.has(entry.path)) throw new Error(`release scope manifest duplicate path: ${entry.path}`); seen.add(entry.path);
    if (!SCOPE_CLASSIFICATIONS.has(entry.classification)) throw new Error(`release scope manifest invalid classification: ${entry.path}`);
    if (typeof entry.owner !== "string" || !entry.owner.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`release scope manifest owner/reason missing: ${entry.path}`);
    if (current && (Object.hasOwn(entry, "pathHash") || Object.hasOwn(entry, "beforePathHash"))) throw new Error(`release scope manifest v0.28.1 must not contain pathHash: ${entry.path}`);
    if (!["added", "modified", "deleted", "renamed"].includes(entry.state)) throw new Error(`release scope manifest state invalid: ${entry.path}`);
    if (entry.state === "renamed" && !pathSafe(entry.from)) throw new Error(`release scope rename source invalid: ${entry.path}`);
    if (!current && entry.path !== relativePath && !/^[a-f0-9]{64}$/.test(entry.pathHash || "")) throw new Error(`release scope manifest pathHash invalid: ${entry.path}`);
    if (entry.path === relativePath && entry.classification !== "record-only") throw new Error("scope manifest must declare itself record-only");
  }
  if (!entries.some((entry) => entry.path === relativePath)) throw new Error("scope manifest must declare itself record-only");
  const digest = computeScopeDigest(entries, relativePath);
  if (!/^[a-f0-9]{64}$/.test(manifest.scopeDigest || "") || digest !== manifest.scopeDigest) throw new Error("release scope manifest scopeDigest mismatch");
  return { ...manifest, relativePath, entries };
}

export function classifyReleaseScope({ root, version, phase = "pre-commit", requireStaged = true, allowManifestUntracked = true, allowDeclaredAddedUntracked = false, approvalIdentity = null } = {}) {
  const manifest = readScopeManifest(root, version); const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (phase === "pre-commit" && head !== manifest.baseHead) throw new Error(`release scope baseHead mismatch: expected ${manifest.baseHead}, got ${head}`);
  if (!["pre-commit", "post-commit"].includes(phase)) throw new Error(`unsupported release scope phase: ${phase}`);
  const categories = { implementation: [], "record-only": [], excludedExternal: [], unclassified: [] }; const blockers = []; const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry])); const states = scanGitScope(root);
  if (phase === "post-commit") {
    const post = validatePostCommitScope({ root, version, committedHead: head, approvalIdentity });
    for (const relativePath of states.keys()) blockers.push(`post-commit worktree is not scope-clean: ${relativePath}`);
    return { ready: blockers.length === 0, phase, version, baseHead: manifest.baseHead, head, scopeDigest: manifest.scopeDigest, categories, blockers, manifestPath: manifest.relativePath, post };
  }
  for (const [relativePath, state] of states) {
    const entry = byPath.get(relativePath) || manifest.entries.find((candidate) => candidate.state === "renamed" && candidate.from === relativePath);
    if (!entry) { categories.unclassified.push(relativePath); blockers.push(`unclassified dirty path: ${relativePath}`); continue; }
    const allowedAddedUntracked = entry.state === "added" && allowDeclaredAddedUntracked && phase === "pre-commit";
    if (state.untracked && !(relativePath === manifest.relativePath && allowManifestUntracked) && !allowedAddedUntracked) blockers.push(`untracked path is not allowed: ${relativePath}`);
    if (entry.classification === "excludedExternal") blockers.push(`excludedExternal remains dirty: ${relativePath}`);
    if (requireStaged && state.unstaged) blockers.push(`declared path has unstaged drift: ${relativePath}`);
    if (requireStaged && !state.staged && !allowedAddedUntracked) blockers.push(`declared path is not staged: ${relativePath}`);
    if (relativePath !== manifest.relativePath) categories[entry.classification].push(relativePath);
  }
  for (const entry of manifest.entries) if (entry.path !== manifest.relativePath && !states.has(entry.path) && entry.state !== "deleted") blockers.push(`declared path is not dirty: ${entry.path}`);
  return { ready: blockers.length === 0, phase, version, baseHead: manifest.baseHead, head, scopeDigest: manifest.scopeDigest, categories, blockers, manifestPath: manifest.relativePath };
}

export function validatePostCommitScope({ root, version, committedHead = git(root, ["rev-parse", "HEAD"]).trim(), approvalIdentity = null } = {}) {
  const manifest = readScopeManifest(root, version); const parent = git(root, ["rev-parse", `${committedHead}^`]).trim();
  if (parent !== manifest.baseHead) throw new Error(`post-commit firstParent mismatch: expected ${manifest.baseHead}, got ${parent}`);
  const paths = commitPaths(root, committedHead); for (const entry of manifest.entries) if (entry.path !== manifest.relativePath && !paths.has(entry.path)) throw new Error(`declared scope path missing from committedHead: ${entry.path}`);
  const post = readPostCommitScopeEvidence(root, version); const evidence = post.evidence;
  if (evidence.version !== version || evidence.committedHead !== committedHead || evidence.baseHead !== manifest.baseHead || evidence.scopeDigest !== manifest.scopeDigest) throw new Error("post-commit scope evidence identity mismatch");
  if (approvalIdentity) for (const field of ["approvalHash", "candidateHash", "approvedTreeOid"]) if (evidence[field] !== approvalIdentity[field]) throw new Error(`post-commit scope evidence ${field} drift`);
  return { manifest, evidence, evidencePath: post.evidencePath, bytes: post.bytes, evidenceHash: post.evidenceHash, committedHead, baseHead: manifest.baseHead, committedPaths: [...paths].sort(byteCompare) };
}

export function validateCommittedScope({ root, version, committedHead = git(root, ["rev-parse", "HEAD"]).trim() } = {}) {
  const manifest = readScopeManifest(root, version); const parent = git(root, ["rev-parse", `${committedHead}^`]).trim();
  if (parent !== manifest.baseHead) throw new Error(`post-commit firstParent mismatch: expected ${manifest.baseHead}, got ${parent}`);
  const paths = commitPaths(root, committedHead); for (const entry of manifest.entries) if (entry.path !== manifest.relativePath && !paths.has(entry.path)) throw new Error(`declared scope path missing from committedHead: ${entry.path}`);
  const states = scanGitScope(root); const blockers = [...states.keys()].map((relativePath) => `post-commit worktree is not scope-clean: ${relativePath}`);
  return { ready: blockers.length === 0, blockers, manifest, committedHead, baseHead: manifest.baseHead, scopeDigest: manifest.scopeDigest };
}

export function createScopeManifest({ version, baseHead, entries }) {
  const relativePath = scopeManifestRelativePath(version);
  const normalized = entries.map((entry) => {
    const copy = { ...entry };
    if (version === "v0.28.1") { delete copy.pathHash; delete copy.beforePathHash; }
    return copy;
  }).sort((a, b) => byteCompare(a.path, b.path));
  const manifest = { schemaVersion: SCOPE_SCHEMA_VERSION, phase: "pre-commit", version, baseHead, scopeManifestPath: relativePath, paths: normalized };
  manifest.scopeDigest = computeScopeDigest(normalized, relativePath); return manifest;
}
