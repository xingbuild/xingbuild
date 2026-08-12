#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Graphviz } from "@hpcc-js/wasm-graphviz";
import { diagramFigureAssets } from "../src/content/diagramFigureAssets.js";
import { readPublishedArticles, root } from "./lib/evergreen-article.mjs";
import { runQaBrowserCommand } from "./lib/qa-browser-runtime.mjs";

const run = promisify(execFile);
const args = process.argv.slice(2);
const valueFor = (name) => args[args.indexOf(name) + 1];
const fixtureArticle = valueFor("--article");
const publicDirectory = valueFor("--output") || join(root, "public");
if ((fixtureArticle && !valueFor("--output")) || args.some((arg) => arg.startsWith("--") && !["--article", "--output"].includes(arg))) {
  throw new Error("Usage: node scripts/generate-evergreen-figures.mjs [--article <fixture.json> --output <directory>]");
}

function safeSvg(svg) {
  if (/<(?:script|foreignObject|iframe|object|embed)\b/i.test(svg) || /(?:href|xlink:href)=["'](?:https?:|data:|javascript:)/i.test(svg)) throw new Error("Generated SVG contains disallowed executable or external content");
  return svg.replace(/<\?xml[^>]*>\s*/i, "");
}
function readerDot(dot) {
  return dot.replace(/label=<<TABLE[\s\S]*?POINT-SIZE="20">([^<]+)<[\s\S]*?<\/TABLE>>/g, 'label="$1"')
    .replace(/color="#2563eb"/g, 'color="#7d2f19"').replace(/fillcolor="#3b82f6"/g, 'fillcolor="#f1e8dc"')
    .replace(/fontcolor="#eff6ff"/g, 'fontcolor="#3b2c21"').replace(/color="#8D8D8D"/g, 'color="#60564b"').replace(/fontcolor="#C9C9C9"/g, 'fontcolor="#60564b"');
}
function mobileDot(dot) { return dot.replace(/nodesep=[\d.]+/, "nodesep=0.55").replace(/ranksep=[\d.]+/, "ranksep=0.72").replace(/fontsize=20/, "fontsize=16").replace(/fontsize=14/, "fontsize=12").replace(/POINT-SIZE="20"/g, 'POINT-SIZE="16"').replace(/POINT-SIZE="15"/g, 'POINT-SIZE="12"'); }
async function renderLikeC4(figure, assets) {
  const temp = await mkdtemp(join(tmpdir(), "xingbuild-evergreen-"));
  try {
    await run(join(root, "node_modules/.bin/likec4"), ["gen", "dot", "--outdir", temp, dirname(join(root, figure.sourcePath))]);
    const dotFile = (await readdir(temp)).find((file) => file !== "index.dot" && file.endsWith(".dot"));
    if (!dotFile) throw new Error(`LikeC4 did not generate a view for ${figure.sourcePath}`);
    const dot = await readFile(join(temp, dotFile), "utf8");
    const graphviz = await Graphviz.load();
    await mkdir(dirname(join(publicDirectory, assets.desktop)), { recursive: true });
    const readerSource = readerDot(dot);
    await Promise.all([writeFile(join(publicDirectory, assets.desktop), safeSvg(graphviz.layout(readerSource, "svg", "dot"))), writeFile(join(publicDirectory, assets.mobile), safeSvg(graphviz.layout(mobileDot(readerSource), "svg", "dot")))]);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
async function renderMermaid(figure, assets) {
  const source = join(root, figure.sourcePath);
  await mkdir(dirname(join(publicDirectory, assets.desktop)), { recursive: true });
  const command = join(root, "node_modules/.bin/mmdc");
  await runQaBrowserCommand(command, ["-i", source, "-o", join(publicDirectory, assets.desktop), "-w", "1600", "-b", "transparent"], { taskId: `article-figure-desktop-${figure.sourcePath}` });
  await runQaBrowserCommand(command, ["-i", source, "-o", join(publicDirectory, assets.mobile), "-w", "640", "-b", "transparent"], { taskId: `article-figure-mobile-${figure.sourcePath}` });
}
const adapters = { likec4: renderLikeC4, mermaid: renderMermaid };
const articles = fixtureArticle ? [JSON.parse(await readFile(join(root, fixtureArticle), "utf8"))] : await readPublishedArticles();
const figures = articles.flatMap((article) => article.blocks.filter((block) => block.type === "figure"));
const manifest = { figures: {} };
for (const figure of figures) {
  const assets = diagramFigureAssets(figure.sourcePath);
  if (!assets || !adapters[figure.renderer]) throw new Error(`Unsupported diagram source: ${figure.sourcePath}`);
  await Promise.all([rm(join(publicDirectory, assets.desktop), { force: true }), rm(join(publicDirectory, assets.mobile), { force: true })]);
  await adapters[figure.renderer](figure, assets);
  manifest.figures[figure.sourcePath] = { renderer: figure.renderer, layoutPreset: figure.layoutPreset, sourceHash: createHash("sha256").update(await readFile(join(root, figure.sourcePath))).digest("hex"), ...assets };
}
await mkdir(join(publicDirectory, "figures"), { recursive: true });
await writeFile(join(publicDirectory, "figures/diagram-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Generated ${figures.length} responsive evergreen diagram figure(s) from declared sources`);
