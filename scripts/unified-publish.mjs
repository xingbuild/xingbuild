#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatVersion, parseCurrentVersion } from "./lib/unified-release.mjs";
import { assertNoVersionStateFields } from "./lib/release-readiness.mjs";
import {
  assertFixedPublishTarget,
  assertPublishAuthorization,
  edgeoneDomain,
  edgeoneProject,
  edgeoneProjectId,
  isPublishAuthorized,
  readDeploymentResult,
  readFixedEdgeoneTarget,
} from "./lib/publish-target.mjs";
import { createSitePublication } from "./lib/site-publication.mjs";
import { transportSitePublication } from "./lib/site-publication-coordinator.mjs";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { classifyReleaseScope } from "./lib/release-scope-classifier.mjs";
import { assertArtifactApproval, readApprovalRecord } from "./lib/release-transaction.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const expectedOrigin = "https://github.com/Chizheng4/xingbuild.git";
const edgeone = path.join(root, "node_modules", ".bin", "edgeone");

export function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function run(command, args, cwd, { env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit", env });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
}

async function exists(file) {
  try { await access(file); return true; } catch { return false; }
}

export function trackedDirtyPaths(statusText = "") {
  return statusText.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).filter(Boolean);
}

function runCapture(command, args, cwd, { env = process.env } = {}) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env });
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  process.stdout.write(output);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}`);
  return output;
}

export {
  assertFixedPublishTarget,
  assertPublishAuthorization,
  edgeoneDomain,
  edgeoneProject,
  edgeoneProjectId,
  isPublishAuthorized,
  publicUrl,
  readDeploymentResult,
  readFixedEdgeoneTarget,
} from "./lib/publish-target.mjs";

export async function readAcceptedVersion(sourceCwd = root) {
  const packageJson = JSON.parse(await readFile(path.join(sourceCwd, "package.json"), "utf8"));
  const packageLock = JSON.parse(await readFile(path.join(sourceCwd, "package-lock.json"), "utf8"));
  const versionText = await readFile(path.join(sourceCwd, "VERSION.md"), "utf8");
  const currentText = await readFile(path.join(sourceCwd, "docs/iterations/current.md"), "utf8");
  assertNoVersionStateFields(currentText);
  const version = formatVersion(packageJson.version);
  const expectedNumber = version.slice(1);
  if (packageLock.version !== expectedNumber || packageLock.packages?.[""]?.version !== expectedNumber) throw new Error("package.json and package-lock.json versions are not aligned");
  if (!versionText.includes(`## ${version}`)) throw new Error(`VERSION.md does not record ${version}`);
  if (parseCurrentVersion(currentText) !== version) throw new Error(`current.md does not record ${version}`);
  const historyFile = path.join(sourceCwd, "docs/iterations/history", `${version}.md`);
  if (!(await exists(historyFile))) throw new Error(`missing history record for ${version}`);
  return { version, historyFile };
}

export async function collectPublishContext(sourceCwd = root) {
  const resolved = path.resolve(sourceCwd);
  if (resolved !== root) throw new Error(`publish source cwd must be canonical direct-local: ${root}`);
  if (git(["symbolic-ref", "--short", "HEAD"], resolved) !== "main") throw new Error("publish source must be on main");
  const identity = await readAcceptedVersion(resolved);
  const approval = await readApprovalRecord(resolved, identity.version, null, { requireCurrentIdentity: false, allowTagRecovery: true });
  let scope;
  try {
    scope = classifyReleaseScope({ root: resolved, version: identity.version, phase: "post-commit", requireStaged: false, allowManifestUntracked: false, approvalIdentity: approval });
  } catch (error) {
    throw new Error(`publish source scope classifier failed: ${error.message}`);
  }
  if (!scope.ready) throw new Error(`publish source scope is not clean: ${scope.blockers.join("; ")}`);
  const head = git(["rev-parse", "HEAD"], resolved);
  const tag = identity.version;
  if (git(["cat-file", "-t", tag], resolved) !== "tag") throw new Error(`${tag} is not an annotated tag`);
  const taggedCommit = git(["rev-parse", `${tag}^{commit}`], resolved);
  if (taggedCommit !== head) throw new Error(`${tag} points to ${taggedCommit}; expected HEAD ${head}`);
  return { sourceCwd: resolved, head, tag, version: identity.version, historyFile: identity.historyFile, dirtyPaths: [], scope, approval };
}

