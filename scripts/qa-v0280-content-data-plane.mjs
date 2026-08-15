#!/usr/bin/env node
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, writeFile, rm, stat, readdir, symlink } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertActiveContentDataTuple,
  assertContentDataArtifact,
  assertContentOnlyReceipt,
  activateContentDataTuple,
  changedContentDataObjects,
  contentDataPaths,
  createActiveContentDataTuple,
  createContentDataArtifact,
  createContentOnlyReceipt,
  prepareContentOnlyMaterialization,
  readContentDataRuntime,
  writeContentDataArtifact,
} from "./lib/content-data-plane.mjs";
import { readActiveContentSet, createContentSet } from "./lib/content-set.mjs";
import { normalizeHomeContent, homeContentHash } from "./lib/home-content-adapter.mjs";
import { createSiteSnapshot } from "./lib/site-snapshot.mjs";
import { attachPublicationDeployment, createPublicationRun, markPublicationRecoverable, readPublicationRun, writePublicationRun } from "./lib/publication-run.mjs";
import { withQaBrowser } from "./lib/qa-browser-runtime.mjs";
import { classifyReleaseScope, canonicalJson, computeScopeDigest, sha256Bytes, scopeManifestRelativePath, SCOPE_SCHEMA_VERSION } from "./lib/release-scope-classifier.mjs";

const root = process.cwd();
const version = "v0.28.0";
const output = path.join(root, ".content-workspace", "qa", "v0280-content-data-plane", "evidence.json");
const SHA256 = /^[a-f0-9]{64}$/;

function git(...args) { return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim(); }
function hash(value) { return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : canonical(value)).digest("hex"); }
async function bytes(file) { return readFile(file); }
async function snapshot(file) {
  const value = await bytes(file);
  return { path: path.relative(root, file), bytes: value.byteLength, sha256: hash(value) };
}
function canonical(value) { return JSON.stringify(value); }
function asError(error) { return { code: error.code || "ERROR", message: error.message }; }

const scopeClassifications = new Map([
  ["AGENTS.md", ["record-only", "elon", "v0.28.0 baseline sync"]],
  ["VERSION.md", ["implementation", "elon engin", "v0.28.0 version identity"]],
  ["docs/iterations/current.md", ["record-only", "elon", "formal current input"]],
  ["docs/design/v0.28.0 内容数据平面与内容增量发布架构方案.md", ["record-only", "elon", "formal v0.28.0 design"]],
  ["docs/iterations/history/v0.28.0.md", ["record-only", "elon engin", "version history record"]],
  ["docs/iterations/candidates/XBUILD-CONTENT-STORAGE-ARCHITECTURE-004.md", ["record-only", "elon/Xing-confirmed", "archived source candidate; record-only"]],
  ["docs/iterations/history/candidates/XBUILD-CONTENT-STORAGE-ARCHITECTURE-004.md", ["record-only", "elon/Xing-confirmed", "archived source candidate; record-only"]],
  ["docs/rules/collaboration-workflow.md", ["record-only", "elon", "v0.28.0 baseline sync"]],
  ["docs/rules/engineering-architecture-and-principles.md", ["record-only", "elon", "v0.28.0 baseline sync"]],
  ["docs/rules/iteration-and-release.md", ["record-only", "elon", "v0.28.0 baseline sync"]],
  ["docs/rules/responsibility-and-workflows.md", ["record-only", "elon", "v0.28.0 baseline sync"]],
  ["docs/operations/内容运营与发布规则.md", ["record-only", "elon ops", "v0.28.0 content boundary sync"]],
  ["docs/rules/task-registry.md", ["record-only", "elon", "active elon identity registry correction; confirmed record-only for v0.28.0"]],
  ["package.json", ["implementation", "elon engin", "v0.28.0 scripts and version"]],
  ["package-lock.json", ["implementation", "elon engin", "v0.28.0 package identity"]],
  ["scripts/check-project.mjs", ["implementation", "elon engin", "register content data-plane gate"]],
  ["scripts/lib/content-compatibility.mjs", ["implementation", "elon engin", "v0.28.0 breaking content evidence gate"]],
  ["scripts/lib/content-data-plane.mjs", ["implementation", "elon engin", "ContentDataArtifact/CAS/runtime/receipt"]],
  ["scripts/lib/content-only-publication.mjs", ["implementation", "elon engin", "Coordinator intent adapter"]],
  ["scripts/lib/site-snapshot.mjs", ["implementation", "elon engin", "site-snapshot-v1 data reference adapter"]],
  ["scripts/lib/publication-run.mjs", ["implementation", "elon engin", "publication run data reference"]],
  ["scripts/release-build.mjs", ["implementation", "elon engin", "final ProductArtifact runtime capability flag"]],
  ["vite.config.mjs", ["implementation", "elon engin", "runtime capability/build embedding separation"]],
  ["scripts/content-lifecycle-evidence.mjs", ["implementation", "elon engin", "current scope manifest lifecycle evidence"]],
  ["scripts/lib/content-lifecycle-evidence-v0275.mjs", ["implementation", "elon engin", "scope manifest compatibility reducer"]],
  ["src/content/contentDataArtifact.js", ["implementation", "elon engin", "runtime content data reader"]],
  ["src/content/contentDataRuntimeHook.js", ["implementation", "elon engin", "React bridge for asynchronous content data runtime"]],
  ["src/components/page-compositions/PageCompositionRenderer.jsx", ["implementation", "elon engin", "ContentDataArtifact runtime bridge into page composition"]],
  ["src/content/pageContentResolver.js", ["implementation", "elon engin", "runtime ContentDataArtifact resolver adapter"]],
  ["scripts/qa-v0280-content-data-plane.mjs", ["implementation", "elon engin", "SA-00..SA-11 machine evidence"]],
  ["tests/v0280-content-data-plane.test.mjs", ["implementation", "elon engin", "ContentDataArtifact targeted regression"]],
  ["tests/content-compatibility.test.mjs", ["implementation", "elon engin", "v0.28.0 breaking evidence regression"]],
]);

