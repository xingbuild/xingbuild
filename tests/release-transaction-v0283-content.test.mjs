import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  activateContentSet,
  createContentSet,
  readActiveContentSet,
  writeContentSet,
} from "../scripts/lib/content-set.mjs";
import {
  assertActiveContentDataTuple,
  contentDataPaths,
  createContentDataArtifact,
  createActiveContentDataTuple,
  changedContentDataObjects,
  prepareContentOnlyMaterialization,
  validateContentDataMaterialization,
  readActiveContentDataTuple,
  writeContentDataArtifact,
} from "../scripts/lib/content-data-plane.mjs";
import {
  assertContentPublicationIntent,
  createContentPublicationIntent,
  prepareContentPublicationIntent,
  resolveLegacyContentDataBaseline,
} from "../scripts/lib/content-publication-intent.mjs";
import { prepareContentSetCandidate as prepareContentSetCandidateFromCli } from "../scripts/content-release.mjs";
import {
  computeProductArtifactHash,
  readProductArtifact,
} from "../scripts/lib/product-artifact.mjs";
import { createBaseSiteArtifact, hashArtifactValue } from "../scripts/lib/base-site-artifact.mjs";
import {
  acquireSitePublicationLease,
  createSitePublication,
  releaseSitePublicationLease,
  validateUploadQuota,
} from "../scripts/lib/site-publication.mjs";
import { createSiteSnapshot } from "../scripts/lib/site-snapshot.mjs";
import {
  finalizeSitePublication,
  transportSitePublication,
  verifyPublicSitePublication,
} from "../scripts/lib/site-publication-coordinator.mjs";
import { verifyPublicBrowserRuntime } from "../scripts/lib/publication-runtime.mjs";
import { readPublicationRun } from "../scripts/lib/publication-run.mjs";
import { readRuntimeContentDataFromHttp } from "../src/content/contentDataArtifact.js";

const COMMIT = "c".repeat(40);

