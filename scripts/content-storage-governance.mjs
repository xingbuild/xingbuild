#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildStorageAcceptanceMatrix,
  createProtectedRootManifest,
  createStorageDryRun,
  inventoryContentStorage,
  assertStorageDryRun,
} from "./lib/content-storage-governance.mjs";

const sourceRoot = process.cwd();
const now = new Date().toISOString();
const outputDirectory = path.join(sourceRoot, ".content-workspace", "qa", "v0273-storage-governance");
const rootManifest = await createProtectedRootManifest({ sourceRoot, now });
const inventory = await inventoryContentStorage({ sourceRoot, now });
const dryRun = createStorageDryRun({ inventory, now });
assertStorageDryRun(dryRun);
const evidence = {
  schemaVersion: "content-storage-acceptance-evidence-v1",
  version: "v0.27.3",
  generatedAt: now,
  sourceRoot,
  rootManifest,
  inventory,
  dryRun,
  roots: { staging: "temporary-only", uploadRoot: "temporary-only", outputRoot: ".content-workspace/site-publications" },
  acceptance: buildStorageAcceptanceMatrix({ inventory, dryRun, roots: { staging: "temporary-only", uploadRoot: "temporary-only", outputRoot: ".content-workspace/site-publications" }, namespaceCas: "read-only inventory; CAS tests", productionPublishAuthorized: false }),
  physicalDeletion: { executed: false, reason: "v0.27.3 explicitly forbids unauthorized physical deletion" },
  contentPublish: { executed: false },
  productTransport: { executed: false },
};
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ evidencePath: path.join(outputDirectory, "evidence.json"), inventoryHash: inventory.inventoryHash, dryRunZeroWrite: dryRun.zeroWrite, acceptance: evidence.acceptance }, null, 2)}\n`);
