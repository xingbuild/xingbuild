import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContentSet } from "../scripts/lib/content-set.mjs";
import { activateContentSet, readContentSet, writeContentSet } from "../scripts/lib/content-set.mjs";
import { prepareContentSetCandidate } from "../scripts/lib/content-set-candidate.mjs";
import {
  assertCompactSitePublicationRecord,
  assertContentChangeSet,
  assertContentRevision,
  assertZeroWriteDryRun,
  compactSitePublicationRecord,
  createContentChangeSet,
  createContentRevision,
  createDeterministicSiteSnapshot,
  createLifecycleDryRun,
  inventoryContentWorkspace,
  logicalContentId,
  readContentChangeSet,
  retainContentRevisions,
  reuseContentSetEntries,
  sanitizeDurableSitePublicationRecord,
} from "../scripts/lib/content-lifecycle-governance.mjs";

const product = {
  artifactContractVersion: "product-artifact-v1",
  productArtifactId: "v0.27.0-aaaaaaaaaaaa",
  productVersion: "v0.27.0",
  productCommit: "a".repeat(40),
  baseSiteArtifactId: "v0.27.0-aaaaaaaaaaaa",
  productArtifactHash: "b".repeat(64),
};

function entry(target, contentHash, extra = {}) {
  return {
    entryId: `observation:${target}`,
    kind: "observation",
    target,
    sourcePath: `content/observations/${target}.json`,
    route: `/observations/${target}`,
    contentHash,
    sourceProof: [`canonical:${target}`],
    reviewProof: { status: "approved", reviewId: `review-${target}` },
    mediaProof: [],
    legacyAuditId: `legacy-${target}`,
    ...extra,
  };
}

test("logical content revisions retain one current and at most two history records", () => {
  const id = logicalContentId({ kind: "observation", target: "demo" });
  const first = createContentRevision({ logicalContentId: id, source: "one", value: { text: "one" } });
  const second = createContentRevision({ logicalContentId: id, source: "two", value: { text: "two" }, predecessorRevisionId: first.revisionId });
  const third = createContentRevision({ logicalContentId: id, source: "three", value: { text: "three" }, predecessorRevisionId: second.revisionId });
  const fourth = createContentRevision({ logicalContentId: id, source: "four", value: { text: "four" }, predecessorRevisionId: third.revisionId });
  assert.doesNotThrow(() => assertContentRevision(fourth));
  const retained = retainContentRevisions({ current: fourth, history: [third, second, first] });
  assert.deepEqual(retained.history.map((revision) => revision.revisionId), [third.revisionId, second.revisionId]);
  assert.equal(retained.current.logicalContentId, id);
});

test("ChangeSet emits only changed refs and reuses unchanged target identity", () => {
  const unchanged = entry("same", "1".repeat(64));
  const before = [unchanged, entry("changed", "2".repeat(64))];
  const after = [entry("same", "1".repeat(64)), entry("changed", "3".repeat(64))];
  const changeSet = createContentChangeSet({ beforeEntries: before, afterEntries: after, productArtifactId: product.productArtifactId });
  assert.equal(changeSet.changes.length, 1);
  assert.equal(changeSet.changes[0].targetId, "observation:changed");
  assert.deepEqual(changeSet.reused.map((item) => item.targetId), ["observation:same"]);
  assert.doesNotThrow(() => assertContentChangeSet(changeSet));
  assert.equal(changeSet.changes[0].revisionRef.revisionId, changeSet.changes[0].revision.revisionId);
  const merged = reuseContentSetEntries({ beforeEntries: before, afterEntries: after, changeSet });
  assert.equal(merged[0], unchanged);
  assert.equal(merged[1].contentHash, "3".repeat(64));
});

test("ProductArtifact + ContentSet + manifest deterministically rebuild one snapshot", () => {
  const contentSet = createContentSet({ entries: [entry("demo", "a".repeat(64))], createdAt: "2026-08-15T00:00:00.000Z" });
  const manifest = { contentSetId: contentSet.contentSetId, contentSetHash: contentSet.contentSetHash, observationSlugs: ["demo"] };
  const first = createDeterministicSiteSnapshot({ productArtifact: product, contentSet, manifest });
  const second = createDeterministicSiteSnapshot({ productArtifact: product, contentSet, manifest });
  assert.equal(first.snapshotHash, second.snapshotHash);
  assert.equal(first.siteSnapshotId, second.siteSnapshotId);
});

test("durable SitePublication record contains references only, never a client copy", () => {
  const record = compactSitePublicationRecord({
    sitePublicationId: "publication-demo",
    siteSnapshotId: "site-snapshot-demo",
    snapshotHash: "c".repeat(64),
    productArtifact: product,
    contentSetId: "content-set-demo",
    contentSetHash: "d".repeat(64),
    contentManifest: { contentSetId: "content-set-demo" },
    deploymentId: "deployment-demo",
    client: "/tmp/must-not-persist",
  });
  assert.equal(record.manifest.reference, "content-manifest.json");
  assert.equal(record.deployment.deploymentId, "deployment-demo");
  assert.doesNotThrow(() => assertCompactSitePublicationRecord(record));
  assert.throws(() => assertCompactSitePublicationRecord({ ...record, client: "/tmp/unsafe" }), /cannot persist client/);
});

