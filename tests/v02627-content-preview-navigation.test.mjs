import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { projectRoot } from "../scripts/lib/content-root.mjs";

test("v0.26.27 removes the split page selector and uses registered frame navigation", async () => {
  const source = await readFile(`${projectRoot}/vite.config.mjs`, "utf8");
  assert.doesNotMatch(source, /data-page-select/);
  assert.doesNotMatch(source, /选择页面/);
  assert.match(source, /pageDefinitions\.map\(\(definition\) => definition\.route\)/);
  assert.match(source, /const PAGE_ROUTES = \$\{safeJson\(CONTENT_PREVIEW_PAGE_ROUTES\)\}/);
  assert.match(source, /registeredRoute/);
  assert.match(source, /type: "preview-navigation-click"/);
  assert.match(source, /type: "target-select"/);
  assert.match(source, /event\.source/);
  assert.match(source, /syncPreviewRoute/);
  assert.match(source, /clearEditorSelection/);
  assert.match(source, /frame\.dataset\.baseSrc = routeUrl/);
  assert.doesNotMatch(source, /type:\s*["']full-reload/);
});

test("navigation and target selection remain distinct in the injected preview frame bridge", async () => {
  const source = await readFile(`${projectRoot}/vite.config.mjs`, "utf8");
  const navigationIndex = source.indexOf('type: "preview-navigation-click"');
  const targetIndex = source.indexOf('type: "target-select"');
  assert.ok(navigationIndex >= 0 && targetIndex >= 0);
  assert.ok(targetIndex < navigationIndex || navigationIndex < targetIndex);
  assert.match(source, /if \(target\) \{[\s\S]*?type: "target-select"/);
  assert.match(source, /const anchor = event\.target\?\.closest\?\.\("a\[href\]"\)/);
  assert.match(source, /url\.origin !== location\.origin/);
  assert.match(source, /PAGE_ROUTES\.includes\(url\.pathname\)/);
});
