import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  applyContentChangeSet,
  createContentChangeSet,
  createRollbackChangeSet,
  hashValue,
  readContentChangeSet,
  resolveContentTarget,
  writeContentChangeSet,
} from "../scripts/lib/content-targets.mjs";
import { normalizeResponsiveTextSlot, responsiveTextSegments } from "../scripts/lib/responsive-text-slot.mjs";
import { createContentSet, writeContentSet } from "../scripts/lib/content-set.mjs";

const root = new URL("../", import.meta.url).pathname;

test("responsive-text-slot-v1 normalizes legacy strings and rejects unsafe or invalid breaks", () => {
  assert.deepEqual(normalizeResponsiveTextSlot("legacy copy").parts, [{ id: "legacy", text: "legacy copy" }]);
  const slot = normalizeResponsiveTextSlot({
    schemaVersion: "responsive-text-slot-v1",
    parts: [{ id: "one", text: "第一段" }, { id: "two", text: "第二段" }],
    projections: { "products.productHero.intro": { web: { breakAfter: ["one"] }, mobile: { breakAfter: ["one"] } } },
  }, { projections: ["products.productHero.intro"] });
  assert.deepEqual(responsiveTextSegments(slot, { projection: "products.productHero.intro", profile: "web" }), ["第一段", "\n", "第二段"]);
  assert.throws(() => normalizeResponsiveTextSlot({ schemaVersion: "responsive-text-slot-v1", parts: [{ id: "one", text: "" }], projections: {} }), /non-empty/);
  assert.throws(() => normalizeResponsiveTextSlot({ schemaVersion: "responsive-text-slot-v1", parts: [{ id: "one", text: "一" }, { id: "two", text: "二" }], projections: { "products.productHero.intro": { web: { breakAfter: ["two"] } } } }, { projections: ["products.productHero.intro"] }), /final part/);
  assert.throws(() => normalizeResponsiveTextSlot({ schemaVersion: "responsive-text-slot-v1", parts: [{ id: "one", text: "一" }], projections: { "unknown.projection": { web: { breakAfter: [] } } } }, { projections: ["products.productHero.intro"] }), /not registered/);
  assert.throws(() => normalizeResponsiveTextSlot({ schemaVersion: "responsive-text-slot-v1", parts: [{ id: "one", text: "<b>一<\/b>" }], projections: {} }), /plain text/);
});

