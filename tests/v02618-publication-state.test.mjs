import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyPublicSitePublication, transitionSitePublication } from "../scripts/lib/site-publication-coordinator.mjs";
import { writePublicationAssetManifest } from "../scripts/lib/publication-assets.mjs";

test("v4 publication state reducer keeps failure out of propagating and enforces CAS", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v02618-state-"));
  const publication = path.join(root, "site-publication");
  try {
    await mkdir(publication, { recursive: true });
    await writeFile(path.join(publication, "site-publication.json"), JSON.stringify({
      sitePublicationId: "pub-v3", snapshotHash: "snapshot-v3", state: "verifying", stateRevision: 0,
    }));
    const evidence = { phase: "verifying-app", routes: { "/": { appReady: true } } };
    const appended = await transitionSitePublication({
      publicationDirectory: publication,
      expectedRevision: 0,
      patch: { runtimeEvidence: evidence, lastEvidence: evidence },
    });
    assert.equal(appended.state, "verifying");
    assert.equal(appended.stateRevision, 1);
    await assert.rejects(
      transitionSitePublication({
        publicationDirectory: publication,
        state: "propagating",
        failure: { code: "RUNTIME_FAILED", phase: "verifying-app", lastEvidence: evidence },
      }),
      /cannot be propagating while failure exists/,
    );
    const recoverable = await transitionSitePublication({
      publicationDirectory: publication,
      expectedRevision: 1,
      state: "recoverable",
      phase: "recoverable",
      failure: { code: "RUNTIME_TIMEOUT", phase: "verifying-app", lastEvidence: evidence },
    });
    assert.equal(recoverable.state, "recoverable");
    assert.equal(recoverable.failure.code, "RUNTIME_TIMEOUT");
    await assert.rejects(
      transitionSitePublication({ publicationDirectory: publication, expectedRevision: 1, state: "verifying" }),
      /state revision CAS failed/,
    );
    const persisted = JSON.parse(await readFile(path.join(publication, "site-publication.json"), "utf8"));
    assert.equal(persisted.state, "recoverable");
    assert.equal(persisted.publicVerify, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("v4 public verification keeps app and media evidence independent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v02618-evidence-"));
  try {
    await mkdir(path.join(root, "assets"), { recursive: true });
    await mkdir(path.join(root, "media"), { recursive: true });
    const indexHtml = "<!doctype html><title>xingbuild</title><div id=\"root\"><main><h1>Ready</h1></main></div><script src=\"/assets/app.js\"></script>";
    await writeFile(path.join(root, "index.html"), indexHtml);
    await writeFile(path.join(root, "assets", "app.js"), "console.log('ok');");
    await writeFile(path.join(root, "media", "demo.mp4"), "binary-media");
    const assetManifest = await writePublicationAssetManifest({ clientRoot: root, additionalPaths: ["/media/demo.mp4"] });
    const publication = {
      sitePublicationId: "pub-v4-evidence", snapshotHash: "snapshot-v4-evidence", productVersion: "v0.26.19",
      productCommit: "b".repeat(40), productArtifactId: "v0.26.19-bbbbbbbbbbbb", client: root, assetManifest,
      contentReleaseIds: [], contentManifest: { publishedSlugs: [], publishedArticleSlugs: [], practiceIds: [], profileIds: [], businessObservationIds: [], mediaPaths: ["/media/demo.mp4"], contentReleaseReceipts: [] },
    };
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/release.json") return Response.json({ version: publication.productVersion, commit: publication.productCommit });
      if (pathname === "/content-manifest.json") return Response.json({ version: publication.productVersion, commit: publication.productCommit, sitePublicationId: publication.sitePublicationId, snapshotHash: publication.snapshotHash, baseSiteArtifactId: publication.productArtifactId, activeContentReleaseIds: [], ...publication.contentManifest });
      if (!pathname.startsWith("/assets/") && !pathname.startsWith("/media/")) return new Response(indexHtml, { status: 200, headers: { "content-type": "text/html" } });
      const body = await readFile(path.join(root, pathname.slice(1)));
      const contentType = pathname.endsWith(".js") ? "text/javascript" : pathname.endsWith(".mp4") ? "video/mp4" : "text/html";
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    };
    const browserRuntimeVerify = async ({ onEvidence, publicationIdentity, attemptId }) => {
      const app = {
        schemaVersion: "publication-runtime-evidence-v4",
        publicationIdentity,
        attemptId,
        phase: "verifying-app",
        startedAt: "2026-08-13T00:00:00.000Z",
        finishedAt: "2026-08-13T00:00:01.000Z",
        result: "verified",
        verified: true,
        routes: { "/": { appReady: true } },
        lastEvidence: { "/": { appReady: true } },
      };
      await onEvidence?.({ phase: "verifying-app", result: app });
      return app;
    };
    const verified = await verifyPublicSitePublication({ publication, fetchImpl, browserRuntimeVerify, baseUrl: "https://example.test/" });
    assert.equal(verified.verificationEvidence.result, "verified");
    assert.equal(verified.verificationEvidence.phases.app.result, "verified");
    assert.equal(verified.verificationEvidence.phases.media.media["/media/demo.mp4"].verified, true);
    assert.equal(verified.verificationEvidence.phases.media.media["/media/demo.mp4"].browserProbe, "not-probed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