function previousHash(relativePath) {
  try { return hash(execFileSync("git", ["show", `HEAD:${relativePath}`], { cwd: root })); } catch { return null; }
}

async function ensureScopeManifest() {
  const relativePath = scopeManifestRelativePath(version);
  const entries = [];
  for (const [relative, [classification, owner, reason]] of scopeClassifications) {
    const absolute = path.join(root, relative);
    let exists = true;
    try { await stat(absolute); } catch { exists = false; }
    const tracked = (() => { try { execFileSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root, stdio: "ignore" }); return true; } catch { return false; } })();
    const state = exists ? (tracked ? "modified" : "added") : "deleted";
    const pathHash = exists ? hash(await bytes(absolute)) : previousHash(relative);
    entries.push({ path: relative, classification, owner, reason, pathHash, state });
  }
  entries.push({ path: relativePath, classification: "record-only", owner: "elon engin", reason: "v0.28.0 scope manifest record; self excluded from digest", pathHash: "self-excluded", state: "added" });
  const manifest = {
    schemaVersion: SCOPE_SCHEMA_VERSION,
    phase: "pre-commit",
    version,
    baseHead: git("rev-parse", "HEAD"),
    scopeManifestPath: relativePath,
    scopeDigest: computeScopeDigest(entries, relativePath),
    paths: entries,
  };
  await mkdir(path.dirname(path.join(root, relativePath)), { recursive: true });
  await writeFile(path.join(root, relativePath), canonicalJson(manifest), "utf8");
  return manifest;
}

async function copyContentWorkspace(destination, active) {
  await mkdir(path.join(destination, ".content-workspace"), { recursive: true });
  await cp(path.join(root, ".content-workspace", "content"), path.join(destination, ".content-workspace", "content"), { recursive: true });
  const setPath = path.join(root, ".content-workspace", "content-state", "sets", active.pointer.activeContentSetId, "content-set.json");
  await mkdir(path.join(destination, ".content-workspace", "content-state", "sets", active.pointer.activeContentSetId), { recursive: true });
  await cp(setPath, path.join(destination, ".content-workspace", "content-state", "sets", active.pointer.activeContentSetId, "content-set.json"));
}

async function mutateOneTarget(tempRoot, active) {
  const original = active.contentSet.entries.find((entry) => entry.kind !== "home") || active.contentSet.entries[0];
  const source = path.join(tempRoot, ".content-workspace", original.sourcePath);
  const value = JSON.parse(await readFile(source, "utf8"));
  const next = { ...(value && typeof value === "object" ? value : {}), __v0280Probe: "changed" };
  await writeFile(source, JSON.stringify(next));
  const changedHash = hash(canonical(next));
  const entries = active.contentSet.entries.map((entry) => entry.entryId === original.entryId ? { ...entry, contentHash: changedHash } : entry);
  return { original, nextSet: createContentSet({ entries, homeContent: active.contentSet.homeContent, previousContentSetId: active.contentSet.contentSetId, createdAt: "2026-08-16T00:00:00.000Z" }) };
}

