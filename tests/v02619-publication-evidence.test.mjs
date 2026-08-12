import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  PUBLICATION_RUNTIME_EVIDENCE_V3,
  PUBLICATION_RUNTIME_EVIDENCE_V4,
  aggregatePublicationPhaseEvidence,
  assertPublicationPhaseAggregate,
  createPublicationEvidenceReducer,
  createPublicationPhaseEvidence,
  publicationEvidenceHash,
  validatePublicationPhaseEvidence,
} from "../scripts/lib/publication-evidence.mjs";
import { finalizeSitePublication, verifyPublicSitePublication } from "../scripts/lib/site-publication-coordinator.mjs";
import { writePublicationAssetManifest } from "../scripts/lib/publication-assets.mjs";

const identity = Object.freeze({
  sitePublicationId: "pub-v02619-evidence",
  snapshotHash: "snapshot-v02619-evidence",
});
const attemptId = "attempt-v02619-positive";

function phase(role, payload = {}, phaseIdentity = identity, phaseAttemptId = attemptId) {
  const phaseName = { assets: "verifying-assets", app: "verifying-app", media: "verifying-media" }[role];
  const payloadKey = role === "app" ? "routes" : role;
  return createPublicationPhaseEvidence({
    publicationIdentity: phaseIdentity,
    attemptId: phaseAttemptId,
    phase: phaseName,
    startedAt: "2026-08-13T00:00:00.000Z",
    finishedAt: "2026-08-13T00:00:01.000Z",
    result: "verified",
    verified: true,
    lastEvidence: payload,
    [payloadKey]: payload,
  });
}

test("v4 factory and reducer produce one deterministic verified aggregate", () => {
  const reducer = createPublicationEvidenceReducer({ publicationIdentity: identity, attemptId });
  reducer.add(phase("assets", { manifestHash: "asset-hash", assets: { "/assets/app.js": { verified: true } } }));
  reducer.add(phase("app", { routes: { "/": { appReady: true, main: 1, h1: 1 } } }));
  reducer.add(phase("media", { media: { "/media/robotaxi.mp4": { verified: true, status: 200 } } }));
  const aggregate = reducer.aggregate();
  assert.equal(aggregate.schemaVersion, PUBLICATION_RUNTIME_EVIDENCE_V4);
  assert.equal(aggregate.result, "verified");
  assert.deepEqual(aggregate.phaseOrder, ["assets", "app", "media"]);
  assert.equal(aggregate.phases.assets.result, "verified");
  assert.equal(aggregate.phases.app.result, "verified");
  assert.equal(aggregate.phases.media.result, "verified");
  assert.equal(publicationEvidenceHash(aggregate), publicationEvidenceHash(reducer.aggregate()));
  assert.doesNotThrow(() => assertPublicationPhaseAggregate(aggregate, { expectedIdentity: identity, expectedAttemptId: attemptId }));
});

test("v4 aggregation rejects missing result, missing phase, duplicate phase, raw and mixed v3 evidence", () => {
  const assets = phase("assets", { manifestHash: "asset-hash" });
  const app = phase("app", { routes: { "/": { appReady: true } } });
  const media = phase("media", { media: {} });
  assert.throws(() => aggregatePublicationPhaseEvidence({ publicationIdentity: identity, attemptId, phases: { assets, app } }), /phase is missing: media/);
  const missingResult = { ...assets, result: undefined };
  assert.throws(() => aggregatePublicationPhaseEvidence({ publicationIdentity: identity, attemptId, phases: { assets: missingResult, app, media } }), /result is invalid|required/);
  assert.throws(() => aggregatePublicationPhaseEvidence({ publicationIdentity: identity, attemptId, phases: [assets, assets, app, media] }), /duplicate phase/);
  assert.throws(() => aggregatePublicationPhaseEvidence({ publicationIdentity: identity, attemptId, phases: { assets: { verified: true }, app, media } }), /publication-runtime-evidence-v4/);
  const legacy = { ...app, schemaVersion: PUBLICATION_RUNTIME_EVIDENCE_V3 };
  assert.equal(validatePublicationPhaseEvidence(legacy, { allowLegacyV3: true }).legacyReadOnly, true);
  assert.throws(() => aggregatePublicationPhaseEvidence({ publicationIdentity: identity, attemptId, phases: { assets, app: legacy, media } }), /v3 is read-only/);
  const drifted = { ...media, publicationIdentity: { ...identity, snapshotHash: "other-snapshot" } };
  assert.throws(() => aggregatePublicationPhaseEvidence({ publicationIdentity: identity, attemptId, phases: { assets, app, media: drifted } }), /identity drift/);
});

