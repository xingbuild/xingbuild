import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CONTENT_DATA_ARTIFACT_SCHEMA_VERSION,
  assertActiveContentDataTuple,
  assertContentDataArtifact,
  assertContentOnlyReceipt,
  activateContentDataTuple,
  changedContentDataObjects,
  contentDataPaths,
  createActiveContentDataTuple,
  createContentDataArtifact,
  prepareContentDataArtifactForContentSet,
  createContentOnlyReceipt,
  prepareContentOnlyMaterialization,
  readActiveContentDataTuple,
  readContentDataRuntime,
  writeContentDataArtifact,
} from "../scripts/lib/content-data-plane.mjs";
import { createContentSet, validateContentSet } from "../scripts/lib/content-set.mjs";
import { assertContentOnlyPublicationIntent, createContentOnlyPublicationIntent } from "../scripts/lib/content-only-publication.mjs";
import { readRuntimeContentDataFromHttp } from "../src/content/contentDataArtifact.js";
import { createSiteSnapshot } from "../scripts/lib/site-snapshot.mjs";
import { attachPublicationDeployment, createPublicationRun, markPublicationRecoverable, readPublicationRun, writePublicationRun } from "../scripts/lib/publication-run.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0280-data-"));
  const content = path.join(root, ".content-workspace", "content");
  await mkdir(content, { recursive: true });
  await writeFile(path.join(content, "home.json"), JSON.stringify({ description: "D", homeTitle: "T", emptyStates: { observations: { message: "M", description: "E" } } }));
  await writeFile(path.join(content, "products.json"), JSON.stringify({ id: "robotaxi", intro: "I" }));
  const entries = [
    { entryId: "home:home", kind: "home", target: "home", sourcePath: "content/home.json", route: "/", contentHash: "" },
    { entryId: "practice:robotaxi", kind: "practice", target: "robotaxi", sourcePath: "content/products.json", route: "/products", contentHash: "" },
  ];
  const values = [JSON.parse(await readFile(path.join(content, "home.json"), "utf8")), JSON.parse(await readFile(path.join(content, "products.json"), "utf8"))];
  const { createHash } = await import("node:crypto");
  entries.forEach((entry, index) => { entry.contentHash = createHash("sha256").update(JSON.stringify(values[index])).digest("hex"); entry.sourceProof = [entry.sourcePath]; entry.reviewProof = { status: "approved" }; entry.mediaProof = []; });
  const contentSet = createContentSet({ entries, homeContent: values[0], createdAt: "2026-08-16T00:00:00.000Z" });
  validateContentSet(contentSet);
  return { root, contentSet, entries, values };
}

test("ContentDataArtifact is deterministic, source-byte based and retains current plus two revisions", async () => {
  const first = await fixture();
  const a = await createContentDataArtifact({ sourceRoot: first.root, contentSet: first.contentSet });
  const b = await createContentDataArtifact({ sourceRoot: first.root, contentSet: first.contentSet });
  assert.equal(a.contentDataHash, b.contentDataHash);
  assert.equal(a.contentDataArtifactId, b.contentDataArtifactId);
  assert.equal(a.schemaVersion, CONTENT_DATA_ARTIFACT_SCHEMA_VERSION);
  assert.ok(a.records.every((record) => record.logicalContentId && /^[a-f0-9]{64}$/.test(record.sourceHash) && /^[a-f0-9]{64}$/.test(record.valueHash)));
  const changedValue = { ...first.values[1], intro: "changed" };
  await writeFile(path.join(first.root, ".content-workspace/content/products.json"), JSON.stringify(changedValue));
  const changedEntries = first.entries.map((entry) => entry.entryId === "practice:robotaxi" ? { ...entry, contentHash: "b".repeat(64) } : entry);
  const changedSet = createContentSet({ entries: changedEntries, homeContent: first.values[0], createdAt: "2026-08-16T00:00:00.000Z" });
  const c = await createContentDataArtifact({ sourceRoot: first.root, contentSet: changedSet, previousArtifact: a });
  const delta = changedContentDataObjects({ previousArtifact: a, nextArtifact: c });
  assert.equal(delta.productArtifactBuildCount, 0);
  assert.equal(delta.changed.length, 1);
  assert.equal(delta.reused.length, 1);
  const record = c.records.find((item) => item.logicalContentId === "practice:robotaxi");
  assert.equal(record.history.length, 1);
  assert.doesNotThrow(() => assertContentDataArtifact(c));
});

