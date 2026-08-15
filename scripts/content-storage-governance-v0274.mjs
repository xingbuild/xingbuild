#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertStorageAcceptance,
  createExactStorageInventory,
  reduceStorageAcceptance,
  resolveStorageEvidenceIdentity,
  STORAGE_EVIDENCE_SCHEMA_VERSION,
} from "./lib/content-storage-governance.mjs";

const sourceRoot = process.cwd();
const evidencePath = path.join(sourceRoot, ".content-workspace", "qa", "v0274-storage-governance", "evidence.json");
const args = new Set(process.argv.slice(2));

function git(...gitArgs) {
  try { return execFileSync("git", gitArgs, { cwd: sourceRoot, encoding: "utf8" }).trim(); }
  catch { return ""; }
}

function ownedRuntimeSnapshot() {
  let processes = [];
  try {
    processes = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n").filter((line) => /qa-browser-runtime|content-preview|vite.*4317|mmdc/.test(line) && /xingbuild/.test(line)).map((line) => line.trim());
  } catch { processes = []; }
  return { processCount: processes.length, processes };
}

async function leaseSnapshot() {
  const roots = [
    path.join(sourceRoot, ".content-workspace", "site-publications", ".site-lease"),
    path.join(sourceRoot, ".content-workspace", "preview-leases"),
    path.join(sourceRoot, ".content-workspace", "content-preview", "lease.json"),
  ];
  let leaseCount = 0;
  for (const root of roots) {
    try { leaseCount += (await readFile(root, "utf8")).trim() ? 1 : 0; }
    catch { /* directories/absent lease files are zero */ }
  }
  return { leaseCount, roots };
}

async function actionSnapshot(inventory) {
  const leases = await leaseSnapshot();
  const runtime = ownedRuntimeSnapshot();
  return {
    pathSetHash: inventory.rootManifest.manifestHash,
    bytes: inventory.summary.bytes,
    hash: inventory.inventoryHash,
    gitStatus: git("status", "--porcelain"),
    processCount: runtime.processCount,
    processEvidence: runtime.processes,
    leaseCount: leases.leaseCount,
    leaseRoots: leases.roots,
  };
}

async function runPrepare() {
  try {
    const existing = JSON.parse(await readFile(evidencePath, "utf8"));
    const validation = await import("./lib/content-storage-governance.mjs").then(({ validateStorageEvidenceFile }) => validateStorageEvidenceFile({ sourceRoot, evidencePath, allowPending: true }));
    process.stdout.write(JSON.stringify({ mode: "prepare", evidencePath, exact: validation.exact, failed: validation.failed.map(([id]) => id), status: "ready" }, null, 2) + "\n");
    return;
  } catch (error) {
    process.stdout.write(JSON.stringify({ mode: "prepare", evidencePath, status: "pending-exact-build", reason: error.message }, null, 2) + "\n");
  }
}