test("v4 verified aggregate is the only evidence accepted by finalize", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v02619-finalize-"));
  const publicationDirectory = path.join(root, "publication");
  try {
    await mkdir(publicationDirectory, { recursive: true });
    const publication = {
      sitePublicationId: identity.sitePublicationId,
      snapshotHash: identity.snapshotHash,
      productVersion: "v0.26.19",
      productCommit: "c".repeat(40),
      productArtifactId: "v0.26.19-cccccccccccc",
      baseSiteArtifactId: "v0.26.19-cccccccccccc",
      deploymentId: "deployment-v02619",
      state: "verifying",
      contentReleaseIds: [],
      contentManifest: { contentReleaseReceipts: [] },
    };
    await writeFile(path.join(publicationDirectory, "site-publication.json"), JSON.stringify(publication));
    const finalIdentity = {
      ...identity,
      productArtifactId: publication.productArtifactId,
      productVersion: publication.productVersion,
      productCommit: publication.productCommit,
      baseSiteArtifactId: publication.baseSiteArtifactId,
      version: publication.productVersion,
      commit: publication.productCommit,
    };
    const reducer = createPublicationEvidenceReducer({ publicationIdentity: finalIdentity, attemptId });
    reducer.add(phase("assets", { manifestHash: "asset-hash" }, finalIdentity));
    reducer.add(phase("app", { routes: { "/": { appReady: true } } }, finalIdentity));
    reducer.add(phase("media", { media: {} }, finalIdentity));
    const aggregate = reducer.aggregate();
    const publicVerify = {
      sitePublicationId: identity.sitePublicationId,
      snapshotHash: identity.snapshotHash,
      activeContentReleaseIds: [],
      contentManifest: { contentReleaseReceipts: [] },
      verificationEvidence: aggregate,
    };
    const released = await finalizeSitePublication({ publicationDirectory, publicVerify, sourceRoot: root });
    assert.equal(released.state, "released");
    assert.equal(released.publicVerify.verificationEvidence.schemaVersion, PUBLICATION_RUNTIME_EVIDENCE_V4);
    const persisted = JSON.parse(await readFile(path.join(publicationDirectory, "site-publication.json"), "utf8"));
    assert.equal(persisted.state, "released");
    await writeFile(path.join(publicationDirectory, "site-publication.json"), JSON.stringify({ ...publication, state: "verifying" }));
    await assert.rejects(
      finalizeSitePublication({ publicationDirectory, publicVerify: { ...publicVerify, verificationEvidence: { ...aggregate, phases: { ...aggregate.phases, assets: { ...aggregate.phases.assets, result: undefined } } } }, sourceRoot: root }),
      /result is invalid|required/,
    );
    await assert.rejects(
      finalizeSitePublication({ publicationDirectory, publicVerify: { ...publicVerify, verificationEvidence: { ...aggregate, schemaVersion: PUBLICATION_RUNTIME_EVIDENCE_V3 } }, sourceRoot: root }),
      /v3 is read-only|publication-runtime-evidence-v4/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("phase verification failures are persisted as v4 recoverable evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v02619-failure-"));
  try {
    await mkdir(path.join(root, "assets"), { recursive: true });
    const indexHtml = "<!doctype html><title>xingbuild</title><div id=\"root\"><main><h1>Ready</h1></main></div><script src=\"/assets/app.js\"></script>";
    await writeFile(path.join(root, "index.html"), indexHtml);
    await writeFile(path.join(root, "assets", "app.js"), "console.log('ok');");
    const assetManifest = await writePublicationAssetManifest({ clientRoot: root });
    const publication = {
      sitePublicationId: "pub-v02619-failure",
      snapshotHash: "snapshot-v02619-failure",
      productVersion: "v0.26.19",
      productCommit: "d".repeat(40),
      productArtifactId: "v0.26.19-dddddddddddd",
      client: root,
      assetManifest,
      contentReleaseIds: [],
      contentManifest: {
        publishedSlugs: [], publishedArticleSlugs: [], practiceIds: [], profileIds: [], businessObservationIds: [], mediaPaths: [], contentReleaseReceipts: [],
      },
    };
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/release.json") return Response.json({ version: publication.productVersion, commit: publication.productCommit });
      if (pathname === "/content-manifest.json") return Response.json({ version: publication.productVersion, commit: publication.productCommit, sitePublicationId: publication.sitePublicationId, snapshotHash: publication.snapshotHash, baseSiteArtifactId: publication.productArtifactId, activeContentReleaseIds: [], ...publication.contentManifest });
      if (pathname === "/assets/app.js") return new Response("<!doctype html><html>fallback</html>", { status: 200, headers: { "content-type": "text/html" } });
      return new Response(indexHtml, { status: 200, headers: { "content-type": "text/html" } });
    };
    await assert.rejects(
      verifyPublicSitePublication({ publication, fetchImpl, baseUrl: "https://example.test/" }),
      (error) => error.recoverable === true
        && error.runtimeEvidence?.schemaVersion === PUBLICATION_RUNTIME_EVIDENCE_V4
        && error.runtimeEvidence.result === "recoverable"
        && error.runtimeEvidence.failure?.phase === "verifying-assets",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