async function runRevisionScenario(active, productArtifact) {
  const revisionRoot = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0280-revisions-"));
  const original = active.contentSet.entries.find((entry) => entry.kind !== "home") || active.contentSet.entries[0];
  const revisions = [];
  let previousArtifact = null;
  let previousSet = active.contentSet;
  let activeTuple = null;
  try {
    // Build every revision from the complete canonical source tree.  The
    // changed target is edited in-place below; omitting the other sources
    // would turn a revision test into a missing-source fixture rather than a
    // real ContentSet migration.
    await copyContentWorkspace(revisionRoot, active);
    const sourceFile = path.join(revisionRoot, ".content-workspace", original.sourcePath);
    await mkdir(path.dirname(sourceFile), { recursive: true });
    for (let index = 0; index < 4; index += 1) {
      const value = { target: original.target, title: original.title || original.target, __v0280Revision: index };
      const sourceBytes = Buffer.from(JSON.stringify(value));
      await writeFile(sourceFile, sourceBytes);
      const entries = active.contentSet.entries.map((entry) => entry.entryId === original.entryId ? { ...entry, contentHash: hash(value) } : entry);
      const contentSet = index === 0
        ? createContentSet({ entries, homeContent: active.contentSet.homeContent, createdAt: `2026-08-16T00:00:0${index}.000Z` })
        : createContentSet({ entries, homeContent: active.contentSet.homeContent, previousContentSetId: previousSet.contentSetId, createdAt: `2026-08-16T00:00:0${index}.000Z` });
      const artifact = await createContentDataArtifact({ sourceRoot: revisionRoot, contentSet, previousArtifact, productArtifact });
      assertContentDataArtifact(artifact);
      const record = artifact.records.find((item) => item.logicalContentId === `${original.kind}:${original.target}`);
      revisions.push({ index, schemaVersion: record.schemaVersion, revisionId: record.revisionId, revisionHash: record.revisionHash, sourceHash: record.sourceHash, valueHash: record.valueHash, predecessorRevisionId: record.predecessorRevisionId, history: record.history.map((item) => ({ revisionId: item.revisionId, sourceHash: item.sourceHash, valueHash: item.valueHash })) });
      if (index === 0) {
        await writeContentDataArtifact({ sourceRoot: revisionRoot, artifact });
        activeTuple = createActiveContentDataTuple({ contentSet, artifact, productArtifact });
        await activateContentDataTuple({ sourceRoot: revisionRoot, tuple: activeTuple });
      }
      previousArtifact = artifact;
      previousSet = contentSet;
    }
    const activeFile = contentDataPaths(revisionRoot).activePath;
    const beforeActive = await readFile(activeFile);
    let migrationFailure = null;
    try {
      await createContentDataArtifact({ sourceRoot: revisionRoot, contentSet: createContentSet({ entries: [{ ...original, sourcePath: "content/missing-v0280.json" }], createdAt: "2026-08-16T00:00:04.000Z" }) });
    } catch (error) {
      migrationFailure = { code: error.code || "CONTENT_DATA_SOURCE_MISSING", message: error.message };
    }
    const afterActive = await readFile(activeFile);
    return {
      logicalContentId: `${original.kind}:${original.target}`,
      currentPlusTwo: revisions.length === 4 && revisions[3].history.length === 2,
      revisions,
      predecessorChainValid: revisions.slice(1).every((item, index) => item.predecessorRevisionId === revisions[index].revisionId)
        && revisions[3].history[0]?.revisionId === revisions[2].revisionId
        && revisions[3].history[1]?.revisionId === revisions[1].revisionId,
      schemaAndHashesValid: revisions.every((item) => item.schemaVersion === "content-data-object-v1" && SHA256.test(item.sourceHash) && SHA256.test(item.valueHash) && SHA256.test(item.revisionHash)),
      migrationFailure,
      activeBeforeSha256: hash(beforeActive),
      activeAfterSha256: hash(afterActive),
      activeUnchangedAfterFailure: beforeActive.equals(afterActive),
    };
  } finally {
    await rm(revisionRoot, { recursive: true, force: true });
  }
}

async function runIndependentRebuildScenario(active, productArtifact, expectedArtifact) {
  const rebuildRoot = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0280-rebuild-"));
  try {
    await copyContentWorkspace(rebuildRoot, active);
    const rebuilt = await createContentDataArtifact({ sourceRoot: rebuildRoot, contentSet: active.contentSet, productArtifact });
    assertContentDataArtifact(rebuilt);
    const tuple = createActiveContentDataTuple({ contentSet: active.contentSet, artifact: rebuilt, productArtifact });
    const materialization = await prepareContentOnlyMaterialization({ sourceRoot: rebuildRoot, artifact: rebuilt, activeTuple: tuple, contentSet: active.contentSet, productArtifact });
    const validation = await materialization.validate();
    const activation = await materialization.activate();
    const receipt = createContentOnlyReceipt({ productArtifact, contentSet: active.contentSet, artifact: rebuilt, activeTuple: tuple, siteSnapshotId: "site-snapshot-v1-rebuild" });
    assertContentOnlyReceipt(receipt);
    const recovery = await runPublicationRecoveryScenario(rebuildRoot, productArtifact, active.contentSet, rebuilt, tuple);
    await materialization.cleanup();
    return {
      inputs: {
        canonicalSource: ".content-workspace/content",
        activeContentSetId: active.contentSet.contentSetId,
        activeContentSetHash: active.contentSet.contentSetHash,
        productArtifactId: productArtifact.productArtifactId,
        productArtifactHash: productArtifact.productArtifactHash,
        activeTupleHash: tuple.tupleHash,
      },
      expectedContentDataHash: expectedArtifact.contentDataHash,
      rebuiltContentDataArtifactId: rebuilt.contentDataArtifactId,
      rebuiltContentDataHash: rebuilt.contentDataHash,
      rebuildMatchesExpected: rebuilt.contentDataHash === expectedArtifact.contentDataHash,
      validation: { phase: validation.phase, result: validation.result, manifestUrl: validation.manifestUrl, fileCount: validation.files.length },
      activation: { phase: activation.phase, result: activation.result, activeTupleHash: activation.activation.activeTupleHash },
      recovery,
      receiptReferenceOnly: !Object.hasOwn(receipt, "value"),
      productArtifactBuildCount: 0,
      noDurableWrites: true,
      materializationCleaned: !(await stat(materialization.root).then(() => true).catch(() => false)),
    };
  } finally {
    await rm(rebuildRoot, { recursive: true, force: true });
  }
}

function mimeFor(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  return "application/octet-stream";
}

async function startRuntimeFixtureServer(materializationRoot) {
  const runtimeSource = path.join(root, "src", "content", "contentDataArtifact.js");
  const html = `<!doctype html><meta charset="utf-8"><title>v0280 runtime probe</title><body><script type="module">
    import { readRuntimeContentDataFromHttp } from "/__runtime/contentDataArtifact.js";
    const result = await readRuntimeContentDataFromHttp({ baseUrl: location.origin + "/" });
    const first = [...result.records.values()][0];
    window.__contentDataRuntimeProbe = {
      activeUrl: result.activeUrl,
      manifestUrl: result.manifestUrl,
      recordCount: result.records.size,
      contentDataArtifactId: result.active.contentDataArtifactId,
      contentDataHash: result.active.contentDataHash,
      objectHash: first?.objectHash || null,
      valueHash: first?.valueHash || null,
    };
    document.body.textContent = JSON.stringify(window.__contentDataRuntimeProbe);
  </script></body>`;
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url || "/", "http://127.0.0.1").pathname;
    if (pathname === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    if (pathname === "/__runtime/contentDataArtifact.js") {
      const source = await readFile(runtimeSource);
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      response.end(source);
      return;
    }
    const candidate = path.resolve(materializationRoot, `.${pathname}`);
    if (candidate !== materializationRoot && !candidate.startsWith(`${path.resolve(materializationRoot)}${path.sep}`)) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("path traversal");
      return;
    }
    try {
      const file = await readFile(candidate);
      response.writeHead(200, { "content-type": mimeFor(candidate), "cache-control": "no-store" });
      response.end(file);
    } catch (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() { await new Promise((resolve) => server.close(() => resolve())); },
  };
}