function hashJson(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

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

async function writeContentFixture(root) {
  const contentRoot = path.join(root, ".content-workspace", "content");
  await mkdir(contentRoot, { recursive: true });
  await mkdir(path.join(root, "content", "registry"), { recursive: true });
  await cp(path.resolve("content/registry/content-targets.json"), path.join(root, "content", "registry", "content-targets.json"));
  const oldHome = homeValue("old");
  const entries = [{
    entryId: "home:home", kind: "home", target: "home", sourcePath: "content/home.json", route: "/",
    contentHash: hashJson(oldHome), sourceProof: ["content/home.json"], reviewProof: { status: "approved" }, mediaProof: [],
  }];
  for (let index = 0; index < 37; index += 1) {
    const target = `observation-${String(index + 1).padStart(2, "0")}`;
    const value = { id: target, title: `Observation ${index + 1}`, body: `Stable body ${index + 1}` };
    const relative = `content/observations/${target}.json`;
    await mkdir(path.dirname(path.join(contentRoot, relative.slice("content/".length))), { recursive: true });
    await writeFile(path.join(root, ".content-workspace", relative), `${JSON.stringify(value)}\n`);
    entries.push({
      entryId: `observation:${target}`, kind: "observation", target, sourcePath: relative, route: `/observations/${target}`,
      contentHash: hashJson(value), sourceProof: [relative], reviewProof: { status: "approved" }, mediaProof: [],
    });
  }
  await writeFile(path.join(contentRoot, "home.json"), `${JSON.stringify(oldHome, null, 2)}\n`);
  const contentSet = createContentSet({ entries, homeContent: oldHome, createdAt: "2026-08-16T00:00:00.000Z", migration: { source: "test-fixture" } });
  await writeContentSet({ sourceRoot: root, contentSet });
  await activateContentSet({ sourceRoot: root, nextContentSetId: contentSet.contentSetId, expectedContentSetId: null, now: "2026-08-16T00:00:00.000Z" });
  return { contentSet, oldHome };
}

async function writeProductFixture(root) {
  const client = path.join(root, "product");
  await mkdir(path.join(client, "assets"), { recursive: true });
  await writeFile(path.join(client, "index.html"), `<!doctype html><html><head><title>xingbuild</title><link rel="icon" href="/favicon.svg"><link rel="stylesheet" href="/assets/app.css"></head><body><div id="root"><main><h1>new line one new line twonew line three</h1></main></div><script type="module" src="/assets/app.js"></script></body></html>\n`);
  await writeFile(path.join(client, "assets", "app.js"), "document.documentElement.dataset.fixture = 'v0283';\n");
  await writeFile(path.join(client, "assets", "app.css"), "body{font-family:sans-serif}\n");
  await writeFile(path.join(client, "edgeone.json"), "{}\n");
  await writeFile(path.join(client, "favicon.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 1 1\"><rect width=\"1\" height=\"1\"/></svg>\n");
  const productVersion = "v0.28.3";
  const productArtifactId = `${productVersion}-${COMMIT.slice(0, 12)}`;
  const contentManifest = { schemaVersion: "content-manifest-v2", publishedSlugs: [], publishedArticleSlugs: [] };
  const transactionIdentity = { approvalHash: "a".repeat(64), candidateHash: "b".repeat(64), approvedTreeOid: "d".repeat(40) };
  const provisionalRelease = {
    schemaVersion: "product-artifact-release-v2", productVersion, productCommit: COMMIT,
    version: productVersion, commit: COMMIT,
    productArtifactId, baseSiteArtifactId: productArtifactId,
    contentManifestHash: "0".repeat(64), baseSiteArtifactManifestHash: "0".repeat(64),
    ...transactionIdentity, clientFiles: [],
  };
  await writeFile(path.join(client, "content-manifest.json"), `${JSON.stringify(contentManifest, null, 2)}\n`);
  await writeFile(path.join(client, "release.json"), `${JSON.stringify(provisionalRelease, null, 2)}\n`);
  const baseSiteArtifact = await createBaseSiteArtifact({
    sourceRoot: root, clientDirectory: client, productVersion, productCommit: COMMIT,
    release: provisionalRelease, contentManifest,
  });
  await writeFile(path.join(client, "base-site-artifact.json"), `${JSON.stringify(baseSiteArtifact, null, 2)}\n`);
  const { readdir } = await import("node:fs/promises");
  async function files(directory, current = "") {
    const result = [];
    for (const entry of await readdir(path.join(directory, current), { withFileTypes: true })) {
      const relative = path.posix.join(current, entry.name);
      if (entry.isDirectory()) result.push(...await files(directory, relative));
      else if (entry.isFile() && relative !== "release.json") result.push({ path: relative, sha256: createHash("sha256").update(await readFile(path.join(directory, relative))).digest("hex") });
    }
    return result.sort((a, b) => a.path.localeCompare(b.path));
  }
  const clientFiles = await files(client);
  const release = {
    ...provisionalRelease,
    contentManifestHash: hashArtifactValue(contentManifest),
    baseSiteArtifactManifestHash: hashArtifactValue(baseSiteArtifact),
    clientFiles,
  };
  release.productArtifactHash = computeProductArtifactHash(release);
  await writeFile(path.join(client, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  const storedClient = path.join(root, ".content-workspace", "base-site-artifacts", productArtifactId, "client");
  await writeFile(path.join(storedClient, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
  return { client, productArtifactId, release };
}

async function serveDirectory(directory) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
      if (!relative || !path.extname(relative)) relative = "index.html";
      const file = path.resolve(directory, relative);
      if (file !== directory && !file.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error("unsafe path");
      const bytes = await readFile(file);
      const type = relative.endsWith(".json") ? "application/json" : relative.endsWith(".js") ? "text/javascript" : relative.endsWith(".css") ? "text/css" : "text/html";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      response.end(bytes);
    } catch {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not found");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}/` };
}

async function writeTransportContract(root) {
  await mkdir(path.join(root, ".edgeone"), { recursive: true });
  await writeFile(path.join(root, ".edgeone", "project.json"), JSON.stringify({ Name: "xingbuild-nochina", ProjectId: "makers-ze0f6txvlhco" }));
  const current = "# current\ncontentImpact: compatible\ncontentImpactReason: v0283\naffectedTargets: []\naffectedRoutes: []\ncompatibilityEvidence: v0283\n";
  await mkdir(path.join(root, "docs", "iterations"), { recursive: true });
  await writeFile(path.join(root, "docs", "iterations", "current.md"), current);
  await writeFile(path.join(root, "docs-current.md"), current);
}

/**
 * Prepare one isolated, tuple-bound publication.  The helper is only used by
 * formal fault tests; the positive staged-tree chain remains the independent
 * proof of the real release/content/browser path.
 */
async function prepareDataPlaneFixture(root, { transport = false } = {}) {
  if (transport) await writeTransportContract(root);
  const content = await writeContentFixture(root);
  const productFixture = await writeProductFixture(root);
  const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
  const baseline = await resolveLegacyContentDataBaseline({ sourceRoot: root, persist: false });
  const nextHome = homeValue("new");
  await writeFile(path.join(root, ".content-workspace", "content", "home.json"), `${JSON.stringify(nextHome, null, 2)}\n`);
  const candidate = createContentSet({
    entries: content.contentSet.entries.map((entry) => entry.entryId === "home:home" ? { ...entry, contentHash: hashJson(nextHome) } : entry),
    homeContent: nextHome,
    previousContentSetId: content.contentSet.contentSetId,
    createdAt: "2026-08-16T00:00:01.000Z",
    migration: { source: "test-fixture" },
  });
  await writeContentSet({ sourceRoot: root, contentSet: candidate });
  const prepared = await prepareContentPublicationIntent({
    sourceRoot: root,
    productArtifact: product,
    contentSet: candidate,
    previousArtifact: baseline.artifact,
  });
  const publication = await createSitePublication({
    productClient: productFixture.client,
    releasesRoot: path.join(root, ".content-workspace", "releases"),
    publicationRoot: path.join(root, ".content-workspace", "site-publications"),
    sourceRoot: root,
    contentSet: prepared.contentSet,
    contentDataArtifact: prepared.contentDataArtifact,
    activeTuple: prepared.activeTuple,
    contentPublicationIntent: prepared.intent,
    assemble: false,
  });
  return { content, productFixture, product, baseline, candidate, prepared, publication };
}

test("FM-01 baseline unreconstructible entry rejects with zero writes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-baseline-"));
  try {
    await writeContentFixture(root);
    const before = await readFile(path.join(root, ".content-workspace", "content-state", "active.json"));
    await rm(path.join(root, ".content-workspace", "content", "observations", "observation-01.json"));
    await assert.rejects(resolveLegacyContentDataBaseline({ sourceRoot: root, persist: true }), /baseline source\/contentHash drift|canonical content source is missing/);
    assert.equal((await readFile(path.join(root, ".content-workspace", "content-state", "active.json"))).toString(), before.toString());
    await assert.rejects(stat(path.join(root, ".content-workspace", "content-state", "data-artifacts")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-02 source/contentHash drift rejects before baseline write", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-baseline-drift-"));
  try {
    await writeContentFixture(root);
    const activePath = path.join(root, ".content-workspace", "content-state", "active.json");
    const before = await readFile(activePath, "utf8");
    const source = path.join(root, ".content-workspace", "content", "observations", "observation-01.json");
    await writeFile(source, JSON.stringify({ id: "observation-01", title: "tampered source" }));
    await assert.rejects(
      () => resolveLegacyContentDataBaseline({ sourceRoot: root, persist: true }),
      (error) => error.code === "CONTENT_DATA_BASELINE_HASH_DRIFT" && /source\/contentHash drift/.test(error.message),
    );
    assert.equal(await readFile(activePath, "utf8"), before);
    await assert.rejects(stat(path.join(root, ".content-workspace", "content-state", "data-artifacts")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v0.28.3 ContentPublicationIntent proves one changed home and 37 reused records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-intent-"));
  try {
    const fixture = await writeContentFixture(root);
    const product = { productVersion: "v0.28.3", productCommit: COMMIT, productArtifactId: `v0.28.3-${COMMIT.slice(0, 12)}`, baseSiteArtifactId: `v0.28.3-${COMMIT.slice(0, 12)}` };
    const baseline = await resolveLegacyContentDataBaseline({ sourceRoot: root, persist: false });
    const nextHome = homeValue("new");
    await writeFile(path.join(root, ".content-workspace", "content", "home.json"), `${JSON.stringify(nextHome, null, 2)}\n`);
    const nextEntries = fixture.contentSet.entries.map((entry) => entry.entryId === "home:home" ? { ...entry, contentHash: hashJson(nextHome) } : entry);
    const candidate = createContentSet({ entries: nextEntries, homeContent: nextHome, previousContentSetId: fixture.contentSet.contentSetId, createdAt: "2026-08-16T00:00:01.000Z", migration: { source: "test-fixture" } });
    await writeContentSet({ sourceRoot: root, contentSet: candidate });
    const prepared = await prepareContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: candidate, previousArtifact: baseline.artifact });
    assertContentPublicationIntent(prepared.intent);
    assert.equal(prepared.intent.delta.changed.length, 1);
    assert.equal(prepared.intent.delta.changed[0].logicalContentId, "home:home");
    assert.equal(prepared.intent.delta.reused.length, 37);
    assert.equal(prepared.intent.siteSnapshot.schemaVersion, "site-snapshot-v1");
    assert.equal(prepared.intent.activeTuple.manifestHash.length, 64);
    assert.equal(prepared.intent.expectedPreviousTupleHash, null);
    const same = await prepareContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: candidate, previousArtifact: baseline.artifact, contentDataArtifact: prepared.contentDataArtifact });
    assert.equal(same.intent.intentHash, prepared.intent.intentHash);
    await assert.rejects(() => createContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: candidate, contentDataArtifact: prepared.contentDataArtifact, activeTuple: { ...prepared.activeTuple, contentDataHash: "0".repeat(64) } }), /tuple|hash|ContentDataArtifact/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-03 approved review hash drift rejects the content candidate entry", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-review-drift-"));
  const target = "nhtsa-first-responder-requirement";
  try {
    await writeContentFixture(root);
    const source = path.join(root, ".content-workspace", "content", "observations", `${target}.json`);
    await mkdir(path.dirname(source), { recursive: true });
    await cp(path.join(process.cwd(), ".content-workspace", "content", "observations", `${target}.json`), source);
    const sourceBytes = await readFile(source);
    const reviewRoot = path.join(root, ".content-workspace");
    await mkdir(path.join(reviewRoot, "drafts"), { recursive: true });
    await mkdir(path.join(reviewRoot, "recoveries"), { recursive: true });
    await mkdir(path.join(reviewRoot, "reviews"), { recursive: true });
    await writeFile(path.join(reviewRoot, "drafts", `${target}.json`), sourceBytes);
    await writeFile(path.join(reviewRoot, "recoveries", `${target}.json`), Buffer.concat([sourceBytes, Buffer.from("\n") ]));
    const contentHash = createHash("sha256").update(sourceBytes).digest("hex");
    await writeFile(path.join(reviewRoot, "reviews", `${target}.json`), JSON.stringify({
      slug: target,
      status: "approved",
      reviewedAt: "2026-08-16T00:00:00.000Z",
      authority: "test-review",
      contentHash,
    }));
    await assert.rejects(
      () => prepareContentSetCandidateFromCli({ kind: "content", target, sourceRoot: root }),
      /content lifecycle hash mismatch/,
    );
    await assert.rejects(stat(path.join(root, ".content-workspace", "candidates")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-07 missing ContentData refs reject canonical SiteSnapshot", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-contract-"));
  try {
    const content = await writeContentFixture(root);
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    assert.throws(() => createSiteSnapshot({ productArtifact: product, contentSet: content.contentSet }), /requires ContentDataArtifact and active tuple/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-04 CDA object tamper rejects prepared materialization and cleans it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-object-tamper-"));
  try {
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact });
    const materialization = await prepareContentOnlyMaterialization({ sourceRoot: root, artifact, activeTuple: tuple, contentSet: content.contentSet });
    const objectFile = path.join(materialization.root, "content-data", artifact.contentDataArtifactId, "objects", `${artifact.records[0].objectHash}.json`);
    await writeFile(objectFile, JSON.stringify({ objectHash: "0".repeat(64), record: { tampered: true } }));
    await assert.rejects(() => validateContentDataMaterialization({ root: materialization.root, artifact, activeTuple: materialization.activePointer }), /object identity drift/);
    await materialization.cleanup();
    await assert.rejects(stat(materialization.root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-05 intent cross-mix rejects a ContentSet and CDA from different tuples", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-intent-cross-mix-"));
  try {
    const content = await writeContentFixture(root);
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const otherSet = createContentSet({ entries: content.contentSet.entries, homeContent: content.contentSet.homeContent, previousContentSetId: content.contentSet.contentSetId, createdAt: "2026-08-16T00:00:02.000Z", migration: { source: "cross-mix" } });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact, productArtifact: product });
    await assert.rejects(
      () => createContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: otherSet, contentDataArtifact: artifact, activeTuple: tuple }),
      /ContentSet identity mismatch/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-06 ProductArtifact mismatch rejects a tuple-bound publication intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-product-mismatch-"));
  try {
    const content = await writeContentFixture(root);
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact, productArtifact: product });
    const wrongCommit = "d".repeat(40);
    const wrongProduct = { ...product, productCommit: wrongCommit, productArtifactId: `v0.28.3-${wrongCommit.slice(0, 12)}`, baseSiteArtifactId: `v0.28.3-${wrongCommit.slice(0, 12)}`, productArtifactHash: "e".repeat(64) };
    await assert.rejects(
      () => createContentPublicationIntent({ sourceRoot: root, productArtifact: wrongProduct, contentSet: content.contentSet, contentDataArtifact: artifact, activeTuple: tuple }),
      /ProductArtifact identity mismatch/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-03B unapproved review proof rejects an otherwise valid ContentSet", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-review-proof-"));
  try {
    const content = await writeContentFixture(root);
    const pending = createContentSet({
      entries: content.contentSet.entries.map((entry) => entry.entryId === "home:home" ? { ...entry, reviewProof: { status: "pending" } } : entry),
      homeContent: content.contentSet.homeContent,
      previousContentSetId: content.contentSet.contentSetId,
      createdAt: "2026-08-16T00:00:02.000Z",
      migration: { source: "test-fixture" },
    });
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    await assert.rejects(() => prepareContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: pending, previousArtifact: null }), /review proof is not approved/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v0.28.3 exact product client materialization rejects source/client drift", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-materialization-"));
  try {
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    await writeContentDataArtifact({ sourceRoot: root, artifact });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact, productArtifact: product, manifest: { stable: true } });
    await writeFile(path.join(productFixture.client, "assets", "app.js"), "tampered\n");
    await assert.rejects(() => prepareContentOnlyMaterialization({ productClient: productFixture.client, sourceRoot: root, artifact, activeTuple: tuple, contentSet: content.contentSet, productArtifact: product, manifest: { stable: true } }), /ProductArtifact client bytes drift/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v0.28.3 browser runtime rejects tampered CAS object bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-runtime-tamper-"));
  try {
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact });
    const materialization = await prepareContentOnlyMaterialization({ sourceRoot: root, artifact, activeTuple: tuple, contentSet: content.contentSet });
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      const file = pathname.endsWith("/active.json")
        ? path.join(materialization.root, "content-data/active.json")
        : path.join(materialization.root, pathname.slice(1));
      try {
        const payload = JSON.parse(await readFile(file, "utf8"));
        if (pathname.includes("/objects/") && payload.record) payload.record.value = { tampered: true };
        return Response.json(payload, { status: 200 });
      } catch {
        return new Response("missing", { status: 404 });
      }
    };
    await assert.rejects(() => readRuntimeContentDataFromHttp({ baseUrl: "https://fixture.invalid/", fetchImpl }), /object identity mismatch/);
    await materialization.cleanup();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-08 no-change reuses all 38 objects and preserves identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-no-change-"));
  try {
    const content = await writeContentFixture(root);
    const first = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const second = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, previousArtifact: first, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const delta = changedContentDataObjects({ previousArtifact: first, nextArtifact: second });
    assert.equal(second.contentDataArtifactId, first.contentDataArtifactId);
    assert.equal(second.contentDataHash, first.contentDataHash);
    assert.equal(delta.changed.length, 0);
    assert.equal(delta.reused.length, 38);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-09 duplicate prepare is idempotent and writes one immutable intent", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-duplicate-prepare-"));
  try {
    const content = await writeContentFixture(root);
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    const first = await prepareContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: content.contentSet, previousArtifact: null });
    const second = await prepareContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: content.contentSet, previousArtifact: null });
    assert.equal(second.intent.intentId, first.intent.intentId);
    assert.equal(second.intent.intentHash, first.intent.intentHash);
    assert.equal(second.persisted.reused, true);
    const intentFiles = (await readdir(path.join(root, ".content-workspace", "content-state", "content-publication-intents"))).filter((file) => file.endsWith(".json"));
    assert.deepEqual(intentFiles, [`${first.intent.intentId}.json`]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-10 upload quota rejects an oversized temporary materialization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-quota-"));
  try {
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact });
    const materialization = await prepareContentOnlyMaterialization({ sourceRoot: root, artifact, activeTuple: tuple, contentSet: content.contentSet });
    await assert.rejects(() => validateUploadQuota(materialization.root, { maxFileBytes: 1 }), /upload quota exceeded/);
    const tempRoot = materialization.root;
    await materialization.cleanup();
    await assert.rejects(stat(tempRoot));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-11 publication lease conflict rejects a second snapshot and releases cleanly", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-lease-"));
  let first = null;
  try {
    const leaseDirectory = path.join(root, ".content-workspace", "site-publications", ".site-lease");
    const publicationDirectory = path.join(root, ".content-workspace", "site-publications", "fixture");
    first = await acquireSitePublicationLease({ publicationDirectory, leaseDirectory, sitePublicationId: "publication-a", snapshotHash: "a".repeat(64), ttlMs: 900000 });
    await assert.rejects(
      () => acquireSitePublicationLease({ publicationDirectory, leaseDirectory, sitePublicationId: "publication-b", snapshotHash: "b".repeat(64), ttlMs: 900000 }),
      /lease|already|held/i,
    );
  } finally {
    if (first) await releaseSitePublicationLease(first);
    await rm(root, { recursive: true, force: true });
  }
});

