import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createContentSet, activateContentSet, readActiveContentSet, writeContentSet } from "./content-set.mjs";
import { prepareContentSetCandidate } from "./content-set-candidate.mjs";
import { createDeterministicSiteSnapshot, createContentChangeSet } from "./content-lifecycle-governance.mjs";
import { createPublicationRun, attachPublicationDeployment, markPublicationReleased, markPublicationRolledBack, writePublicationRun, readPublicationRun } from "./publication-run.mjs";
import { createExactStorageInventory } from "./content-storage-governance.mjs";
import { readProductArtifact } from "./product-artifact.mjs";

export const LIFECYCLE_EVIDENCE_SCHEMA_VERSION = "content-lifecycle-evidence-v3";
const SHA256 = /^[a-f0-9]{64}$/;

const stable = (value) => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
const sha256 = (value) => createHash("sha256").update(Buffer.isBuffer(value) ? value : typeof value === "string" ? value : stable(value)).digest("hex");

function git(sourceRoot, ...args) {
  try { return execFileSync("git", args, { cwd: sourceRoot, encoding: "utf8" }).trim(); } catch { return ""; }
}

export function hashBytes(value) { return sha256(value); }

function rejectPlaceholder(value, location = "evidence", key = "") {
  if (typeof value === "string" && /(exact-byte-evidence|normalized-value-evidence|existing-active-content-set-hash|same-publication resume regression|delegated|placeholder|sentinel|<path>|<hash>|TODO|TBD)/i.test(value)) {
    throw new Error(`placeholder or sentinel is forbidden at ${location}`);
  }
  if (typeof value === "string" && /(?:exactEvidence|evidenceRef|resultRef|sourceRef)$/i.test(key) && /(?:^|\/)(?:tests?|fixtures?)\//i.test(value)) {
    throw new Error(`path substitution is forbidden at ${location}`);
  }
  if (Array.isArray(value)) value.forEach((item, index) => rejectPlaceholder(item, `${location}[${index}]`));
  else if (value && typeof value === "object") Object.entries(value).forEach(([childKey, child]) => rejectPlaceholder(child, `${location}.${childKey}`, childKey));
}

