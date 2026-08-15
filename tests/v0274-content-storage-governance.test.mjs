import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertStorageAcceptance,
  createExactStorageInventory,
  reduceStorageAcceptance,
} from "../scripts/lib/content-storage-governance.mjs";

test("v0.27.4 reducer rejects missing or unconditional evidence", () => {
  const result = reduceStorageAcceptance({ evidence: {} });
  assert.equal(result["AC74-01"].status, "FAIL");
  assert.equal(result["AC74-03"].status, "FAIL");
  assert.equal(result["AC74-13"].status, "N/A");
  assert.doesNotThrow(() => assertStorageAcceptance(result));
});

test("full inventory records exact bytes and protects metadata-only objects", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0274-inventory-"));
  try {
    await mkdir(path.join(root, ".content-workspace", "content-state"), { recursive: true });
    await writeFile(path.join(root, ".content-workspace", "content-state", "active.json"), '{"contentSetId":"set-1"}\n');
    const inventory = await createExactStorageInventory({ sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
    const record = inventory.records.find((candidate) => candidate.path.endsWith("active.json"));
    assert.equal(record.hashMode, "exact-byte");
    assert.match(record.hash, /^[a-f0-9]{64}$/);
    assert.equal(inventory.rootManifest.roots.find((candidate) => candidate.path === ".content-workspace/content-state").hashMode, "exact-byte");
    assert.equal(inventory.summary.records, inventory.records.length);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unresolved graph references are delete-never and outputRoot embedded materialization is a failure", () => {
  const base = {
    identity: { version: "v0.27.4", commit: "a", tag: "v0.27.4", exactTag: true, productArtifactId: "artifact", artifactHash: "b", baseSiteArtifactId: "base", artifact: {} },
    inventory: {
      schemaVersion: "content-storage-acceptance-evidence-v2",
      rootManifest: { roots: Array.from({ length: 13 }, (_, index) => ({ pathSetHash: String(index), hash: String(index), bytes: 0 })), manifestHash: "root" },
      records: [{ path: "x", hashMode: "exact-byte", decision: "delete-never", unresolvedReferences: ["missing"], outputRoot: true, durableRecord: true, embeddedMaterialization: true, embeddedVerification: false }],
      referenceGraph: { nodes: [{ id: "x" }], edges: [{ from: "x", type: "unresolved" }], unresolved: [{ type: "unresolved" }], external: [] },
      summary: { records: 1, hashModes: { "exact-byte": 1 } },
    },
    zeroWrite: { zeroWrite: true, before: { pathSetHash: "a", bytes: 1, hash: "h", gitStatus: "", processCount: 0, leaseCount: 0 }, after: { pathSetHash: "a", bytes: 1, hash: "h", gitStatus: "", processCount: 0, leaseCount: 0 }, sideEffects: { writes: [] } },
    scenarios: {},
    retention: {},
    postAction: {},
  };
  const result = reduceStorageAcceptance({ evidence: base });
  assert.equal(result["AC74-04"].status, "PASS");
  assert.equal(result["AC74-08"].status, "FAIL");
});
