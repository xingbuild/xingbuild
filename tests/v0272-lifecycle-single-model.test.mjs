import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createHash } from "node:crypto";
import { activateContentSet, createContentSet, readActiveContentSet, writeContentSet } from "../scripts/lib/content-set.mjs";
import { createContentSetCandidate, prepareContentSetCandidate } from "../scripts/lib/content-set-candidate.mjs";
import {
  assertDurableSitePublicationRecord,
  createContentChangeSet,
  createDeterministicSiteSnapshot,
  sanitizeDurableSitePublicationRecord,
} from "../scripts/lib/content-lifecycle-governance.mjs";

const product = {
  artifactContractVersion: "product-artifact-v1",
  productArtifactId: "v0.27.2-aaaaaaaaaaaa",
  productVersion: "v0.27.2",
  productCommit: "a".repeat(40),
  baseSiteArtifactId: "v0.27.2-aaaaaaaaaaaa",
  productArtifactHash: "b".repeat(64),
};

function entry(target, contentHash, extra = {}) {
  return {
    entryId: `observation:${target}`,
    kind: "observation",
    target,
    sourcePath: `content/observations/${target}.json`,
    route: `/observations/${target}`,
    contentHash,
    sourceProof: ["source-proof-is-not-the-source"],
    reviewProof: { status: "approved", reviewId: `review-${target}` },
    mediaProof: [],
    ...extra,
  };
}

test("V272-01 uses the sole site-snapshot-v1 identity source", () => {
  const contentSet = createContentSet({ entries: [entry("demo", "a".repeat(64))], createdAt: "2026-08-15T00:00:00.000Z" });
  const snapshot = createDeterministicSiteSnapshot({
    productArtifact: product,
    contentSet,
    manifest: { contentSetId: contentSet.contentSetId, contentSetHash: contentSet.contentSetHash },
  });
  assert.equal(snapshot.schemaVersion, "site-snapshot-v1");
  assert.equal(Object.hasOwn(snapshot, "manifest"), false);
});

test("V272-03 sourceHash is canonical source bytes and ignores proof wording", () => {
  const before = [entry("demo", "a".repeat(64))];
  const after = [entry("demo", "b".repeat(64), { sourceProof: ["changed-proof-label"] })];
  const sourceBytes = Buffer.from('{"text":"canonical"}\n');
  const sourceHash = createHash("sha256").update(sourceBytes).digest("hex");
  const first = createContentChangeSet({ beforeEntries: before, afterEntries: after, sourceHashes: { "observation:demo": sourceHash } });
  const second = createContentChangeSet({ beforeEntries: before, afterEntries: [entry("demo", "b".repeat(64), { sourceProof: ["another-proof-label"] })], sourceHashes: { "observation:demo": sourceHash } });
  assert.equal(first.changes[0].revision.sourceHash, sourceHash);
  assert.equal(first.changes[0].revision.sourceHash, second.changes[0].revision.sourceHash);
});

test("V272-02 candidate and ChangeSet failure injection leaves no half-written files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0272-atomic-"));
  const active = createContentSet({ entries: [entry("demo", "a".repeat(64))], createdAt: "2026-08-15T00:00:00.000Z" });
  await writeContentSet({ sourceRoot: root, contentSet: active });
  await activateContentSet({ sourceRoot: root, nextContentSetId: active.contentSetId, expectedContentSetId: null, now: "2026-08-15T00:00:00.000Z" });
  await assert.rejects(() => prepareContentSetCandidate({
    sourceRoot: root,
    entries: [entry("demo", "b".repeat(64))],
    previousContentSetId: active.contentSetId,
    createdAt: "2026-08-15T00:00:01.000Z",
    failAfter: "candidate",
  }), /injected candidate\/change-set commit failure/);
  const state = await readdir(path.join(root, ".content-workspace"), { withFileTypes: true });
  assert.equal(state.some((item) => item.name === "changes"), true);
  const changes = await readdir(path.join(root, ".content-workspace", "changes"));
  assert.deepEqual(changes, []);
  const sets = await readdir(path.join(root, ".content-workspace", "content-state", "sets"));
  assert.deepEqual(sets, [active.contentSetId]);
  assert.equal((await readActiveContentSet({ sourceRoot: root })).contentSet.contentSetId, active.contentSetId);
});

test("V272-04 no target change reuses active identity and writes no new input", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0272-nochange-"));
  const active = createContentSet({ entries: [entry("demo", "a".repeat(64))], createdAt: "2026-08-15T00:00:00.000Z" });
  await writeContentSet({ sourceRoot: root, contentSet: active });
  await activateContentSet({ sourceRoot: root, nextContentSetId: active.contentSetId, expectedContentSetId: null, now: "2026-08-15T00:00:00.000Z" });
  const result = await prepareContentSetCandidate({ sourceRoot: root, entries: [entry("demo", "a".repeat(64))], previousContentSetId: active.contentSetId, createdAt: "2026-08-15T00:00:01.000Z" });
  assert.equal(result.noChanges, true);
  assert.equal(result.contentSet.contentSetId, active.contentSetId);
  assert.equal(result.changeSet, null);
  assert.equal((await readdir(path.join(root, ".content-workspace", "content-state", "sets"))).length, 1);
});

test("V272-05 durable readback rejects duplicated runtime evidence", () => {
  const durable = sanitizeDurableSitePublicationRecord({
    sitePublicationId: "publication-demo",
    publicVerify: { verified: true, verificationEvidence: { schemaVersion: "publication-runtime-evidence-v4" } },
    client: "/tmp/client",
  });
  assert.doesNotThrow(() => assertDurableSitePublicationRecord(durable));
  assert.equal(Object.hasOwn(durable.publicVerify, "verificationEvidence"), false);
  assert.throws(() => assertDurableSitePublicationRecord({ ...durable, publicVerify: { verificationEvidence: {} } }), /cannot persist publicVerify.verificationEvidence/);
});