test("CAS active tuple is atomic and failure leaves prior tuple unchanged", async () => {
  const f = await fixture();
  const artifact = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  await writeContentDataArtifact({ sourceRoot: f.root, artifact });
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact });
  await activateContentDataTuple({ sourceRoot: f.root, tuple });
  const before = await readFile(contentDataPaths(f.root).activePath, "utf8");
  await assert.rejects(() => activateContentDataTuple({ sourceRoot: f.root, tuple: { ...tuple, tupleHash: "0".repeat(64) }, expectedTupleHash: tuple.tupleHash, failAfter: "active" }));
  assert.equal(await readFile(contentDataPaths(f.root).activePath, "utf8"), before);
  assert.deepEqual(await readActiveContentDataTuple({ sourceRoot: f.root }), tuple);
  await assert.rejects(() => activateContentDataTuple({ sourceRoot: f.root, tuple, expectedTupleHash: "f".repeat(64) }), /CAS conflict/);
});

test("runtime reader consumes active artifact objects and receipt stays reference-only", async () => {
  const f = await fixture();
  const artifact = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  await writeContentDataArtifact({ sourceRoot: f.root, artifact });
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact });
  await activateContentDataTuple({ sourceRoot: f.root, tuple });
  const runtime = await readContentDataRuntime({ sourceRoot: f.root, logicalContentId: "practice:robotaxi" });
  assert.equal(runtime.value.intro, "I");
  const receipt = createContentOnlyReceipt({ contentSet: f.contentSet, artifact, activeTuple: tuple, siteSnapshotId: "site-snapshot-demo", sitePublicationId: "site-publication-demo" });
  assert.doesNotThrow(() => assertContentOnlyReceipt(receipt));
  assert.equal(Object.hasOwn(receipt, "value"), false);
  const materialization = await prepareContentOnlyMaterialization({ sourceRoot: f.root, artifact, activeTuple: tuple, contentSet: f.contentSet });
  const dataRoot = path.join(materialization.root, "content-data", artifact.contentDataArtifactId);
  assert.equal((await readFile(path.join(dataRoot, "content-data-manifest.json"), "utf8")).includes(artifact.contentDataArtifactId), true);
  assert.equal((await readFile(path.join(dataRoot, "content-data-artifact.json"), "utf8")).includes(artifact.contentDataHash), true);
  await stat(path.join(dataRoot, "objects", `${artifact.records[0].objectHash}.json`));
  await stat(materialization.root);
  await materialization.cleanup();
  await assert.rejects(() => stat(materialization.root));
});

test("browser runtime reader follows active tuple, immutable manifest and CAS objects", async () => {
  const f = await fixture();
  const artifact = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact });
  const materialization = await prepareContentOnlyMaterialization({ sourceRoot: f.root, artifact, activeTuple: tuple, contentSet: f.contentSet });
  const fetchImpl = async (url) => {
    const pathname = new URL(url).pathname;
    const file = pathname.endsWith("/active.json")
      ? path.join(materialization.root, "content-data/active.json")
      : path.join(materialization.root, pathname.slice(1));
    try {
      const body = await readFile(file);
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    } catch {
      return new Response("missing", { status: 404, headers: { "content-type": "text/plain" } });
    }
  };
  const runtime = await readRuntimeContentDataFromHttp({ baseUrl: "https://fixture.invalid/", fetchImpl });
  assert.equal(runtime.active.contentDataArtifactId, artifact.contentDataArtifactId);
  assert.equal(runtime.manifest.contentDataHash, artifact.contentDataHash);
  assert.ok(runtime.records.size >= f.contentSet.entries.length);
  await materialization.cleanup();
});

test("two-phase materialization failure and same-deployment recovery are persisted and idempotent", async () => {
  const f = await fixture();
  const artifact = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  const productCommit = "b".repeat(40);
  const productArtifact = { productVersion: "v0.28.0", productCommit, productArtifactId: `v0.28.0-${productCommit.slice(0, 12)}`, baseSiteArtifactId: `v0.28.0-${productCommit.slice(0, 12)}`, productArtifactHash: "c".repeat(64) };
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact, productArtifact });
  const materialization = await prepareContentOnlyMaterialization({ sourceRoot: f.root, artifact, activeTuple: tuple, contentSet: f.contentSet, productArtifact });
  assert.equal(materialization.state.phase, "prepared");
  const validation = await materialization.validate();
  assert.equal(validation.phase, "validated");
  const activation = await materialization.activate();
  assert.equal(activation.phase, "activated");
  const failed = await prepareContentOnlyMaterialization({ sourceRoot: f.root, artifact, activeTuple: tuple, contentSet: f.contentSet, productArtifact });
  await assert.rejects(() => failed.activate({ failPhase: "activate" }), /injected content data activation failure/);
  await failed.cleanup();
  const snapshot = createSiteSnapshot({ productArtifact, contentSet: f.contentSet, contentDataArtifact: { contentDataArtifactId: artifact.contentDataArtifactId, contentDataHash: artifact.contentDataHash }, createdAt: "2026-08-16T00:00:00.000Z" });
  const assembled = createPublicationRun({ siteSnapshot: snapshot, createdAt: "2026-08-16T00:00:00.000Z" });
  await writePublicationRun({ sourceRoot: f.root, run: assembled });
  const deployed = attachPublicationDeployment(assembled, { deploymentId: "deployment-test", deployment: { status: "success" } });
  await writePublicationRun({ sourceRoot: f.root, run: markPublicationRecoverable(deployed, { code: "test-failure", phase: "verifying", decision: "resume-same-deployment" }) });
  const readback = await readPublicationRun({ sourceRoot: f.root, publicationRunId: assembled.publicationRunId });
  const resumed = attachPublicationDeployment(readback, { deploymentId: "deployment-test", deployment: readback.deployment });
  await writePublicationRun({ sourceRoot: f.root, run: resumed });
  const final = await readPublicationRun({ sourceRoot: f.root, publicationRunId: assembled.publicationRunId });
  assert.equal(final.deploymentId, "deployment-test");
  assert.equal(final.deploymentCount, 1);
  assert.equal(final.publicationRunId, assembled.publicationRunId);
  assert.equal(final.snapshotHash, assembled.snapshotHash);
  await materialization.cleanup();
});

