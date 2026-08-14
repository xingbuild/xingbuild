import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { normalizeLongFormDocument, LONG_FORM_DOCUMENT_SCHEMA } from "../src/content/longFormDocument.js";
import { readContentTargetRegistry, resolveContentTarget } from "../scripts/lib/content-targets.mjs";

const root = new URL("../", import.meta.url).pathname;

test("About and evergreen article share the long-form-document-v1 adapter without source migration", async () => {
  const [about, article] = await Promise.all([
    import("../src/content/profileRepository.js"),
    import("../src/content/evergreenArticleRepository.js"),
  ]);
  assert.equal(about.profile, null, "product-only module must stay content isolated");
  assert.equal(article.evergreenArticles.length, 0, "product-only module must stay content isolated");
  const normalized = normalizeLongFormDocument({
    id: "about",
    title: "关于我",
    summary: "摘要",
    blocks: [
      { id: "intro", type: "paragraph", text: ["第一段", "第二段"] },
      { id: "list", type: "list", items: [{ id: "item-one", text: "一项" }] },
    ],
  });
  assert.equal(normalized.schemaVersion, LONG_FORM_DOCUMENT_SCHEMA);
  assert.deepEqual(normalized.blocks[0].text, ["第一段", "第二段"]);
  assert.throws(
    () => normalizeLongFormDocument({ id: "about", title: "关于我", blocks: [{ id: "duplicate", type: "paragraph", text: "一" }, { id: "duplicate", type: "paragraph", text: "二" }] }),
    (error) => error.code === "LONG_FORM_DOCUMENT_DUPLICATE_ID",
  );
});
test("visible content domains have registered target coverage and real consumer routes", async () => {
  const registry = await readContentTargetRegistry({ rootDirectory: root });
  const templateIds = new Set(registry.templates.map((template) => template.targetIdPattern));
  for (const required of [
    "site.home.homeTitle",
    "products.robotaxi.intro",
    "products.robotaxi.module.{moduleId}.shortDescription",
    "articles.enterprise-operating-system.block.{blockId}.text",
    "profile.about.block.{blockId}.text",
    "observations.{slug}.brief.subject",
    "observations.{slug}.brief.statement",
  ]) {
    assert.ok(templateIds.has(required) || registry.targets.some((target) => target.targetId === required), `missing visible target ${required}`);
  }
  assert.deepEqual((await resolveContentTarget("products.robotaxi.title", { rootDirectory: root })).projectionRoutes, ["/", "/products"]);
  assert.deepEqual((await resolveContentTarget("observations.nhtsa-first-responder-requirement.brief.statement", { rootDirectory: root })).projectionRoutes, ["/", "/business-observations", "/observations", "/observations/nhtsa-first-responder-requirement"]);
});

test("optional projections and resume contract do not leave placeholder DOM", async () => {
  const renderer = await readFile(new URL("../src/components/page-compositions/PageCompositionRenderer.jsx", import.meta.url), "utf8");
  const resume = await readFile(new URL("../src/components/profile/ResumeActions.jsx", import.meta.url), "utf8");
  const richDocument = await readFile(new URL("../src/components/reading/RichDocument.jsx", import.meta.url), "utf8");
  const pages = await readFile(new URL("../src/styles/pages.css", import.meta.url), "utf8");
  assert.match(renderer, /about\.summary \? <p/);
  assert.match(renderer, /about\.blocks\?\.some\(\(block\) => block\.id === "resume"\)/);
  assert.match(richDocument, /if \(!showFigures\) return null/);
  assert.match(richDocument, /showArchitectureViews \?/);
  assert.match(resume, /查看简历/);
  assert.match(resume, /下载简历/);
  assert.doesNotMatch(resume, /查看简历 HTML|下载简历 PDF|已核验简历制品/);
  assert.match(resume, /downloadName/);
  assert.match(pages, /home-page__latest-briefs[^}]*margin-top: var\(--rhythm-section-entry\)/);
});
