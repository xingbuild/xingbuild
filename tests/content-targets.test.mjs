import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { prepareContentRelease } from "../scripts/content-release.mjs";
import { runTargetCommand } from "../scripts/content-target.mjs";
import {
  applyContentChangeSet,
  createContentChangeSet,
  createRollbackChangeSet,
  createContentTargetCard,
  hashValue,
  parseFieldPath,
  readContentTargetRegistry,
  readContentChangeSet,
  readFieldValue,
  validateContentTargetRegistry,
  writeContentChangeSet,
} from "../scripts/lib/content-targets.mjs";

const root = new URL("../", import.meta.url).pathname;
const targetId = "products.robotaxi.module.robotaxi-operations-current-simulation.action.href";

test("registry integrity fixes Robotaxi targets to safe product fields and routes", async () => {
  const registry = await readContentTargetRegistry({ rootDirectory: root });
  assert.ok(registry.targets.length > 0);
  for (const target of registry.targets.filter((entry) => entry.kind === "product-content")) {
    assert.equal(target.sourcePath, "content/products/robotaxi.json");
    assert.equal(target.scope, "field");
    assert.deepEqual(target.projectionRoutes, target.targetId === "products.robotaxi.intro" ? ["/", "/products"] : ["/products"]);
  }
  const productTarget = registry.targets.find((entry) => entry.kind === "product-content");
  assert.ok(productTarget);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [...registry.targets, productTarget] }), /duplicate targetId/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [{ ...productTarget, sourcePath: "../outside.json" }] }), /unsafe target source/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [{ ...productTarget, sourcePath: "content/articles/enterprise-operating-system.json" }] }), /Robotaxi product target contract/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [{ ...productTarget, valueType: "object" }] }), /Robotaxi product target contract/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [{ ...productTarget, editable: false }] }), /Robotaxi product target contract/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [{ ...productTarget, projectionRoutes: ["/wrong"] }] }), /Robotaxi product target contract/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, targets: [{ ...productTarget, fieldPath: "modules[0].label" }] }), /unsupported fieldPath|explicit fields/);
  const mediaTemplates = registry.templates.filter((entry) => entry.kind === "media-content");
  assert.ok(mediaTemplates.length > 0);
  for (const target of mediaTemplates) {
    assert.equal(target.scope, "field");
    assert.equal(target.valueType, "string");
    assert.equal(target.editable, true);
    assert.deepEqual(target.projectionRoutes, ["/products"]);
  }
  assert.throws(() => validateContentTargetRegistry({ ...registry, templates: [...registry.templates, { ...mediaTemplates[0], sourcePathTemplate: "content/media/other/manifest.json" }] }), /Robotaxi media template contract/);
  assert.throws(() => validateContentTargetRegistry({ ...registry, templates: [...registry.templates, { ...mediaTemplates[0], valueType: "object" }] }), /template contract/);
});

test("registry exposes unified media type and empty-binding targets without guessing", async () => {
  const registry = await readContentTargetRegistry({ rootDirectory: root });
  const { resolveContentTarget } = await import("../scripts/lib/content-targets.mjs");
  const typeTarget = await resolveContentTarget("media.robotaxi.asset.robotaxi-evidence-grid-simulation-operations-map-v1.type", { rootDirectory: root });
  const bindingTarget = await resolveContentTarget("media.robotaxi.module.robotaxi-operations-current-simulation.mediaId", { rootDirectory: root });
  assert.equal(typeTarget.constraints.enum.join(","), "image,video");
  assert.equal(bindingTarget.fieldPath, "modules[id=robotaxi-operations-current-simulation].mediaId");
  const card = await createContentTargetCard(typeTarget.targetId, { rootDirectory: root });
  assert.equal(card.current, null);
  assert.equal(card.beforeHash, hashValue(null));
});

test("content:target emits one locating card and writes an ignored ChangeSet", async () => {
  const result = await runTargetCommand([
    "--target-id", "products.robotaxi.title",
    "--after", "Robotaxi 定位卡测试",
    "--source-ref", "robotaxi:test-card",
    "--boundary", "仅验证定位卡和字段级变更。",
    "--authority", "test-authority",
    "--change-id", "test-target-cli",
  ], { rootDirectory: root });
  try {
    assert.equal(result.mode, "create");
    assert.equal(result.card.targetId, "products.robotaxi.title");
    assert.equal(result.card.fieldPath, "title");
    assert.equal(result.changeSet.targetId, result.card.targetId);
    assert.match(result.file, /\.content-workspace\/changes/);
  } finally {
    await rm(result.file, { force: true });
  }
});

