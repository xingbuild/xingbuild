#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createBaseSiteArtifact, hashArtifactValue } from "./lib/base-site-artifact.mjs";
import { computeProductArtifactHash } from "./lib/product-artifact.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distClient = path.join(root, "dist", "client");
const index = path.join(distClient, "index.html");
const worker = path.join(root, "worker", "index.js");
const hosting = path.join(root, ".openai", "hosting.json");
const edgeOneConfig = path.join(root, "edgeone.json");
for (const file of [index, worker, hosting, edgeOneConfig]) if (!existsSync(file)) throw new Error(`Missing Sites build input: ${file}`);
mkdirSync(path.join(root, "dist", "server"), { recursive: true }); mkdirSync(path.join(root, "dist", ".openai"), { recursive: true });
copyFileSync(worker, path.join(root, "dist", "server", "index.js")); copyFileSync(hosting, path.join(root, "dist", ".openai", "hosting.json")); copyFileSync(edgeOneConfig, path.join(distClient, "edgeone.json"));
if (process.env.XINGBUILD_CONTENT_BUILD !== "1") rmSync(path.join(distClient, "media"), { recursive: true, force: true });
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const commit = process.env.XINGBUILD_PRODUCT_COMMIT || execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const productVersion = process.env.XINGBUILD_PRODUCT_VERSION || `v${packageJson.version}`;
const baseSiteArtifactId = `${productVersion}-${commit.slice(0, 12)}`;
const transactionIdentity = { approvalHash: process.env.XINGBUILD_APPROVAL_HASH, candidateHash: process.env.XINGBUILD_CANDIDATE_HASH, approvedTreeOid: process.env.XINGBUILD_APPROVED_TREE_OID };
if (process.env.XINGBUILD_FINAL_BUILD !== "1" || !/^[a-f0-9]{64}$/.test(transactionIdentity.approvalHash || "") || !/^[a-f0-9]{64}$/.test(transactionIdentity.candidateHash || "") || !/^[a-f0-9]{40}$/.test(transactionIdentity.approvedTreeOid || "")) {
  throw new Error("ProductArtifact materialization requires final release build and ApprovalRecord identity");
}
const contentManifest = { schemaVersion: "content-manifest-v2", publishedSlugs: [], publishedArticleSlugs: [] };
writeFileSync(path.join(distClient, "content-manifest.json"), `${JSON.stringify(contentManifest, null, 2)}\n`);
/* release.json is written once after subordinate hashes are known; it is never self-hashed. */
const provisionalRelease = { schemaVersion: "product-artifact-release-v2", productVersion, productCommit: commit, productArtifactId: baseSiteArtifactId, baseSiteArtifactId, contentManifestHash: "0".repeat(64), baseSiteArtifactManifestHash: "0".repeat(64), ...transactionIdentity, clientFiles: [] };
writeFileSync(path.join(distClient, "release.json"), `${JSON.stringify(provisionalRelease, null, 2)}\n`);
const baseSiteArtifact = await createBaseSiteArtifact({ sourceRoot: root, clientDirectory: distClient, productVersion, productCommit: commit, release: { productVersion, productCommit: commit, baseSiteArtifactId }, contentManifest });
writeFileSync(path.join(distClient, "base-site-artifact.json"), `${JSON.stringify(baseSiteArtifact, null, 2)}\n`);
const allFiles = [];
function inspect(directory, current = "") { for (const entry of readdirSync(directory, { withFileTypes: true })) { const relative = path.posix.join(current, entry.name); const file = path.join(directory, entry.name); if (entry.isDirectory()) inspect(file, relative); else allFiles.push({ path: relative, sha256: requireHash(file) }); } }
function requireHash(file) { return execFileSync("shasum", ["-a", "256", file], { encoding: "utf8" }).split(/\s+/)[0]; }
inspect(distClient);
const clientFiles = allFiles.filter((entry) => entry.path !== "release.json").sort((a, b) => a.path.localeCompare(b.path));
const release = { ...provisionalRelease, contentManifestHash: hashArtifactValue(contentManifest), baseSiteArtifactManifestHash: hashArtifactValue(baseSiteArtifact), clientFiles };
release.productArtifactHash = computeProductArtifactHash(release);
writeFileSync(path.join(distClient, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
const artifactClient = path.join(root, ".content-workspace", "base-site-artifacts", baseSiteArtifactId, "client");
await mkdir(artifactClient, { recursive: true });
for (const entry of readdirSync(distClient, { withFileTypes: true })) { const from = path.join(distClient, entry.name); const to = path.join(artifactClient, entry.name); if (entry.isDirectory()) await import("node:fs/promises").then(({ cp }) => cp(from, to, { recursive: true, force: false })); else if (entry.name !== "base-site-artifact.json") await copyFile(from, to); }
await writeFile(path.join(artifactClient, "release.json"), await readFile(path.join(distClient, "release.json")));
await writeFile(path.join(artifactClient, "base-site-artifact.json"), await readFile(path.join(distClient, "base-site-artifact.json")));
for (const file of allFiles.map((entry) => entry.path)) { const absolute = path.join(distClient, file); if (file === "base-site-artifact.json" || !/\.(?:html|js|css|json|txt|xml|svg)$/.test(absolute)) continue; if (readFileSync(absolute, "utf8").includes(".content-workspace")) throw new Error(`Production build contains workspace path: ${file}`); }
console.log("Prepared ProductArtifact client-only materialization; repository source was not copied");
