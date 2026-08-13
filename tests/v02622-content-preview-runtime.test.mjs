import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createContentPreviewRevisionState, readContentPreviewSourceState } from "../scripts/lib/content-preview.mjs";
import {
  CONTENT_PREVIEW_EVENT_SCHEMA,
  CONTENT_PREVIEW_RUNTIME_V2_SCHEMA,
  createPreviewEventBroker,
  createPreviewSourceWatcher,
} from "../scripts/lib/content-preview-runtime-v2.mjs";
import { projectRoot } from "../scripts/lib/content-root.mjs";

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvent(events, predicate, timeoutMs = 2000, startAt = 0) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const event = [...events].slice(startAt).reverse().find(predicate);
    if (event) return event;
    await wait(25);
  }
  throw new Error("timed out waiting for preview event");
}

function parseSse(body) {
  const match = body.match(/data: (.+)\n\n/);
  return match ? JSON.parse(match[1]) : null;
}

test("Preview Runtime v2 exposes one explicit session-scoped SSE channel", () => {
  const state = createContentPreviewRevisionState({ sourceHash: "source-a", valueHash: "value-a" });
  const broker = createPreviewEventBroker({
    sessionId: "session-v2",
    targetId: "site.home.homeTitle",
    consumerViews: [{ route: "/", viewport: "web-1280" }, { route: "/", viewport: "mobile-390" }],
    state,
  });
  const chunks = [];
  const response = {
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(value) { chunks.push(value); },
    on() {},
    end() { this.writableEnded = true; },
  };
  broker.connect({ on() {} }, response);
  const initial = parseSse(chunks.join(""));
  assert.equal(initial.schemaVersion, CONTENT_PREVIEW_EVENT_SCHEMA);
  assert.equal(initial.runtimeSchemaVersion, CONTENT_PREVIEW_RUNTIME_V2_SCHEMA);
  assert.equal(initial.sessionId, "session-v2");
  assert.equal(initial.targetId, "site.home.homeTitle");
  assert.equal(initial.status, "ready");
  assert.deepEqual(initial.consumerViews, [
    { route: "/", viewport: "web-1280" },
    { route: "/", viewport: "mobile-390" },
  ]);
  broker.publish({
    status: "valid-updated",
    eventType: "valid",
    refresh: true,
    revision: 1,
    sourceHash: "source-b",
    valueHash: "value-b",
    consumerViews: initial.consumerViews,
  });
  assert.equal(chunks.length, 2);
  assert.equal(parseSse(chunks.at(-1)).revision, 1);
  broker.close();
  assert.equal(broker.getClosed(), true);
});

test("Preview SourceWatcher handles valid, invalid, outside-target, restore and cleanup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xingbuild-v02622-runtime-"));
  const sourcePath = path.join(directory, "home.json");
  const original = JSON.stringify({ homeTitle: "原始定位", description: "稳定说明" }, null, 2) + "\n";
  const context = await readContentPreviewSourceState({
    sourcePath,
    fieldPath: "homeTitle",
    valueType: "string",
  }).catch(async () => {
    await writeFile(sourcePath, original);
    return readContentPreviewSourceState({ sourcePath, fieldPath: "homeTitle", valueType: "string" });
  });
  const state = createContentPreviewRevisionState(context);
  const broker = createPreviewEventBroker({
    sessionId: "session-watcher",
    targetId: "site.home.homeTitle",
    consumerViews: [{ route: "/", viewport: "web-1280" }, { route: "/", viewport: "mobile-390" }],
    state,
  });
  const events = [];
  const response = {
    writableEnded: false,
    setHeader() {},
    flushHeaders() {},
    write(value) {
      const event = parseSse(value);
      if (event) events.push(event);
    },
    on() {},
    end() { this.writableEnded = true; },
  };
  broker.connect({ on() {} }, response);
  const watcher = createPreviewSourceWatcher({
    sessionId: "session-watcher",
    targetId: "site.home.homeTitle",
    sourcePath,
    fieldPath: "homeTitle",
    valueType: "string",
    consumerRoutes: ["/"],
    consumerViews: [{ route: "/", viewport: "web-1280" }, { route: "/", viewport: "mobile-390" }],
    broker,
    debounceMs: 40,
  });
  try {
    await writeFile(sourcePath, JSON.stringify({ homeTitle: "更新定位", description: "稳定说明" }, null, 2) + "\n");
    const updated = await waitForEvent(events, (event) => event.status === "valid-updated");
    assert.equal(updated.refresh, true);
    assert.equal(updated.revision, 1);
    const updatedRevision = updated.revision;

    await writeFile(sourcePath, "{ invalid\n");
    const invalid = await waitForEvent(events, (event) => event.status === "invalid", 2000, events.length);
    assert.equal(invalid.refresh, false);
    assert.equal(invalid.revision, updatedRevision);

    await writeFile(sourcePath, JSON.stringify({ homeTitle: "更新定位", description: "稳定说明" }, null, 2) + "\n");
    const restored = await waitForEvent(events, (event) => event.status === "valid-updated" && event.revision === updatedRevision, 2000, events.length);
    assert.equal(restored.refresh, false);

    await writeFile(sourcePath, JSON.stringify({ homeTitle: "更新定位", description: "说明发生变化" }, null, 2) + "\n");
    const outside = await waitForEvent(events, (event) => event.status === "outside-selected-target", 2000, events.length);
    assert.equal(outside.refresh, false);
    assert.equal(outside.revision, updatedRevision);
  } finally {
    watcher.close();
    broker.close();
    await rm(directory, { recursive: true, force: true });
  }
  assert.equal(watcher.getClosed(), true);
  assert.equal(broker.getClosed(), true);
});

test("Workbench uses explicit EventSource and exact consumer views, not Vite HMR", async () => {
  const viteConfig = await readFile(path.join(projectRoot, "vite.config.mjs"), "utf8");
  assert.match(viteConfig, /contentPreviewRuntimeV2/);
  assert.match(viteConfig, /preview-events/);
  assert.match(viteConfig, /new EventSource/);
  assert.match(viteConfig, /data-viewport/);
  assert.doesNotMatch(viteConfig, /import\.meta\.hot/);
  assert.doesNotMatch(viteConfig, /type:\s*[\"']full-reload/);
});
