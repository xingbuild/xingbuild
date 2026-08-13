import assert from "node:assert/strict";
import { test } from "node:test";
import { listContentPreviewTargetIds } from "../scripts/lib/content-preview.mjs";
import { readContentAuthoringTarget } from "../scripts/lib/content-preview-authoring.mjs";
import { compileAuthoringValue, RICH_TEXT_LIST_SCHEMA } from "../scripts/lib/content-authoring.mjs";

test("content preview enumerates authored article, profile, and observation body text", async () => {
  const ids = new Set(await listContentPreviewTargetIds());
  for (const id of [
    "articles.enterprise-operating-system.block.lead.text",
    "profile.about.block.problems-list.item.business-objects.text",
    "observations.baidu-apollo-go-q1-2026-update.brief.body",
    "observations.baidu-apollo-go-q1-2026-update.rangeAndFacts.text",
    "observations.baidu-apollo-go-q1-2026-update.evidence.evidence-baidu-q1-rides.claim",
  ]) assert.ok(ids.has(id), `missing body target ${id}`);
});

test("rich text list authoring keeps paragraph boundaries without changing the page schema", async () => {
  const target = await readContentAuthoringTarget("observations.baidu-apollo-go-q1-2026-update.rangeAndFacts.text");
  assert.equal(target.valueType, RICH_TEXT_LIST_SCHEMA);
  assert.match(target.authoring.text, /Baidu披露/);
  assert.deepEqual(compileAuthoringValue({ valueType: RICH_TEXT_LIST_SCHEMA, text: "第一段\n第二段", maxLength: 100 }), ["第一段", "第二段"]);
});
