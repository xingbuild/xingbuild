#!/usr/bin/env node

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createQaBrowserRun, resolveQaBrowserRuntime } from "./lib/qa-browser-runtime.mjs";

const root = process.cwd();
const scriptsDirectory = path.join(root, "scripts");
const runtimeFile = path.join(scriptsDirectory, "lib", "qa-browser-runtime.mjs");
const checkerFile = path.join(scriptsDirectory, "qa-browser-check.mjs");

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file));
    else if (entry.isFile() && file.endsWith(".mjs")) files.push(file);
  }
  return files;
}

const violations = [];
for (const file of await walk(scriptsDirectory)) {
  if (file === runtimeFile || file === checkerFile) continue;
  const source = await readFile(file, "utf8");
  if (/puppeteer\.launch\s*\(/.test(source)) violations.push(`${path.relative(root, file)}: 裸 puppeteer.launch`);
  if (/chromium\.launch\s*\(/.test(source)) violations.push(`${path.relative(root, file)}: 裸 chromium.launch`);
  if (source.includes("node_modules/.bin/mmdc") && !source.includes("runQaBrowserCommand")) {
    violations.push(`${path.relative(root, file)}: Mermaid CLI 未通过 runQaBrowserCommand`);
  }
  if (/Google Chrome for Testing\.app|\.cache[\\/]puppeteer|Library[\\/]Caches[\\/]ms-playwright/i.test(source)) {
    violations.push(`${path.relative(root, file)}: 包含禁止浏览器缓存路径`);
  }
}
if (violations.length) {
  console.error("qa-browser-check failed");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

const runtime = await resolveQaBrowserRuntime();
const runtimeInfo = await stat(runtime.executablePath);
const lifecycleRun = await createQaBrowserRun({ runtime, taskId: "qa-browser-check" });
const lifecycle = await lifecycleRun.cleanup({ exitState: "success" });
const evidenceDirectory = path.join(root, ".content-workspace", "qa", "v02613");
await mkdir(evidenceDirectory, { recursive: true });
await writeFile(path.join(evidenceDirectory, "qa-browser-runtime-check.json"), `${JSON.stringify({
  runtime,
  run: lifecycle,
  forbiddenPathScan: "passed",
  staticEntrypoints: "passed",
}, null, 2)}\n`);
console.log(JSON.stringify({
  ok: true,
  runtime: {
    ...runtime,
    executableFile: runtimeInfo.isFile(),
  },
  lifecycle: {
    runId: lifecycle.runId,
    exitState: lifecycle.exitState,
    cleanup: lifecycle.cleanup,
    manifestPath: lifecycleRun.manifestPath,
  },
  staticEntrypoints: "passed",
}, null, 2));