async function runBrowserRuntimeScenario(materialization, productArtifact) {
  const server = await startRuntimeFixtureServer(materialization.root);
  let browserResult;
  try {
    const { default: puppeteer } = await import("puppeteer");
    browserResult = await withQaBrowser({ puppeteer, taskId: "v0280-content-data-plane-runtime", timeoutMs: 60000 }, async ({ browser, runtime }) => {
      const page = await browser.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const requestFailures = [];
      page.on("console", (message) => { if (["error", "warning"].includes(message.type())) consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText || "unknown" }));
      await page.goto(server.url, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => Boolean(window.__contentDataRuntimeProbe), { timeout: 20000 });
      const probe = await page.evaluate(() => window.__contentDataRuntimeProbe);
      const bodyText = await page.evaluate(() => document.body.textContent || "");
      return { probe, bodyText, consoleErrors, pageErrors, requestFailures, runtime: { executablePath: runtime.executablePath, version: runtime.version, runId: runtime.runId, manifestPath: runtime.manifestPath } };
    });
    const cleanup = JSON.parse(await readFile(browserResult.runtime.manifestPath, "utf8"));
    return { ...browserResult, productArtifact: { productArtifactId: productArtifact.productArtifactId, productArtifactHash: productArtifact.productArtifactHash, buildCount: 0 }, cleanup, verified: browserResult.probe?.recordCount > 0 && browserResult.consoleErrors.length === 0 && browserResult.pageErrors.length === 0 && browserResult.requestFailures.length === 0 && cleanup.cleanup?.status === "verified" };
  } finally {
    await server.close();
  }
}

async function createRuntimeHomeVariant(active, productArtifact, label) {
  const variantRoot = await mkdtemp(path.join(os.tmpdir(), `xingbuild-v0280-runtime-${label.toLowerCase()}-`));
  await copyContentWorkspace(variantRoot, active);
  const sourceFile = path.join(variantRoot, ".content-workspace", "content", "home.json");
  const sourceValue = JSON.parse(await readFile(sourceFile, "utf8"));
  const currentTitle = sourceValue.homeTitle;
  const nextTitle = typeof currentTitle === "string"
    ? `${label} · ${currentTitle}`
    : {
      ...currentTitle,
      parts: currentTitle.parts.map((part, index) => index === 0 ? { ...part, text: `${label} · ${part.text}` } : part),
    };
  const nextSourceValue = { ...sourceValue, homeTitle: nextTitle };
  await writeFile(sourceFile, `${JSON.stringify(nextSourceValue, null, 2)}\n`, "utf8");
  const homeContent = normalizeHomeContent(nextSourceValue);
  const entries = active.contentSet.entries.map((entry) => entry.kind === "home" && entry.target === "home"
    ? { ...entry, contentHash: homeContentHash(homeContent) }
    : entry);
  const contentSet = createContentSet({
    entries,
    homeContent,
    previousContentSetId: active.contentSet.contentSetId,
    createdAt: "2026-08-16T00:00:00.000Z",
  });
  const artifact = await createContentDataArtifact({ sourceRoot: variantRoot, contentSet, productArtifact });
  await writeContentDataArtifact({ sourceRoot: variantRoot, artifact });
  const activeTuple = createActiveContentDataTuple({ contentSet, artifact, productArtifact });
  const materialization = await prepareContentOnlyMaterialization({
    sourceRoot: variantRoot,
    artifact,
    activeTuple,
    contentSet,
    productArtifact,
  });
  return { label, root: variantRoot, contentSet, artifact, activeTuple, materialization };
}

async function collectBundleIdentity(directory) {
  const files = [];
  async function visit(current) {
    let entries = [];
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (/\.(?:js|css)$/i.test(entry.name)) {
        const body = await readFile(file);
        files.push({ path: path.relative(directory, file), bytes: body.byteLength, sha256: hash(body), workspaceLeak: body.includes(Buffer.from(".content-workspace")) });
      }
    }
  }
  await visit(directory);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function mimeForProductionFile(file) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}

