import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LEGACY_SCOPE_SCHEMA_VERSION,
  classifyReleaseScope,
  computeScopeDigest,
  createScopeManifest,
  readScopeManifest,
} from "../scripts/lib/release-scope-classifier.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-scope-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "scope@test.invalid"]);
  git(root, ["config", "user.name", "Scope Test"]);
  await writeFile(path.join(root, "source.txt"), "before\n");
  git(root, ["add", "source.txt"]);
  git(root, ["commit", "-qm", "base"]);
  return { root, baseHead: git(root, ["rev-parse", "HEAD"]) };
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("scope classifier accepts declared implementation and record-only paths", async () => {
  const { root, baseHead } = await fixture();
  await writeFile(path.join(root, "source.txt"), "after\n");
  await writeFile(path.join(root, "record.md"), "record\n");
  const manifestPath = "docs/iterations/scopes/v0.27.6.json";
  const entries = [
    { path: "record.md", classification: "record-only", owner: "elon", reason: "record", pathHash: hash("record\n"), state: "added" },
    { path: "source.txt", classification: "implementation", owner: "elon engin", reason: "implementation", pathHash: hash("after\n"), state: "modified" },
    { path: manifestPath, classification: "record-only", owner: "elon engin", reason: "scope manifest", pathHash: "self-excluded", state: "added" },
  ];
  const manifest = createScopeManifest({ version: "v0.27.6", baseHead, entries, schemaVersion: LEGACY_SCOPE_SCHEMA_VERSION });
  await mkdir(path.join(root, "docs/iterations/scopes"), { recursive: true });
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = classifyReleaseScope({ root, version: "v0.27.6", requireStaged: false, allowManifestUntracked: true, allowDeclaredAddedUntracked: true });
  assert.equal(result.ready, true, result.blockers.join("; "));
  assert.deepEqual(result.categories.implementation, ["source.txt"]);
  assert.deepEqual(result.categories["record-only"], ["record.md"]);
  assert.equal(readScopeManifest(root, "v0.27.6").scopeDigest, computeScopeDigest(entries, manifestPath));
  const closeout = classifyReleaseScope({ root, version: "v0.27.6", requireStaged: true, allowManifestUntracked: false, allowDeclaredAddedUntracked: false });
  assert.equal(closeout.ready, false);
  assert.match(closeout.blockers.join("\n"), /untracked path is not allowed/);
});

test("undeclared and untracked paths hard-fail instead of directory allowlisting", async () => {
  const { root, baseHead } = await fixture();
  await writeFile(path.join(root, "source.txt"), "after\n");
  await writeFile(path.join(root, "unknown.txt"), "unknown\n");
  const manifestPath = "docs/iterations/scopes/v0.27.6.json";
  const entries = [{ path: "source.txt", classification: "implementation", owner: "elon engin", reason: "implementation", pathHash: hash("after\n"), state: "modified" }, { path: manifestPath, classification: "record-only", owner: "elon engin", reason: "scope manifest", pathHash: "self-excluded", state: "added" }];
  const manifest = createScopeManifest({ version: "v0.27.6", baseHead, entries, schemaVersion: LEGACY_SCOPE_SCHEMA_VERSION });
  await mkdir(path.join(root, "docs/iterations/scopes"), { recursive: true });
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  git(root, ["add", "source.txt", manifestPath]);
  const result = classifyReleaseScope({ root, version: "v0.27.6", requireStaged: false, allowManifestUntracked: true });
  assert.equal(result.ready, false);
  assert.match(result.blockers.join("\n"), /unclassified dirty path: unknown\.txt/);
});

test("scope digest drift is rejected", async () => {
  const { root, baseHead } = await fixture();
  const manifestPath = "docs/iterations/scopes/v0.27.6.json";
  const entries = [{ path: "source.txt", classification: "implementation", owner: "elon engin", reason: "implementation", pathHash: hash("before\n"), state: "modified" }, { path: manifestPath, classification: "record-only", owner: "elon engin", reason: "scope manifest", pathHash: "self-excluded", state: "added" }];
  const manifest = createScopeManifest({ version: "v0.27.6", baseHead, entries, schemaVersion: LEGACY_SCOPE_SCHEMA_VERSION });
  manifest.paths.find((entry) => entry.path === "source.txt").reason = "tampered";
  await mkdir(path.join(root, "docs/iterations/scopes"), { recursive: true });
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  assert.throws(() => readScopeManifest(root, "v0.27.6"), /scopeDigest mismatch/);
  assert.equal(await readFile(path.join(root, "source.txt"), "utf8"), "before\n");
});

test("rename state keeps before and after byte hashes", async () => {
  const { root, baseHead } = await fixture();
  git(root, ["mv", "source.txt", "renamed.txt"]);
  await writeFile(path.join(root, "renamed.txt"), "after\n");
  const manifestPath = "docs/iterations/scopes/v0.27.6.json";
  const entries = [
    { path: "renamed.txt", from: "source.txt", classification: "implementation", owner: "elon engin", reason: "rename", pathHash: hash("after\n"), beforePathHash: hash("before\n"), state: "renamed" },
    { path: manifestPath, classification: "record-only", owner: "elon engin", reason: "scope manifest", pathHash: "self-excluded", state: "added" },
  ];
  const manifest = createScopeManifest({ version: "v0.27.6", baseHead, entries, schemaVersion: LEGACY_SCOPE_SCHEMA_VERSION });
  await mkdir(path.join(root, "docs/iterations/scopes"), { recursive: true });
  await writeFile(path.join(root, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`);
  git(root, ["add", "-A"]);
  const result = classifyReleaseScope({ root, version: "v0.27.6", requireStaged: false, allowManifestUntracked: false });
  assert.equal(result.ready, true, result.blockers.join("; "));
});
