#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { verifyResumeArtifact } from "./lib/resume-artifact.mjs";
import { projectRoot } from "./lib/content-root.mjs";
import { readContentAuthoringTarget, writeContentAuthoringTarget } from "./lib/content-preview-authoring.mjs";
import { resolveContentPreviewTarget } from "./lib/content-preview.mjs";

const exec = promisify(execFile);
const expectedVersion = "v0.26.31";
const evidenceDirectory = path.join(projectRoot, ".content-workspace", "qa", "v02631", "content-preview-evidence");

async function git(...args) {
  const { stdout } = await exec("git", args, { cwd: projectRoot });
  return stdout.trim();
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathManifest(root) {
  const entries = [];
  async function visit(current, relative = "") {
    let names;
    try { names = await readdir(current); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const name of names.sort()) {
      const absolute = path.join(current, name);
      const rel = path.posix.join(relative, name);
      const info = await lstat(absolute);
      entries.push({ path: rel, type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other", size: info.size, mtimeMs: info.mtimeMs });
      if (info.isDirectory()) await visit(absolute, rel);
    }
  }
  await visit(root);
  return entries;
}

async function protectedState() {
  const roots = [
    ".content-workspace/content-state",
    ".content-workspace/content/review",
    ".content-workspace/content/recovery",
    ".content-workspace/content/releases",
    ".content-workspace/site-publications",
    ".content-workspace/base-site-artifacts",
  ];
  const result = {};
  for (const relative of roots) {
    const absolute = path.join(projectRoot, relative);
    result[relative] = await pathManifest(absolute);
  }
  return result;
}

async function runPreviewEditRestore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v02631-preview-"));
  const targetId = "profile.about.block.positioning-lead.text";
  try {
    await mkdir(path.join(directory, "content/registry"), { recursive: true });
    await mkdir(path.join(directory, ".content-workspace/content/profile"), { recursive: true });
    await cp(path.join(projectRoot, "content/registry/content-targets.json"), path.join(directory, "content/registry/content-targets.json"));
    await cp(path.join(projectRoot, ".content-workspace/content/profile/about.json"), path.join(directory, ".content-workspace/content/profile/about.json"));
    await cp(path.join(projectRoot, ".content-workspace/content-state"), path.join(directory, ".content-workspace/content-state"), { recursive: true });
    const sourcePath = path.join(directory, ".content-workspace/content/profile/about.json");
    const originalBytes = await readFile(sourcePath, "utf8");
    const original = await readContentAuthoringTarget(targetId, { rootDirectory: directory });
    const edited = await writeContentAuthoringTarget({
      targetId,
      text: `${original.authoring.text}\n临时预览证据段落`,
      sourceHash: original.sourceHash,
      valueHash: original.valueHash,
      rootDirectory: directory,
    });
    const updated = await readContentAuthoringTarget(targetId, { rootDirectory: directory });
    const restored = await writeContentAuthoringTarget({
      targetId,
      text: original.authoring.text,
      sourceHash: updated.sourceHash,
      valueHash: updated.valueHash,
      restoreSnapshot: { sourceHash: original.sourceHash, valueHash: original.valueHash, text: originalBytes },
      rootDirectory: directory,
    });
    assert.equal(restored.sourceRestored, true);
    assert.equal(await readFile(sourcePath, "utf8"), originalBytes);
    return {
      targetId,
      sourcePath: original.sourcePath,
      projectionRoutes: original.projectionRoutes,
      consumerViews: original.consumerViews,
      beforeSourceHash: original.sourceHash,
      editedSourceHash: edited.sourceHash,
      beforeValueHash: original.valueHash,
      editedValueHash: edited.afterValueHash,
      changedRevision: 1,
      restoredExactBytes: true,
      activeBaselineReadOnly: original.activeBaseline?.readOnly === true,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const [head, tagCommit, packageVersion] = await Promise.all([
    git("rev-parse", "HEAD"),
    git("rev-list", "-n", "1", expectedVersion),
    readFile(path.join(projectRoot, "package.json"), "utf8").then((text) => `v${JSON.parse(text).version}`),
  ]);
  assert.equal(packageVersion, expectedVersion, "preview evidence package version must be v0.26.31");
  assert.equal(tagCommit, head, "preview evidence tag must point at exact HEAD");
  const beforeProtected = await protectedState();
  const [resume, intro, homeTitle, usage] = await Promise.all([
    verifyResumeArtifact(),
    resolveContentPreviewTarget("products.robotaxi.intro"),
    resolveContentPreviewTarget("site.home.homeTitle"),
    runPreviewEditRestore(),
  ]);
  const afterProtected = await protectedState();
  assert.deepEqual(afterProtected, beforeProtected, "preview usage must not write protected content/publication state");
  const evidence = {
    schemaVersion: "content-preview-evidence-v1",
    generatedAt: new Date().toISOString(),
    identity: { version: packageVersion, head, tag: expectedVersion, tagCommit },
    resumeArtifact: resume,
    targetImpact: {
      intro: { targetId: intro.targetId, sourcePath: intro.sourcePath, projectionRoutes: intro.projectionRoutes, projectionKeys: intro.projectionKeys, consumerViews: intro.consumerViews },
      homeTitle: { targetId: homeTitle.targetId, sourcePath: homeTitle.sourcePath, projectionRoutes: homeTitle.projectionRoutes, projectionKeys: homeTitle.projectionKeys, consumerViews: homeTitle.consumerViews },
    },
    actualUsage: usage,
    protectedState: { readOnly: true, unchanged: true, before: beforeProtected, after: afterProtected },
    verified: true,
  };
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(path.join(evidenceDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ evidencePath: path.join(evidenceDirectory, "evidence.json"), identity: evidence.identity, targetImpact: evidence.targetImpact, actualUsage: evidence.actualUsage, verified: true }, null, 2));
}

await main();
