import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { projectRoot } from "../scripts/lib/content-root.mjs";

test("page-oriented workbench keeps one page-first navigation and real preview relation contract", async () => {
  const source = await readFile(`${projectRoot}/vite.config.mjs`, "utf8");
  for (const label of ["首页", "B端产品", "经营观察", "观察文章", "关于我"]) assert.match(source, new RegExp(label));
  assert.match(source, /workbench-shell/);
  assert.match(source, /本地编辑预览工具/);
  assert.match(source, /data-page-select/);
  assert.doesNotMatch(source, /data-field-list/);
  assert.doesNotMatch(source, /class="status"/);
  assert.match(source, /data-editor-context/);
  assert.match(source, /xingbuild-content-target-click/);
  assert.match(source, /targets:\s*pageTargets\.map/);
  assert.match(source, /\.editor-column[^}]*overflow-y:\s*auto/);
  assert.match(source, /\.preview-column[^}]*position:\s*sticky/);
  assert.match(source, /data-preview-scroll/);
  assert.match(source, /overflow-y:\s*auto/);
  assert.match(source, /data-relation-layer/);
  assert.match(source, /data-xingbuild-content-target/);
  assert.match(source, /xingbuild-content-target-marker/);
  assert.match(source, /new EventSource/);
  assert.doesNotMatch(source, /type:\s*["']full-reload/);
});

test("page route grouping keeps observation detail targets in the observation page", async () => {
  const source = await readFile(`${projectRoot}/vite.config.mjs`, "utf8");
  assert.match(source, /route\.startsWith\("\/observations\/"\)/);
  assert.match(source, /PAGE_LABELS/);
  assert.match(source, /targetFieldLabel/);
});