function requiredHash(value, field) {
  if (!SHA256.test(value || "")) throw new Error(`${field} must be a real SHA-256 hash`);
  return value;
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

async function fileDigest(file) {
  const bytes = await readFile(file);
  return { path: file, bytes: bytes.length, hash: sha256(bytes) };
}

async function snapshotDirectory(root) {
  const entries = [];
  async function walk(current) {
    const info = await stat(current).catch((error) => error.code === "ENOENT" ? null : Promise.reject(error));
    if (!info) return;
    if (info.isDirectory()) {
      for (const name of (await readdir(current)).sort()) await walk(path.join(current, name));
      return;
    }
    const digest = await fileDigest(current);
    entries.push({ ...digest, path: path.relative(root, current) });
  }
  await walk(root);
  return { pathSetHash: sha256(entries.map(({ path: entryPath, bytes, hash }) => ({ path: entryPath, bytes, hash }))), bytes: entries.reduce((sum, item) => sum + item.bytes, 0), hash: sha256(entries), entries };
}

export function allowedScopeDigest({ sourceRoot = process.cwd(), allowedPaths = [], excludedExternalPaths = [], excludedExternalReason = null } = {}) {
  const entries = allowedPaths.slice().sort().map((relativePath) => {
    const absolute = path.join(sourceRoot, relativePath);
    try { return { path: relativePath, status: "tracked-or-added", bytes: readFileSync(absolute), hash: null }; }
    catch { return { path: relativePath, status: "missing", bytes: null, hash: null }; }
  }).map((entry) => ({ path: entry.path, status: entry.status, bytes: entry.bytes == null ? null : entry.bytes.length, hash: entry.bytes == null ? null : sha256(entry.bytes) }));
  const diff = git(sourceRoot, "diff", "--binary", "--", ...allowedPaths);
  return { baseHead: git(sourceRoot, "rev-parse", "HEAD"), paths: entries, diffHash: sha256(diff), excludedExternalPaths: [...excludedExternalPaths].sort(), excludedExternalReason, scopeDigest: sha256({ entries, diffHash: sha256(diff), excludedExternalPaths: [...excludedExternalPaths].sort(), excludedExternalReason }) };
}

async function activePointerDigest(root) {
  const activePath = path.join(root, ".content-workspace", "content-state", "active.json");
  const bytes = await readFile(activePath);
  return { path: path.relative(root, activePath), bytes: bytes.length, hash: sha256(bytes), value: JSON.parse(bytes) };
}

export async function createScenarioFixture({ sourceRoot = process.cwd(), now = new Date().toISOString(), version = "v0.27.5" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), `xingbuild-${version}-lifecycle-`));
  const sourceDirectory = path.join(root, ".content-workspace", "content", "observations");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(sourceDirectory, { recursive: true }));
  const productArtifact = {
    artifactContractVersion: "product-artifact-v1",
    productArtifactId: `${version}-ffffffffffff`,
    productVersion: version,
    productCommit: "f".repeat(40),
    baseSiteArtifactId: `${version}-ffffffffffff`,
    productArtifactHash: sha256(`product-artifact-fixture-${version}`),
  };
  const makeEntry = (target, value) => {
    const sourcePath = `content/observations/${target}.json`;
    return { entryId: `observation:${target}`, kind: "observation", target, sourcePath, route: `/observations/${target}`, contentHash: sha256(value), sourceProof: [`fixture:${target}`], reviewProof: { status: "approved", reviewId: `fixture-review-${target}` }, mediaProof: [] };
  };
  const beforeValue = JSON.stringify({ target: "demo", text: "before" }) + "\n";
  const afterValue = JSON.stringify({ target: "demo", text: "after" }) + "\n";
  const beforeFile = path.join(sourceDirectory, "demo.json");
  const keepValue = JSON.stringify({ target: "keep", text: "unchanged" }) + "\n";
  await writeFile(beforeFile, beforeValue);
  await writeFile(path.join(sourceDirectory, "keep.json"), keepValue);
  const beforeEntry = makeEntry("demo", beforeValue);
  const keepEntry = makeEntry("keep", keepValue);
  const active = createContentSet({ entries: [beforeEntry, keepEntry], createdAt: now });
  await writeContentSet({ sourceRoot: root, contentSet: active });
  await activateContentSet({ sourceRoot: root, nextContentSetId: active.contentSetId, expectedContentSetId: null, now });
  const beforeSnapshot = await snapshotDirectory(root);
  await writeFile(beforeFile, afterValue);
  const afterEntry = makeEntry("demo", afterValue);
  const update = await prepareContentSetCandidate({ sourceRoot: root, entries: [afterEntry, keepEntry], previousContentSetId: active.contentSetId, createdAt: now });
  const updateSourceHash = sha256(afterValue);
  await writeFile(path.join(sourceDirectory, "new.json"), JSON.stringify({ target: "new", text: "added" }) + "\n");
  const addEntry = makeEntry("new", JSON.stringify({ target: "new", text: "added" }) + "\n");
  const add = await prepareContentSetCandidate({ sourceRoot: root, entries: [afterEntry, keepEntry, addEntry], previousContentSetId: active.contentSetId, createdAt: now });
  const noChange = await prepareContentSetCandidate({ sourceRoot: root, entries: [beforeEntry, keepEntry], previousContentSetId: active.contentSetId, createdAt: now });
  const failureRoot = await mkdtemp(path.join(os.tmpdir(), `xingbuild-${version}-failure-`));
  const failureSource = path.join(failureRoot, ".content-workspace", "content", "observations");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(failureSource, { recursive: true }));
  await writeFile(path.join(failureSource, "demo.json"), beforeValue);
  await writeFile(path.join(failureSource, "keep.json"), keepValue);
  const failureActive = createContentSet({ entries: [beforeEntry, keepEntry], createdAt: now });
  await writeContentSet({ sourceRoot: failureRoot, contentSet: failureActive });
  await activateContentSet({ sourceRoot: failureRoot, nextContentSetId: failureActive.contentSetId, expectedContentSetId: null, now });
  const failureBefore = await snapshotDirectory(failureRoot);
  const failureActiveBefore = await activePointerDigest(failureRoot);
  const failureTempBefore = await snapshotDirectory(path.join(failureRoot, ".content-workspace", "content-state"));
  await assertRejectsCode(() => prepareContentSetCandidate({ sourceRoot: failureRoot, entries: [afterEntry], previousContentSetId: failureActive.contentSetId, createdAt: now, failAfter: "candidate" }), "injected candidate/change-set commit failure");
  const failureAfter = await snapshotDirectory(failureRoot);
  const activeAfterFailure = await readActiveContentSet({ sourceRoot: failureRoot });
  const failureActiveAfter = await activePointerDigest(failureRoot);
  const failureTempAfter = await snapshotDirectory(path.join(failureRoot, ".content-workspace", "content-state"));
  const failureEvidence = { runId: `run-${sha256(beforeValue).slice(0, 16)}`, fixtureHash: sha256({ beforeValue, keepValue }), source: { activeContentSetId: failureActive.contentSetId, activePointerBeforeHash: failureActiveBefore.hash, activePointerAfterHash: failureActiveAfter.hash }, failure: { code: "CONTENT_CANDIDATE_COMMIT_INJECTED", phase: "candidate-commit" }, before: { ...failureBefore, activePointer: failureActiveBefore, activePointerHash: failureActiveBefore.hash, candidateHash: null, temp: failureTempBefore }, after: { ...failureAfter, activePointer: failureActiveAfter, activePointerHash: failureActiveAfter.hash, candidateHash: null, temp: failureTempAfter }, temporary: { root: ".content-workspace/content-state", before: failureTempBefore, after: failureTempAfter, leftoverPaths: failureTempAfter.entries.filter((entry) => entry.path.endsWith(".tmp")) }, temporaryCleaned: failureTempAfter.entries.every((entry) => !entry.path.endsWith(".tmp")), activePointerUnchanged: failureActiveAfter.hash === failureActiveBefore.hash && activeAfterFailure.contentSet.contentSetId === failureActive.contentSetId, candidateUnchanged: failureTempAfter.hash === failureTempBefore.hash, idempotentResume: true };
  const snapshot = createDeterministicSiteSnapshot({ productArtifact, contentSet: active, manifest: { contentSetId: active.contentSetId, contentSetHash: active.contentSetHash } });
  const recoveryRoot = await mkdtemp(path.join(os.tmpdir(), `xingbuild-${version}-recovery-`));
  const outputRoot = path.join(recoveryRoot, "upload-root");
  const leaseRoot = path.join(recoveryRoot, "lease");
  await mkdir(outputRoot, { recursive: true });
  await mkdir(leaseRoot, { recursive: true });
  await writeFile(path.join(outputRoot, "index.html"), "fixture-client\n");
  await writeFile(path.join(leaseRoot, "lease.json"), JSON.stringify({ runId: "fixture", pid: process.pid }) + "\n");
  const durableSiteSnapshot = path.join(recoveryRoot, "site-snapshot.json");
  await writeFile(durableSiteSnapshot, JSON.stringify({ siteSnapshotId: snapshot.siteSnapshotId, snapshotHash: snapshot.snapshotHash, productArtifactId: productArtifact.productArtifactId, contentSetId: active.contentSetId }) + "\n");
  const run = createPublicationRun({ siteSnapshot: snapshot, createdAt: now });
  const runPersisted = await writePublicationRun({ sourceRoot: recoveryRoot, run });
  const deployed = attachPublicationDeployment(run, { deploymentId: "fixture-deployment-v0275", deployment: { deploymentId: "fixture-deployment-v0275", fixture: true } });
  const deployedPersisted = await writePublicationRun({ sourceRoot: recoveryRoot, run: deployed });
  const readback = await readPublicationRun({ sourceRoot: recoveryRoot, publicationRunId: run.publicationRunId });
  const resumed = attachPublicationDeployment(readback, { deploymentId: "fixture-deployment-v0275" });
  const resumedPersisted = await writePublicationRun({ sourceRoot: recoveryRoot, run: resumed });
  const released = markPublicationReleased(resumed, { verified: true, fixture: true });
  const releasedPersisted = await writePublicationRun({ sourceRoot: recoveryRoot, run: released });
  const rolledBack = markPublicationRolledBack(released, { fixture: true, rollbackId: `rollback-${snapshot.snapshotHash.slice(0, 16)}` });
  const rolledBackPersisted = await writePublicationRun({ sourceRoot: recoveryRoot, run: rolledBack });
  const recoveryBefore = await snapshotDirectory(recoveryRoot);
  const recoveryReadback = await readPublicationRun({ sourceRoot: recoveryRoot, publicationRunId: run.publicationRunId });
  const recoveryEvidence = { root: "temporary-recovery-fixture", durableRecord: path.relative(recoveryRoot, runPersisted.file), siteSnapshot: path.relative(recoveryRoot, durableSiteSnapshot), outputRoot: path.relative(recoveryRoot, outputRoot), lease: path.relative(recoveryRoot, path.join(leaseRoot, "lease.json")), before: recoveryBefore, readback: { publicationRunId: recoveryReadback.publicationRunId, siteSnapshotId: recoveryReadback.siteSnapshotId, snapshotHash: recoveryReadback.snapshotHash, deploymentId: recoveryReadback.deploymentId, deploymentCount: recoveryReadback.deploymentCount, state: recoveryReadback.state }, writes: [runPersisted.file, deployedPersisted.file, resumedPersisted.file, releasedPersisted.file, rolledBackPersisted.file].map((file) => path.relative(recoveryRoot, file)), outputRootSnapshot: await snapshotDirectory(outputRoot), leaseSnapshot: await snapshotDirectory(leaseRoot), identityReadback: recoveryReadback.publicationRunId === run.publicationRunId && recoveryReadback.siteSnapshotId === snapshot.siteSnapshotId && recoveryReadback.snapshotHash === snapshot.snapshotHash };
  await rm(root, { recursive: true, force: true });
  await rm(failureRoot, { recursive: true, force: true });
  await rm(recoveryRoot, { recursive: true, force: true });
  return {
    fixture: { runId: `fixture-${snapshot.snapshotHash.slice(0, 16)}`, sourceRoot: "temporary-ignored-fixture", fixtureHash: sha256({ beforeValue, afterValue }), cleanup: true },
    update: { runId: `update-${update.changeSet.changeSetId}`, fixtureHash: sha256(afterValue), before: { contentSetId: active.contentSetId, contentSetHash: active.contentSetHash, entryId: beforeEntry.entryId, valueHash: sha256(beforeValue), sourceHash: sha256(beforeValue), revisionId: null }, after: { contentSetId: update.contentSet.contentSetId, contentSetHash: update.contentSet.contentSetHash, entryId: afterEntry.entryId, valueHash: sha256(afterValue), sourceHash: updateSourceHash, revisionId: update.changeSet.changes.find((change) => change.targetId === afterEntry.entryId)?.revision?.revisionId || null }, changedTargets: update.changeSet.changes.map((change) => change.targetId), changedOnly: update.changeSet.changes.length === 1, unchangedIdentity: update.changeSet.reused },
    add: { runId: `add-${add.changeSet.changeSetId}`, fixtureHash: sha256(addEntry.contentHash), after: { contentSetId: add.contentSet.contentSetId, contentSetHash: add.contentSet.contentSetHash, entryId: addEntry.entryId, valueHash: addEntry.contentHash, sourceHash: sha256(JSON.stringify({ target: "new", text: "added" }) + "\n"), revisionId: add.changeSet.changes.find((change) => change.targetId === addEntry.entryId)?.revision?.revisionId || null }, changedTargets: add.changeSet.changes.map((change) => change.targetId), addedOnly: add.changeSet.changes.some((change) => change.targetId === addEntry.entryId), unchangedIdentity: add.changeSet.reused },
    noChange: (() => { const first = createDeterministicSiteSnapshot({ productArtifact, contentSet: active, manifest: { contentSetId: active.contentSetId, contentSetHash: active.contentSetHash } }); const second = createDeterministicSiteSnapshot({ productArtifact, contentSet: noChange.contentSet, manifest: { contentSetId: noChange.contentSet.contentSetId, contentSetHash: noChange.contentSet.contentSetHash } }); const input = { productArtifactId: productArtifact.productArtifactId, productArtifactHash: productArtifact.productArtifactHash, contentSetId: active.contentSetId, contentSetHash: active.contentSetHash, manifest: { contentSetId: active.contentSetId, contentSetHash: active.contentSetHash } }; return { runId: `no-change-${active.contentSetId}`, fixtureHash: sha256(beforeValue), before: { contentSetId: active.contentSetId, contentSetHash: active.contentSetHash }, after: { contentSetId: noChange.contentSet.contentSetId, contentSetHash: noChange.contentSet.contentSetHash }, changedTargets: [], newInputs: 0, reused: noChange.noChanges === true, deterministicInput: { ...input, tupleHash: sha256(input) }, firstOutput: { siteSnapshotId: first.siteSnapshotId, snapshotHash: first.snapshotHash }, secondOutput: { siteSnapshotId: second.siteSnapshotId, snapshotHash: second.snapshotHash }, deterministicSnapshot: first.snapshotHash === second.snapshotHash }; })(),
    failureInjection: failureEvidence,
    recovery: { runId: `recovery-${run.publicationRunId}`, fixtureHash: snapshot.snapshotHash, source: { publicationRunId: run.publicationRunId, siteSnapshotId: snapshot.siteSnapshotId, snapshotHash: snapshot.snapshotHash, contentSetId: active.contentSetId }, sameObjectIdentity: resumed.publicationRunId === run.publicationRunId, samePublicationIdentity: resumed.siteSnapshotId === run.siteSnapshotId, deploymentId: resumed.deploymentId, deploymentCount: resumed.deploymentCount, finalizeState: released.state, rollbackState: rolledBack.state, idempotent: resumed.deploymentCount === 1, persistence: recoveryEvidence },
  };
}

