import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertActiveContentDataTuple,
  contentDataManifestHash,
  createActiveContentDataTuple,
  createContentDataArtifact,
  activateContentDataTuple,
} from "../scripts/lib/content-data-plane.mjs";
import { contentAuthorityManifestFromContentSet, createContentSet } from "../scripts/lib/content-set.mjs";
import { readContentPublicationAuthority } from "../scripts/lib/content-publication-intent.mjs";
import { createSiteSnapshot } from "../scripts/lib/site-snapshot.mjs";
import { attachPublicationDeployment, createPublicationRun, writePublicationRun } from "../scripts/lib/publication-run.mjs";
import { deriveRuntimeAcceptanceSpec } from "../scripts/lib/runtime-acceptance.mjs";
import { finalizeSitePublication } from "../scripts/lib/site-publication-coordinator.mjs";
import { readProductArtifact } from "../scripts/lib/product-artifact.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0285-authority-"));
  await mkdir(path.join(root, ".content-workspace", "content"), { recursive: true });
  const value = { description: "D", homeTitle: "T", emptyStates: { observations: { message: "M", description: "E" } } };
  await writeFile(path.join(root, ".content-workspace/content/home.json"), JSON.stringify(value));
  const { createHash } = await import("node:crypto");
  const entry = { entryId: "home:home", kind: "home", target: "home", sourcePath: "content/home.json", route: "/", contentHash: createHash("sha256").update(JSON.stringify(value)).digest("hex"), sourceProof: ["content/home.json"], reviewProof: { status: "approved" }, mediaProof: [] };
  const contentSet = createContentSet({ entries: [entry], homeContent: value, createdAt: "2026-08-17T00:00:00.000Z" });
  const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet });
  return { root, contentSet, artifact };
}

function product(version, commit, hash) {
  const id = `${version}-${commit.slice(0, 12)}`;
  return { productArtifactId: id, productVersion: version, productCommit: commit, baseSiteArtifactId: id, productArtifactHash: hash };
}

test("CA-01 content authority manifest and tuple are product-independent", async () => {
  const f = await fixture();
  const authority = contentAuthorityManifestFromContentSet(f.contentSet, { contentDataArtifact: f.artifact });
  const tupleA = createActiveContentDataTuple({ contentSet: f.contentSet, artifact: f.artifact, productArtifact: product("v0.28.4", "a".repeat(40), "a".repeat(64)) });
  const tupleB = createActiveContentDataTuple({ contentSet: f.contentSet, artifact: f.artifact, productArtifact: product("v0.28.5", "b".repeat(40), "b".repeat(64)) });
  assert.equal(tupleA.schemaVersion, "content-data-active-v2");
  assert.equal(tupleA.contentAuthorityManifestHash, contentDataManifestHash(authority));
  assert.equal(tupleA.tupleHash, tupleB.tupleHash);
  assert.equal(Object.hasOwn(tupleA, "productArtifactId"), false);
  assert.doesNotThrow(() => assertActiveContentDataTuple(tupleA));
  await writeFile(path.join(f.root, "authority-before.json"), JSON.stringify(tupleA));
});

test("CA-02 v1 legacy authority adapter proves provenance without writing active bytes", async () => {
  const authority = await readContentPublicationAuthority({ sourceRoot: process.cwd(), allowLegacy: false });
  assert.equal(authority.mode, "legacy-tuple");
  assert.equal(authority.tuple.schemaVersion, "content-data-active-v1");
  assert.equal(authority.legacyProductProvenance.productArtifactId, "v0.28.3-85e8c3d080f9");
  assert.match(authority.contentAuthorityManifestHash, /^[a-f0-9]{64}$/);
  const before = await readFile(path.join(process.cwd(), ".content-workspace/content-state/content-data-active.json"), "utf8");
  const again = await readContentPublicationAuthority({ sourceRoot: process.cwd(), allowLegacy: false });
  assert.equal(again.sourceTupleHash, authority.sourceTupleHash);
  assert.equal(await readFile(path.join(process.cwd(), ".content-workspace/content-state/content-data-active.json"), "utf8"), before);
});

test("CA-03 exact canonical active bytes compose with the next ProductArtifact in isolation", async () => {
  const root = process.cwd();
  const activePath = path.join(root, ".content-workspace/content-state/content-data-active.json");
  const before = await readFile(activePath, "utf8");
  const authority = await readContentPublicationAuthority({ sourceRoot: root, allowLegacy: false });
  const productArtifact = await readProductArtifact({
    clientDirectory: path.join(root, ".content-workspace/base-site-artifacts/v0.28.4-b23d76a56764/client"),
    sourceRoot: root,
    version: "v0.28.4",
    commit: "b23d76a567645b222605a3944611825a7441db00",
  });
  const snapshot = createSiteSnapshot({
    productArtifact,
    contentSet: authority.contentSet,
    contentDataArtifact: { contentDataArtifactId: authority.artifact.contentDataArtifactId, contentDataHash: authority.artifact.contentDataHash, objectRefs: authority.artifact.objectRefs, contentAuthorityManifestHash: authority.contentAuthorityManifestHash },
    activeTuple: authority.tuple,
    legacyProductProvenance: authority.legacyProductProvenance,
    contentAuthorityManifestHash: authority.contentAuthorityManifestHash,
    requireContentData: true,
  });
  assert.equal(snapshot.schemaVersion, "site-snapshot-v1");
  assert.equal(await readFile(activePath, "utf8"), before);
});

