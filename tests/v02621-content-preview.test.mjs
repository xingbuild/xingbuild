import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createContentPreviewRevisionState,
  readContentPreviewSourceState,
  reduceContentPreviewTargetUpdate,
  resolveContentPreviewTarget,
  resolveContentPreviewTargetImpact,
} from "../scripts/lib/content-preview.mjs";
import { resolveContentTarget } from "../scripts/lib/content-targets.mjs";
import { projectRoot } from "../scripts/lib/content-root.mjs";

test("TargetImpact follows registered projection routes and validates page content references", async () => {
  const intro = await resolveContentTarget("products.robotaxi.intro");
  const introImpact = resolveContentPreviewTargetImpact(intro);
  assert.deepEqual(introImpact.consumerRoutes, ["/", "/products"]);
  assert.deepEqual(introImpact.consumerViews.map((view) => `${view.route}:${view.viewport}`), [
    "/:web-1280", "/:mobile-390", "/products:web-1280", "/products:mobile-390",
  ]);

  const why = await resolveContentTarget("products.robotaxi.why.eyebrow");
  assert.deepEqual(resolveContentPreviewTargetImpact(why).consumerRoutes, ["/products"]);

  const home = await resolveContentTarget("site.home.homeTitle");
  assert.deepEqual(resolveContentPreviewTargetImpact(home).consumerRoutes, ["/"]);
});

test("content target update reducer refreshes only selected consumers and preserves last valid state on invalid input", () => {
  const initial = createContentPreviewRevisionState({ sourceHash: "source-a", valueHash: "value-a" });
  const valid = reduceContentPreviewTargetUpdate({
    state: initial,
    targetId: "products.robotaxi.intro",
    consumerRoutes: ["/", "/products"],
    sourceState: { sourceHash: "source-b", valueHash: "value-b", currentValue: "updated" },
    now: "2026-08-13T01:00:00.000Z",
  });
  assert.equal(valid.event.status, "valid");
  assert.equal(valid.event.sessionStatus, "valid-updated");
  assert.equal(valid.event.refresh, true);
  assert.equal(valid.state.revision, 1);
  assert.deepEqual(valid.event.consumerRoutes, ["/", "/products"]);

  const outside = reduceContentPreviewTargetUpdate({
    state: valid.state,
    targetId: "products.robotaxi.intro",
    consumerRoutes: ["/", "/products"],
    now: "2026-08-13T01:01:00.000Z",
  });
  assert.equal(outside.event.status, "outside-selected-target");
  assert.equal(outside.event.refresh, false);
  assert.equal(outside.state.revision, 1);

  const sameTargetOutside = reduceContentPreviewTargetUpdate({
    state: valid.state,
    targetId: "products.robotaxi.intro",
    consumerRoutes: ["/", "/products"],
    sourceState: { sourceHash: "source-c", valueHash: "value-b", currentValue: "updated" },
    now: "2026-08-13T01:01:30.000Z",
  });
  assert.equal(sameTargetOutside.event.status, "outside-selected-target");
  assert.equal(sameTargetOutside.event.refresh, false);
  assert.equal(sameTargetOutside.state.revision, 1);

  const invalid = reduceContentPreviewTargetUpdate({
    state: valid.state,
    targetId: "products.robotaxi.intro",
    consumerRoutes: ["/", "/products"],
    error: Object.assign(new Error("invalid responsive slot"), { code: "CONTENT_PREVIEW_VALUE_INVALID" }),
    now: "2026-08-13T01:02:00.000Z",
  });
  assert.equal(invalid.event.status, "invalid");
  assert.equal(invalid.event.refresh, false);
  assert.equal(invalid.state.lastValidValueHash, "value-b");
  assert.equal(invalid.state.revision, 1);

  const restored = reduceContentPreviewTargetUpdate({
    state: invalid.state,
    targetId: "products.robotaxi.intro",
    consumerRoutes: ["/", "/products"],
    sourceState: { sourceHash: "source-b", valueHash: "value-b", currentValue: "updated" },
    now: "2026-08-13T01:03:00.000Z",
  });
  assert.equal(restored.event.status, "valid");
  assert.equal(restored.event.sessionStatus, "valid-updated");
  assert.equal(restored.event.refresh, false);
  assert.equal(restored.state.lastError, null);
});