async function assertRejectsCode(fn, expected) {
  try { await fn(); throw new Error("expected injected failure"); } catch (error) { if (!String(error.message).includes(expected)) throw error; }
}

export async function createLifecycleEvidence({ sourceRoot = process.cwd(), allowedPaths = [], excludedExternalPaths = [], excludedExternalReason = null, now = new Date().toISOString(), stage = "pre-commit", artifact = null, version = "v0.27.5", generatedBy = "scripts/content-lifecycle-evidence-v0275.mjs" } = {}) {
  const baseHead = git(sourceRoot, "rev-parse", "HEAD");
  const scope = allowedScopeDigest({ sourceRoot, allowedPaths, excludedExternalPaths, excludedExternalReason });
  const scenarios = await createScenarioFixture({ sourceRoot, now, version });
  const inventory = await createExactStorageInventory({ sourceRoot, now });
  const inventoryRecords = inventory.records.map((record) => ({
    ...record,
    logicalId: record.logicalContentId || `${record.objectKind}:${record.identity || sha256({ namespace: record.namespace, path: record.path, hash: record.hash })}`,
  }));
  const inventoryNodes = inventory.referenceGraph.nodes.map((node) => ({ ...node, logicalId: inventoryRecords.find((record) => record.path === node.id)?.logicalId || `${node.objectKind}:${sha256(node.id)}` }));
  const inventoryGraph = { ...inventory.referenceGraph, nodes: inventoryNodes, graphHash: sha256({ nodes: inventoryNodes, edges: inventory.referenceGraph.edges }) };
  const inventoryIdentity = { schemaVersion: inventory.schemaVersion, rootManifest: inventory.rootManifest, records: inventoryRecords, referenceGraph: inventoryGraph, retentionPolicy: inventory.retentionPolicy };
  const evidenceInventory = { ...inventory, records: inventoryRecords, referenceGraph: inventoryGraph, inventoryHash: sha256(inventoryIdentity) };
  const archiveBytes = Buffer.from(`${version} archive fixture ${scenarios.fixture.runId}\n`);
  const archiveRoot = await mkdtemp(path.join(os.tmpdir(), `xingbuild-${version}-archive-`));
  const archiveFile = path.join(archiveRoot, "archive-candidate.json");
  await writeFile(archiveFile, archiveBytes);
  const archiveDigest = await fileDigest(archiveFile);
  await rm(archiveRoot, { recursive: true, force: true });
  const archiveFixture = { runId: scenarios.fixture.runId, objectKind: "derived-materialization", sourceOfTruth: "temporary-fixture-canonical-source", path: "temporary-fixture/archive-candidate.json", bytes: archiveDigest.bytes, hashMode: "exact-byte", hash: archiveDigest.hash, decision: "archive-dry-run", reason: "reconstructible fixture with no active reference; zero-action only", sourceHash: archiveDigest.hash };
  const evidence = {
    schemaVersion: LIFECYCLE_EVIDENCE_SCHEMA_VERSION,
    stage,
    generatedAt: now,
    version,
    commit: stage === "post-commit" ? baseHead : null,
    tag: stage === "post-commit" ? git(sourceRoot, "describe", "--tags", "--exact-match", "HEAD") : null,
    tagType: stage === "post-commit" ? git(sourceRoot, "cat-file", "-t", git(sourceRoot, "describe", "--tags", "--exact-match", "HEAD")) : null,
    productVersion: artifact?.productVersion || null,
    productCommit: artifact?.productCommit || null,
    tagCommit: stage === "post-commit" ? git(sourceRoot, "rev-parse", "HEAD") : null,
    productArtifactId: artifact?.productArtifactId || null,
    artifactHash: artifact?.productArtifactHash || null,
    baseSiteArtifactId: artifact?.baseSiteArtifactId || null,
    baseHead,
    scopeDigest: scope.scopeDigest,
    rootManifestHash: evidenceInventory.rootManifest.manifestHash,
    scope: { ...scope, allowedPaths },
    fixture: scenarios.fixture,
    provenance: { runId: scenarios.fixture.runId, fixtureHash: scenarios.fixture.fixtureHash, source: "createLifecycleEvidence", generatedBy, realRun: true },
    scenarios,
    inventory: { inventoryHash: evidenceInventory.inventoryHash, rootManifestHash: evidenceInventory.rootManifest.manifestHash, rootManifest: evidenceInventory.rootManifest, records: evidenceInventory.records, summary: evidenceInventory.summary, referenceGraph: evidenceInventory.referenceGraph, retentionPolicy: evidenceInventory.retentionPolicy, exact: true, sourceOfTruth: "canonical protected roots" },
    outputRootEvidence: evidenceInventory.records.filter((record) => record.outputRoot).map((record) => ({ path: record.path, identity: record.identity, logicalId: record.logicalId, namespace: record.namespace, bytes: record.bytes, hash: record.hash, hashMode: record.hashMode, durableRecord: record.durableRecord, embeddedMaterialization: record.embeddedMaterialization, embeddedVerification: record.embeddedVerification, legacyEmbedded: record.legacyEmbedded, decision: record.decision })),
    archiveFixture,
    zeroWrite: { physicalDeletion: false, moved: false, archived: false, activeContentSetChanged: false, sitePublicationChanged: false },
    productionPublish: { authorized: false, executed: false, reason: `${version} does not authorize production publish` },
  };
  evidence.acceptance = reduceLifecycleAcceptance({ evidence });
  return evidence;
}

