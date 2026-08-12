#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import process from "node:process";
import { assertProductContentCompatibility } from "./lib/content-compatibility.mjs";
import { assertNoVersionStateFields, evaluateCloseoutReadiness, parseCurrentIterationVersion } from "./lib/release-readiness.mjs";
import { access, readFile as readFileAsync } from "node:fs/promises";

function git(...args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const versionRecord = await readFile(new URL("../VERSION.md", import.meta.url), "utf8");
const currentIteration = await readFile(
  new URL("../docs/iterations/current.md", import.meta.url),
  "utf8",
);
await access(new URL("../.content-workspace/qa/v02614/qa-browser-install-policy.json", import.meta.url));
const installPolicyEvidence = JSON.parse(await readFileAsync(new URL("../.content-workspace/qa/v02614/qa-browser-install-policy.json", import.meta.url)));
if (installPolicyEvidence.status !== "passed" || installPolicyEvidence.policyVersion !== "qa-browser-install-policy-v1") {
  throw new Error("QA_BROWSER_INSTALL_POLICY_CLOSEOUT: install policy evidence missing or failed");
}
assertProductContentCompatibility({ currentText: currentIteration });
assertNoVersionStateFields(currentIteration);
const result = evaluateCloseoutReadiness({
  branch: git("branch", "--show-current"),
  allowReleaseWorktree: process.env.XINGBUILD_RELEASE_WORKTREE === "1",
  stagedEntries: git("diff", "--cached", "--name-only").split("\n"),
  unstagedEntries: git("diff", "--name-only").split("\n"),
  untrackedEntries: git("ls-files", "--others", "--exclude-standard").split("\n"),
  packageVersion: packageJson.version,
  versionRecord: versionRecord.match(/^##\s+(v\d+\.\d+\.\d+)\b/m)?.[1],
  currentVersion: parseCurrentIterationVersion(currentIteration),
});
if (!result.ready) {
  console.error(`版本收口未就绪：${result.version}`);
  for (const blocker of result.blockers) console.error(`- ${blocker}`);
  process.exit(1);
}

console.log(`版本收口就绪：${result.version}，暂存范围完整且无遗留工作。`);
