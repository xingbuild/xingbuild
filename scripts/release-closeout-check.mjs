#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { assertProductContentCompatibility } from "./lib/content-compatibility.mjs";
import { assertNoVersionStateFields, evaluateCloseoutReadiness, parseCurrentIterationVersion } from "./lib/release-readiness.mjs";
import { validateLifecycleEvidence } from "./lib/content-lifecycle-evidence.mjs";
import { classifyReleaseScope } from "./lib/release-scope-classifier.mjs";
import { readLifecycleEvidence } from "./lib/lifecycle-evidence-path.mjs";
import { readQaBrowserInstallPolicyEvidence } from "./lib/qa-browser-install-policy.mjs";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
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
  validateLifecycleEvidence(lifecycleEvidence, { requirePostCommit: false, expectedVersion: `v${packageJson.version}` });
} catch (error) {
  throw new Error(`LIFECYCLE_EVIDENCE_CLOSEOUT: ${error.message}`);
}
let scopeResult;
try {
  scopeResult = classifyReleaseScope({
    root: process.cwd(),
    version: `v${packageJson.version}`,
    phase: "pre-commit",
    requireStaged: true,
    allowManifestUntracked: false,
  });
} catch (error) {
  scopeResult = { ready: false, blockers: [`release scope classifier: ${error.message}`] };
}
const result = evaluateCloseoutReadiness({
  branch: git("branch", "--show-current"),
  allowReleaseWorktree: process.env.XINGBUILD_RELEASE_WORKTREE === "1",
  stagedEntries: git("diff", "--cached", "--name-only").split("\n"),
  unstagedEntries: git("diff", "--name-only").split("\n"),
  untrackedEntries: git("ls-files", "--others", "--exclude-standard").split("\n"),
  packageVersion: packageJson.version,
  versionRecord: versionRecord.match(/^##\s+(v\d+\.\d+\.\d+)\b/m)?.[1],
  currentVersion: parseCurrentIterationVersion(currentIteration),
  scopeResult,
});
if (!result.ready) {
  console.error(`版本收口未就绪：${result.version}`);
  for (const blocker of result.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log(`版本收口就绪：${result.version}，暂存范围完整且无遗留工作。`);
console.log(JSON.stringify({ scope: scopeResult }, null, 2));