test("responsive slot target uses atomic ChangeSet and rollback without touching canonical source", async () => {
  const fixtureRoot = await mkdtemp(path.join("/tmp", "xingbuild-v02615-slot-"));
  const sourcePath = path.join(fixtureRoot, ".content-workspace/content/products/robotaxi.json");
  const registry = await readFile(path.join(root, "content/registry/content-targets.json"), "utf8");
  const source = { id: "robotaxi", route: "/products", navLabel: "Robotaxi", title: "标题", intro: "旧说明", boundary: "边界", modules: [{ id: "robotaxi-operations-current-simulation", group: "运营中控台", label: "模块", shortDescription: "旧模块说明", loopRelation: "关系" }] };
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await mkdir(path.join(fixtureRoot, "content/registry"), { recursive: true });
  await writeFile(path.join(fixtureRoot, "content/registry/content-targets.json"), registry);
  await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`);
  const target = await resolveContentTarget("products.robotaxi.intro", { rootDirectory: fixtureRoot });
  const after = { schemaVersion: "responsive-text-slot-v1", parts: [{ id: "identity", text: "新说明" }, { id: "detail", text: "补充" }], projections: { "products.productHero.intro": { web: { breakAfter: ["identity"] }, mobile: { breakAfter: ["identity"] } } } };
  const changeSet = await createContentChangeSet({ targetId: target.targetId, after, beforeHash: hashValue(source.intro), sourceRefs: ["test:responsive-slot"], boundary: "仅验证响应式文本槽位", authority: "test", rootDirectory: fixtureRoot, changeId: "test-v02615-responsive-slot" });
  const written = await writeContentChangeSet(changeSet, { rootDirectory: fixtureRoot });
  let rollback;
  try {
    const staged = applyContentChangeSet(source, changeSet);
    assert.deepEqual(staged.intro, after);
    assert.equal(JSON.parse(await readFile(sourcePath, "utf8")).intro, source.intro);
    await writeFile(path.join(fixtureRoot, ".content-workspace/content/products/robotaxi.json"), `${JSON.stringify(staged, null, 2)}\n`);
    await writeFile(path.join(fixtureRoot, ".content-workspace/changes/linked.json"), JSON.stringify({}));
    const loaded = await readContentChangeSet(written.file, { rootDirectory: fixtureRoot });
    assert.equal(loaded.operations[0].valueType, "responsive-text-slot-v1");
    // Associate the ignored package identity so the existing rollback contract can be exercised.
    const linked = { ...loaded, contentReleaseId: "test-release", releasePackage: ".content-workspace/releases/test-release" };
    await writeFile(written.file, `${JSON.stringify(linked, null, 2)}\n`);
    rollback = await createRollbackChangeSet(written.file, { rootDirectory: fixtureRoot, changeId: "test-v02615-responsive-slot-rollback" });
    assert.deepEqual(rollback.after, source.intro);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("page renderers use one shared slot renderer while keeping Home and Products projections independent", async () => {
  const home = await readFile(new URL("../src/components/page-compositions/HomeProductProjection.jsx", import.meta.url), "utf8");
  const primitives = await readFile(new URL("../src/components/practice/PracticePrimitives.jsx", import.meta.url), "utf8");
  const products = await readFile(new URL("../src/components/page-compositions/ProductsShowcase.jsx", import.meta.url), "utf8");
  const renderer = await readFile(new URL("../src/components/page-compositions/PageCompositionRenderer.jsx", import.meta.url), "utf8");
  assert.match(primitives, /ResponsiveText/);
  assert.match(home, /home\.productHero\.intro/);
  assert.match(products, /products\.productHero\.intro/);
  assert.match(products, /showWhy/);
  assert.doesNotMatch(home, /showWhy/);
  assert.doesNotMatch(renderer, /home\.description/);
  assert.doesNotMatch(home, /ShowcaseFlow/);
  assert.doesNotMatch(products, /ShowcaseFlow/);
});

test("Why is Products-only and its spacing has explicit structural owners", async () => {
  const home = await readFile(new URL("../src/components/page-compositions/HomeProductProjection.jsx", import.meta.url), "utf8");
  const products = await readFile(new URL("../src/components/page-compositions/ProductsShowcase.jsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../src/styles/components.css", import.meta.url), "utf8");
  assert.doesNotMatch(home, /why/);
  assert.match(products, /showWhy/);
  assert.match(styles, /product-hero--with-why \.product-hero__intro[^}]*margin-top: var\(--space-4\)/s);
  assert.match(styles, /product-hero__why[^}]*margin: var\(--space-3\) 0 0/s);
  assert.match(styles, /product-hero__why-eyebrow[^}]*margin: 0 0 var\(--space-1\)/s);
  assert.match(styles, /product-hero__why-items[^}]*gap: var\(--space-2\)/s);
  assert.match(styles, /product-hero--with-why \.action-group[^}]*margin-top: var\(--space-6\)/s);
});

test("ContentSet boundary rejects an unregistered projection before any candidate is written", async () => {
  const fixtureRoot = await mkdtemp(path.join("/tmp", "xingbuild-v02615-contentset-"));
  try {
    await mkdir(path.join(fixtureRoot, "content/registry"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "content/registry/content-targets.json"), await readFile(path.join(root, "content/registry/content-targets.json"), "utf8"));
    const candidate = createContentSet({
      entries: [],
      homeContent: {
        homeTitle: { schemaVersion: "responsive-text-slot-v1", parts: [{ id: "one", text: "定位" }, { id: "two", text: "说明" }], projections: { "home.unknown": { web: { breakAfter: ["one"] } } } },
        description: "旧说明",
        emptyStates: { observations: { message: "暂无", description: "暂无" } },
      },
    });
    await assert.rejects(writeContentSet({ sourceRoot: fixtureRoot, contentSet: candidate }), /not registered/);
    await assert.rejects(access(path.join(fixtureRoot, ".content-workspace/content-state/sets")), /ENOENT/);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
