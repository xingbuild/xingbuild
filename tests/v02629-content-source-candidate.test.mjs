import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { homeContent as legacyHomeContent } from "../src/content/siteContent.js";
import {
  contentSetEntryFromCanonical,
  createContentSetCandidate,
  prepareContentSetCandidate,
} from "../scripts/lib/content-set-candidate.mjs";
import {
  homeContentHash,
  readCanonicalHomeContent,
} from "../scripts/lib/home-content-adapter.mjs";
import { projectRoot } from "../scripts/lib/content-root.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "xingbuild-v02629-candidate-"));
  await mkdir(path.join(directory, "content/registry"), { recursive: true });
  await mkdir(path.join(directory, ".content-workspace/content"), { recursive: true });
  await cp(path.join(projectRoot, "content/registry/content-targets.json"), path.join(directory, "content/registry/content-targets.json"));
  for (const relative of [
    "home.json",
    "products/robotaxi.json",
    "media/robotaxi/manifest.json",
    "articles/enterprise-operating-system.json",
    "profile/about.json",
  ]) {
    await mkdir(path.dirname(path.join(directory, ".content-workspace/content", relative)), { recursive: true });
    await cp(path.join(projectRoot, ".content-workspace/content", relative), path.join(directory, ".content-workspace/content", relative));
  }
  await cp(path.join(projectRoot, ".content-workspace/content-state"), path.join(directory, ".content-workspace/content-state"), { recursive: true });
  return directory;
}

test("Home Candidate reads canonical home.json, never the product-only legacy fallback", async () => {
  const directory = await fixture();
  try {
    const canonical = await readCanonicalHomeContent({ sourceRoot: directory });
    assert.notDeepEqual(canonical.value, legacyHomeContent);
    const entry = await contentSetEntryFromCanonical({
      sourceRoot: directory,
      kind: "home",
      target: "home",
      reviewProof: { status: "approved" },
    });
    assert.equal(entry.sourcePath, "content/home.json");
    assert.equal(entry.contentHash, canonical.valueHash);
    assert.deepEqual(entry.sourceProof, ["canonical:content/home.json"]);
    assert.equal(homeContentHash(canonical.value), entry.contentHash);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing or invalid canonical Home source fails before Candidate write", async () => {
  const directory = await fixture();
  try {
    const home = path.join(directory, ".content-workspace/content/home.json");
    const setsBefore = await readdir(path.join(directory, ".content-workspace/content-state/sets"));
    await rm(home);
    await assert.rejects(
      () => contentSetEntryFromCanonical({ sourceRoot: directory, kind: "home", target: "home" }),
      (error) => error.code === "CONTENT_HOME_SOURCE_MISSING",
    );
    await writeFile(home, "{ invalid\n");
    await assert.rejects(
      () => contentSetEntryFromCanonical({ sourceRoot: directory, kind: "home", target: "home" }),
      (error) => error.code === "CONTENT_HOME_SOURCE_INVALID_JSON",
    );
    await writeFile(home, JSON.stringify({ description: "", homeTitle: "", emptyStates: { observations: { message: "m", description: "e" } } }));
    await assert.rejects(
      () => contentSetEntryFromCanonical({ sourceRoot: directory, kind: "home", target: "home" }),
      (error) => error.code === "CONTENT_HOME_SOURCE_INVALID_VALUE",
    );
    const sets = await readdir(path.join(directory, ".content-workspace/content-state/sets"));
    assert.deepEqual(sets.sort(), setsBefore.sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Home Candidate rejects a supplied value that is not derived from canonical source", async () => {
  const directory = await fixture();
  try {
    await assert.rejects(
      () => contentSetEntryFromCanonical({
        sourceRoot: directory,
        kind: "home",
        target: "home",
        contentValue: { description: "漂移", homeTitle: "漂移", emptyStates: { observations: { message: "m", description: "e" } } },
      }),
      (error) => error.code === "CONTENT_HOME_SOURCE_MAPPING_MISMATCH",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("four confirmed targets merge into one Candidate and preserve unchanged identities", async () => {
  const directory = await fixture();
  try {
    const specs = [
      ["home", "home"],
      ["practice", "robotaxi"],
      ["article", "enterprise-operating-system"],
      ["profile", "about"],
    ];
    const entries = [];
    for (const [kind, target] of specs) {
      entries.push(await contentSetEntryFromCanonical({
        sourceRoot: directory,
        kind,
        target,
        reviewProof: { status: "approved" },
        sourceProof: [`canonical:${kind}/${target}`],
      }));
    }
    assert.deepEqual(entries[0].sourceProof, ["canonical:content/home.json"]);
    const activeBefore = JSON.parse(await readFile(path.join(directory, ".content-workspace/content-state/active.json"), "utf8"));
    const activeSet = JSON.parse(await readFile(path.join(directory, ".content-workspace/content-state/sets", activeBefore.activeContentSetId, "content-set.json"), "utf8"));
    const candidate = await prepareContentSetCandidate({
      sourceRoot: directory,
      entries,
      homeContent: (await readCanonicalHomeContent({ sourceRoot: directory })).value,
    });
    assert.equal(new Set(candidate.contentSet.entries.map((entry) => entry.entryId)).size, candidate.contentSet.entries.length);
    for (const entry of entries) assert.equal(candidate.contentSet.entries.some((item) => item.entryId === entry.entryId && item.contentHash === entry.contentHash), true);
    assert.equal(homeContentHash(candidate.contentSet.homeContent), candidate.contentSet.entries.find((entry) => entry.entryId === "home:home").contentHash);
    const unchangedId = "observation:zoox-smoke-scene-recall";
    assert.deepEqual(
      candidate.contentSet.entries.find((entry) => entry.entryId === unchangedId),
      activeSet.entries.find((entry) => entry.entryId === unchangedId),
    );
    const activeAfter = await readFile(path.join(directory, ".content-workspace/content-state/active.json"), "utf8");
    assert.equal(activeAfter, JSON.stringify(activeBefore, null, 2) + "\n");
    const canonicalHome = (await readCanonicalHomeContent({ sourceRoot: directory })).value;
    await assert.rejects(
      () => prepareContentSetCandidate({ sourceRoot: directory, entries: [entries[0], entries[0]], homeContent: canonicalHome }),
      (error) => error.code === "CONTENT_CANDIDATE_DUPLICATE_ENTRY",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
