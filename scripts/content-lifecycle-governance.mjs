#!/usr/bin/env node
import { inventoryContentWorkspace, createLifecycleDryRun } from "./lib/content-lifecycle-governance.mjs";

const argv = process.argv.slice(2);
const sourceRoot = process.cwd();
const inventory = await inventoryContentWorkspace({ sourceRoot });
const output = argv.includes("--dry-run")
  ? { inventory, dryRun: createLifecycleDryRun({ inventory, sourceRoot }) }
  : { inventory };
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