test("CA-03 SiteSnapshot v1 composes a new product with legacy content authority", async () => {
  const f = await fixture();
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact: f.artifact });
  const p = product("v0.28.5", "c".repeat(40), "c".repeat(64));
  const authority = contentAuthorityManifestFromContentSet(f.contentSet, { contentDataArtifact: f.artifact });
  const snapshot = createSiteSnapshot({
    productArtifact: p,
    contentSet: f.contentSet,
    contentDataArtifact: { contentDataArtifactId: f.artifact.contentDataArtifactId, contentDataHash: f.artifact.contentDataHash, objectRefs: f.artifact.objectRefs },
    activeTuple: tuple,
    contentAuthorityManifestHash: contentDataManifestHash(authority),
    requireContentData: true,
  });
  assert.equal(snapshot.schemaVersion, "site-snapshot-v1");
  assert.equal(snapshot.productArtifact.productArtifactId, p.productArtifactId);
  assert.equal(snapshot.activeTupleHash, tuple.tupleHash);
  assert.equal(snapshot.contentAuthorityManifestHash, contentDataManifestHash(authority));
});

test("CA-07 product finalize preserves active tuple bytes and performs no CAS", async () => {
  const f = await fixture();
  const tuple = createActiveContentDataTuple({ contentSet: f.contentSet, artifact: f.artifact });
  await activateContentDataTuple({ sourceRoot: f.root, tuple });
  const p = product("v0.28.5", "e".repeat(40), "e".repeat(64));
  const authority = contentAuthorityManifestFromContentSet(f.contentSet, { contentDataArtifact: f.artifact });
  const authorityHash = contentDataManifestHash(authority);
  const snapshot = createSiteSnapshot({ productArtifact: p, contentSet: f.contentSet, contentDataArtifact: { contentDataArtifactId: f.artifact.contentDataArtifactId, contentDataHash: f.artifact.contentDataHash, contentAuthorityManifestHash: authorityHash, objectRefs: f.artifact.objectRefs }, activeTuple: tuple, contentAuthorityManifestHash: authorityHash, requireContentData: true });
  const sitePublicationId = `v0.28.5+${p.productCommit}+${f.contentSet.contentSetId}`;
  const contentManifest = { ...snapshot.contentManifest, sitePublicationId, siteSnapshotId: snapshot.siteSnapshotId, snapshotHash: snapshot.snapshotHash, contentDataArtifactId: f.artifact.contentDataArtifactId, contentDataHash: f.artifact.contentDataHash, activeTupleHash: tuple.tupleHash, contentAuthorityManifestHash: authorityHash, contentDataManifestHash: authorityHash };
  const spec = deriveRuntimeAcceptanceSpec({ sitePublicationId, snapshotHash: snapshot.snapshotHash, activeTupleHash: tuple.tupleHash, contentManifest });
  const run = attachPublicationDeployment(createPublicationRun({ siteSnapshot: snapshot, runtimeAcceptanceSpec: spec }), { deploymentId: "dep-product-only", deployment: { deploymentId: "dep-product-only", status: "success" } });
  await writePublicationRun({ sourceRoot: f.root, run });
  const publicationDirectory = path.join(f.root, "publication");
  await mkdir(publicationDirectory, { recursive: true });
  const current = { sitePublicationId, productVersion: p.productVersion, productCommit: p.productCommit, productArtifactId: p.productArtifactId, baseSiteArtifactId: p.baseSiteArtifactId, productArtifactHash: p.productArtifactHash, productArtifact: p, contentSetId: f.contentSet.contentSetId, contentSetHash: f.contentSet.contentSetHash, contentDataArtifactId: f.artifact.contentDataArtifactId, contentDataHash: f.artifact.contentDataHash, activeTupleHash: tuple.tupleHash, activeTuple: tuple, contentAuthorityManifestHash: authorityHash, siteSnapshotId: snapshot.siteSnapshotId, snapshotHash: snapshot.snapshotHash, publicationRunId: run.publicationRunId, runtimeAcceptanceSpec: spec, runtimeAcceptanceSpecHash: spec.specHash, contentManifest, contentAuthorityMutation: false, deploymentId: "dep-product-only", state: "verifying" };
  await writeFile(path.join(publicationDirectory, "site-publication.json"), JSON.stringify(current));
  const before = await readFile(path.join(f.root, ".content-workspace/content-state/content-data-active.json"), "utf8");
  await finalizeSitePublication({ publicationDirectory, sourceRoot: f.root, publicVerify: { sitePublicationId, snapshotHash: snapshot.snapshotHash, contentSetId: f.contentSet.contentSetId, contentSetHash: f.contentSet.contentSetHash, siteSnapshotId: snapshot.siteSnapshotId, baseSiteArtifactId: p.baseSiteArtifactId, productArtifactHash: p.productArtifactHash, contentDataArtifactId: f.artifact.contentDataArtifactId, contentDataHash: f.artifact.contentDataHash, activeTupleHash: tuple.tupleHash, runtimeAcceptanceSpecHash: spec.specHash } });
  assert.equal(await readFile(path.join(f.root, ".content-workspace/content-state/content-data-active.json"), "utf8"), before);
});
