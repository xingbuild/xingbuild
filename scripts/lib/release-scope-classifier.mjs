import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const SCOPE_SCHEMA_VERSION = "release-scope-v1";
export const SCOPE_CLASSIFICATIONS = new Set(["implementation", "record-only", "excludedExternal"]);
export const SCOPE_MANIFEST_ROOT = "docs/iterations/scopes";

function byteCompare(left, right) {
  return Buffer.from(String(left)).compare(Buffer.from(String(right)));
}

function canonicalize(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort(byteCompare).map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value) {
  return `${canonicalize(value)}\n`;
}

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function scopeManifestRelativePath(version) {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`invalid release scope version: ${version}`);
  return `${SCOPE_MANIFEST_ROOT}/${version}.json`;
}

export function normalizeScopeEntries(entries = [], manifestPath = "") {
  return [...entries]
    .filter((entry) => entry && entry.path !== manifestPath)
    .sort((left, right) => byteCompare(left.path || left.to || left.from, right.path || right.to || right.from));
}

export function computeScopeDigest(entries, manifestPath) {
  return sha256Bytes(canonicalJson(normalizeScopeEntries(entries, manifestPath)));
}

function git(root, args, { allowFailure = false } = {}) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8" });
  } catch (error) {
    if (allowFailure) return "";
    throw error;
  }
}

function parseNameStatus(output) {
  const tokens = output.split("\0").filter(Boolean);
  const records = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    if (status.startsWith("R")) {
      records.push({ status: "R", from: tokens[index++], path: tokens[index++] });
    } else {
      records.push({ status: status[0], path: tokens[index++] });
    }
  }
  return records.filter((entry) => entry.path);
}

function mergePathState(states, record, source) {
  const names = record.status === "R" ? [record.from, record.path] : [record.path];
  for (const name of names) {
    if (!name) continue;
    const current = states.get(name) || { path: name, sources: new Set(), statuses: new Set(), staged: false, unstaged: false, untracked: false };
    current.sources.add(source);
    current.statuses.add(record.status);
    if (source === "staged") current.staged = true;
    if (source === "unstaged") current.unstaged = true;
    states.set(name, current);
  }
}

export function scanGitScope(root) {
  const states = new Map();
  for (const record of parseNameStatus(git(root, ["diff", "--cached", "--name-status", "-z"]))) mergePathState(states, record, "staged");
  for (const record of parseNameStatus(git(root, ["diff", "--name-status", "-z"]))) mergePathState(states, record, "unstaged");
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
  for (const file of untracked.split("\0").filter(Boolean)) {
    const state = states.get(file) || { path: file, sources: new Set(), statuses: new Set(), staged: false, unstaged: false, untracked: false };
    state.sources.add("untracked");
    state.statuses.add("??");
    state.untracked = true;
    states.set(file, state);
  }
  return states;
}

function fileHash(root, relativePath) {
  const absolute = path.join(root, relativePath);
  if (existsSync(absolute)) return sha256Bytes(readFileSync(absolute));
  try {
    const previous = execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: root });
    return previous.length ? sha256Bytes(previous) : null;
  } catch {
    return null;
  }
}

function commitPaths(root, commit) {
  return new Set(git(root, ["diff-tree", "--no-commit-id", "--name-only", "-r", commit]).split("\n").filter(Boolean));
}

export function readPostCommitScopeEvidence(root, version) {
  const evidencePath = path.join(root, ".content-workspace", "qa", version, "release-scope-postcommit.json");
  if (!existsSync(evidencePath)) throw new Error(`post-commit scope evidence missing: ${evidencePath}`);
  let evidence;
  try {
    evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  } catch (error) {
    throw new Error(`post-commit scope evidence invalid JSON: ${error.message}`);
  }
  return evidence;
}

