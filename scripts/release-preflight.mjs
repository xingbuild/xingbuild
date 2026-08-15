#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { assertProductContentCompatibility } from "./lib/content-compatibility.mjs";
import { assertNoVersionStateFields, evaluateProductReleaseReadiness, parseCurrentIterationVersion } from "./lib/release-readiness.mjs";
import { readProductArtifact } from "./lib/product-artifact.mjs";
import { validateLifecycleEvidence } from "./lib/content-lifecycle-evidence.mjs";
import { classifyReleaseScope } from "./lib/release-scope-classifier.mjs";
import { readLifecycleEvidence } from "./lib/lifecycle-evidence-path.mjs";
import { readQaBrowserInstallPolicyEvidence } from "./lib/qa-browser-install-policy.mjs";

function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versionRecord = await readFile(new URL("../VERSION.md", import.meta.url), "utf8");
const currentIteration = await readFile(
  new URL("../docs/iterations/current.md", import.meta.url),
  "utf8",
);
const installPolicyEvidence = await readQaBrowserInstallPolicyEvidence({ root: process.cwd(), version: `v${packageJson.version}` });
assertProductContentCompatibility({ currentText: currentIteration });
assertNoVersionStateFields(currentIteration);
try {
  const lifecycleEvidence = await readLifecycleEvidence({ root: process.cwd(), version: `v${packageJson.version}`, allowMissing: false });
  validateLifecycleEvidence(lifecycleEvidence, { requirePostCommit: true, expectedVersion: `v${packageJson.version}` });
} catch (error) {
  throw new Error(`LIFECYCLE_EVIDENCE_PREFLIGHT: ${error.message}`);
}
let scopeResult;
try {
  scopeResult = classifyReleaseScope({
    root: process.cwd(),
    version: `v${packageJson.version}`,
    phase: "post-commit",
    requireStaged: false,
    allowManifestUntracked: false,
  });
} catch (error) {
  scopeResult = { ready: false, blockers: [`release scope classifier: ${error.message}`] };
}
const result = evaluateProductReleaseReadiness({
  branch: git("branch", "--show-current"),
  allowReleaseWorktree: process.env.XINGBUILD_RELEASE_WORKTREE === "1",
  statusEntries: git("status", "--porcelain").split("\n"),
  packageVersion: packageJson.version,
  versionRecord: versionRecord.match(/^##\s+(v\d+\.\d+\.\d+)\b/m)?.[1],
  currentVersion: parseCurrentIterationVersion(currentIteration),
  headTag: git("describe", "--tags", "--exact-match", "HEAD"),
  origin: git("remote", "get-url", "origin"),
  scopeResult,
});
let productArtifact = null;
const artifactBlockers = [];
const head = git("rev-parse", "HEAD");
try {
  productArtifact = await readProductArtifact({
    clientDirectory: fileURLToPath(new URL("../dist/client", import.meta.url)),
    sourceRoot: fileURLToPath(new URL("..", import.meta.url)),
    version: `v${packageJson.version}`,
    commit: head,
  });
} catch (error) {
  artifactBlockers.push(`ProductArtifact：${error.message}`);
}
if (artifactBlockers.length) result.blockers.push(...artifactBlockers);
if (!result.ready) {
  console.error(`发布未就绪：${result.version}`);
  for (const blocker of result.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log(`发布就绪：${result.version}，main、版本记录、标签、工作区与 ProductArtifact 身份一致。`);
console.log(JSON.stringify({
  productArtifactId: productArtifact.productArtifactId,
  productArtifactHash: productArtifact.productArtifactHash,
  baseSiteArtifactId: productArtifact.baseSiteArtifactId,
}, null, 2));
console.log(JSON.stringify({ scope: scopeResult }, null, 2));