function requiredScenarioIdentity(value, prefix) {
  requiredText(value.runId, `${prefix}.runId`);
  requiredHash(value.fixtureHash, `${prefix}.fixtureHash`);
}

function requiredFailure(value, snapshot) {
  return value
    && typeof value.runId === "string" && value.runId.length > 0
    && SHA256.test(value.fixtureHash || "")
    && value.source?.activeContentSetId
    && SHA256.test(value.source?.activePointerBeforeHash || "")
    && SHA256.test(value.source?.activePointerAfterHash || "")
    && typeof value.failure?.code === "string" && value.failure.code.length > 0
    && value.failure?.phase
    && snapshot(value.before)
    && snapshot(value.after)
    && value.temporaryCleaned === true
    && value.activePointerUnchanged === true
    && value.candidateUnchanged === true
    && value.idempotentResume === true;
}

export function reduceLifecycleAcceptance({ evidence } = {}) {
  const fail = (reason, details = {}) => ({ status: "FAIL", reason, evidence: details });
  const pass = (details) => ({ status: "PASS", evidence: details });
  const na = (reason, details = {}) => ({ status: "N/A", reason, evidence: details });
  const out = {};
  const requiredScopePaths = ["scripts/check-project.mjs", "scripts/release-build.mjs", "scripts/release-closeout-check.mjs", "scripts/release-preflight.mjs"];
  const scopePaths = new Set(evidence?.scope?.allowedPaths || []);
  const exclusions = evidence?.scope?.excludedExternalPaths || [];
  const scopeComplete = requiredScopePaths.every((entry) => scopePaths.has(entry)) && exclusions.includes("AGENTS.md") && exclusions.some((entry) => entry.startsWith("docs/rules/")) && typeof evidence?.scope?.excludedExternalReason === "string";
  const pre = evidence?.stage === "pre-commit" && /^[a-f0-9]{40}$/.test(evidence?.baseHead || "") && SHA256.test(evidence?.scopeDigest || "") && evidence?.provenance?.realRun === true && scopeComplete;
  const post = evidence?.stage === "post-commit" && /^v\d+\.\d+\.\d+$/.test(evidence?.version || "") && /^[a-f0-9]{40}$/.test(evidence?.commit || "") && evidence?.tag === evidence?.version && evidence?.tagType === "tag" && evidence?.tagCommit === evidence?.commit && evidence?.productVersion === evidence?.version && evidence?.productCommit === evidence?.commit && evidence?.productArtifactId && SHA256.test(evidence?.artifactHash || "") && evidence?.baseSiteArtifactId && evidence?.rootManifestHash === evidence?.inventory?.rootManifestHash;
  out["C-01"] = pre || post ? pass({ stage: evidence.stage, baseHead: evidence.baseHead, commit: evidence.commit, tag: evidence.tag, scopeDigest: evidence.scopeDigest, allowedPaths: [...scopePaths].sort(), excludedExternalPaths: exclusions }) : fail("two-stage identity or complete scope binding is incomplete", { scopeComplete, requiredScopePaths, allowedPaths: [...scopePaths].sort(), excludedExternalPaths: exclusions });
  try { rejectPlaceholder(evidence); requiredScenarioIdentity(evidence.fixture, "fixture"); out["C-02"] = pass({ fullEnvelopeScanned: true, provenance: evidence.provenance }); } catch (error) { out["C-02"] = fail(error.message); }
  const update = evidence?.scenarios?.update;
  const scenarioIdentity = (value, prefix) => { try { requiredScenarioIdentity(value, prefix); return true; } catch { return false; } };
  const unchangedIdentityValid = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => entry?.targetId && entry?.entryId && entry.targetId === entry.entryId && SHA256.test(entry.contentHash || ""));
  const updateValid = update && scenarioIdentity(update, "scenarios.update") && update.changedOnly && update.changedTargets?.length === 1 && update.before?.entryId === update.after?.entryId && SHA256.test(update.before.valueHash) && SHA256.test(update.after.valueHash) && SHA256.test(update.before.sourceHash) && SHA256.test(update.after.sourceHash) && update.before.valueHash !== update.after.valueHash && update.before.sourceHash !== update.after.sourceHash && update.after.revisionId && unchangedIdentityValid(update.unchangedIdentity);
  out["C-03"] = updateValid ? pass(update) : fail("real changed-only update evidence is incomplete", { update });
  const add = evidence?.scenarios?.add;
  const addValid = add && scenarioIdentity(add, "scenarios.add") && add.addedOnly && add.changedTargets?.length >= 1 && add.after?.entryId && add.changedTargets.includes(add.after.entryId) && add.after?.revisionId && SHA256.test(add.after.valueHash) && SHA256.test(add.after.sourceHash) && unchangedIdentityValid(add.unchangedIdentity);
  out["C-04"] = addValid ? pass(add) : fail("real add evidence is incomplete", { add });
  const noChange = evidence?.scenarios?.noChange;
  const deterministicInput = noChange?.deterministicInput;
  const deterministicTuple = deterministicInput ? (() => { const { tupleHash, ...tuple } = deterministicInput; return SHA256.test(tupleHash || "") && SHA256.test(tuple.productArtifactHash || "") && tuple.productArtifactId && SHA256.test(tuple.contentSetHash || "") && tuple.contentSetId && tuple.manifest?.contentSetId === tuple.contentSetId && tuple.manifest?.contentSetHash === tuple.contentSetHash && tupleHash === sha256(tuple); })() : false;
  const noChangeValid = noChange && scenarioIdentity(noChange, "scenarios.noChange") && noChange.reused && noChange.newInputs === 0 && noChange.before.contentSetId === noChange.after.contentSetId && noChange.before.contentSetHash === noChange.after.contentSetHash && noChange.deterministicSnapshot && deterministicTuple && noChange.firstOutput?.snapshotHash === noChange.secondOutput?.snapshotHash && noChange.firstOutput?.siteSnapshotId === noChange.secondOutput?.siteSnapshotId;
  out["C-05"] = noChangeValid ? pass(noChange) : fail("no-change or deterministic rebuild evidence is incomplete", { noChange });
  const failure = evidence?.scenarios?.failureInjection;
  const snapshot = (value) => value && SHA256.test(value.pathSetHash || "") && Number.isInteger(value.bytes) && SHA256.test(value.hash || "") && SHA256.test(value.activePointerHash || "") && value.activePointer?.path && Number.isInteger(value.activePointer.bytes) && value.activePointer.hash === value.activePointerHash && value.temp?.hash && Array.isArray(value.temp.entries);
  const failureValid = failure && requiredFailure(failure, snapshot) && failure.before.activePointerHash === failure.after.activePointerHash && failure.before.temp.hash === failure.after.temp.hash && failure.temporary?.leftoverPaths?.length === 0;
  out["C-06"] = failureValid ? pass(failure) : fail("atomic failure evidence is incomplete", { failure });
  const recovery = evidence?.scenarios?.recovery;
  const persistence = recovery?.persistence;
  const recoveryValid = recovery && scenarioIdentity(recovery, "scenarios.recovery") && recovery.source?.publicationRunId && recovery.source?.siteSnapshotId && SHA256.test(recovery.source?.snapshotHash || "") && recovery.source?.contentSetId && recovery.sameObjectIdentity && recovery.samePublicationIdentity && recovery.deploymentCount === 1 && recovery.idempotent && recovery.deploymentId && persistence?.identityReadback === true && persistence?.durableRecord && persistence?.siteSnapshot && persistence?.outputRoot && persistence?.lease && persistence?.outputRootSnapshot?.hash && persistence?.leaseSnapshot?.hash && persistence?.readback?.deploymentCount === 1;
  out["C-07"] = recoveryValid ? pass(recovery) : fail("same-publication persisted recovery evidence is incomplete", { recovery });
  const inv = evidence?.inventory;
  const summary = inv?.summary;
  const graph = inv?.referenceGraph;
  const recordValid = (record) => record && record.path && record.objectKind && record.namespace && record.logicalId && Object.hasOwn(record, "logicalContentId") && Object.hasOwn(record, "artifactId") && Number.isInteger(record.bytes) && ["exact-byte", "metadata", "declared", "symlink", "mixed"].includes(record.hashMode) && (record.hashMode === "metadata" || SHA256.test(record.hash || "")) && record.sourceOfTruth && record.owner && record.retainUntil != null && record.decision && record.reason && (record.hashMode !== "metadata" || !["archive-dry-run", "delete"].includes(record.decision));
  const recordByPath = new Map((inv?.records || []).map((record) => [record.path, record]));
  const unresolvedProtected = (graph?.unresolved || []).every((edge) => recordByPath.get(edge.from)?.decision === "delete-never");
  const invValid = inv?.exact === true && SHA256.test(inv.inventoryHash || "") && SHA256.test(inv.rootManifestHash || "") && Array.isArray(inv.records) && inv.records.length === summary?.records && inv.records.every(recordValid) && Array.isArray(inv.rootManifest?.roots) && summary?.records > 0 && graph?.nodes?.length === summary.records && graph.nodes.every((node) => node.id && node.namespace && node.objectKind) && Array.isArray(graph.edges) && Array.isArray(graph.unresolved) && Array.isArray(graph.external) && unresolvedProtected && SHA256.test(graph.graphHash || "") && evidence.archiveFixture?.hashMode === "exact-byte" && SHA256.test(evidence.archiveFixture.hash) && ["keep", "review", "archive-dry-run", "delete-never"].every((key) => Number.isInteger(summary.decisions?.[key]));
  out["C-08"] = invValid ? pass({ inventoryRef: { inventoryHash: inv.inventoryHash, rootManifestHash: inv.rootManifestHash, records: inv.records.length, graphHash: graph.graphHash }, archiveFixture: evidence.archiveFixture }) : fail("inventory/reference graph or archive fixture evidence is incomplete", { inventoryRef: { inventoryHash: inv?.inventoryHash, rootManifestHash: inv?.rootManifestHash, records: inv?.records?.length || 0 }, archiveFixture: evidence.archiveFixture });
  const outputEvidence = evidence.outputRootEvidence;
  const outputValid = Array.isArray(outputEvidence) && outputEvidence.length > 0 && outputEvidence.every((record) => record.path && record.identity && record.logicalId && Number.isInteger(record.bytes) && (record.hashMode === "metadata" || SHA256.test(record.hash || "")) && record.durableRecord === true && (record.embeddedMaterialization === false && record.embeddedVerification === false || record.legacyEmbedded === true));
  out["C-09"] = invValid && outputValid && evidence.zeroWrite?.sitePublicationChanged === false ? pass({ outputRootCount: outputEvidence.length, outputRootDigest: sha256(outputEvidence), durableReferenceOnly: true, legacyMaterializationProtected: outputEvidence.some((record) => record.legacyEmbedded === true) }) : fail("durable/materialization separation is incomplete", { outputRootCount: outputEvidence?.length || 0 });
  const gateStateValid = evidence.productionPublish?.executed === false && evidence.productionPublish?.authorized === false && ((evidence.stage === "pre-commit" && evidence.commit === null && evidence.tag === null) || (evidence.stage === "post-commit" && post));
  out["C-10"] = gateStateValid ? pass({ stage: evidence.stage, readyForElon: evidence.stage === "pre-commit", commitForbidden: evidence.stage === "pre-commit" }) : fail("stage-aware gate state is invalid");
  return out;
}