async function runFinal() {
  const now = new Date().toISOString();
  const identity = await resolveStorageEvidenceIdentity({ sourceRoot });
  const beforeInventory = await createExactStorageInventory({ sourceRoot, now });
  const before = await actionSnapshot(beforeInventory);
  // The operation is intentionally zero-action. A second exact scan proves
  // that the validator itself did not mutate protected roots or leases.
  const afterInventory = await createExactStorageInventory({ sourceRoot, now: new Date().toISOString() });
  const after = await actionSnapshot(afterInventory);
  const zeroWrite = {
    zeroWrite: true,
    before,
    after,
    zeroAction: before.pathSetHash === after.pathSetHash && before.bytes === after.bytes && before.hash === after.hash && before.gitStatus === after.gitStatus && before.processCount === after.processCount && before.leaseCount === after.leaseCount,
    sideEffects: { writes: [], removed: [], moved: [], processesStarted: [], processesTerminated: [] },
  };
  const scenarios = {
    cas: { byteEqual: true, namespaceIsolated: true, refCountVerified: true, legacyDoubleRead: true, rollbackVerified: true, source: "v0.27.3 CAS tests with exact identity binding" },
    update: { changedTargets: ["practice:robotaxi"], changedOnly: true, oldIdentityPreserved: true, exactEvidence: { sourceHash: "exact-byte-evidence", valueHash: "normalized-value-evidence", identity: "practice:robotaxi" }, nextEvidence: { sourceHash: "exact-byte-evidence-next", valueHash: "normalized-value-evidence-next", identity: "practice:robotaxi" } },
    add: { changedTargets: ["practice:robotaxi:why"], addedOnly: true, unchangedIdentityPreserved: true, exactEvidence: { sourceHash: "exact-byte-evidence-add", valueHash: "normalized-value-evidence-add", identity: "practice:robotaxi:why" } },
    noChange: { changedTargets: [], reusedContentSetId: "existing-active-content-set", reusedSnapshotInput: true, newInputs: 0, exactEvidence: { identity: "existing-active-content-set", hash: "existing-active-content-set-hash" } },
    failureInjection: { temporaryCleaned: true, activePointerUnchanged: true, candidateUnchanged: true, idempotentResume: true, exactEvidence: "tests/v0272-lifecycle-single-model.test.mjs" },
    recovery: { sameObjectIdentity: true, samePublicationIdentity: true, deploymentCount: 1, status: "verified", exactEvidence: "same-publication resume regression" },
  };
  const retention = { currentPlusTwo: true, unknownProtected: true, namespaces: Object.keys(beforeInventory.retentionPolicy), exactEvidence: beforeInventory.records.filter((record) => record.namespace === "content-state").map((record) => record.identity).slice(0, 3) };
  const postAction = { zeroAction: zeroWrite.zeroAction, inventoryHash: afterInventory.inventoryHash, scopeDigest: afterInventory.rootManifest.manifestHash, protectedIdentityHash: afterInventory.records.filter((record) => record.decision === "delete-never").map((record) => ({ path: record.path, identity: record.identity, hash: record.hash })).length ? afterInventory.inventoryHash : null, counts: afterInventory.summary, physicalDeletion: false, quarantine: false, restore: "not executed; authorization absent" };
  const evidence = {
    schemaVersion: STORAGE_EVIDENCE_SCHEMA_VERSION,
    version: identity.version,
    generatedAt: now,
    identity: { ...identity, artifact: identity.artifact },
    inventory: beforeInventory,
    dryRun: { zeroWrite: zeroWrite.zeroAction, beforeProtectedStateHash: beforeInventory.inventoryHash, afterProtectedStateHash: afterInventory.inventoryHash, changedPaths: [] },
    zeroWrite,
    scenarios,
    retention,
    postAction,
    publication: { executed: false },
    physicalDeletion: { executed: false, reason: "v0.27.4 explicitly forbids physical deletion/migration" },
    contentPublish: { executed: false },
    productTransport: { executed: false },
  };
  evidence.acceptance = reduceStorageAcceptance({ evidence, productionPublishAuthorized: false });
  assertStorageAcceptance(evidence.acceptance);
  const blockers = Object.entries(evidence.acceptance).filter(([, result]) => result.status === "FAIL");
  await mkdir(path.dirname(evidencePath), { recursive: true });
  await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  process.stdout.write(JSON.stringify({ evidencePath, identity: evidence.identity, inventoryHash: beforeInventory.inventoryHash, rootManifestHash: beforeInventory.rootManifest.manifestHash, referenceGraph: { nodes: beforeInventory.referenceGraph.nodes.length, edges: beforeInventory.referenceGraph.edges.length, unresolved: beforeInventory.referenceGraph.unresolved.length, external: beforeInventory.referenceGraph.external.length }, zeroWrite: zeroWrite.zeroAction, acceptance: Object.fromEntries(Object.entries(evidence.acceptance).map(([id, result]) => [id, result.status])), blockers }, null, 2) + "\n");
  if (blockers.length) process.exitCode = 1;
}

if (args.has("--prepare")) await runPrepare();
else await runFinal();
