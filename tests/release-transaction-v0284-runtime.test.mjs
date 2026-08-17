import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createContentDataArtifact, prepareContentOnlyMaterialization } from "../scripts/lib/content-data-plane.mjs";
import { createContentPublicationIntent } from "../scripts/lib/content-publication-intent.mjs";
import { createContentSet } from "../scripts/lib/content-set.mjs";
import { deriveRuntimeAcceptanceSpec, assertRuntimeAcceptanceSpec, runtimeTextHash } from "../scripts/lib/runtime-acceptance.mjs";
import { verifyPublicBrowserRuntime } from "../scripts/lib/publication-runtime.mjs";
import { captureProtectedFacts } from "../scripts/lib/release-transaction.mjs";

const COMMIT = "e".repeat(40);

function homeValue(prefix) {
  return {
    description: `${prefix} description`,
    homeTitle: {
      schemaVersion: "responsive-text-slot-v1",
      parts: [
        { id: "line-1", text: `${prefix} line one` },
        { id: "line-2", text: `${prefix} line two` },
        { id: "line-3", text: `${prefix} line three` },
      ],
      projections: { "home.positioning.title": { web: { breakAfter: ["line-1"] }, mobile: { breakAfter: ["line-1", "line-2"] } } },
    },
    emptyStates: { observations: { message: `${prefix} message`, description: `${prefix} empty` } },
  };
}

function productArtifact() {
  const productArtifactId = `v0.28.4-${COMMIT.slice(0, 12)}`;
  return {
    artifactContractVersion: "product-artifact-v2",
    contentDataContractVersion: "content-data-publication-v1",
    productArtifactId,
    productVersion: "v0.28.4",
    productCommit: COMMIT,
    baseSiteArtifactId: productArtifactId,
    productArtifactHash: "f".repeat(64),
  };
}

async function delayedRuntimeFixture({ delayedMs = 1250, failObject = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0284-runtime-"));
  const client = path.join(root, "client");
  await mkdir(client, { recursive: true });
  const product = productArtifact();
  const home = homeValue("approved");
  const entries = [{ entryId: "home:home", kind: "home", target: "home", sourcePath: "content/home.json", route: "/", contentHash: "0".repeat(64), sourceProof: ["content/home.json"], reviewProof: { status: "approved" }, mediaProof: [] }];
  const sourceOverrides = new Map([["home:home", home]]);
  for (let index = 0; index < 37; index += 1) {
    const target = `observation-${String(index + 1).padStart(2, "0")}`;
    const value = { id: target, title: `Observation ${index + 1}`, body: `Stable body ${index + 1}` };
    entries.push({ entryId: `observation:${target}`, kind: "observation", target, sourcePath: `content/observations/${target}.json`, route: `/observations/${target}`, contentHash: "0".repeat(64), sourceProof: [`content/observations/${target}.json`], reviewProof: { status: "approved" }, mediaProof: [] });
    sourceOverrides.set(`observation:${target}`, value);
  }
  const contentSet = createContentSet({
    entries,
    homeContent: home,
    migration: { source: "v0284-test" },
    createdAt: "2026-08-17T00:00:00.000Z",
  });
  const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet, productArtifact: product, sourceOverrides });
  const intent = await createContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet, contentDataArtifact: artifact, createdAt: "2026-08-17T00:00:00.000Z" });
  await writeFile(path.join(client, "index.html"), `<!doctype html><html><head><title>xingbuild</title></head><body><div id="root"><main><h1>repository fallback</h1></main></div><script type="module" src="/runtime-app.js"></script></body></html>\n`);
  await cp(path.join(process.cwd(), "src/content/contentDataArtifact.js"), path.join(client, "contentDataArtifact.js"));
  await writeFile(path.join(client, "runtime-app.js"), `import { readRuntimeContentDataFromHttp } from "./contentDataArtifact.js";
const data = await readRuntimeContentDataFromHttp();
const value = data.records.get("home:home")?.value?.homeTitle;
const h1 = document.querySelector("main h1");
h1.replaceChildren();
for (const [index, part] of value.parts.entries()) { h1.append(document.createTextNode(part.text)); if (index === 0) h1.append(document.createElement("br")); }
`);
  const materialization = await prepareContentOnlyMaterialization({ productClient: client, sourceRoot: root, artifact, activeTuple: intent.activeTuple, contentSet, productArtifact: product, manifest: intent.siteSnapshot.contentManifest });
  const objectPaths = new Set(artifact.records.map((record) => `/content-data/${artifact.contentDataArtifactId}/objects/${record.objectHash}.json`));
  const delayedObjectPath = [...objectPaths][0];
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/favicon.ico") { response.writeHead(204); response.end(); return; }
    if (pathname === delayedObjectPath && failObject) { response.writeHead(404, { "content-type": "text/plain" }); response.end("injected object failure"); return; }
    if (pathname === delayedObjectPath) await new Promise((resolve) => setTimeout(resolve, delayedMs));
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    try {
      const body = await readFile(path.join(materialization.root, relative));
      const type = relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".json") ? "application/json" : "text/html";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      response.end(body);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" }); response.end("not found");
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;
  const sitePublicationId = `v0.28.4+${COMMIT}+${contentSet.contentSetId}`;
  const runtimeAcceptanceSpec = deriveRuntimeAcceptanceSpec({ sitePublicationId, snapshotHash: intent.siteSnapshot.snapshotHash, activeTupleHash: intent.activeTuple.tupleHash, contentManifest: intent.siteSnapshot.contentManifest });
  const publicationIdentity = {
    sitePublicationId,
    snapshotHash: intent.siteSnapshot.snapshotHash,
    activeTupleHash: intent.activeTuple.tupleHash,
    contentManifest: intent.siteSnapshot.contentManifest,
  };
  return { root, client, product, contentSet, artifact, intent, materialization, server, baseUrl, runtimeAcceptanceSpec, publicationIdentity };
}

