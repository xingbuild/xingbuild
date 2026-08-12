import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readPublishedArticles, validateEvergreenArticle } from "../scripts/lib/evergreen-article.mjs";

const app = await readFile(new URL("../src/App.jsx", import.meta.url), "utf8");
const page = await readFile(new URL("../src/pages/FrameworkPage.jsx", import.meta.url), "utf8");
const articleComponent = await readFile(new URL("../src/components/reading/EvergreenArticle.jsx", import.meta.url), "utf8");
const toc = await readFile(new URL("../src/components/reading/ReadingTOC.jsx", import.meta.url), "utf8");
const richDocument = await readFile(new URL("../src/components/reading/RichDocument.jsx", import.meta.url), "utf8");
const architectureReader = await readFile(new URL("../src/components/reading/EnterpriseArchitectureViews.jsx", import.meta.url), "utf8");
const layout = await readFile(new URL("../src/styles/layout.css", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles/components.css", import.meta.url), "utf8");
const articleScope = await readFile(new URL("../scripts/article-scope-check.mjs", import.meta.url), "utf8");

test("enterprise operating system is a content-driven evergreen article", async () => {
  const [article] = await readPublishedArticles();
  assert.equal(article.slug, "enterprise-operating-system");
  assert.deepEqual(await validateEvergreenArticle(article), []);
  assert.deepEqual(article.blocks.filter((block) => block.type === "heading" && block.level === 2).map((block) => block.id), [
    "enterprise-operating-system", "system-boundary", "operating-and-architecture-design", "digital-implementation", "operations-facts-results", "analysis-and-feedback", "sources-and-fact-boundary",
  ]);
  assert.ok(article.blocks.some((block) => block.type === "figure" && block.renderer === "likec4" && block.layoutPreset === "reader" && block.sourcePath.endsWith(".c4") && !block.src && !block.mobileSrc));
  assert.deepEqual(article.blocks.filter((block) => block.type === "architectureViews").map((block) => block.id), ["enterprise-architecture-views"]);
  assert.match(page, /<EvergreenArticle article=\{article\}/);
  assert.match(articleComponent, /<ReadingTOC blocks=\{article\.blocks\}/);
  assert.match(articleComponent, /<RichDocument blocks=\{article\.blocks\}/);
});

test("public framework route no longer reads an architecture graph runtime", () => {
  assert.doesNotMatch(page, /FrameworkExplorer|ArchitectureExplorer|FrameworkGraphRuntime|frameworkModel/);
  assert.doesNotMatch(app, /frameworkModel|FrameworkExplorer|ArchitectureExplorer/);
  assert.match(app, /navigate\("\/business-observations#digital-implementation", \{ replace: true, scroll: false \}\)/);
  assert.match(architectureReader, /LikeC4Reader/);
  assert.doesNotMatch(architectureReader, /ArchitectureExplorer|FrameworkGraphRuntime/);
});

test("the shared TOC uses anchors, desktop sticky navigation and native mobile details", () => {
  assert.match(toc, /IntersectionObserver/);
  assert.match(toc, /<details/);
  assert.match(toc, /detailsRef\.current\.open = false/);
  assert.match(toc, /href=\{`#\$\{heading\.id\}`\}/);
  assert.match(layout, /\.evergreen-article__reading \{ display: grid; grid-template-columns/);
  assert.match(layout, /\.evergreen-article__reading > \.reading-toc \{ position: sticky/);
  assert.match(layout, /\.evergreen-article__reading > \.mobile-toc \{ display: block;/);
  assert.match(styles, /scroll-margin-top: calc\(var\(--header-height\)/);
});

test("responsive figures project only approved static SVG sources", () => {
  assert.match(richDocument, /<picture>/);
  assert.match(richDocument, /diagramFigureAssets\(block\.sourcePath\)/);
  assert.match(richDocument, /assets\.mobile/);
  assert.match(styles, /\.rich-document__figure picture, \.rich-document__figure img/);
});

test("a declared figure needs only a source and semantic metadata for both responsive outputs", async () => {
  const generator = await readFile(new URL("../scripts/generate-evergreen-figures.mjs", import.meta.url), "utf8");
  assert.match(generator, /const adapters = \{ likec4: renderLikeC4, mermaid: renderMermaid \}/);
  assert.match(generator, /diagramFigureAssets\(figure\.sourcePath\)/);
  assert.doesNotMatch(generator, /figure\.mobileSrc|figure\.src/);
  assert.doesNotMatch(generator, /d2:\s*render/);
  assert.match(generator, /runQaBrowserCommand/);
  assert.doesNotMatch(generator, /MERMAID_PUPPETEER_EXECUTABLE_PATH/);
  assert.doesNotMatch(generator, /puppeteer\.launch/);
});

test("a Mermaid source alone generates both responsive SVG outputs and removes stale output on failure", async () => {
  const output = await mkdtemp(path.join(tmpdir(), "xingbuild-mermaid-fixture-"));
  const run = (article) => execFileSync("node", ["scripts/generate-evergreen-figures.mjs", "--article", article, "--output", output], { cwd: new URL("..", import.meta.url), encoding: "utf8", stdio: "pipe" });
  try {
    const success = run("tests/fixtures/evergreen/mermaid-reader-article.json");
    assert.match(success, /Generated 1 responsive evergreen diagram/);
    const manifest = JSON.parse(await readFile(path.join(output, "figures/diagram-manifest.json"), "utf8"));
    const record = manifest.figures["src/architecture/fixtures/mermaid-reader.mmd"];
    assert.equal(record.renderer, "mermaid");
    await access(path.join(output, record.desktop));
    await access(path.join(output, record.mobile));
    const stale = path.join(output, "figures/fixtures/invalid-mermaid.svg");
    await writeFile(stale, "stale");
    assert.throws(() => run("tests/fixtures/evergreen/invalid-mermaid-article.json"));
    await assert.rejects(access(stale));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test("product build manifest excludes independent evergreen publication", async () => {
  const manifest = JSON.parse(await readFile(new URL("../dist/client/content-manifest.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(manifest.publishedSlugs));
  assert.deepEqual(manifest.publishedArticleSlugs, []);
});

test("future article publication is explicit and uses the independent content boundary", () => {
  assert.match(articleScope, /Usage: npm run article:scope-check -- --slug <slug>/);
  assert.match(articleScope, /content\/articles\/\$\{slug\}\.json/);
  assert.doesNotMatch(articleScope, /evaluateUnifiedReleaseReadiness|unified-release/);
});
