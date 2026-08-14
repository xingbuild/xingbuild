#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { migrateContentSet } from "./lib/content-set.mjs";
import { homeContentSetEntry } from "./lib/home-content-adapter.mjs";
import { homeContent } from "../src/content/siteContent.js";

const root = process.cwd();

async function readJson(file, label) {
  try {
    return JSON.parse(await readFile(path.resolve(root, file), "utf8"));
  } catch (error) {
    throw new Error(`${label} is missing or unreadable: ${file}: ${error.message}`);
  }
}

async function fetchManifest(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { redirect: "follow", cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function valueFor(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

export async function runMigration({ sourceRoot = root, localManifest, publicManifest, productArtifact = null, homeEntry = null, publicHomeEntry = null, homeContent: selectedHomeContent = homeContent, now } = {}) {
  return migrateContentSet({ sourceRoot, localManifest, publicManifest, productArtifact, homeEntry, publicHomeEntry, homeContent: selectedHomeContent, now });
}

async function main(argv = process.argv.slice(2)) {
  const localPath = valueFor(argv, "--local-manifest") || "dist/client/content-manifest.json";
  const publicPath = valueFor(argv, "--public-manifest");
  const publicUrl = valueFor(argv, "--public-url");
  if (!publicPath && !publicUrl) throw new Error("ContentSet migration requires --public-manifest <file> or --public-url <https-url>");
  const localManifest = await readJson(localPath, "local content manifest");
  const publicManifest = publicPath ? await readJson(publicPath, "public content manifest") : await fetchManifest(publicUrl);
  const artifactPath = valueFor(argv, "--product-artifact");
  const productArtifact = artifactPath ? await readJson(artifactPath, "ProductArtifact") : null;
  const homeEvidencePath = valueFor(argv, "--public-home-entry");
  // This is the one-time legacy migration path; preserve its historical
  // provenance explicitly instead of inheriting the Candidate default.
  const homeEntry = homeContentSetEntry({
    value: homeContent,
    sourceProof: ["legacy:src/content/siteContent.js"],
  });
  const publicHomeEntry = homeEvidencePath ? await readJson(homeEvidencePath, "public home entry") : null;
  const result = await runMigration({ sourceRoot: root, localManifest, publicManifest, productArtifact, homeEntry, publicHomeEntry });
  console.log(JSON.stringify({
    contentSetId: result.contentSet.contentSetId,
    contentSetHash: result.contentSet.contentSetHash,
    count: result.reconciliation.count,
    reused: result.written.reused || result.activation.reused,
    activeContentSetId: result.activation.pointer.activeContentSetId,
  }, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try {
    await main();
  } catch (error) {
    console.error(`ContentSet migration stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
