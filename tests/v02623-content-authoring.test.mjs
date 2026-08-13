import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileResponsiveAuthoringValue,
  decompileResponsiveAuthoringValue,
  compileAuthoringValue,
} from "../scripts/lib/content-authoring.mjs";
import { listContentPreviewTargetIds, resolveContentPreviewTargetImpact } from "../scripts/lib/content-preview.mjs";
import { resolveContentTarget } from "../scripts/lib/content-targets.mjs";

test("authoring compiler keeps one semantic text with independent Web/Mobile line breaks", () => {
  const value = compileResponsiveAuthoringValue({
    text: "第一段文字\n第二段文字",
    mobileText: "第一段\n文字第二段文字",
    projectionKeys: ["home.productHero.intro", "products.productHero.intro"],
  });
  assert.deepEqual(decompileResponsiveAuthoringValue(value, {
    projectionKeys: ["home.productHero.intro", "products.productHero.intro"],
  }), {
    schemaVersion: "content-authoring-value-v1",
    valueType: "responsive-text-slot-v1",
    text: "第一段文字\n第二段文字",
    mobileText: "第一段\n文字第二段文字",
    projection: "home.productHero.intro",
  });
  assert.deepEqual(value.projections["products.productHero.intro"], value.projections["home.productHero.intro"]);
});

test("authoring compiler rejects semantic drift and empty lines", () => {
  assert.throws(() => compileResponsiveAuthoringValue({ text: "同一内容", mobileText: "不同内容", projectionKeys: ["products.productHero.intro"] }), /same characters/);
  assert.throws(() => compileResponsiveAuthoringValue({ text: "第一行\n\n第二行", projectionKeys: ["products.productHero.intro"] }), /empty lines/);
  assert.throws(() => compileAuthoringValue({ text: "   ", valueType: "string" }), /non-empty/);
});

test("all-page target inventory includes every page domain and resolves real consumer views", async () => {
  const ids = await listContentPreviewTargetIds();
  for (const targetId of [
    "site.home.homeTitle",
    "site.home.description",
    "products.robotaxi.intro",
    "products.robotaxi.why.item.transferability.text",
    "articles.enterprise-operating-system.title",
    "profile.about.title",
  ]) assert.ok(ids.includes(targetId), `missing target ${targetId}`);
  const target = await resolveContentTarget("products.robotaxi.intro");
  const impact = resolveContentPreviewTargetImpact(target);
  assert.deepEqual(impact.consumerViews, [
    { route: "/", viewport: "web-1280" },
    { route: "/", viewport: "mobile-390" },
    { route: "/products", viewport: "web-1280" },
    { route: "/products", viewport: "mobile-390" },
  ]);
});
