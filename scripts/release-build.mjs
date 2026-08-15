#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { classifyReleaseScope, validateCommittedScope } from "./lib/release-scope-classifier.mjs";

const root = process.cwd();

function git(...args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}
function assertFinalSourceVersion() {
  const branch = git("branch", "--show-current");
  if (branch !== "main") throw new Error(`final release build requires canonical main, got ${branch || "detached"}`);
  const head = git("rev-parse", "HEAD");
  const tag = git("describe", "--tags", "--exact-match", "HEAD");
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`final release build requires an exact semver tag, got ${tag || "none"}`);
  if (git("cat-file", "-t", `refs/tags/${tag}`) !== "tag") throw new Error(`final release build requires annotated tag: ${tag}`);
  if (git("rev-parse", `${tag}^{}`) !== head) throw new Error(`final release build tag drift: ${tag}`);
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const scope = validateCommittedScope({ root, version: `v${packageJson.version}`, committedHead: head });
  if (!scope.ready) throw new Error(`final release build requires classifier-confirmed scope-clean HEAD: ${scope.blockers.join("; ")}`);
  return { head, tag };
}

function run(command, args, env) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
}

export async function buildFinalProductArtifact({ sourceRoot = root } = {}) {
  if (path.resolve(sourceRoot) !== path.resolve(root)) throw new Error("final release build must run in canonical root");
  const identity = assertFinalSourceVersion();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const version = `v${packageJson.version}`;
  const current = await readFile(path.join(root, "docs/iterations/current.md"), "utf8");
  if (!current.includes(`当前唯一版本：\`${version}\``)) throw new Error(`current.md does not identify ${version}`);
  run("npm", ["run", "release:prepare"], process.env);
  run("npm", ["run", "build"], {
    ...process.env,
    XINGBUILD_FINAL_BUILD: "1",
    // ProductArtifact must be able to read a separately published
    // ContentDataArtifact; it must not enable build-time workspace embedding.
    XINGBUILD_CONTENT_RUNTIME: "1",
    XINGBUILD_PRODUCT_VERSION: version,
    XINGBUILD_PRODUCT_COMMIT: identity.head,
  });
  run("node", ["scripts/content-lifecycle-evidence.mjs", "--post-commit"], process.env);
  const artifact = await readProductArtifact({
    clientDirectory: path.join(root, "dist", "client"),
    sourceRoot: root,
    version,
    commit: identity.head,
  });
  const postEvidencePath = path.join(root, ".content-workspace", "qa", version, "release-scope-postcommit.json");
  await mkdir(path.dirname(postEvidencePath), { recursive: true });
  await writeFile(postEvidencePath, `${JSON.stringify({
    schemaVersion: "release-scope-postcommit-v1",
    phase: "post-commit",
    version,
    committedHead: identity.head,
    baseHead: git("rev-parse", `${identity.head}^`),
    scopeManifestPath: `docs/iterations/scopes/${version}.json`,
    scopeDigest: JSON.parse(readFileSync(path.join(root, `docs/iterations/scopes/${version}.json`), "utf8")).scopeDigest,
    productArtifactId: artifact.productArtifactId,
    productArtifactHash: artifact.productArtifactHash,
    baseSiteArtifactId: artifact.baseSiteArtifactId,
  }, null, 2)}\n`, "utf8");
  const postScope = classifyReleaseScope({ root, version, phase: "post-commit", requireStaged: false, allowManifestUntracked: false });
  if (!postScope.ready) throw new Error(`final release build left scope dirty: ${postScope.blockers.join("; ")}`);
  return { ...identity, version, artifact };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = await buildFinalProductArtifact();
    console.log(JSON.stringify({
      version: result.version,
      commit: result.head,
      tag: result.tag,
      productArtifactId: result.artifact.productArtifactId,
      productArtifactHash: result.artifact.productArtifactHash,
      baseSiteArtifactId: result.artifact.baseSiteArtifactId,
    }, null, 2));
  } catch (error) {
    console.error(`最终 ProductArtifact 构建已停止：${error.message}`);
    process.exitCode = 1;
  }
}