export function validatePostCommitScope({ root, version, committedHead = git(root, ["rev-parse", "HEAD"]).trim() } = {}) {
  const manifest = readScopeManifest(root, version);
  const parent = git(root, ["rev-parse", `${committedHead}^`]).trim();
  if (parent !== manifest.baseHead) throw new Error(`post-commit firstParent mismatch: expected ${manifest.baseHead}, got ${parent}`);
  const paths = commitPaths(root, committedHead);
  for (const entry of manifest.entries) {
    if (!paths.has(entry.path)) throw new Error(`declared scope path missing from committedHead: ${entry.path}`);
  }
  const evidence = readPostCommitScopeEvidence(root, version);
  if (evidence.version !== version || evidence.committedHead !== committedHead || evidence.baseHead !== manifest.baseHead || evidence.scopeDigest !== manifest.scopeDigest) throw new Error("post-commit scope evidence identity mismatch");
  return { manifest, evidence, committedHead, baseHead: manifest.baseHead, committedPaths: [...paths].sort(byteCompare) };
}

export function readScopeManifest(root, version) {
  const relativePath = scopeManifestRelativePath(version);
  const absolutePath = path.join(root, relativePath);
  if (!existsSync(absolutePath)) throw new Error(`release scope manifest missing: ${relativePath}`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(absolutePath, "utf8"));
  } catch (error) {
    throw new Error(`release scope manifest invalid JSON: ${error.message}`);
  }
  if (manifest.schemaVersion !== SCOPE_SCHEMA_VERSION) throw new Error(`release scope manifest schema mismatch: ${manifest.schemaVersion || "missing"}`);
  if (manifest.version !== version) throw new Error(`release scope manifest version mismatch: ${manifest.version || "missing"}`);
  if (manifest.phase !== "pre-commit") throw new Error(`release scope manifest must be pre-commit phase, got ${manifest.phase || "missing"}`);
  if (!/^[a-f0-9]{40}$/.test(manifest.baseHead || "")) throw new Error("release scope manifest baseHead is invalid");
  if (manifest.scopeManifestPath !== relativePath) throw new Error("release scope manifest path identity mismatch");
  const entries = Array.isArray(manifest.paths) ? manifest.paths : [];
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.path !== "string" || !entry.path || path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith("../") || entry.path.includes("/../")) throw new Error("release scope manifest contains unsafe path");
    if (seen.has(entry.path)) throw new Error(`release scope manifest duplicate path: ${entry.path}`);
    seen.add(entry.path);
    if (!SCOPE_CLASSIFICATIONS.has(entry.classification)) throw new Error(`release scope manifest invalid classification: ${entry.path}`);
    if (typeof entry.owner !== "string" || !entry.owner.trim() || typeof entry.reason !== "string" || !entry.reason.trim()) throw new Error(`release scope manifest owner/reason missing: ${entry.path}`);
    if (entry.path === relativePath) {
      if (entry.pathHash !== "self-excluded") throw new Error("scope manifest self pathHash must be self-excluded");
    } else if (!/^[a-f0-9]{64}$/.test(entry.pathHash || "")) {
      throw new Error(`release scope manifest pathHash invalid: ${entry.path}`);
    }
    if (!["added", "modified", "deleted", "renamed"].includes(entry.state)) throw new Error(`release scope manifest state invalid: ${entry.path}`);
    if (entry.state === "renamed") {
      if (typeof entry.from !== "string" || !entry.from || path.posix.normalize(entry.from) !== entry.from || entry.from.startsWith("../")) throw new Error(`release scope rename source invalid: ${entry.path}`);
      if (!/^[a-f0-9]{64}$/.test(entry.beforePathHash || "")) throw new Error(`release scope rename beforePathHash invalid: ${entry.path}`);
    }
  }
  const manifestEntry = entries.find((entry) => entry.path === relativePath);
  if (!manifestEntry || manifestEntry.classification !== "record-only") throw new Error("scope manifest must declare itself record-only");
  const digest = computeScopeDigest(entries, relativePath);
  if (digest !== manifest.scopeDigest) throw new Error("release scope manifest scopeDigest mismatch");
  return { ...manifest, relativePath, entries };
}