test("RR-01 RuntimeAcceptanceSpec is one deterministic intent/SiteSnapshot projection", () => {
  const contentManifest = { homeContent: homeValue("approved") };
  const spec = deriveRuntimeAcceptanceSpec({ sitePublicationId: "v0.28.4+" + COMMIT, snapshotHash: "a".repeat(64), activeTupleHash: "b".repeat(64), contentManifest });
  assert.equal(spec.schemaVersion, "runtime-acceptance-v1");
  assert.equal(spec.routes.length, 1);
  assert.equal(spec.routes[0].expectations.length, 1);
  assert.equal(spec.routes[0].expectations[0].valueHash, runtimeTextHash(spec.routes[0].expectations[0].normalizedValue));
  const expected = { sitePublicationId: spec.sitePublicationId, snapshotHash: spec.snapshotHash, activeTupleHash: spec.activeTupleHash, contentManifest };
  assertRuntimeAcceptanceSpec(spec, expected);
  assert.throws(() => assertRuntimeAcceptanceSpec({ ...spec, specHash: "0".repeat(64) }, expected), /specHash drift/);
  assert.throws(() => assertRuntimeAcceptanceSpec({ ...spec, activeTupleHash: "c".repeat(64) }, expected), /specHash drift/);
  assert.throws(() => assertRuntimeAcceptanceSpec({ ...spec, routes: [{ ...spec.routes[0], expectations: [] }] }), /exactly one home expectation/);
  assert.throws(() => deriveRuntimeAcceptanceSpec({ sitePublicationId: spec.sitePublicationId, snapshotHash: spec.snapshotHash, activeTupleHash: "not-a-hash", contentManifest }), /SHA-256/);
  const fallbackManifest = { ...contentManifest, homeContent: homeValue("repository fallback") };
  const fallbackSpec = deriveRuntimeAcceptanceSpec({ sitePublicationId: spec.sitePublicationId, snapshotHash: spec.snapshotHash, activeTupleHash: spec.activeTupleHash, contentManifest: fallbackManifest });
  assert.throws(() => assertRuntimeAcceptanceSpec(fallbackSpec, expected), /approved content manifest projection drift/);
});