test("v0.28.3 joint SitePublication uses real Coordinator, public proof, CAS finalize and cleanup", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-positive-"));
  let http = null;
  try {
    await mkdir(path.join(root, ".edgeone"), { recursive: true });
    await writeFile(path.join(root, ".edgeone", "project.json"), JSON.stringify({ Name: "xingbuild-nochina", ProjectId: "makers-ze0f6txvlhco" }));
    await writeFile(path.join(root, "docs-current.md"), "contentImpact: compatible\ncontentImpactReason: v0283\naffectedTargets: []\naffectedRoutes: []\ncompatibilityEvidence: v0283\n");
    await mkdir(path.join(root, "docs", "iterations"), { recursive: true });
    await writeFile(path.join(root, "docs", "iterations", "current.md"), "# current\ncontentImpact: compatible\ncontentImpactReason: v0283\naffectedTargets: []\naffectedRoutes: []\ncompatibilityEvidence: v0283\n");
    const content = await writeContentFixture(root);
    const productFixture = await writeProductFixture(root);
    const product = await readProductArtifact({ clientDirectory: productFixture.client, sourceRoot: root, version: "v0.28.3", commit: COMMIT });
    const baseline = await resolveLegacyContentDataBaseline({ sourceRoot: root, persist: false });
    const nextHome = homeValue("new");
    await writeFile(path.join(root, ".content-workspace", "content", "home.json"), `${JSON.stringify(nextHome, null, 2)}\n`);
    const candidate = createContentSet({ entries: content.contentSet.entries.map((entry) => entry.entryId === "home:home" ? { ...entry, contentHash: hashJson(nextHome) } : entry), homeContent: nextHome, previousContentSetId: content.contentSet.contentSetId, createdAt: "2026-08-16T00:00:01.000Z", migration: { source: "test-fixture" } });
    await writeContentSet({ sourceRoot: root, contentSet: candidate });
    const prepared = await prepareContentPublicationIntent({ sourceRoot: root, productArtifact: product, contentSet: candidate, previousArtifact: baseline.artifact });
    const publication = await createSitePublication({
      productClient: productFixture.client,
      releasesRoot: path.join(root, ".content-workspace", "releases"),
      publicationRoot: path.join(root, ".content-workspace", "site-publications"),
      sourceRoot: root,
      contentSet: prepared.contentSet,
      contentDataArtifact: prepared.contentDataArtifact,
      activeTuple: prepared.activeTuple,
      contentPublicationIntent: prepared.intent,
      assemble: false,
    });
    assert.equal(publication.contentDataArtifactId, prepared.contentDataArtifact.contentDataArtifactId);
    assert.equal(publication.contentPublicationIntentId, prepared.intent.intentId);
    const legacyActiveBefore = await readFile(path.join(root, ".content-workspace", "content-state", "active.json"));
    assert.equal(await stat(path.join(root, ".content-workspace", "content-state", "content-data-active.json")).then(() => true).catch(() => false), false);
    http = await serveDirectory(publication.client);
    // The candidate pointer is materialized in the upload root, while the
    // canonical authority remains absent until the Coordinator's public
    // proof completes.
    assert.equal(await stat(contentDataPaths(root).activePath).then(() => true).catch(() => false), false);
    const runCaptureImpl = (_command, args) => args[0] === "whoami" ? "authenticated" : JSON.stringify({ status: "success", deploymentId: "deployment-v0283", projectId: "makers-ze0f6txvlhco" });
    const released = await transportSitePublication({
      publication, sourceRoot: root, argv: ["--authorize-publish"], env: {}, edgeonePath: "edgeone", baseUrl: http.baseUrl,
      fetchImpl: fetch, runCaptureImpl, maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, sleepImpl: async () => {},
    });
    assert.equal(released.state, "released");
    assert.equal(released.activeTupleHash, prepared.activeTuple.tupleHash);
    assert.deepEqual((await readActiveContentDataTuple({ sourceRoot: root })).tupleHash, prepared.activeTuple.tupleHash);
    assert.equal(await stat(path.dirname(publication.client)).then(() => true).catch(() => false), true);
    assert.equal(await stat(path.join(root, ".content-workspace", "content-state", "active.json")).then(() => true).catch(() => false), true);
    assert.equal((await readFile(path.join(root, ".content-workspace", "content-state", "active.json"))).toString(), legacyActiveBefore.toString());
  } finally {
    if (http) await new Promise((resolve) => http.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("CP-07 public proof runs before active tuple finalization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-public-proof-"));
  let http = null;
  try {
    const fixture = await prepareDataPlaneFixture(root);
    http = await serveDirectory(fixture.publication.client);
    const activePath = contentDataPaths(root).activePath;
    assert.equal(await stat(activePath).then(() => true).catch(() => false), false);
    const proof = await verifyPublicSitePublication({
      publication: fixture.publication,
      baseUrl: http.baseUrl,
      fetchImpl: fetch,
      browserRuntimeVerify: verifyPublicBrowserRuntime,
      attemptId: "cp07-public-proof",
    });
    assert.equal(proof.snapshotHash, fixture.publication.snapshotHash);
    assert.equal(proof.browserRuntime?.verified, true);
    assert.equal(await stat(activePath).then(() => true).catch(() => false), false);
  } finally {
    if (http) await new Promise((resolve) => http.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("FM-12 transport timeout records one recoverable deployment", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-timeout-"));
  try {
    const fixture = await prepareDataPlaneFixture(root, { transport: true });
    let deployCalls = 0;
    const runCaptureImpl = (_command, args) => {
      if (args[0] === "whoami") return "authenticated";
      deployCalls += 1;
      return JSON.stringify({ status: "success", deploymentId: "deployment-timeout", projectId: "makers-ze0f6txvlhco" });
    };
    await assert.rejects(
      () => transportSitePublication({
        publication: fixture.publication,
        sourceRoot: root,
        argv: ["--authorize-publish"],
        env: {},
        edgeonePath: "edgeone",
        baseUrl: "http://127.0.0.1:9/",
        fetchImpl: async () => new Response("stale", { status: 503 }),
        runCaptureImpl,
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      }),
      (error) => error.code === "SITE_PUBLICATION_VERIFY_TIMEOUT" && error.recoverable === true,
    );
    assert.equal(deployCalls, 1);
    const run = await readPublicationRun({ sourceRoot: root, publicationRunId: fixture.publication.publicationRunId });
    assert.equal(run.state, "recoverable");
    assert.equal(run.deploymentCount, 1);
    assert.equal(await stat(contentDataPaths(root).activePath).then(() => true).catch(() => false), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-13 public stale manifest rejects before any authority mutation", async () => {
  const publication = {
    sitePublicationId: "publication-stale",
    snapshotHash: "a".repeat(64),
    productVersion: "v0.28.3",
    productCommit: COMMIT,
    productArtifactId: `v0.28.3-${COMMIT.slice(0, 12)}`,
    baseSiteArtifactId: `v0.28.3-${COMMIT.slice(0, 12)}`,
  };
  const fetchImpl = async (url) => {
    if (String(url).endsWith("/release.json")) return Response.json({ version: publication.productVersion, commit: publication.productCommit });
    if (String(url).endsWith("/content-manifest.json")) return Response.json({
      version: publication.productVersion,
      commit: publication.productCommit,
      sitePublicationId: publication.sitePublicationId,
      snapshotHash: "b".repeat(64),
      baseSiteArtifactId: publication.productArtifactId,
    });
    return new Response("not reached", { status: 404 });
  };
  await assert.rejects(
    () => verifyPublicSitePublication({ publication, baseUrl: "https://stale.invalid/", fetchImpl }),
    /snapshot identity does not match SitePublication/,
  );
});

test("FM-14 browser fallback proof rejects without activating the tuple", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-browser-fallback-"));
  let http = null;
  try {
    const fixture = await prepareDataPlaneFixture(root);
    http = await serveDirectory(fixture.publication.client);
    await assert.rejects(
      () => verifyPublicSitePublication({
        publication: fixture.publication,
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        browserRuntimeVerify: async () => { throw new Error("injected browser fallback proof failure"); },
        attemptId: "fm14-browser-fallback",
      }),
      /injected browser fallback proof failure/,
    );
    assert.equal(await stat(contentDataPaths(root).activePath).then(() => true).catch(() => false), false);
  } finally {
    if (http) await new Promise((resolve) => http.server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("FM-15 active tuple CAS rejects stale finalize without changing authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-cas-"));
  try {
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact });
    await writeContentDataArtifact({ sourceRoot: root, artifact });
    await (await import("../scripts/lib/content-data-plane.mjs")).activateContentDataTuple({ sourceRoot: root, tuple });
    const before = await readFile(contentDataPaths(root).activePath);
    const next = { ...tuple, tupleHash: "0".repeat(64) };
    await assert.rejects(async () => {
      assertActiveContentDataTuple(next);
    }, /hash drift/);
    await assert.rejects((await import("../scripts/lib/content-data-plane.mjs")).activateContentDataTuple({ sourceRoot: root, tuple, expectedTupleHash: "f".repeat(64) }), /CAS conflict/);
    assert.equal((await readFile(contentDataPaths(root).activePath)).toString(), before.toString());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CP-01 tuple is the sole active ContentSet authority and legacy writes are locked", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-authority-"));
  try {
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    await writeContentDataArtifact({ sourceRoot: root, artifact });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact });
    await (await import("../scripts/lib/content-data-plane.mjs")).activateContentDataTuple({ sourceRoot: root, tuple });
    const authority = await readActiveContentSet({ sourceRoot: root });
    assert.equal(authority.mode, "tuple");
    assert.equal(authority.activeTuple.tupleHash, tuple.tupleHash);
    const legacyBytes = await readFile(path.join(root, ".content-workspace", "content-state", "active.json"));
    await assert.rejects(() => activateContentSet({ sourceRoot: root, nextContentSetId: content.contentSetId, expectedContentSetId: content.contentSetId }), /legacy ContentSet active pointer is read-only/);
    assert.equal((await readFile(path.join(root, ".content-workspace", "content-state", "active.json"))).toString(), legacyBytes.toString());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-16 finalize crash rolls the active tuple back to its prior authority", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-finalize-crash-"));
  try {
    const fixture = await prepareDataPlaneFixture(root);
    const publicationFile = path.join(fixture.publication.client, "site-publication.json");
    const current = JSON.parse(await readFile(publicationFile, "utf8"));
    const deployment = { deploymentId: "deployment-finalize-crash", status: "success" };
    await writeFile(publicationFile, `${JSON.stringify({ ...current, deploymentId: deployment.deploymentId, deployment, assetManifest: null }, null, 2)}\n`);
    const publicVerify = {
      sitePublicationId: current.sitePublicationId,
      siteSnapshotId: current.siteSnapshotId,
      snapshotHash: current.snapshotHash,
      contentSetId: current.contentSetId,
      contentSetHash: current.contentSetHash,
      baseSiteArtifactId: current.productArtifactId,
      productArtifactHash: current.productArtifactHash,
      contentDataArtifactId: current.contentDataArtifactId,
      contentDataHash: current.contentDataHash,
      activeTupleHash: current.activeTupleHash,
      runtimeAcceptanceSpecHash: current.runtimeAcceptanceSpecHash,
    };
    await assert.rejects(
      () => finalizeSitePublication({ publicationDirectory: fixture.publication.client, sourceRoot: root, publicVerify, failAfterActivate: "crash" }),
      /injected finalize crash after active tuple activation/,
    );
    assert.equal(await stat(contentDataPaths(root).activePath).then(() => true).catch(() => false), false);
    const run = await readPublicationRun({ sourceRoot: root, publicationRunId: fixture.publication.publicationRunId });
    assert.equal(run.state, "assembled");
    assert.equal(run.deploymentCount, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-17 resume reuses the same deployment and does not redeploy", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-resume-"));
  try {
    const fixture = await prepareDataPlaneFixture(root, { transport: true });
    let deployCalls = 0;
    const runCaptureImpl = (_command, args) => {
      if (args[0] === "whoami") return "authenticated";
      deployCalls += 1;
      return JSON.stringify({ status: "success", deploymentId: "deployment-resume", projectId: "makers-ze0f6txvlhco" });
    };
    const transport = () => transportSitePublication({
      publication: fixture.publication,
      sourceRoot: root,
      argv: ["--authorize-publish"],
      env: {},
      edgeonePath: "edgeone",
      baseUrl: "http://127.0.0.1:9/",
      fetchImpl: async () => new Response("stale", { status: 503 }),
      runCaptureImpl,
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      sleepImpl: async () => {},
    });
    await assert.rejects(transport, /site publication public verification timed out/);
    await assert.rejects(transport, /site publication public verification timed out/);
    assert.equal(deployCalls, 1);
    const run = await readPublicationRun({ sourceRoot: root, publicationRunId: fixture.publication.publicationRunId });
    assert.equal(run.deploymentId, "deployment-resume");
    assert.equal(run.deploymentCount, 1);
    assert.equal(run.state, "recoverable");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("FM-18 temporary-root cleanup removes prepare failures", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0283-cleanup-"));
  try {
    const content = await writeContentFixture(root);
    const artifact = await createContentDataArtifact({ sourceRoot: root, contentSet: content.contentSet, sourceOverrides: new Map([["home:home", content.oldHome]]) });
    const tuple = createActiveContentDataTuple({ contentSet: content.contentSet, artifact });
    const before = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("xingbuild-content-data-upload-")));
    await assert.rejects(
      () => prepareContentOnlyMaterialization({ sourceRoot: root, artifact, activeTuple: tuple, contentSet: content.contentSet, failPhase: "prepare" }),
      /injected content data prepare failure/,
    );
    const after = new Set((await readdir(os.tmpdir())).filter((name) => name.startsWith("xingbuild-content-data-upload-")));
    assert.deepEqual([...after].filter((name) => !before.has(name)), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
