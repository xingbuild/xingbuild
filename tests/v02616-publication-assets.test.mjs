import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createPublicationAssetManifest,
  parseIndexAssetReferences,
  preparePortableUploadRoot,
  verifyPublicPublicationAssets,
  writePublicationAssetManifest,
} from "../scripts/lib/publication-assets.mjs";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-assets-"));
  await mkdir(path.join(root, "assets"), { recursive: true });
  await mkdir(path.join(root, "media"), { recursive: true });
  await writeFile(path.join(root, "index.html"), [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="/assets/site.css">',
    "</head><body><div id=\"root\"></div>",
    '<script type="module" src="/assets/site.js"></script></body></html>',
  ].join(""));
  await writeFile(path.join(root, "assets", "site.css"), "body { color: black; }");
  await writeFile(path.join(root, "assets", "site.js"), "document.querySelector('#root').textContent='ok';");
  await writeFile(path.join(root, "media", "demo.mp4"), "video");
  return root;
}

test("publication asset manifest parses and hashes all referenced files", async () => {
  const root = await fixture();
  try {
    assert.deepEqual(parseIndexAssetReferences(await readFile(path.join(root, "index.html"), "utf8")), [
      { path: "/assets/site.css", kind: "style" },
      { path: "/assets/site.js", kind: "script" },
    ]);
    const manifest = await createPublicationAssetManifest({ clientRoot: root, additionalPaths: ["/media/demo.mp4"] });
    assert.equal(manifest.assets.length, 3);
    assert.ok(manifest.manifestHash);
    assert.equal(manifest.assets.find((item) => item.path === "/assets/site.js").expectedMime, "text/javascript");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("portable upload root materializes bytes and rejects symlink input", async () => {
  const root = await fixture();
  try {
    const portable = await preparePortableUploadRoot({ clientRoot: root, additionalPaths: ["/media/demo.mp4"] });
    try {
      assert.notEqual(portable.root, root);
      assert.equal(await readFile(path.join(portable.root, "assets", "site.js"), "utf8"), "document.querySelector('#root').textContent='ok';");
      assert.equal((await readFile(path.join(portable.root, "asset-manifest.json"), "utf8")).includes("publication-asset-manifest-v1"), true);
    } finally {
      await portable.cleanup();
    }
    const linkedRoot = await mkdtemp(path.join(os.tmpdir(), "xingbuild-assets-link-"));
    try {
      await symlink(path.join(root, "assets", "site.js"), path.join(linkedRoot, "linked.js"));
      await assert.rejects(preparePortableUploadRoot({ clientRoot: linkedRoot }), /symlink/);
    } finally {
      await rm(linkedRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public asset verification rejects HTML fallback and MIME drift", async () => {
  const root = await fixture();
  try {
    const manifest = await writePublicationAssetManifest({ clientRoot: root });
    const indexHtml = await readFile(path.join(root, "index.html"), "utf8");
    const fallbackFetch = async () => new Response(indexHtml, { status: 200, headers: { "content-type": "text/html" } });
    await assert.rejects(
      verifyPublicPublicationAssets({ baseUrl: "https://example.test/", indexHtml, assetManifest: manifest, fetchImpl: fallbackFetch }),
      /MIME mismatch|HTML fallback/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("public asset verification records exact MIME, bytes and hash", async () => {
  const root = await fixture();
  try {
    const manifest = await writePublicationAssetManifest({ clientRoot: root });
    const indexHtml = await readFile(path.join(root, "index.html"), "utf8");
    const fetchImpl = async (url) => {
      const pathname = new URL(url).pathname;
      const file = path.join(root, pathname.slice(1));
      const body = await readFile(file);
      const contentType = pathname.endsWith(".css") ? "text/css" : "application/javascript";
      return new Response(body, { status: 200, headers: { "content-type": contentType } });
    };
    const verified = await verifyPublicPublicationAssets({ baseUrl: "https://example.test/", indexHtml, assetManifest: manifest, fetchImpl });
    assert.equal(verified.verified, true);
    assert.equal(Object.keys(verified.assets).length, 2);
    assert.equal(verified.assets["/assets/site.css"].verified, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