test("RR-05 identity predicates reject a cross-publication RuntimeAcceptanceSpec before browser success", async () => {
  const contentManifest = { homeContent: homeValue("approved") };
  const spec = deriveRuntimeAcceptanceSpec({ sitePublicationId: "v0.28.4+" + COMMIT, snapshotHash: "a".repeat(64), activeTupleHash: "b".repeat(64), contentManifest });
  const expected = { sitePublicationId: spec.sitePublicationId, snapshotHash: spec.snapshotHash, activeTupleHash: spec.activeTupleHash, contentManifest };
  assert.throws(
    () => assertRuntimeAcceptanceSpec(spec, { ...expected, snapshotHash: "c".repeat(64) }),
    /snapshotHash mismatch/,
  );
  await assert.rejects(
    () => verifyPublicBrowserRuntime({
      baseUrl: "http://127.0.0.1:9/",
      routes: ["/"],
      runtimeAcceptanceSpec: spec,
      publicationIdentity: { ...expected, snapshotHash: "c".repeat(64) },
      timeoutMs: 500,
      routeTimeoutMs: 500,
    }),
    /snapshotHash mismatch/,
  );
});

test("RR-02/RR-03/RR-04 delayed ContentData runtime waits beyond fallback and records exact observation", async () => {
  const fixture = await delayedRuntimeFixture();
  try {
    const legacyShell = await verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes: ["/"], timeoutMs: 10000, routeTimeoutMs: 5000 });
    assert.equal(legacyShell.verified, true);
    assert.equal(legacyShell.routes["/"].h1Text, "repository fallback");
    const started = Date.now();
    const verified = await verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes: ["/"], runtimeAcceptanceSpec: fixture.runtimeAcceptanceSpec, timeoutMs: 30000, routeTimeoutMs: 10000, publicationIdentity: fixture.publicationIdentity });
    const elapsed = Date.now() - started;
    const route = verified.routes["/"];
    assert.ok(elapsed >= 1000, `runtime converged too early: ${elapsed}ms`);
    assert.equal(route.shellReady, true);
    assert.equal(route.runtimeReady, true);
    assert.ok(route.shellReadyAt);
    assert.ok(route.runtimeReadyAt);
    assert.equal(route.runtimeObserved.normalizedValue, fixture.runtimeAcceptanceSpec.routes[0].expectations[0].normalizedValue);
    assert.equal(route.runtimeObserved.valueHash, fixture.runtimeAcceptanceSpec.routes[0].expectations[0].valueHash);
    assert.equal(route.expectations[0].matched, true);
    assert.equal(verified.acceptanceSpecHash, fixture.runtimeAcceptanceSpec.specHash);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await fixture.materialization.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("RR-06/RR-04 non-convergence, wrong value, object failure and abort are bounded failures", async () => {
  const fixture = await delayedRuntimeFixture();
  try {
    const expected = fixture.runtimeAcceptanceSpec;
    const neverManifest = { homeContent: { homeTitle: { schemaVersion: "responsive-text-slot-v1", parts: [{ id: "only", text: "never converges" }], projections: { "home.positioning.title": { web: { breakAfter: [] } } } }, description: "d", emptyStates: { observations: { message: "m", description: "d" } } } };
    const rebuilt = deriveRuntimeAcceptanceSpec({ sitePublicationId: expected.sitePublicationId, snapshotHash: expected.snapshotHash, activeTupleHash: expected.activeTupleHash, contentManifest: neverManifest });
    await assert.rejects(() => verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes: ["/"], runtimeAcceptanceSpec: rebuilt, publicationIdentity: { ...fixture.publicationIdentity, contentManifest: neverManifest }, timeoutMs: 5000, routeTimeoutMs: 1200 }), (error) => error.code === "PUBLICATION_RUNTIME_DATA_TIMEOUT");
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(() => verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes: ["/"], runtimeAcceptanceSpec: expected, publicationIdentity: fixture.publicationIdentity, timeoutMs: 5000, routeTimeoutMs: 3000, signal: controller.signal }), (error) => error.code === "PUBLICATION_RUNTIME_ABORTED");
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await fixture.materialization.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("RR-06 wrong runtime text and immutable object failure produce distinct bounded evidence", async () => {
  const fixture = await delayedRuntimeFixture({ delayedMs: 0 });
  try {
    const wrongSpec = deriveRuntimeAcceptanceSpec({
      sitePublicationId: fixture.runtimeAcceptanceSpec.sitePublicationId,
      snapshotHash: fixture.runtimeAcceptanceSpec.snapshotHash,
      activeTupleHash: fixture.runtimeAcceptanceSpec.activeTupleHash,
      contentManifest: { homeContent: homeValue("wrong") },
    });
    const wrongManifest = { homeContent: homeValue("wrong") };
    await assert.rejects(
      () => verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes: ["/"], runtimeAcceptanceSpec: wrongSpec, publicationIdentity: { ...fixture.publicationIdentity, contentManifest: wrongManifest }, timeoutMs: 5000, routeTimeoutMs: 1200 }),
      (error) => error.code === "PUBLICATION_RUNTIME_DATA_TIMEOUT" && error.runtimeEvidence?.routes?.["/"]?.runtimeReady === false,
    );
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await fixture.materialization.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }

  const failedFixture = await delayedRuntimeFixture({ delayedMs: 0, failObject: true });
  try {
    await assert.rejects(
      () => verifyPublicBrowserRuntime({ baseUrl: failedFixture.baseUrl, routes: ["/"], runtimeAcceptanceSpec: failedFixture.runtimeAcceptanceSpec, publicationIdentity: failedFixture.publicationIdentity, timeoutMs: 30000, routeTimeoutMs: 10000 }),
      (error) => ["PUBLICATION_RUNTIME_CONTENT_FETCH_FAILED", "PUBLICATION_RUNTIME_DATA_TIMEOUT", "PUBLICATION_RUNTIME_TIMEOUT"].includes(error.code)
        && Boolean(error.runtimeEvidence?.routes?.["/"] || error.runtimeEvidence),
    );
  } finally {
    await new Promise((resolve) => failedFixture.server.close(resolve));
    await failedFixture.materialization.cleanup();
    await rm(failedFixture.root, { recursive: true, force: true });
  }
});

test("RR-10 candidate-only runtime verification preserves canonical protected facts and approval boundary", async () => {
  const before = captureProtectedFacts(process.cwd());
  const fixture = await delayedRuntimeFixture({ delayedMs: 0 });
  try {
    const evidence = await verifyPublicBrowserRuntime({ baseUrl: fixture.baseUrl, routes: ["/"], runtimeAcceptanceSpec: fixture.runtimeAcceptanceSpec, publicationIdentity: fixture.publicationIdentity, timeoutMs: 10000, routeTimeoutMs: 5000 });
    assert.equal(evidence.verified, true);
    assert.equal(Object.hasOwn(evidence, "transportCalls"), false);
    assert.equal(Object.hasOwn(evidence, "deploymentId"), false);
  } finally {
    await new Promise((resolve) => fixture.server.close(resolve));
    await fixture.materialization.cleanup();
    await rm(fixture.root, { recursive: true, force: true });
  }
  const after = captureProtectedFacts(process.cwd());
  assert.equal(after.hash, before.hash);
  assert.equal(await readFile(path.join(process.cwd(), ".content-workspace", "qa", "v0.28.4", "approval-record.json")).then(() => true).catch(() => false), false);
});
