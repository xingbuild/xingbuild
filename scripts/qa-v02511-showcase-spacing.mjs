import assert from "node:assert/strict";
import puppeteer from "puppeteer";
import { withQaBrowser } from "./lib/qa-browser-runtime.mjs";

const baseUrl = process.env.XINGBUILD_PREVIEW_URL || "http://127.0.0.1:4317";

function geometry(page) {
  return page.evaluate(() => {
    const list = document.querySelector(".practice-module-list");
    const modules = [...document.querySelectorAll(".showcase-module")];
    const rect = (element) => {
      const value = element?.getBoundingClientRect();
      return value ? { top: value.top, bottom: value.bottom, left: value.left, right: value.right } : null;
    };
    const style = (element) => {
      const value = element ? getComputedStyle(element) : null;
      return value ? { gap: value.gap, rowGap: value.rowGap, marginTop: value.marginTop } : null;
    };
    const moduleGeometry = modules.map((module) => {
      const copy = module.querySelector(".showcase-module__copy");
      const media = module.querySelector(".media-stage, .system-stage");
      return {
        rect: rect(module),
        copy: rect(copy),
        media: rect(media),
        style: style(module),
      };
    });
    return {
      viewport: { width: innerWidth, height: innerHeight },
      list: { rect: rect(list), style: style(list) },
      modules: moduleGeometry,
      legacyPracticeModuleCount: document.querySelectorAll(".practice-module").length,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}

function assertRange(value, min, max, label) {
  assert.ok(value >= min - 0.5 && value <= max + 0.5, `${label} expected ${min}-${max}px, got ${value}px`);
}

function assertContract(snapshot, { copyMin, copyMax, moduleMin, moduleMax }) {
  assert.equal(snapshot.legacyPracticeModuleCount, 0, "legacy .practice-module must not own Showcase geometry");
  assert.equal(snapshot.modules.length, 4, "QA fixture must render four independent Showcase modules");
  assert.ok(snapshot.scrollWidth <= snapshot.viewport.width, "Showcase must not overflow horizontally");
  const listGap = Number.parseFloat(snapshot.list.style.rowGap);
  assertRange(listGap, moduleMin, moduleMax, "practice-module-list gap");
  for (const [index, module] of snapshot.modules.entries()) {
    const copyToMedia = snapshot.viewport.width <= 932
      ? module.media.top - module.copy.bottom
      : module.media.left - module.copy.right;
    assertRange(copyToMedia, copyMin, copyMax, `module ${index + 1} copy→media`);
    assert.equal(Number.parseFloat(module.style.marginTop), 0, `module ${index + 1} must not add sibling margin`);
    if (index > 0) {
      const moduleSpacing = module.rect.top - snapshot.modules[index - 1].rect.bottom;
      assertRange(moduleSpacing, moduleMin, moduleMax, `module ${index}→${index + 1}`);
    }
  }
}

await withQaBrowser({ puppeteer, taskId: "qa-v02511-showcase-spacing" }, async ({ browser }) => {
  const page = await browser.newPage();
  const evidence = [];
  for (const viewport of [{ width: 1600, height: 1067 }, { width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewport(viewport);
    await page.goto(`${baseUrl}/products`, { waitUntil: "networkidle0" });
    const snapshot = await geometry(page);
    assertContract(snapshot, viewport.width <= 932
      ? { copyMin: 20, copyMax: 24, moduleMin: 56, moduleMax: 72 }
      : { copyMin: 48, copyMax: 48, moduleMin: 96, moduleMax: 120 });
    evidence.push(snapshot);
  }
  console.log(JSON.stringify({ ok: true, evidence }, null, 2));
});
