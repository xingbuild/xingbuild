#!/usr/bin/env node

import { parseIndexAssetReferences } from "./lib/publication-assets.mjs";
import { verifyPublicBrowserRuntime } from "./lib/publication-runtime.mjs";

const [baseUrl = "https://xingbuild.top/", expectedVersion, expectedCommit] =
  process.argv.slice(2);

if (!expectedVersion || !expectedCommit) {
  console.error(
    "Usage: node scripts/verify-public-release.mjs <url> <version> <commit>",
  );
  process.exit(1);
}

const publicUrl = new URL(baseUrl);
const releaseUrl = new URL("/release.json", publicUrl);
const manifestUrl = new URL("/content-manifest.json", publicUrl);
const attempts = Number(process.env.XINGBUILD_VERIFY_ATTEMPTS || 12);
const intervalMs = Number(process.env.XINGBUILD_VERIFY_INTERVAL_MS || 10_000);

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  try {
    const [pageResponse, releaseResponse, manifestResponse] = await Promise.all([
      fetch(publicUrl, { redirect: "follow" }),
      fetch(releaseUrl, { redirect: "follow", cache: "no-store" }),
      fetch(manifestUrl, { redirect: "follow", cache: "no-store" }),
    ]);

    if (!pageResponse.ok || !releaseResponse.ok || !manifestResponse.ok) {
      throw new Error(
        `HTTP page=${pageResponse.status} release=${releaseResponse.status} manifest=${manifestResponse.status}`,
      );
    }

    const [html, release, manifest] = await Promise.all([
      pageResponse.text(),
      releaseResponse.json(),
      manifestResponse.json(),
    ]);

    if (!html.includes("<title>xingbuild")) {
      throw new Error("homepage title does not identify xingbuild");
    }
    if (release.version !== expectedVersion) {
      throw new Error(
        `version is ${release.version || "missing"}, expected ${expectedVersion}`,
      );
    }
    if (release.commit !== expectedCommit) {
      throw new Error(
        `commit is ${release.commit || "missing"}, expected ${expectedCommit}`,
      );
    }
    if (typeof manifest !== "object" || manifest === null) {
      throw new Error("content manifest is not a valid JSON object");
    }
    const assetEvidence = {};
    for (const reference of parseIndexAssetReferences(html)) {
      const response = await fetch(new URL(reference.path, publicUrl), {
        redirect: "follow",
        cache: "no-store",
        headers: { accept: reference.kind === "style" ? "text/css,*/*" : "application/javascript,text/javascript,*/*" },
      });
      const body = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") || "";
      if (!response.ok) throw new Error("asset " + reference.path + " returned HTTP " + response.status);
      if (reference.kind === "style" && !contentType.toLowerCase().startsWith("text/css")) throw new Error("asset " + reference.path + " has invalid CSS MIME");
      if (reference.kind === "script" && !/(?:text|application)\/javascript/i.test(contentType)) throw new Error("asset " + reference.path + " has invalid JS MIME");
      if (/^\s*(?:<!doctype html|<html)/i.test(body.toString("utf8"))) throw new Error("asset " + reference.path + " returned HTML fallback");
      assetEvidence[reference.path] = { status: response.status, contentType, bytes: body.byteLength, verified: true };
    }
    const browserRuntime = await verifyPublicBrowserRuntime({ baseUrl: publicUrl, taskId: "release-verify-public" });

    console.log(JSON.stringify({ assetEvidence, browserRuntime }));
    console.log(
      `Public release verified: ${expectedVersion} ${expectedCommit.slice(0, 7)}`,
    );
    process.exit(0);
  } catch (error) {
    console.log(
      `Public verification ${attempt}/${attempts} pending: ${error.message}`,
    );
    if (attempt < attempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

console.error(
  `Public verification failed for ${expectedVersion} at ${publicUrl.href}`,
);
process.exit(1);
