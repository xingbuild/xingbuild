import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createLifecycleEvidence, validateLifecycleEvidence } from "../scripts/lib/content-lifecycle-evidence.mjs";
import { readLifecycleEvidence } from "../scripts/lib/lifecycle-evidence-path.mjs";

const root = process.cwd();
const excludedExternalPaths = ["AGENTS.md", "docs/rules/task-onboarding.md"];

async function hashFile(file) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

test("version-aware lifecycle entry emits and validates current-version evidence", async () => {
  const evidence = await createLifecycleEvidence({
    sourceRoot: root,
    version: "v0.27.8",
    allowedPaths: ["scripts/check-project.mjs", "scripts/release-build.mjs", "scripts/release-closeout-check.mjs", "scripts/release-preflight.mjs"],
    excludedExternalPaths,
    excludedExternalReason: "v0.27.8 test scope",
    generatedBy: "scripts/content-lifecycle-evidence.mjs",
  });
  assert.equal(evidence.version, "v0.27.8");
  assert.equal(evidence.provenance.generatedBy, "scripts/content-lifecycle-evidence.mjs");
  validateLifecycleEvidence(evidence, { expectedVersion: "v0.27.8" });
  assert.throws(() => validateLifecycleEvidence(evidence, { expectedVersion: "v0.27.5" }), /LIFECYCLE_EVIDENCE_VERSION/);
});

test("legacy v0.27.5 lifecycle evidence remains byte-stable and outside current output", async () => {
  const legacyPath = path.join(root, ".content-workspace", "qa", "v0275-lifecycle-evidence", "evidence.json");
  const before = await hashFile(legacyPath);
  const legacyStat = await stat(legacyPath);
  const currentEvidencePath = path.join(root, ".content-workspace", "qa", "v0.27.8", "lifecycle-evidence.json");
  assert.notEqual(currentEvidencePath, legacyPath);
  assert.equal((await stat(legacyPath)).size, legacyStat.size);
  assert.equal(await hashFile(legacyPath), before);
});

test("legacy v0.27.7 scope evidence is read-only and byte-stable", async () => {
  const legacyPath = path.join(root, ".content-workspace", "qa", "v0277-scope", "evidence.json");
  const before = await hashFile(legacyPath);
  const beforeStat = await stat(legacyPath);
  assert.equal((await stat(legacyPath)).size, beforeStat.size);
  assert.equal(await hashFile(legacyPath), before);
});

test("missing current evidence is a hard failure for release gates", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0278-missing-evidence-"));
  try {
    await assert.rejects(readLifecycleEvidence({ root: temporaryRoot, version: "v0.27.8", allowMissing: false }), /LIFECYCLE_EVIDENCE_MISSING/);
    assert.equal(await readLifecycleEvidence({ root: temporaryRoot, version: "v0.27.8", allowMissing: true }), null);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
