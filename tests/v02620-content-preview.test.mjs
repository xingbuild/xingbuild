import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectRoot } from "../scripts/lib/content-root.mjs";
import { createContentSet } from "../scripts/lib/content-set.mjs";
import {
  CONTENT_PREVIEW_MODE,
  readContentPreviewBaseline,
  resolveContentPreviewTarget,
  sessionEnvironment,
  sessionOutput,
} from "../scripts/lib/content-preview.mjs";
import { isPreviewRecordFor, previewPort } from "../scripts/preview-runtime.mjs";

async function fileSnapshot(file) {
  return readFile(file, "utf8");
}

test("content preview resolves a registered responsive target and only reads the active baseline", async () => {
  const activePointer = path.join(projectRoot, ".content-workspace/content-state/active.json");
  const activeSet = path.join(projectRoot, ".content-workspace/content-state/sets");
  const beforePointer = await fileSnapshot(activePointer);
  const context = await resolveContentPreviewTarget("products.robotaxi.intro");
  const afterPointer = await fileSnapshot(activePointer);

  assert.equal(context.mode, CONTENT_PREVIEW_MODE);
  assert.equal(context.readOnly, true);
  assert.equal(context.valueType, "responsive-text-slot-v1");
  assert.deepEqual(context.projectionRoutes, ["/", "/products"]);
  assert.deepEqual(context.consumerRoutes, ["/", "/products"]);
  assert.equal(context.consumerViews.length, 4);
  assert.deepEqual(context.projectionKeys, ["home.productHero.intro", "products.productHero.intro"]);
  assert.match(context.sourcePath, /\.content-workspace\/content\/products\/robotaxi\.json$/);
  assert.equal(path.isAbsolute(context.sourcePath), true);
  assert.equal(beforePointer, afterPointer);
  assert.ok(context.activeBaseline.activeContentSetId);
  assert.match(context.activeBaseline.contentSetHash, /^[a-f0-9]{64}$/);
  assert.ok(activeSet.endsWith("sets"));
});

test("content preview fails before starting for unknown sources and resolves the materialized home source", async () => {
  await assert.rejects(
    () => resolveContentPreviewTarget("products.robotaxi.not-registered"),
    /content target is not registered|outside the approved field scope/,
  );
  const homeContext = await resolveContentPreviewTarget("site.home.homeTitle");
  assert.deepEqual(homeContext.consumerRoutes, ["/"]);
  assert.equal(homeContext.consumerViews.length, 2);
});

test("content preview rejects invalid JSON before the server starts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "xingbuild-content-preview-"));
  try {
    const registry = await readFile(path.join(projectRoot, "content/registry/content-targets.json"), "utf8");
    const contentSet = createContentSet({ entries: [], migration: { source: "preview-test" }, createdAt: "2026-08-13T00:00:00.000Z" });
    await mkdir(path.join(root, "content/registry"), { recursive: true });
    await mkdir(path.join(root, ".content-workspace/content/products"), { recursive: true });
    await mkdir(path.join(root, ".content-workspace/content-state/sets", contentSet.contentSetId), { recursive: true });
    await writeFile(path.join(root, "content/registry/content-targets.json"), registry);
    await writeFile(path.join(root, ".content-workspace/content/products/robotaxi.json"), "{ invalid json\n");
    await writeFile(path.join(root, ".content-workspace/content-state/sets", contentSet.contentSetId, "content-set.json"), `${JSON.stringify(contentSet)}\n`);
    await writeFile(path.join(root, ".content-workspace/content-state/active.json"), `${JSON.stringify({
      schemaVersion: "content-set-active-v1",
      activeContentSetId: contentSet.contentSetId,
      contentSetHash: contentSet.contentSetHash,
      updatedAt: "2026-08-13T00:00:00.000Z",
    })}\n`);
    await assert.rejects(
      () => resolveContentPreviewTarget("products.robotaxi.intro", { rootDirectory: root }),
      (error) => error.code === "CONTENT_PREVIEW_SOURCE_INVALID_JSON",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("content preview refuses source-root overrides and exposes only read-only session metadata", async () => {
  const previous = process.env.XINGBUILD_CONTENT_ROOT;
  process.env.XINGBUILD_CONTENT_ROOT = "/tmp/unsafe-content-root";
  try {
    await assert.rejects(
      () => resolveContentPreviewTarget("products.robotaxi.intro"),
      (error) => error.code === "CONTENT_PREVIEW_SOURCE_UNSAFE",
    );
  } finally {
    if (previous === undefined) delete process.env.XINGBUILD_CONTENT_ROOT;
    else process.env.XINGBUILD_CONTENT_ROOT = previous;
  }

  const context = await resolveContentPreviewTarget("products.robotaxi.intro");
  const identity = {
    cwd: projectRoot,
    commit: "abc123",
    version: "v0.26.20",
  };
  const environment = sessionEnvironment(context, { identity, taskId: "preview-test" });
  const output = sessionOutput(context, { identity, taskId: "preview-test" });
  assert.equal(environment.XINGBUILD_CONTENT_BUILD, "1");
  assert.equal(environment.XINGBUILD_PREVIEW_MODE, "content-preview");
  assert.equal(output.readOnly, true);
  assert.equal(output.statusText, "本地内容预览 · 未审核 · 未发布");
  assert.match(environment.XINGBUILD_PREVIEW_OPEN_PATH, /__xingbuild\/content-preview/);
  assert.equal(Object.keys(environment).some((key) => /APPROVE|PUBLISH|DEPLOY|ACTIVE/.test(key) && !key.includes("BASELINE")), false);
});

test("content and product preview leases are different identities on the fixed port", () => {
  const productIdentity = {
    cwd: projectRoot,
    commit: "abc123",
    version: "v0.26.20",
    mode: "product-preview",
    taskId: "local",
    targetId: null,
    sourcePath: null,
    fieldPath: null,
  };
  const contentIdentity = {
    ...productIdentity,
    mode: "content-preview",
    targetId: "products.robotaxi.intro",
    sourcePath: "/content/products/robotaxi.json",
    fieldPath: "intro",
  };
  assert.equal(isPreviewRecordFor({ ...contentIdentity, port: previewPort }, contentIdentity), true);
  assert.equal(isPreviewRecordFor({ ...contentIdentity, port: previewPort }, productIdentity), false);
  assert.equal(isPreviewRecordFor({ ...productIdentity, port: previewPort }, contentIdentity), false);
});

test("dev workbench is gated to content-preview and has no publication controls", async () => {
  const viteConfig = await readFile(path.join(projectRoot, "vite.config.mjs"), "utf8");
  assert.match(viteConfig, /XINGBUILD_PREVIEW_MODE === "content-preview"/);
  assert.match(viteConfig, /__xingbuild\/content-preview/);
  assert.match(viteConfig, /Web 1280/);
  assert.match(viteConfig, /Mobile 390/);
  assert.match(viteConfig, /xingbuild:content-target-update/);
  assert.doesNotMatch(viteConfig, /type:\s*["']full-reload["']/);
  assert.match(viteConfig, /未审核 · 未发布/);
  const workbenchBlock = viteConfig.slice(viteConfig.indexOf("function contentPreviewWorkbench"), viteConfig.indexOf("function contentPreviewHmr"));
  assert.doesNotMatch(workbenchBlock, /approve|publish|deploy|active\s+switch/i);
});
