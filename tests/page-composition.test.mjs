import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMPOSITIONS,
  COMPOSITION_REGIONS,
  pageDefinitionFixtures,
  pageDefinitionRegistry,
  pageDefinitions,
  findPageDefinitionByRoute,
  getPageDefinition,
  validatePageDefinitions,
} from "../src/content/pageDefinitions.js";
import { resolvePageContent } from "../src/content/pageContentResolver.js";
import {
  projectRuntimePractice,
  resolveRuntimeObservation,
} from "../src/content/runtimeContentProjection.js";

const renderer = await readFile(new URL("../src/components/page-compositions/PageCompositionRenderer.jsx", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const about = await readFile(new URL("../src/pages/AboutPage.jsx", import.meta.url), "utf8");

test("page registry covers the four controlled compositions and keeps routes unique", () => {
  assert.deepEqual(COMPOSITIONS, ["HomeComposition", "ShowcaseComposition", "CollectionComposition", "ReadingComposition"]);
  assert.equal(validatePageDefinitions(pageDefinitions).length, 0);
  assert.equal(new Set(pageDefinitions.map((definition) => definition.id)).size, pageDefinitions.length);
  assert.equal(new Set(pageDefinitions.map((definition) => definition.route)).size, pageDefinitions.length);
  assert.equal(getPageDefinition("about").route, "/about");
  assert.equal(findPageDefinitionByRoute("/about").id, "about");
  assert.deepEqual(Object.keys(pageDefinitionRegistry).sort(), ["about", "business-observations", "home", "observations", "products"]);
  for (const definition of pageDefinitions) {
    assert.ok(COMPOSITION_REGIONS[definition.composition]);
    assert.ok(definition.regions.every((region) => COMPOSITION_REGIONS[definition.composition].includes(region)));
  }
});

test("invalid page definitions fail loudly instead of silently changing composition", () => {
  const aboutDefinition = getPageDefinition("about");
  const errors = validatePageDefinitions([
    aboutDefinition,
    { ...aboutDefinition, id: "about-copy" },
  ]);
  assert.ok(errors.some((error) => error.includes("route conflicts with /about")));

  const invalid = validatePageDefinitions([{
    ...aboutDefinition,
    id: "invalid",
    route: "/invalid?view=free",
    composition: "UnknownComposition",
    regions: ["RichDocument", "uncontrolled-region"],
    contentRefs: { profile: { type: "profile", id: "about", renderer: "freeform" } },
    responsivePolicy: "mobile-special-case",
  }]);
  assert.ok(invalid.some((error) => error.includes("safe absolute path")));
  assert.ok(invalid.some((error) => error.includes("composition is not registered")));
  assert.ok(invalid.some((error) => error.includes("unknown region")));
  assert.ok(invalid.some((error) => error.includes("unsupported field")));
  assert.ok(invalid.some((error) => error.includes("shared strategy")));
});

test("same-composition fixture uses only a page definition and an approved content reference", () => {
  assert.equal(pageDefinitionFixtures.length, 1);
  const fixture = pageDefinitionFixtures[0];
  assert.equal(fixture.composition, "ReadingComposition");
  assert.deepEqual(fixture.contentRefs, { profile: { type: "profile", id: "about" } });
  assert.equal(validatePageDefinitions(pageDefinitionFixtures).length, 0);
  assert.match(renderer, /ReadingComposition/);
  assert.match(renderer, /resolvePageContent/);
  assert.doesNotMatch(renderer, /CapabilityHost|VisualizationHost|LikeC4|robotaxi\.xingbuild/);
  assert.match(app, /findPageDefinitionByRoute/);
  assert.match(app, /PageCompositionRenderer/);
  assert.match(about, /getPageDefinition\("about"\)/);
  assert.doesNotMatch(about, /RichDocument|page-specific|<h1/);
});

test("missing profile content resolves to null without dereferencing the absent object", () => {
  const content = resolvePageContent({ contentRefs: { profile: { type: "profile", id: "about" } } });
  assert.deepEqual(content, { profile: null });
});

test("all public page compositions opt into one shared visual structure", () => {
  for (const marker of [
    "page-composition--home",
    "page-composition--showcase",
    "page-composition--collection",
    "page-composition--reading",
  ]) assert.match(renderer, new RegExp(marker));
  assert.match(renderer, /content-empty-state/);
});

test("active runtime content projects observation collections, detail lookup, and approved Robotaxi media", async () => {
  const observation = {
    id: "observation-runtime-example",
    slug: "runtime-example",
    status: "published",
    presentation: "brief",
    eventAt: "2026-08-17",
    publishedAt: "2026-08-17T00:00:00.000Z",
    primaryDimension: "经营",
    relatedWorks: ["robotaxi"],
    sources: [{ id: "source-1", label: "来源", url: "https://example.com" }],
    brief: {
      subject: "运行时观察",
      body: "这是一条用于验证最终旧站运行时集合投影的公开观察内容。",
      sourceRefs: ["source-1"],
      isOpinion: false,
    },
  };
  const practice = {
    id: "robotaxi",
    modules: [{ id: "module-1", mediaId: "robotaxi-evidence-fleet-operations-console-v1" }],
  };
  const runtimeData = {
    records: new Map([
      ["observation:runtime-example", { value: observation }],
      ["practice:robotaxi", { value: practice }],
    ]),
  };

  assert.equal(resolveRuntimeObservation("runtime-example", runtimeData), observation);
  const collection = resolvePageContent(getPageDefinition("observations"), { runtimeData });
  assert.equal(collection.briefs.length, 1);
  assert.equal(collection.briefs[0].slug, "runtime-example");
  const products = resolvePageContent(getPageDefinition("products"), { runtimeData });
  assert.equal(products.practice.modules[0].media.type, "video");
  assert.equal(products.practice.modules[0].media.src, "/media/robotaxi/robotaxi-evidence-fleet-operations-console-v1.mp4");
  assert.equal(projectRuntimePractice(practice).modules[0].media.state, "public");

  const robots = await readFile(new URL("../public/robots.txt", import.meta.url), "utf8");
  const sitemap = await readFile(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  assert.match(robots, /Sitemap: https:\/\/xingbuild\.top\/sitemap\.xml/);
  for (const route of ["/products", "/business-observations", "/observations", "/about"]) {
    assert.match(sitemap, new RegExp(`https://xingbuild\\.top${route.replace("/", "\\/")}`));
  }
});

test("runtime loading is explicit and published observation routes wait for runtime identity", () => {
  assert.match(renderer, /runtime\.status === "loading"/);
  assert.match(renderer, /正在载入内容/);
  assert.match(app, /resolveRuntimeObservation\(slug, runtime\.data\)/);
  assert.match(app, /runtime\.status === "loading"/);
});
