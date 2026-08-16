#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { classifyReleaseScope, readScopeManifest } from "./lib/release-scope-classifier.mjs";
import { captureProtectedFacts, candidateCheckEvidencePath, createCandidateIdentity, stagedTreeOid, workingIdentity, sha256 } from "./lib/release-transaction.mjs";
import { checkCandidate, checkPlan, checkSideEffects } from "./lib/release-invariants.mjs";

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = `v${packageJson.version}`;
const evidenceDir = path.join(root, ".content-workspace", "qa", version);

function run(command, args) {
  const startedAt = Date.now();
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  const exitCode = result.status == null ? 1 : result.status;
  return { command, args, exitCode, result: exitCode === 0 ? "PASS" : "FAIL", elapsedMs: Date.now() - startedAt, outputHash: sha256(JSON.stringify({ command, args, stdout, stderr, exitCode })) };
}

const scope = classifyReleaseScope({ root, version, phase: "pre-commit", requireStaged: true, allowManifestUntracked: false, allowDeclaredAddedUntracked: false });
if (!scope.ready) throw new Error(`candidate scope is not ready: ${scope.blockers.join("; ")}`);
const beforeIdentity = workingIdentity(root);
const baselineBefore = captureProtectedFacts(root);
const commands = process.argv.includes("--run-checks")
  ? [
      run("npm", ["run", "check"]),
      run(process.execPath, ["--test", "tests/v0281-release-transaction.test.mjs"]),
      run("npm", ["run", "release:prepare"]),
    ]
  : [];
if (commands.some((entry) => entry.result !== "PASS")) throw new Error(`candidate checks failed: ${JSON.stringify(commands)}`);
const afterIdentity = workingIdentity(root);
const baselineAfter = captureProtectedFacts(root);
if (beforeIdentity.identityHash !== afterIdentity.identityHash) throw new Error("candidate commands changed working/index identity");
if (baselineBefore.hash !== baselineAfter.hash) throw new Error("candidate commands changed protected facts");
const candidate = createCandidateIdentity({ root, version, scope, protectedBaseline: baselineBefore });
const observedGit = { treeOid: stagedTreeOid(root), working: afterIdentity };
const invariantResults = [
  checkPlan({ root, version, baseHead: candidate.baseHead, scope: readScopeManifest(root, version), git: { head: candidate.baseHead } }),
  checkCandidate({ candidate, git: observedGit, protectedBaseline: baselineBefore }),
  checkSideEffects({ baselineBefore, baselineAfter }),
];
const failed = invariantResults.filter((entry) => entry.result === "FAIL");
if (failed.length) throw new Error(`candidate invariant failure: ${JSON.stringify(failed)}`);

const phaseInvariants = [
  invariantResults.find((entry) => entry.id === "I-01"),
  invariantResults.find((entry) => entry.id === "I-02"),
  { id: "I-03", result: "PENDING_APPROVAL", evidence: { requiredPhase: "approval" } },
  { id: "I-04", result: "PENDING_APPROVAL", evidence: { requiredPhase: "approval" } },
  { id: "I-05", result: "PENDING_COMMIT", evidence: { requiredPhase: "post-commit" } },
  { id: "I-06", result: "PENDING_BUILD", evidence: { requiredPhase: "post-build" } },
  invariantResults.find((entry) => entry.id === "I-07"),
  { id: "I-08", result: "PENDING_COMMIT", evidence: { requiredPhase: "post-commit" } },
];
const evidence = {
  schemaVersion: "release-candidate-check-v4",
  phase: "pre-commit-self-qa",
  version,
  baseHead: candidate.baseHead,
  treeOid: candidate.treeOid,
  scopeDigest: candidate.scopeDigest,
  candidateHash: candidate.candidateHash,
  protectedBaselineHash: candidate.protectedBaselineHash,
  scope: { ready: scope.ready, blockers: scope.blockers, categories: scope.categories, manifestPath: scope.manifestPath },
  commands,
  beforeIdentity,
  afterIdentity,
  protectedBaseline: { hash: baselineBefore.hash, pathSetHash: baselineBefore.pathSetHash, bytes: baselineBefore.bytes, immutableRootCount: baselineBefore.roots.length, allowedRecordCount: baselineBefore.allowedRoot.records.length },
  protectedAfter: { hash: baselineAfter.hash, pathSetHash: baselineAfter.pathSetHash, bytes: baselineAfter.bytes, immutableRootCount: baselineAfter.roots.length, allowedRecordCount: baselineAfter.allowedRoot.records.length },
  invariants: phaseInvariants,
  executionSource: "canonical-working-path-after-exact-stage",
};
await mkdir(evidenceDir, { recursive: true });
const outputPath = candidateCheckEvidencePath(root, version);
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`);
const baselinePath = path.join(evidenceDir, "side-effect-baseline.json");
await writeFile(baselinePath, `${JSON.stringify(baselineBefore, null, 2)}\n`);
const candidatePath = path.join(evidenceDir, "candidate-identity.json");
await writeFile(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);
console.log(JSON.stringify({ evidencePath: outputPath, candidateIdentityPath: candidatePath, sideEffectBaselinePath: baselinePath, version, treeOid: candidate.treeOid, scopeDigest: candidate.scopeDigest, candidateHash: candidate.candidateHash, invariants: phaseInvariants.map((entry) => `${entry.id}:${entry.result}`) }, null, 2));