test("registry resolves Robotaxi fields and creates an ignored ChangeSet", async () => {
  const source = JSON.parse(await readFile(`${root}/.content-workspace/content/products/robotaxi.json`, "utf8"));
  const before = readFieldValue(source, "modules[id=robotaxi-operations-current-simulation].action.href");
  const changeSet = await createContentChangeSet({
    targetId,
    after: "https://robotaxi.xingbuild.top/",
    beforeHash: hashValue(before),
    sourceRefs: ["robotaxi:approved-action-link"],
    boundary: "仅更新已登记 CTA 链接，不改变页面能力或上游事实。",
    authority: "test-authority",
    rootDirectory: root,
    changeId: "test-robotaxi-action-href",
  });
  const written = await writeContentChangeSet(changeSet, { rootDirectory: root });
  try {
    const loaded = await readContentChangeSet(written.file, { rootDirectory: root });
    assert.equal(loaded.targetId, targetId);
    assert.equal(loaded.fieldPath, "modules[id=robotaxi-operations-current-simulation].action.href");
    assert.deepEqual(loaded.affectedRoutes, ["/products"]);
    assert.equal(loaded.beforeHash, hashValue(before));
    assert.equal(readFieldValue(source, loaded.fieldPath), before);
  } finally {
    await rm(written.file, { force: true });
  }
});

test("ChangeSet overlays one field without replacing module order or other content", async () => {
  const source = JSON.parse(await readFile(`${root}/.content-workspace/content/products/robotaxi.json`, "utf8"));
  const fieldPath = "modules[id=robotaxi-operations-current-simulation].shortDescription";
  const before = readFieldValue(source, fieldPath);
  const changeSet = {
    changeId: "test-single-field",
    targetId: "products.robotaxi.module.robotaxi-operations-current-simulation.shortDescription",
    scope: "field",
    sourcePath: "content/products/robotaxi.json",
    fieldPath,
    beforeHash: hashValue(before),
    before,
    after: "新的明确内容边界。",
    affectedRoutes: ["/products"],
    sourceRefs: ["robotaxi:source"],
    boundary: "只修改字段值。",
    authority: "test-authority",
  };
  const result = applyContentChangeSet(source, changeSet);
  assert.equal(result.modules.length, source.modules.length);
  assert.deepEqual(result.modules.map((module) => module.id), source.modules.map((module) => module.id));
  assert.equal(readFieldValue(result, fieldPath), changeSet.after);
  assert.equal(result.title, source.title);
});

test("unregistered, guessed, whole-file and stale-hash changes are rejected", async () => {
  await assert.rejects(
    createContentChangeSet({ targetId: "products.robotaxi.modules[0].label", after: "猜测", sourceRefs: ["x"], boundary: "x", authority: "x", rootDirectory: root }),
    /not registered|outside the approved/,
  );
  assert.throws(() => parseFieldPath("modules[0].label"), /unsupported fieldPath|explicit fields and stable id selectors/);
  assert.throws(() => parseFieldPath("modules[label=当前模拟].label"), /unsupported fieldPath|explicit fields and stable id selectors/);
  await assert.rejects(
    createContentChangeSet({ targetId, after: "https://robotaxi.xingbuild.top/", beforeHash: "0".repeat(64), sourceRefs: ["x"], boundary: "x", authority: "x", rootDirectory: root }),
    /beforeHash conflict/,
  );
  assert.throws(() => applyContentChangeSet({}, { targetId, fieldPath: "modules[id=x].label", beforeHash: "0".repeat(64), after: ["整文件"] }), /ChangeSet beforeHash conflict|fieldPath/);
});