export async function readPreparedDist({ sourceCwd = root, version, head, approval = null } = {}) {
  const client = path.join(sourceCwd, "dist", "client");
  const releasePath = path.join(client, "release.json");
  const manifestPath = path.join(client, "content-manifest.json");
  const artifactPath = path.join(client, "base-site-artifact.json");
  if (!(await exists(releasePath))) throw new Error("prepared dist/client/release.json is required; publish will not build");
  const release = JSON.parse(await readFile(releasePath, "utf8"));
  if ((release.productVersion || release.version) !== version || (release.productCommit || release.commit) !== head) throw new Error(`prepared release.json does not match ${version}/${head}`);
  const manifest = await exists(manifestPath) ? JSON.parse(await readFile(manifestPath, "utf8")) : null;
  const artifact = await exists(artifactPath)
    ? await readProductArtifact({ clientDirectory: client, sourceRoot: sourceCwd, version, commit: head })
    : null;
  if (approval && artifact) assertArtifactApproval(artifact, approval);
  return { client, release, manifest, artifact };
}

function configureNetwork() {
  const proxy = process.env.XINGBUILD_GITHUB_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || "http://127.0.0.1:7897";
  const probe = spawnSync("curl", ["-fsSI", "--http1.1", "--proxy", proxy, "--connect-timeout", "3", "--max-time", "8", "https://github.com"]);
  if (probe.status === 0) {
    for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) process.env[name] = proxy;
    process.env.NODE_USE_ENV_PROXY = "1";
    return;
  }
  for (const name of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete process.env[name];
  run("curl", ["-fsSI", "--http1.1", "--noproxy", "*", "--connect-timeout", "10", "--max-time", "15", "https://github.com"], root);
}

export async function publish({ kind, target, argv = process.argv.slice(2), env = process.env } = {}) {
  if (kind !== "product") throw new Error("unified-publish only handles product transport; use the content publish engine for content targets");
  let phase = "source";
  let source;
  let prepared;
  let edgeoneTarget;
  try {
    assertFixedPublishTarget(env);
    source = await collectPublishContext(root);
    phase = "prepared-dist";
    prepared = await readPreparedDist({ sourceCwd: root, version: source.version, head: source.head, approval: source.approval });
    phase = "preflight";
    run("npm", ["run", "release:preflight", "--", "--approval", path.relative(root, path.join(root, ".content-workspace", "qa", source.version, "approval-record.json"))], root, { env: { ...env, XINGBUILD_RELEASE_WORKTREE: "1" } });
    if (!prepared.artifact) throw new Error("ProductArtifact is required before product transport");
    phase = "authorization";
    assertPublishAuthorization({ argv, env });
    if (!(await exists(edgeone))) throw new Error("EdgeOne CLI is not installed in the project");
    edgeoneTarget = await readFixedEdgeoneTarget(root);
    configureNetwork();
    const publication = await createSitePublication({
      productClient: prepared.client,
      releasesRoot: path.join(root, ".content-workspace", "releases"),
      outputRoot: path.join(root, ".content-workspace", "site-publications", `${source.version}-${source.head}`),
      assemble: false,
      sourceRoot: root,
    });
    prepared = { ...prepared, client: publication.client, publication };
    phase = "transport-push";
    run("git", ["push", "origin", "HEAD:main"], root);
    run("git", ["push", "origin", source.tag], root);
    const remote = git(["ls-remote", "origin", "refs/heads/main"], root).split(/\s+/)[0];
    if (remote !== source.head) throw new Error(`remote main is ${remote}; expected ${source.head}`);
    phase = "transport-deploy";
    const completed = await transportSitePublication({
      publication,
      sourceRoot: root,
      argv,
      env,
      edgeonePath: edgeone,
    });
    phase = "public-verify";
    return { ...source, kind, target, dist: prepared.client, edgeoneTarget, deployment: completed.deployment, publicVerify: completed.publicVerify, sitePublicationId: completed.sitePublicationId, online: true };
  } catch (error) {
    error.publishContext = { ...(source || {}), dist: prepared?.client, phase, edgeoneTarget };
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const kind = argv[argv.indexOf("--kind") + 1];
  const target = argv[argv.indexOf("--slug") + 1] || argv[argv.indexOf("--id") + 1] || "";
  if (kind !== "product") throw new Error("Usage: node scripts/unified-publish.mjs --kind product --authorize-publish");
  const result = await publish({ kind, target, argv });
  console.log(`Unified release completed: ${result.version} ${result.head} ${result.kind}${result.target ? ` ${result.target}` : ""}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  try { await main(); } catch (error) {
    const context = error.publishContext ? ` context=${JSON.stringify(error.publishContext)}` : "";
    console.error(`统一版本发布已停止：${error.message}${context}`);
    process.exitCode = 1;
  }
}