test("durable SitePublication sanitizer keeps snapshot/run references without embedding runtime objects", () => {
  const durable = sanitizeDurableSitePublicationRecord({
    sitePublicationId: "publication-demo",
    siteSnapshot: { siteSnapshotId: "site-snapshot-demo", snapshotHash: "e".repeat(64) },
    publicationRun: { publicationRunId: "publication-run-demo", state: "assembled" },
    client: "/tmp/client",
    uploadRoot: "/tmp/upload",
    assembledClient: "/tmp/assembled",
    sourceDirectory: "/tmp/source",
    contentManifest: { contentSetId: "content-set-demo" },
  });
  assert.equal(durable.siteSnapshotId, "site-snapshot-demo");
  assert.equal(durable.snapshotHash, "e".repeat(64));
  assert.equal(durable.publicationRunId, "publication-run-demo");
  for (const forbidden of ["client", "uploadRoot", "assembledClient", "sourceDirectory", "siteSnapshot", "publicationRun"]) {
    assert.equal(Object.hasOwn(durable, forbidden), false, forbidden);
  }
});

test("inventory and dry-run are repeatable, cross-reference lifecycle facts, and write nothing", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0270-inventory-"));
  await mkdir(path.join(root, ".content-workspace/content"), { recursive: true });
  await mkdir(path.join(root, ".content-workspace/releases/released-a"), { recursive: true });
  await mkdir(path.join(root, ".content-workspace/site-publications/publication-a"), { recursive: true });
  await mkdir(path.join(root, ".content-workspace/qa"), { recursive: true });
  await writeFile(path.join(root, ".content-workspace/content/a.json"), JSON.stringify({ logicalContentId: "observation:a", contentHash: "a".repeat(64) }));
  await writeFile(path.join(root, ".content-workspace/releases/released-a/content-release.json"), JSON.stringify({ state: "released", contentReleaseId: "release-a", logicalContentId: "observation:a", sitePublicationId: "publication-a" }));
  await writeFile(path.join(root, ".content-workspace/site-publications/publication-a/site-publication.json"), JSON.stringify({ state: "released", sitePublicationId: "publication-a", contentReleaseId: "release-a" }));
  await writeFile(path.join(root, ".content-workspace/qa/unowned.json"), JSON.stringify({ note: "no identity" }));
  const before = await readFile(path.join(root, ".content-workspace/content/a.json"), "utf8");
  const first = await inventoryContentWorkspace({ sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
  const second = await inventoryContentWorkspace({ sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
  assert.equal(first.inventoryHash, second.inventoryHash);
  const release = first.records.find((record) => record.path.endsWith("content-release.json"));
  assert.equal(release.decision, "delete-never");
  assert.ok(release.references.includes("publication-a"));
  const publication = first.records.find((record) => record.path.endsWith("site-publication.json"));
  assert.equal(publication.decision, "delete-never");
  assert.equal(publication.retainUntil, "indefinite");
  assert.ok(first.records.every((record) => Object.hasOwn(record, "retainUntil")));
  const dryRun = createLifecycleDryRun({ inventory: first, sourceRoot: root, now: "2026-08-15T00:00:00.000Z" });
  assert.doesNotThrow(() => assertZeroWriteDryRun(dryRun));
  assert.deepEqual(dryRun.changedPaths, []);
  assert.equal(await readFile(path.join(root, ".content-workspace/content/a.json"), "utf8"), before);
});

test("real ContentSet prepare emits changed-only ChangeSet and reuses unchanged entry identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0271-candidate-"));
  const unchanged = entry("same", "1".repeat(64));
  const original = createContentSet({ entries: [unchanged, entry("changed", "2".repeat(64))], createdAt: "2026-08-15T00:00:00.000Z" });
  await writeContentSet({ sourceRoot: root, contentSet: original });
  await activateContentSet({ sourceRoot: root, nextContentSetId: original.contentSetId, expectedContentSetId: null, now: "2026-08-15T00:00:00.000Z" });
  const changed = entry("changed", "3".repeat(64));
  const prepared = await prepareContentSetCandidate({
    sourceRoot: root,
    entries: [changed],
    previousContentSetId: original.contentSetId,
    productArtifactId: product.productArtifactId,
    createdAt: "2026-08-15T00:00:01.000Z",
  });
  assert.equal(prepared.changeSet.changes.length, 1);
  assert.deepEqual(prepared.changeSet.reused.map((item) => item.targetId), ["observation:same"]);
  assert.equal(prepared.changeSet.changes[0].targetId, "observation:changed");
  assert.equal(prepared.changeSet.changes[0].revisionRef.revisionId, prepared.changeSet.changes[0].revision.revisionId);
  const candidate = await readContentSet({ sourceRoot: root, contentSetId: prepared.contentSet.contentSetId });
  assert.equal(candidate.entries.find((item) => item.entryId === unchanged.entryId).contentHash, unchanged.contentHash);
  assert.equal(candidate.entries.find((item) => item.entryId === changed.entryId).contentHash, changed.contentHash);
  const sidecar = await readContentChangeSet({ sourceRoot: root, changeSetId: prepared.changeSet.changeSetId });
  assert.equal(sidecar.changeSetHash, prepared.changeSet.changeSetHash);
  const repeated = await prepareContentSetCandidate({
    sourceRoot: root,
    entries: [changed],
    previousContentSetId: original.contentSetId,
    productArtifactId: product.productArtifactId,
    createdAt: "2026-08-15T00:00:01.000Z",
  });
  assert.equal(repeated.changeSetFile, prepared.changeSetFile);
  assert.equal(repeated.changeSetReused, true);
});