test("ContentSet changed-only preparation produces a real ChangeSet and no product build", async () => {
  const f = await fixture();
  const previous = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  const changedEntries = f.entries.map((entry) => entry.entryId === "practice:robotaxi" ? { ...entry, contentHash: "c".repeat(64) } : entry);
  await writeFile(path.join(f.root, ".content-workspace/content/products.json"), JSON.stringify({ id: "robotaxi", intro: "changed" }));
  const nextSet = createContentSet({ entries: changedEntries, homeContent: f.values[0], createdAt: "2026-08-16T00:00:00.000Z" });
  const prepared = await prepareContentDataArtifactForContentSet({ sourceRoot: f.root, beforeContentSet: f.contentSet, contentSet: nextSet, previousArtifact: previous });
  assert.ok(prepared.changeSet.changeSetId);
  assert.equal(prepared.changeSet.changes.length, 1);
  assert.equal(prepared.changeSet.reused.length, 1);
  assert.equal(prepared.delta.productArtifactBuildCount, 0);
});

test("content-only publication reuses site-snapshot-v1 with a data-plane reference and temporary upload root", async () => {
  const f = await fixture();
  const artifact = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  const productCommit = "a".repeat(40);
  const productArtifact = {
    productVersion: "v0.28.0",
    productCommit,
    productArtifactId: `v0.28.0-${productCommit.slice(0, 12)}`,
    baseSiteArtifactId: `v0.28.0-${productCommit.slice(0, 12)}`,
  };
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact, productArtifact });
  const first = await createContentOnlyPublicationIntent({ sourceRoot: f.root, productArtifact, contentSet: f.contentSet, contentDataArtifact: artifact, activeTuple: tuple });
  const second = await createContentOnlyPublicationIntent({ sourceRoot: f.root, productArtifact, contentSet: f.contentSet, contentDataArtifact: artifact, activeTuple: tuple });
  assert.doesNotThrow(() => assertContentOnlyPublicationIntent(first));
  assert.equal(first.siteSnapshot.schemaVersion, "site-snapshot-v1");
  assert.equal(first.siteSnapshot.snapshotHash, second.siteSnapshot.snapshotHash);
  assert.equal(first.siteSnapshot.contentDataHash, artifact.contentDataHash);
  assert.equal(first.publicationRun.contentDataArtifactId, artifact.contentDataArtifactId);
  assert.equal(first.deploymentCount, 0);
  await first.materialization.cleanup();
  await second.materialization.cleanup();
});

test("artifact write failure cleans staging and does not leave an artifact", async () => {
  const f = await fixture();
  const artifact = await createContentDataArtifact({ sourceRoot: f.root, contentSet: f.contentSet });
  await assert.rejects(() => writeContentDataArtifact({ sourceRoot: f.root, artifact, failAfter: "object" }), /injected object failure/);
  const paths = contentDataPaths(f.root);
  await assert.rejects(() => stat(path.join(paths.artifactsDirectory, artifact.contentDataArtifactId, "content-data-artifact.json")));
  const staging = await readdir(paths.stateDirectory).catch(() => []);
  assert.equal(staging.some((name) => name.includes(".content-data-stage-")), false);
});

test("real active ContentSet can be read without writing its pointer", async () => {
  const root = process.cwd();
  const activePath = path.join(root, ".content-workspace/content-state/active.json");
  const before = await readFile(activePath);
  const { readActiveContentSet } = await import("../scripts/lib/content-set.mjs");
  const active = await readActiveContentSet({ sourceRoot: root });
  assert.ok(active.contentSet.entries.length >= 34);
  assert.equal((await readFile(activePath)).toString(), before.toString());
});