test("content capability construction remains separated from daily content use", async () => {
  const rules = await readFile(`${root}/docs/operations/内容运营与发布规则.md`, "utf8");
  assert.match(rules, /### 6\.1 能力建设与能力使用/);
  assert.match(rules, /字段级 `ChangeSet`.*产品工程能力建设/);
  assert.match(rules, /内容 task 只能报告能力缺口和证据/);
  assert.match(rules, /能力建设完成并通过产品\/视觉验收后，日常内容才回到独立内容运营/);
});

test("Practice prepare consumes a ChangeSet in staging and keeps canonical content untouched", async () => {
  const fixtureRoot = await mkdtemp(path.join("/tmp", "xingbuild-content-targets-"));
  const sourceFile = path.join(fixtureRoot, ".content-workspace/content/products/robotaxi.json");
  const source = { id: "robotaxi", route: "/products", navLabel: "Robotaxi", title: "标题", intro: "简介", boundary: "边界", modules: [{ id: "robotaxi-operations-current-simulation", group: "运营中控台", label: "模块", shortDescription: "说明", loopRelation: "运营中控台", mediaId: "robotaxi-media", action: { href: "https://robotaxi.xingbuild.top/" } }] };
  const registry = await readFile(`${root}/content/registry/content-targets.json`, "utf8");
  const mediaHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const manifest = { id: "robotaxi-approved-media", version: "v1", directory: "/media/robotaxi", reviewStatus: "approved", publicStatus: "public", approvalRecord: { approvalId: "approval", approvalStatus: "approved", authority: "user", approvedAt: "2026-08-01", scope: "test" }, currentPublication: { status: "active", effectiveAt: "2026-08-01", authority: "user", reason: "test" }, provenance: { repository: "Robotaxi", manifestPath: "manifest.json", version: "v1", commit: "abcdef0", sourceDraftManifestSha256: "a".repeat(64) }, assets: [{ id: "robotaxi-media", type: "image", src: "/media/robotaxi/approved.png", altZh: "已批准媒体", ratio: "16:10", assetSha256: mediaHash, reviewStatus: "approved", publicStatus: "public", provenance: { mediaRole: "current_system_evidence", stateBoundary: "测试边界", robotaxiVersion: "v1", commit: "abcdef0", approvalStatus: "approved" } }] };
  await mkdir(path.join(fixtureRoot, "content/registry"), { recursive: true });
  await mkdir(path.dirname(sourceFile), { recursive: true });
  await mkdir(path.join(fixtureRoot, ".content-workspace/content/media/robotaxi"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "public/media/robotaxi"), { recursive: true });
  await mkdir(path.join(fixtureRoot, "dist/client"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "content/registry/content-targets.json"), registry);
  await writeFile(sourceFile, `${JSON.stringify(source, null, 2)}\n`);
  await writeFile(path.join(fixtureRoot, ".content-workspace/content/media/robotaxi/manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(fixtureRoot, "public/media/robotaxi/approved.png"), Buffer.alloc(0));
  await writeFile(path.join(fixtureRoot, "dist/client/release.json"), JSON.stringify({ version: "v0.24.19", commit: "1d93c6f3124ce9fb53b9e61c577d6a6ffd208832" }));
  const fieldPath = "modules[id=robotaxi-operations-current-simulation].label";
  const before = readFieldValue(source, fieldPath);
  const changeSet = await createContentChangeSet({
    targetId: "products.robotaxi.module.robotaxi-operations-current-simulation.label",
    after: `${before}（定位测试）`,
    sourceRefs: ["robotaxi:test-source"],
    boundary: "仅验证 Practice 字段级 staging overlay。",
    authority: "test-authority",
    rootDirectory: fixtureRoot,
    changeId: "test-practice-label-overlay",
  });
  const written = await writeContentChangeSet(changeSet, { rootDirectory: fixtureRoot });
  let prepared;
  let rollbackPrepared;
  let rollbackWritten;
  const baseSiteArtifact = JSON.parse(await readFile(path.join(root, "dist/client/base-site-artifact.json"), "utf8"));
  try {
    prepared = await prepareContentRelease({ kind: "practice", target: "robotaxi", changeSetPath: written.file, baseSiteArtifact, sourceRoot: fixtureRoot });
    const staged = JSON.parse(await readFile(prepared.sourceFile, "utf8"));
    assert.equal(readFieldValue(staged, fieldPath), changeSet.after);
    assert.equal(readFieldValue(JSON.parse(await readFile(sourceFile, "utf8")), fieldPath), before);
    assert.equal(prepared.changeSetId, changeSet.changeId);
    assert.deepEqual(prepared.changedTargets, [changeSet.targetId]);
    const linked = await readContentChangeSet(written.file, { rootDirectory: fixtureRoot });
    assert.equal(linked.contentReleaseId, prepared.contentReleaseId);
    assert.equal(linked.releasePackage, prepared.releasePackage);
    rollbackWritten = await createRollbackChangeSet(written.file, { rootDirectory: fixtureRoot });
    assert.equal(rollbackWritten.rollbackOf.contentReleaseId, prepared.contentReleaseId);
    rollbackPrepared = await prepareContentRelease({ kind: "practice", target: "robotaxi", changeSetPath: rollbackWritten.file, baseSiteArtifact, sourceRoot: fixtureRoot });
    const recovered = JSON.parse(await readFile(rollbackPrepared.sourceFile, "utf8"));
    assert.equal(readFieldValue(recovered, fieldPath), before);
    assert.equal(rollbackPrepared.rollbackOf.changeId, changeSet.changeId);
    const drifted = structuredClone(source);
    drifted.modules[0].label = "canonical 漂移";
    await writeFile(sourceFile, `${JSON.stringify(drifted, null, 2)}\n`);
    await assert.rejects(
      prepareContentRelease({ kind: "practice", target: "robotaxi", changeSetPath: rollbackWritten.file, baseSiteArtifact, sourceRoot: fixtureRoot }),
      /rollback canonical baseline drift/,
    );
    assert.equal(readFieldValue(JSON.parse(await readFile(sourceFile, "utf8")), fieldPath), "canonical 漂移");
  } finally {
    await rm(written.file, { force: true });
    if (rollbackWritten) await rm(rollbackWritten.file, { force: true });
    if (prepared) await rm(prepared.packageDirectory, { recursive: true, force: true });
    if (rollbackPrepared) await rm(rollbackPrepared.packageDirectory, { recursive: true, force: true });
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