export function classifyReleaseScope({ root, version, phase = "pre-commit", requireStaged = true, allowManifestUntracked = true, allowDeclaredAddedUntracked = false } = {}) {
  const manifest = readScopeManifest(root, version);
  const head = git(root, ["rev-parse", "HEAD"]).trim();
  if (phase === "pre-commit" && head !== manifest.baseHead) throw new Error(`release scope baseHead mismatch: expected ${manifest.baseHead}, got ${head}`);
  if (phase !== "pre-commit" && phase !== "post-commit") throw new Error(`unsupported release scope phase: ${phase}`);

  if (phase === "post-commit") {
    const post = validatePostCommitScope({ root, version, committedHead: head });
    const states = scanGitScope(root);
    const blockers = [...states.keys()].map((relativePath) => `post-commit worktree is not scope-clean: ${relativePath}`);
    return {
      ready: blockers.length === 0,
      phase,
      version,
      baseHead: manifest.baseHead,
      head,
      scopeDigest: manifest.scopeDigest,
      categories: {
        implementation: manifest.entries.filter((entry) => entry.classification === "implementation").map((entry) => entry.path),
        "record-only": manifest.entries.filter((entry) => entry.classification === "record-only").map((entry) => entry.path),
        excludedExternal: manifest.entries.filter((entry) => entry.classification === "excludedExternal").map((entry) => entry.path),
        unclassified: [],
      },
      blockers,
      manifestPath: manifest.relativePath,
      post,
    };
  }

  const states = scanGitScope(root);
  const byPath = new Map(manifest.entries.map((entry) => [entry.path, entry]));
  const blockers = [];
  const categories = { implementation: [], "record-only": [], excludedExternal: [], unclassified: [] };
  const manifestPath = manifest.relativePath;
  for (const [relativePath, state] of states) {
    const entry = byPath.get(relativePath) || manifest.entries.find((candidate) => candidate.state === "renamed" && candidate.from === relativePath);
    if (!entry) {
      categories.unclassified.push(relativePath);
      blockers.push(`unclassified dirty path: ${relativePath}`);
      continue;
    }
    const allowedAddedUntracked = entry.state === "added" && allowDeclaredAddedUntracked && phase === "pre-commit";
    if (state.untracked && !(relativePath === manifestPath && allowManifestUntracked) && !allowedAddedUntracked) blockers.push(`untracked path is not allowed: ${relativePath}`);
    if (entry.classification === "excludedExternal") blockers.push(`excludedExternal remains dirty: ${relativePath}`);
    if (requireStaged && !state.staged) blockers.push(`declared path is not staged: ${relativePath}`);
    if (relativePath === manifestPath) continue;
    categories[entry.classification].push(relativePath);
    const actualHash = fileHash(root, relativePath);
    const expectedHash = entry.state === "renamed" && relativePath === entry.from ? entry.beforePathHash : entry.pathHash;
    if (actualHash && actualHash !== expectedHash) blockers.push(`pathHash mismatch: ${relativePath}`);
  }
  for (const entry of manifest.entries) {
    if (entry.path === manifestPath) continue;
    if (!states.has(entry.path) && entry.state !== "deleted") blockers.push(`declared path is not dirty: ${entry.path}`);
  }
  return { ready: blockers.length === 0, phase, version, baseHead: manifest.baseHead, head, scopeDigest: manifest.scopeDigest, categories, blockers, manifestPath };
}

export function validateCommittedScope({ root, version, committedHead = git(root, ["rev-parse", "HEAD"]).trim() } = {}) {
  const manifest = readScopeManifest(root, version);
  const parent = git(root, ["rev-parse", `${committedHead}^`]).trim();
  if (parent !== manifest.baseHead) throw new Error(`post-commit firstParent mismatch: expected ${manifest.baseHead}, got ${parent}`);
  const paths = commitPaths(root, committedHead);
  for (const entry of manifest.entries) {
    if (!paths.has(entry.path) && entry.path !== manifest.relativePath) throw new Error(`declared scope path missing from committedHead: ${entry.path}`);
  }
  const states = scanGitScope(root);
  const blockers = [...states.keys()].map((relativePath) => `post-commit worktree is not scope-clean: ${relativePath}`);
  return { ready: blockers.length === 0, blockers, manifest, committedHead, baseHead: manifest.baseHead, scopeDigest: manifest.scopeDigest };
}

export function createScopeManifest({ version, baseHead, entries }) {
  const relativePath = scopeManifestRelativePath(version);
  const normalized = entries.map((entry) => ({ ...entry })).sort((left, right) => byteCompare(left.path, right.path));
  return {
    schemaVersion: SCOPE_SCHEMA_VERSION,
    phase: "pre-commit",
    version,
    baseHead,
    scopeManifestPath: relativePath,
    scopeDigest: computeScopeDigest(normalized, relativePath),
    paths: normalized,
  };
}