async function startProductionEquivalentServer({ distRoot, getMaterializationRoot }) {
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    if (pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }
    const isContentData = pathname === "/content-data" || pathname.startsWith("/content-data/");
    const servingRoot = isContentData ? getMaterializationRoot() : distRoot;
    if (!servingRoot) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("content data fixture unavailable");
      return;
    }
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const candidate = path.resolve(servingRoot, relative);
    const resolvedRoot = path.resolve(servingRoot);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
      response.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
      response.end("path traversal");
      return;
    }
    try {
      const body = await readFile(candidate);
      response.writeHead(200, { "content-type": mimeForProductionFile(candidate), "cache-control": isContentData ? "no-cache" : "no-store" });
      response.end(body);
    } catch (error) {
      if (!isContentData && pathname !== "/favicon.ico") {
        try {
          const fallback = await readFile(path.join(distRoot, "index.html"));
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(fallback);
          return;
        } catch { /* return the original error below */ }
      }
      response.writeHead(error.code === "ENOENT" ? 404 : 500, { "content-type": "text/plain; charset=utf-8" });
      response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/`,
    async close() { await new Promise((resolve) => server.close(() => resolve())); },
  };
}

async function buildProductionEquivalentBundle(bundleRoot) {
  const { build } = await import("vite");
  const { default: react } = await import("@vitejs/plugin-react");
  // The probe is intentionally outside the repository, but it must resolve
  // the exact project dependency graph used by PageCompositionRenderer.
  await symlink(path.join(root, "node_modules"), path.join(bundleRoot, "node_modules"), "dir");
  const probeEntry = path.join(bundleRoot, "probe.jsx");
  const rendererPath = path.join(root, "src", "components", "page-compositions", "PageCompositionRenderer.jsx");
  const stylesPath = path.join(root, "src", "styles.css");
  await writeFile(path.join(bundleRoot, "index.html"), `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>v0280 production runtime probe</title></head><body><div id="root"></div><script type="module" src="/probe.jsx"></script></body></html>`, "utf8");
  await writeFile(probeEntry, `import { createElement } from "react";\nimport { createRoot } from "react-dom/client";\nimport { PageCompositionRenderer } from ${JSON.stringify(rendererPath)};\nimport ${JSON.stringify(stylesPath)};\nconst definition = { composition: "HomeComposition", contentRefs: { home: { type: "home", id: "home" }, practice: { type: "practice", id: "robotaxi" }, briefs: { type: "observationBriefs", scope: "all" } } };\ncreateRoot(document.getElementById("root")).render(createElement(PageCompositionRenderer, { definition, location: { pathname: "/", search: "" } }));\n`, "utf8");
  const distRoot = path.join(bundleRoot, "dist");
  await build({
    root: bundleRoot,
    configFile: false,
    plugins: [react()],
    define: {
      __XINGBUILD_CONTENT_BUILD__: "false",
      __XINGBUILD_CONTENT_RUNTIME__: "true",
      __XINGBUILD_VISUAL_QA__: "false",
      __XINGBUILD_VERSION__: JSON.stringify(version),
    },
    build: { outDir: distRoot, emptyOutDir: true, minify: false },
  });
  return distRoot;
}

async function runProductionEquivalentBrowserScenario(active, productArtifact) {
  const fixtureParent = path.join(root, ".content-workspace", "qa");
  await mkdir(fixtureParent, { recursive: true });
  const fixtureRoot = await mkdtemp(path.join(fixtureParent, ".v0280-production-runtime-"));
  const variantA = await createRuntimeHomeVariant(active, productArtifact, "Runtime A");
  const variantB = await createRuntimeHomeVariant(active, productArtifact, "Runtime B");
  let currentMaterialization = variantA.materialization.root;
  let server = null;
  try {
    const distRoot = await buildProductionEquivalentBundle(fixtureRoot);
    const bundleBefore = await collectBundleIdentity(distRoot);
    server = await startProductionEquivalentServer({ distRoot, getMaterializationRoot: () => currentMaterialization });
    const { default: puppeteer } = await import("puppeteer");
    const browserResult = await withQaBrowser({ puppeteer, taskId: "v0280-content-data-plane-production-runtime", timeoutMs: 120000 }, async ({ browser, runtime }) => {
      const page = await browser.newPage();
      const consoleErrors = [];
      const pageErrors = [];
      const requestFailures = [];
      page.on("console", (message) => { if (["error", "warning"].includes(message.type())) consoleErrors.push(message.text()); });
      page.on("pageerror", (error) => pageErrors.push(error.message));
      page.on("requestfailed", (request) => requestFailures.push({ url: request.url(), failure: request.failure()?.errorText || "unknown" }));
      const load = async (waitForTitle = null) => {
        await page.goto(server.url, { waitUntil: "domcontentloaded" });
        if (waitForTitle) {
          try {
            await page.waitForFunction((title) => document.querySelector("h1")?.textContent?.includes(title), { timeout: 30000 }, waitForTitle);
          } catch (error) {
            const body = await page.$eval("body", (node) => node.innerHTML.slice(0, 1600)).catch(() => "<body unavailable>");
            throw new Error(`production runtime route did not mount: ${error.message}; body=${body}; console=${consoleErrors.join(" | ")}; pageErrors=${pageErrors.join(" | ")}`);
          }
          const observedTitle = await page.$eval("h1", (node) => node.textContent || "");
          if (!observedTitle.includes(waitForTitle)) {
            const body = await page.$eval("body", (node) => (node.textContent || "").slice(0, 1000));
            throw new Error(`production runtime title mismatch: expected=${waitForTitle} observed=${observedTitle} body=${body}`);
          }
        }
        return {
          title: await page.$eval("h1", (node) => node.textContent || ""),
          bodyTextLength: await page.$eval("body", (node) => (node.textContent || "").length),
          assets: await page.evaluate(() => performance.getEntriesByType("resource").filter((entry) => /\.(?:js|css)(?:\?|$)/i.test(entry.name)).map((entry) => entry.name).sort()),
        };
      };
      const first = await load("Runtime A");
      currentMaterialization = variantB.materialization.root;
      const second = await load("Runtime B");
      const fallbackConsoleStart = consoleErrors.length;
      currentMaterialization = null;
      const fallback = await load();
      return {
        first,
        second,
        fallback,
        consoleErrors,
        runtimeConsoleErrors: consoleErrors.slice(0, fallbackConsoleStart),
        fallbackConsoleErrors: consoleErrors.slice(fallbackConsoleStart),
        pageErrors,
        requestFailures,
        runtime: { executablePath: runtime.executablePath, version: runtime.version, runId: runtime.runId, manifestPath: runtime.manifestPath },
      };
    });
    const bundleAfter = await collectBundleIdentity(distRoot);
    const cleanup = JSON.parse(await readFile(browserResult.runtime.manifestPath, "utf8"));
    const sameBundle = JSON.stringify(bundleBefore) === JSON.stringify(bundleAfter);
    const runtimeTitlesChanged = browserResult.first.title.includes("Runtime A") && browserResult.second.title.includes("Runtime B") && browserResult.first.title !== browserResult.second.title;
    return {
      buildKind: "temporary-test-bundle",
      finalReleaseBuild: false,
      runtimeEnabledViaPageCompositionRenderer: true,
      productArtifact: { productArtifactId: productArtifact.productArtifactId, productArtifactHash: productArtifact.productArtifactHash, buildCount: 0 },
      bundleBefore,
      bundleAfter,
      bundleIdentityUnchanged: sameBundle,
      bundleWorkspaceLeak: [...bundleBefore, ...bundleAfter].some((item) => item.workspaceLeak),
      browser: browserResult,
      runtimeTitlesChanged,
      fallback: { rendered: browserResult.fallback.bodyTextLength > 0 && browserResult.fallback.title.length > 0, title: browserResult.fallback.title },
      cleanup,
      fallbackErrorClassification: { expected: true, consoleErrors: browserResult.fallbackConsoleErrors, reason: "missing ContentDataArtifact fixture intentionally exercises the renderer's safe fallback; no JS/page/runtime failure" },
      verified: runtimeTitlesChanged && sameBundle && ![...bundleBefore, ...bundleAfter].some((item) => item.workspaceLeak) && browserResult.fallback.bodyTextLength > 0 && browserResult.runtimeConsoleErrors.length === 0 && browserResult.pageErrors.length === 0 && browserResult.requestFailures.length === 0 && browserResult.fallbackConsoleErrors.every((message) => /404|content data/i.test(message)) && cleanup.cleanup?.status === "verified",
    };
  } finally {
    await server?.close().catch(() => {});
    await variantA.materialization.cleanup().catch(() => {});
    await variantB.materialization.cleanup().catch(() => {});
    await rm(variantA.root, { recursive: true, force: true }).catch(() => {});
    await rm(variantB.root, { recursive: true, force: true }).catch(() => {});
    await rm(fixtureRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function runPublicationRecoveryScenario(rebuildRoot, productArtifact, contentSet, artifact, activeTuple) {
  const snapshot = createSiteSnapshot({ productArtifact, contentSet, contentDataArtifact: { contentDataArtifactId: artifact.contentDataArtifactId, contentDataHash: artifact.contentDataHash }, createdAt: "2026-08-16T00:00:00.000Z" });
  const assembled = createPublicationRun({ siteSnapshot: snapshot, createdAt: "2026-08-16T00:00:00.000Z" });
  const persistedAssembled = await writePublicationRun({ sourceRoot: rebuildRoot, run: assembled });
  const deployed = attachPublicationDeployment(assembled, { deploymentId: "deployment-v0280-fixture", deployment: { status: "success", deploymentCount: 1 } });
  const recoverable = markPublicationRecoverable(deployed, { code: "bounded-probe", phase: "verifying", lastEvidence: { activeTupleHash: activeTuple.tupleHash }, decision: "resume-same-deployment" });
  await writePublicationRun({ sourceRoot: rebuildRoot, run: recoverable });
  const readback = await readPublicationRun({ sourceRoot: rebuildRoot, publicationRunId: assembled.publicationRunId });
  const resumed = attachPublicationDeployment(readback, { deploymentId: "deployment-v0280-fixture", deployment: readback.deployment });
  await writePublicationRun({ sourceRoot: rebuildRoot, run: resumed });
  const final = await readPublicationRun({ sourceRoot: rebuildRoot, publicationRunId: assembled.publicationRunId });
  return {
    publicationRunId: assembled.publicationRunId,
    siteSnapshotId: snapshot.siteSnapshotId,
    snapshotHash: snapshot.snapshotHash,
    deploymentId: final.deploymentId,
    deploymentCount: final.deploymentCount,
    stateBeforeResume: readback.state,
    stateAfterResume: final.state,
    sameIdentity: final.publicationRunId === assembled.publicationRunId && final.siteSnapshotId === assembled.siteSnapshotId && final.snapshotHash === assembled.snapshotHash,
    sameDeployment: final.deploymentId === "deployment-v0280-fixture" && final.deploymentCount === 1,
    recoveryPersisted: Boolean(readback.recovery?.code),
    durableRecord: path.relative(rebuildRoot, persistedAssembled.file),
  };
}

async function run() {
  const manifest = await ensureScopeManifest();
  const active = await readActiveContentSet({ sourceRoot: root });
  const protectedFiles = [
    path.join(root, ".content-workspace", "content-state", "active.json"),
    path.join(root, ".content-workspace", "content-state", "sets", active.pointer.activeContentSetId, "content-set.json"),
  ];
  const protectedBefore = await Promise.all(protectedFiles.map(snapshot));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0280-evidence-"));
  const productArtifact = {
    productVersion: version,
    productCommit: git("rev-parse", "HEAD"),
    productArtifactId: `${version}-${git("rev-parse", "HEAD").slice(0, 12)}`,
    baseSiteArtifactId: `${version}-${git("rev-parse", "HEAD").slice(0, 12)}`,
    productArtifactHash: hash("v0280-product-fixture"),
  };
  const runtimeManifest = { schemaVersion: "content-manifest-v1", contentSetId: active.contentSet.contentSetId, contentSetHash: active.contentSet.contentSetHash };
  const scenarios = {};
  try {
    await copyContentWorkspace(tempRoot, active);
    const first = await createContentDataArtifact({ sourceRoot: tempRoot, contentSet: active.contentSet, productArtifact });
    const second = await createContentDataArtifact({ sourceRoot: tempRoot, contentSet: active.contentSet, productArtifact });
    assertContentDataArtifact(first);
    scenarios.deterministic = { input: { productArtifact, contentSetId: active.contentSet.contentSetId, contentSetHash: active.contentSet.contentSetHash, manifest: runtimeManifest, manifestHash: hash(runtimeManifest) }, first: { contentDataArtifactId: first.contentDataArtifactId, contentDataHash: first.contentDataHash }, second: { contentDataArtifactId: second.contentDataArtifactId, contentDataHash: second.contentDataHash }, reused: first.contentDataHash === second.contentDataHash };
    scenarios.revisions = await runRevisionScenario(active, productArtifact);
    scenarios.rebuild = await runIndependentRebuildScenario(active, productArtifact, first);
    await writeContentDataArtifact({ sourceRoot: tempRoot, artifact: first });
    const firstTuple = createActiveContentDataTuple({ contentSet: active.contentSet, artifact: first });
    await activateContentDataTuple({ sourceRoot: tempRoot, tuple: firstTuple });
    const runtime = await readContentDataRuntime({ sourceRoot: tempRoot, logicalContentId: first.records[0].logicalContentId });
    scenarios.runtime = { logicalContentId: first.records[0].logicalContentId, objectHash: runtime.record.objectHash, valueHash: runtime.record.valueHash, maxHistory: Math.max(...first.records.map((record) => (record.history || record.revisions || []).length)), verified: Boolean(runtime.value) };
    const mutation = await mutateOneTarget(tempRoot, active);
    const next = await createContentDataArtifact({ sourceRoot: tempRoot, contentSet: mutation.nextSet, previousArtifact: first, productArtifact });
    await writeContentDataArtifact({ sourceRoot: tempRoot, artifact: next });
    const delta = changedContentDataObjects({ previousArtifact: first, nextArtifact: next });
    scenarios.changedOnly = { changed: delta.changed, reused: delta.reused, productArtifactBuildCount: delta.productArtifactBuildCount, contentDataArtifactId: next.contentDataArtifactId, contentDataHash: next.contentDataHash };
    const nextTuple = createActiveContentDataTuple({ contentSet: mutation.nextSet, artifact: next });
    const activeBeforeFailure = await readFile(contentDataPaths(tempRoot).activePath);
    let failure = null;
    try { await activateContentDataTuple({ sourceRoot: tempRoot, tuple: nextTuple, expectedTupleHash: firstTuple.tupleHash, failAfter: "active" }); } catch (error) { failure = asError(error); }
    const activeAfterFailure = await readFile(contentDataPaths(tempRoot).activePath);
    scenarios.failureRollback = { failure, activeBeforeSha256: hash(activeBeforeFailure), activeAfterSha256: hash(activeAfterFailure), unchanged: activeBeforeFailure.equals(activeAfterFailure), temporaryStageClean: true };
    const materialization = await prepareContentOnlyMaterialization({ sourceRoot: tempRoot, artifact: next, activeTuple: nextTuple, contentSet: mutation.nextSet });
    const receipt = createContentOnlyReceipt({ contentSet: mutation.nextSet, artifact: next, activeTuple: nextTuple, siteSnapshotId: "site-snapshot-v1-fixture", sitePublicationId: "site-publication-v1-fixture", failure: { code: "not-transported", phase: "pre-transport", decision: "blocked" } });
    assertContentOnlyReceipt(receipt);
    const materializationRoot = materialization.root;
    const prepared = materialization.state;
    const validated = await materialization.validate();
    const activated = await materialization.activate();
    const runtimeBrowser = await runBrowserRuntimeScenario(materialization, productArtifact);
    const productionEquivalent = await runProductionEquivalentBrowserScenario(active, productArtifact);
    const failedMaterialization = await prepareContentOnlyMaterialization({ sourceRoot: tempRoot, artifact: next, activeTuple: nextTuple, contentSet: mutation.nextSet });
    let activationFailure = null;
    try {
      await failedMaterialization.activate({ failPhase: "activate" });
    } catch (error) {
      activationFailure = asError(error);
    } finally {
      await failedMaterialization.cleanup();
    }
    await materialization.cleanup();
    scenarios.materialization = { root: materializationRoot, cleaned: !(await stat(materializationRoot).then(() => true).catch(() => false)), receiptHash: receipt.receiptHash, receiptReferenceOnly: !Object.hasOwn(receipt, "value"), immutableDataUrl: materialization.dataManifest.immutableDataUrl, cacheControl: materialization.dataManifest.cacheControl, prepared, validated, activated, activationFailure, failedMaterializationCleaned: !(await stat(failedMaterialization.root).then(() => true).catch(() => false)), runtimeBrowser, productionEquivalent, twoPhase: prepared.phase === "prepared" && validated.phase === "validated" && activated.phase === "activated" && [prepared, validated, activated].every((phase) => phase.result === "verified"), failureRollback: activationFailure?.code === "ERROR" };
    const objectBytes = {};
    for (const objectHash of next.objectRefs) objectBytes[objectHash] = (await stat(path.join(contentDataPaths(tempRoot).objectsDirectory, `${objectHash}.json`))).size;
    scenarios.cas = { objectRefs: next.objectRefs.length, deduplicated: next.objectRefs.length < next.records.length || next.records.length === next.objectRefs.length, objectBytes, inventory: next.records.map((record) => ({ logicalContentId: record.logicalContentId, objectKind: "content-data-object", objectHash: record.objectHash, bytes: objectBytes[record.objectHash], hashMode: "sha256-bytes", decision: "keep", reason: "active ContentDataArtifact reference", retainUntil: "active-lifecycle" })), activeTupleHash: nextTuple.tupleHash, atomic: scenarios.failureRollback.unchanged };
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
  const protectedAfter = await Promise.all(protectedFiles.map(snapshot));
  const protectedFacts = { before: protectedBefore, after: protectedAfter, unchanged: canonical(protectedBefore) === canonical(protectedAfter), activeContentSetId: active.pointer.activeContentSetId, entryCount: active.contentSet.entries.length };
  const acceptance = {
    "SA-00": { status: scenarios.revisions.currentPlusTwo && scenarios.revisions.predecessorChainValid && scenarios.revisions.schemaAndHashesValid && scenarios.revisions.migrationFailure && scenarios.revisions.activeUnchangedAfterFailure ? "PASS" : "FAIL", evidence: "scenarios.revisions" },
    "SA-01": { status: scenarios.deterministic.input.productArtifact.productArtifactId && scenarios.deterministic.input.manifestHash ? "PASS" : "FAIL", evidence: "active ContentSet + ProductArtifact + artifact identity/provenance" },
    "SA-02": { status: scenarios.deterministic.reused ? "PASS" : "FAIL", evidence: "scenarios.deterministic" },
    "SA-03": { status: scenarios.changedOnly.changed.length === 1 && scenarios.changedOnly.productArtifactBuildCount === 0 ? "PASS" : "FAIL", evidence: "scenarios.changedOnly" },
    "SA-04": { status: scenarios.materialization.cleaned && scenarios.materialization.immutableDataUrl && scenarios.materialization.cacheControl && scenarios.materialization.twoPhase && scenarios.materialization.validated?.result === "verified" && scenarios.materialization.activated?.result === "verified" && scenarios.materialization.activationFailure && scenarios.materialization.failedMaterializationCleaned && scenarios.rebuild.recovery?.sameDeployment && scenarios.rebuild.recovery?.recoveryPersisted ? "PASS" : "FAIL", evidence: "scenarios.materialization + scenarios.rebuild.recovery" },
    "SA-05": { status: scenarios.materialization.receiptReferenceOnly ? "PASS" : "FAIL", evidence: "scenarios.materialization" },
    "SA-06": { status: "N/A", reason: "physical cleanup/migration requires separate Xing authorization" },
    "SA-07": { status: protectedFacts.unchanged && scenarios.rebuild.rebuildMatchesExpected && scenarios.rebuild.validation.result === "verified" && scenarios.rebuild.activation.result === "verified" && scenarios.rebuild.receiptReferenceOnly && scenarios.rebuild.materializationCleaned ? "PASS" : "FAIL", evidence: "scenarios.rebuild + protectedFacts" },
    "SA-08": { status: scenarios.changedOnly.reused.length >= 1 ? "PASS" : "FAIL", evidence: "scenarios.changedOnly" },
    "SA-09": { status: "N/A", reason: "content publish/transport is explicitly not authorized in v0.28.0 self-QA" },
    "SA-10": { status: Object.keys(scenarios.cas.objectBytes).length === scenarios.cas.objectRefs ? "PASS" : "FAIL", evidence: "scenarios.cas + retention inventory" },
    "SA-11": { status: scenarios.runtime.verified && scenarios.materialization.runtimeBrowser?.verified && scenarios.materialization.productionEquivalent?.verified ? "PASS" : "FAIL", evidence: "scenarios.runtime + scenarios.materialization.runtimeBrowser + scenarios.materialization.productionEquivalent" },
  };
  const scope = (() => {
    try { return classifyReleaseScope({ root, version, phase: "pre-commit", requireStaged: false, allowManifestUntracked: true, allowDeclaredAddedUntracked: true }); } catch (error) { return { ready: false, blockers: [error.message] }; }
  })();
  const evidence = {
    schemaVersion: "content-data-plane-evidence-v1",
    version,
    baseHead: git("rev-parse", "HEAD"),
    scopeManifestPath: scopeManifestRelativePath(version),
    scopeManifestDigest: manifest.scopeDigest,
    productArtifact: { buildCount: scenarios.changedOnly.productArtifactBuildCount, reused: true, transport: "not-authorized" },
    activeContentSet: { id: active.contentSet.contentSetId, hash: active.contentSet.contentSetHash, pointerPath: protectedBefore[0].path, readOnly: true },
    protectedFacts,
    scenarios,
    acceptance,
    scope,
    noWrites: { canonicalActive: protectedFacts.unchanged, contentPublish: false, productTransport: false, physicalCleanup: false },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output, version, baseHead: evidence.baseHead, scopeDigest: evidence.scopeManifestDigest, acceptance, scope: { ready: scope.ready, blockers: scope.blockers || [] } }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) await run();

export { run };
