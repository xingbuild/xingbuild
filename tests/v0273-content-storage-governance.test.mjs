import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertCleanupGate,
  assertNamespaceCas,
  assertStorageDryRun,
  assertStorageRootSeparation,
  buildStorageAcceptanceMatrix,
  createNamespaceReference,
  createProtectedRootManifest,
  createQuarantineManifest,
  createStorageDryRun,
  inventoryContentStorage,
  quarantineObject,
  restoreQuarantinedObject,
  writeNamespaceCas,
} from "../scripts/lib/content-storage-governance.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0273-storage-"));
  await writeFile(path.join(root, "placeholder"), "fixture");
  await writeFile(path.join(root, ".keep"), "");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, ".content-workspace/content"), { recursive: true }));
  await writeFile(path.join(root, ".content-workspace/content/source.json"), JSON.stringify({ logicalContentId: "observation:source", contentHash: "a".repeat(64) }));
  return root;
}

test("SG-01/02/03 inventory emits protected roots, namespaces, references and decisions", async () => {
  const root = await fixture();
  const manifest = await createProtectedRootManifest({ sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
  assert.equal(manifest.schemaVersion, "content-storage-root-manifest-v1");
  assert.ok(manifest.roots.some((item) => item.id === "active-content-set" && item.decision === "delete-never"));
  const inventory = await inventoryContentStorage({ sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
  assert.equal(inventory.schemaVersion, "content-storage-governance-v1");
  const source = inventory.records.find((record) => record.path.endsWith("content/source.json"));
  assert.equal(source.namespace, "canonical-content");
  assert.equal(source.decision, "delete-never");
  const dryRun = createStorageDryRun({ inventory, now: "2026-08-15T00:00:00.000Z" });
  assert.doesNotThrow(() => assertStorageDryRun(dryRun));
  assert.equal(dryRun.zeroWrite, true);
});

test("SG-04 namespace CAS keeps logical identity separate from hash and is idempotent", async () => {
  const root = await fixture();
  const reference = createNamespaceReference({ namespace: "qa", logicalId: "artifact-a", hash: "a".repeat(64), sourceOfTruth: "fixture" });
  const first = await writeNamespaceCas({ sourceRoot: root, reference });
  const second = await writeNamespaceCas({ sourceRoot: root, reference });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.throws(() => assertNamespaceCas({ existing: reference, next: { ...reference, hash: "b".repeat(64) } }), /hash drift/);
  await assert.rejects(() => writeNamespaceCas({ sourceRoot: root, reference: { ...reference, logicalId: "artifact-b" }, failAfter: true }), /injected namespace CAS write failure/);
  assert.equal((await readFile(first.file, "utf8")).includes(reference.hash), true);
});

test("SG-05 separated roots and SG-07 quarantine/restore gates are reversible and bounded", async () => {
  const root = await fixture();
  assert.deepEqual(assertStorageRootSeparation({ stagingRoot: path.join(root, "tmp/staging"), uploadRoot: path.join(root, "tmp/upload"), outputRoot: path.join(root, ".content-workspace/site-publications") }).separated, true);
  assert.throws(() => assertStorageRootSeparation({ stagingRoot: root, uploadRoot: root, outputRoot: path.join(root, "out") }), /distinct/);
  const inventory = await inventoryContentStorage({ sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
  const record = { path: "placeholder", identity: "placeholder", namespace: "qa", hash: "a".repeat(64), bytes: 7, decision: "archive-dry-run", reconstructible: true, incomingReferences: [], references: [], lease: null, retainUntil: null };
  const manifest = createQuarantineManifest({ inventory: { ...inventory, records: [record] }, selectedPaths: [record.path], authorization: { scope: "content-storage-quarantine" }, now: "2026-08-15T00:00:00.000Z" });
  assert.equal(manifest.entries.length, 1);
  assert.doesNotThrow(() => assertCleanupGate({ record, manifest, authorization: { scope: "content-storage-quarantine" }, restoreTest: true }));
  await assert.rejects(() => quarantineObject({ sourceRoot: root, record, manifest, authorization: { scope: "content-storage-quarantine" }, restoreTest: true, failAfter: true }), /injected quarantine failure/);
  const moved = await quarantineObject({ sourceRoot: root, record, manifest, authorization: { scope: "content-storage-quarantine" }, restoreTest: true });
  assert.equal(moved.state, "quarantined");
  const restored = await restoreQuarantinedObject({ sourceRoot: root, record, manifest });
  assert.equal(restored.state, "restored");
});

test("AC-13 is explicit N/A and cannot bypass local gates", () => {
  const matrix = buildStorageAcceptanceMatrix({ inventory: { rootManifest: {}, referenceGraph: { nodes: [] } }, dryRun: { zeroWrite: true }, productionPublishAuthorized: false });
  assert.equal(matrix["AC-13"].status, "N/A");
  assert.match(matrix["AC-13"].reason, /not authorized/);
  assert.equal(matrix["AC-01"].status, "PASS");
});