test("preview implementation has no global full reload and exposes the local-only event contract", async () => {
  const viteConfig = await readFile(path.join(projectRoot, "vite.config.mjs"), "utf8");
  assert.match(viteConfig, /xingbuild:content-target-update/);
  assert.match(viteConfig, /consumerRoutes/);
  assert.match(viteConfig, /return \[\]/);
  assert.doesNotMatch(viteConfig, /server\.ws\.send\(\{\s*type:\s*["']full-reload/);
});

test("workbench renders every consumer route frame and local event status surface", async () => {
  const previous = { ...process.env };
  let handler;
  try {
    Object.assign(process.env, {
      XINGBUILD_PREVIEW_MODE: "content-preview",
      XINGBUILD_CONTENT_PREVIEW_TARGET_ID: "products.robotaxi.intro",
      XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH: "/workspace/.content-workspace/content/products/robotaxi.json",
      XINGBUILD_CONTENT_PREVIEW_FIELD_PATH: "intro",
      XINGBUILD_CONTENT_PREVIEW_CONSUMER_ROUTES: JSON.stringify(["/", "/products"]),
      XINGBUILD_CONTENT_PREVIEW_CONSUMER_VIEWS: JSON.stringify([
        { route: "/", viewport: "web-1280" },
        { route: "/", viewport: "mobile-390" },
        { route: "/products", viewport: "web-1280" },
        { route: "/products", viewport: "mobile-390" },
      ]),
      XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH: "source",
      XINGBUILD_CONTENT_PREVIEW_VALUE_HASH: "value",
      XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS: JSON.stringify(["home.productHero.intro", "products.productHero.intro"]),
      XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE: JSON.stringify({ activeContentSetId: "content-set-test", contentSetHash: "hash" }),
    });
    const { contentPreviewWorkbench } = await import("../vite.config.mjs");
    contentPreviewWorkbench().configureServer({ middlewares: { use(_path, callback) { handler = callback; } } });
    const chunks = [];
    const response = {
      statusCode: 0,
      setHeader() {},
      end(value = "") { chunks.push(String(value)); },
    };
    await handler({ method: "GET", url: "/?target-id=products.robotaxi.intro" }, response, () => {});
    const html = chunks.join("");
    assert.equal((html.match(/data-preview-frame data-route/g) || []).length, 4);
    assert.match(html, /data-route="\/"/);
    assert.match(html, /data-route="\/products"/);
    assert.match(html, /xingbuild:content-target-update/);
    assert.match(html, /data-preview-status/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) process.env[key] = value;
  }
});

test("content-preview HMR emits a custom target event and never a full reload", async () => {
  const previous = { ...process.env };
  try {
    const context = await resolveContentPreviewTarget("products.robotaxi.intro");
    Object.assign(process.env, {
      XINGBUILD_PREVIEW_MODE: "content-preview",
      XINGBUILD_CONTENT_PREVIEW_TARGET_ID: context.targetId,
      XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH: context.sourcePath,
      XINGBUILD_CONTENT_PREVIEW_FIELD_PATH: context.fieldPath,
      XINGBUILD_CONTENT_PREVIEW_VALUE_TYPE: context.valueType,
      XINGBUILD_CONTENT_PREVIEW_MAX_LENGTH: String(context.constraints.maxLength),
      XINGBUILD_CONTENT_PREVIEW_CONSUMER_ROUTES: JSON.stringify(context.consumerRoutes),
      XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH: context.sourceHash,
      XINGBUILD_CONTENT_PREVIEW_VALUE_HASH: context.valueHash,
      XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS: JSON.stringify(context.projectionKeys),
    });
    const { contentPreviewHmr } = await import("../vite.config.mjs");
    const sent = [];
    const plugin = contentPreviewHmr();
    await plugin.handleHotUpdate({
      file: context.sourcePath,
      server: { ws: { send(message) { sent.push(message); } } },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, "custom");
    assert.equal(sent[0].event, "xingbuild:content-target-update");
    assert.deepEqual(sent[0].data.consumerRoutes, ["/", "/products"]);
    assert.doesNotMatch(JSON.stringify(sent), /full-reload/);
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
    for (const [key, value] of Object.entries(previous)) process.env[key] = value;
  }
});

test("source edit, invalid write, and exact-byte restore remain outside active ContentSet state", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xingbuild-v02621-preview-"));
  const source = path.join(directory, "home.json");
  const original = JSON.stringify({ homeTitle: "原始定位" }, null, 2) + "\n";
  try {
    await writeFile(source, original);
    const before = await readContentPreviewSourceState({ sourcePath: source, fieldPath: "homeTitle", valueType: "string" });
    await writeFile(source, JSON.stringify({ homeTitle: "更新定位" }, null, 2) + "\n");
    const updated = await readContentPreviewSourceState({ sourcePath: source, fieldPath: "homeTitle", valueType: "string" });
    assert.notEqual(updated.valueHash, before.valueHash);
    await writeFile(source, "{ invalid\n");
    await assert.rejects(
      () => readContentPreviewSourceState({ sourcePath: source, fieldPath: "homeTitle", valueType: "string" }),
      (error) => error.code === "CONTENT_PREVIEW_SOURCE_INVALID_JSON",
    );
    await writeFile(source, original);
    const restored = await readContentPreviewSourceState({ sourcePath: source, fieldPath: "homeTitle", valueType: "string" });
    assert.equal(await readFile(source, "utf8"), original);
    assert.equal(restored.sourceHash, before.sourceHash);
    assert.equal(restored.valueHash, before.valueHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