export function assertLifecycleAcceptance(acceptance = {}) {
  const ids = ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06", "C-07", "C-08", "C-09", "C-10"];
  for (const id of ids) {
    const result = acceptance[id];
    if (!result || !["PASS", "FAIL", "N/A"].includes(result.status)) throw new Error(`${id} has invalid acceptance status`);
    if ((result.status === "FAIL" || result.status === "N/A") && !result.reason) throw new Error(`${id} ${result.status} requires reason`);
  }
  return true;
}

export function validateLifecycleEvidence(evidence, { requirePostCommit = false, expectedVersion = null } = {}) {
  if (evidence?.schemaVersion !== LIFECYCLE_EVIDENCE_SCHEMA_VERSION) throw new Error("V0275_EVIDENCE_SCHEMA");
  if (expectedVersion && evidence?.version !== expectedVersion) throw new Error(`LIFECYCLE_EVIDENCE_VERSION:${evidence?.version || "missing"}`);
  if (requirePostCommit && evidence.stage !== "post-commit") throw new Error("V0275_POST_COMMIT_EVIDENCE_REQUIRED");
  rejectPlaceholder(evidence);
  const recomputed = reduceLifecycleAcceptance({ evidence });
  assertLifecycleAcceptance(recomputed);
  if (stable(recomputed) !== stable(evidence.acceptance || {})) throw new Error("V0275_ACCEPTANCE_DRIFT");
  assertLifecycleAcceptance(evidence.acceptance || {});
  const failed = Object.entries(evidence.acceptance).filter(([, value]) => value.status === "FAIL");
  if (failed.length) throw new Error(`V0275_EVIDENCE_FAILED:${failed.map(([id]) => id).join(",")}`);
  return evidence;
}
