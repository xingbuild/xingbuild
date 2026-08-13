import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  compileAuthoringValue,
  decompileAuthoringValue,
  RICH_TEXT_LIST_SCHEMA,
} from "../scripts/lib/content-authoring.mjs";
import {
  assertUniqueContentIds,
  resolveContentTarget,
} from "../scripts/lib/content-targets.mjs";
import {
  readContentAuthoringTarget,
  writeContentAuthoringTarget,
} from "../scripts/lib/content-preview-authoring.mjs";
import {
  resolveContentPreviewTarget,
  reduceContentPreviewTargetUpdate,
  createContentPreviewRevisionState,
} from "../scripts/lib/content-preview.mjs";
import { projectRoot } from "../scripts/lib/content-root.mjs";

test("rich authoring preserves legacy strings and turns Enter into visible paragraphs", () => {
  const legacy = "第一段。第二句。";
  const read = decompileAuthoringValue(legacy, { valueType: RICH_TEXT_LIST_SCHEMA });
  assert.equal(read.text, legacy);
  assert.equal(read.mobileText, legacy);
  assert.equal(compileAuthoringValue({ text: legacy, valueType: RICH_TEXT_LIST_SCHEMA, existingValue: legacy }), legacy);
  const edited = compileAuthoringValue({ text: "第一段。\n第二段。", valueType: RICH_TEXT_LIST_SCHEMA, existingValue: legacy });
  assert.deepEqual(edited, ["第一段。", "第二段。"]);
  assert.deepEqual(decompileAuthoringValue(edited, { valueType: RICH_TEXT_LIST_SCHEMA }).text.split("\n"), ["第一段。", "第二段。"]);
});

test("duplicate block/item ids hard-fail target reads and writes without changing source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xingbuild-v02628-duplicate-"));
  try {
    await mkdir(path.join(directory, "content/registry"), { recursive: true });
    await mkdir(path.join(directory, ".content-workspace/content/profile"), { recursive: true });
    await cp(path.join(projectRoot, ".content-workspace/content-state"), path.join(directory, ".content-workspace/content-state"), { recursive: true });
    await cp(path.join(projectRoot, "content/registry/content-targets.json"), path.join(directory, "content/registry/content-targets.json"));
    await cp(path.join(projectRoot, ".content-workspace/content/profile/about.json"), path.join(directory, ".content-workspace/content/profile/about.json"));
    const source = path.join(directory, ".content-workspace/content/profile/about.json");
    const document = JSON.parse(await readFile(source, "utf8"));
    document.blocks.push({ ...document.blocks.find((block) => block.id === "positioning-lead"), id: "positioning-lead" });
    await writeFile(source, `${JSON.stringify(document, null, 2)}\n`);
    const before = await readFile(source, "utf8");
    assert.throws(() => assertUniqueContentIds(document, { sourcePath: source, targetId: "profile.about.block.positioning-lead.text" }), (error) => error.code === "CONTENT_TARGET_AMBIGUOUS_ID");
    await assert.rejects(
      () => readContentAuthoringTarget("profile.about.block.positioning-lead.text", { rootDirectory: directory }),
      (error) => error.code === "CONTENT_TARGET_AMBIGUOUS_ID",
    );
    await assert.rejects(
      () => writeContentAuthoringTarget({ targetId: "profile.about.block.positioning-lead.text", text: "不会写入", rootDirectory: directory }),
      (error) => error.code === "CONTENT_TARGET_AMBIGUOUS_ID",
    );
    assert.equal(await readFile(source, "utf8"), before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("authoring restore snapshot returns the exact original source bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "xingbuild-v02628-restore-"));
  try {
    await mkdir(path.join(directory, "content/registry"), { recursive: true });
    await mkdir(path.join(directory, ".content-workspace/content/profile"), { recursive: true });
    await cp(path.join(projectRoot, "content/registry/content-targets.json"), path.join(directory, "content/registry/content-targets.json"));
    await cp(path.join(projectRoot, ".content-workspace/content/profile/about.json"), path.join(directory, ".content-workspace/content/profile/about.json"));
    await cp(path.join(projectRoot, ".content-workspace/content-state"), path.join(directory, ".content-workspace/content-state"), { recursive: true });
    const targetId = "profile.about.block.positioning-lead.text";
    const sourcePath = path.join(directory, ".content-workspace/content/profile/about.json");
    const originalBytes = await readFile(sourcePath, "utf8");
    const original = await readContentAuthoringTarget(targetId, { rootDirectory: directory });
    const edited = await writeContentAuthoringTarget({
      targetId,
      text: `${original.authoring.text}\n临时结构化段落`,
      sourceHash: original.sourceHash,
      valueHash: original.valueHash,
      rootDirectory: directory,
    });
    const current = await readContentAuthoringTarget(targetId, { rootDirectory: directory });
    const restored = await writeContentAuthoringTarget({
      targetId,
      text: original.authoring.text,
      sourceHash: current.sourceHash,
      valueHash: current.valueHash,
      restoreSnapshot: { sourceHash: original.sourceHash, valueHash: original.valueHash, text: originalBytes },
      rootDirectory: directory,
    });
    assert.equal(edited.changeSummary.afterPartCount, 2);
    assert.equal(restored.sourceRestored, true);
    assert.equal(await readFile(sourcePath, "utf8"), originalBytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("v0.26.28 target impact is exact and only its consumer views refresh", async () => {
  const intro = await resolveContentPreviewTarget("products.robotaxi.intro");
  assert.deepEqual(intro.consumerViews, [
    { route: "/", viewport: "web-1280" },
    { route: "/", viewport: "mobile-390" },
    { route: "/products", viewport: "web-1280" },
    { route: "/products", viewport: "mobile-390" },
  ]);
  const state = createContentPreviewRevisionState({ sourceHash: intro.sourceHash, valueHash: intro.valueHash });
  const update = reduceContentPreviewTargetUpdate({
    state,
    targetId: intro.targetId,
    consumerRoutes: intro.consumerRoutes,
    consumerViews: intro.consumerViews,
    sourceState: { sourceHash: "changed-source", valueHash: "changed-value", currentValue: intro.currentValue },
  });
  assert.equal(update.event.refresh, true);
  assert.deepEqual(update.event.consumerViews, intro.consumerViews);
  const outside = reduceContentPreviewTargetUpdate({
    state: update.state,
    targetId: intro.targetId,
    consumerRoutes: intro.consumerRoutes,
    consumerViews: intro.consumerViews,
    sourceState: { sourceHash: "other-source", valueHash: "changed-value", currentValue: intro.currentValue },
  });
  assert.equal(outside.event.status, "outside-selected-target");
  assert.equal(outside.event.refresh, false);
  assert.equal(outside.state.revision, update.state.revision);
});

test("workbench has no connection-line layer and the fixed launcher is explicit", async () => {
  const vite = await readFile(path.join(projectRoot, "vite.config.mjs"), "utf8");
  const launcher = await readFile(path.join(projectRoot, "start-content-preview.command"), "utf8");
  assert.doesNotMatch(vite, /relation-layer|data-relation-layer|drawRelations|is-related/);
  assert.match(vite, /consumerViews/);
  assert.match(launcher, /4317|content-site-preview/);
  assert.match(launcher, /exec node scripts\/content-site-preview\.mjs/);
  const target = await resolveContentTarget("profile.about.block.direction.text");
  assert.equal(target.valueType, RICH_TEXT_LIST_SCHEMA);
});
