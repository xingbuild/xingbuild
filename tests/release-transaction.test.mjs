import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  LEGACY_SCOPE_SCHEMA_VERSION,
  SCOPE_CONTRACT_VERSION,
  SCOPE_SCHEMA_VERSION,
  readScopeManifest,
  sha256Bytes,
} from "../scripts/lib/release-scope-classifier.mjs";
import {
  LEGACY_SIDE_EFFECT_POLICY_VERSION,
  SIDE_EFFECT_POLICY_VERSION,
  captureProtectedFacts,
  approvalRecordPath,
  readDurableApprovalRecord,
  stagedTreeOid,
  workingIdentity,
} from "../scripts/lib/release-transaction.mjs";
import { readProductArtifact } from "../scripts/lib/product-artifact.mjs";
import { readContentPublicationIntent } from "../scripts/lib/content-publication-intent.mjs";
import { sitePublicationIdempotencyKey } from "../scripts/lib/site-publication.mjs";
import { readActiveContentDataTuple } from "../scripts/lib/content-data-plane.mjs";
import { readPublicationRun } from "../scripts/lib/publication-run.mjs";
import { readSitePublicationRecord, recoverExistingSitePublication } from "../scripts/lib/site-publication-coordinator.mjs";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const version = `v${packageJson.version}`;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function run(cwd, command, args, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  return result;
}

function runCli(cwd, script, args = [], env = {}) {
  return run(cwd, process.execPath, [path.join(cwd, script), ...args], env);
}

function runNpm(cwd, args, env = {}) {
  return run(cwd, "npm", args, env);
}

test("V283 stable scope and protected-facts contracts keep v0.28.1 read-only legacy", () => {
  const currentScope = readScopeManifest(root, version);
  assert.equal(currentScope.schemaVersion, SCOPE_SCHEMA_VERSION);
  assert.equal(currentScope.contractVersion, SCOPE_CONTRACT_VERSION);
  assert.equal(currentScope.legacy, false);
  assert.ok(currentScope.entries.every((entry) => !Object.hasOwn(entry, "pathHash") && !Object.hasOwn(entry, "beforePathHash")));

  const legacyScope = readScopeManifest(root, "v0.28.1");
  assert.equal(legacyScope.schemaVersion, LEGACY_SCOPE_SCHEMA_VERSION);
  assert.equal(legacyScope.legacy, true);
  const currentBaseline = captureProtectedFacts(root);
  assert.equal(currentBaseline.policyVersion, SIDE_EFFECT_POLICY_VERSION);
  assert.equal(readDurableApprovalRecord(root, "v0.28.1").sideEffectBaseline.policyVersion, LEGACY_SIDE_EFFECT_POLICY_VERSION);
});

if (version === "v0.28.3") test("V283 canonical positive chain uses exact staged-tree Git objects and real production entries", async () => {
  const exactTree = stagedTreeOid(root);
  const baseHead = git(root, ["rev-parse", "HEAD"]);
  const blockedTagObject = git(root, ["rev-parse", "refs/tags/v0.28.1"]);
  const blockedTagType = git(root, ["cat-file", "-t", "refs/tags/v0.28.1"]);
  const blockedPeeledCommit = git(root, ["rev-parse", "refs/tags/v0.28.1^{}"]);
  const blockedApprovalHash = sha256Bytes(await readFile(approvalRecordPath(root, "v0.28.1")));
  const before = { baseHead, exactTree, blockedTagObject, blockedTagType, blockedPeeledCommit, blockedApprovalHash, working: workingIdentity(root), protectedHash: captureProtectedFacts(root).hash };
  const fixture = await fsTempDirectory("xingbuild-v0283-positive-");
  const contentRoot = path.join(root, ".content-workspace");
  const env = {
    XINGBUILD_CANONICAL_ROOT: root,
  };
  try {
    git(fixture, ["init", "-q"]);
    await mkdir(path.join(fixture, ".git", "objects", "info"), { recursive: true });
    await writeFile(path.join(fixture, ".git", "objects", "info", "alternates"), `${path.join(root, ".git", "objects")}\n`);
    git(fixture, ["config", "user.email", "v0283-test@example.invalid"]);
    git(fixture, ["config", "user.name", "v0.28.3 isolated positive"]);
    git(fixture, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(fixture, ["update-ref", "refs/heads/main", baseHead]);
    git(fixture, ["read-tree", exactTree]);
    git(fixture, ["checkout-index", "-a", "-f"]);
    await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"));
    await writeFile(path.join(fixture, ".git", "info", "exclude"), "node_modules\n");
    await mkdir(path.join(fixture, ".content-workspace", "qa", version), { recursive: true });
    // The isolated content authority is a byte-for-byte copy of the current
    // immutable active ContentSet/source facts. It is not a ProductArtifact
    // fixture: the product below is produced by the real release:build path.
    await cp(path.join(root, ".content-workspace", "content"), path.join(fixture, ".content-workspace", "content"), { recursive: true });
    const activePointerBytes = await readFile(path.join(root, ".content-workspace", "content-state", "active.json"));
    const activePointer = JSON.parse(activePointerBytes);
    const fixtureState = path.join(fixture, ".content-workspace", "content-state");
    await mkdir(path.join(fixtureState, "sets"), { recursive: true });
    await writeFile(path.join(fixtureState, "active.json"), activePointerBytes);
    await cp(path.join(root, ".content-workspace", "content-state", "sets", activePointer.activeContentSetId), path.join(fixtureState, "sets", activePointer.activeContentSetId), { recursive: true });
    await cp(path.join(root, ".content-workspace", "reviews"), path.join(fixture, ".content-workspace", "reviews"), { recursive: true });
    await mkdir(path.join(fixture, ".edgeone"), { recursive: true });
    await writeFile(path.join(fixture, ".edgeone", "project.json"), JSON.stringify({ Name: "xingbuild-nochina", ProjectId: "makers-ze0f6txvlhco" }));
    assert.equal(git(fixture, ["rev-parse", "HEAD"]), baseHead);
    assert.equal(git(fixture, ["write-tree"]), exactTree);
    assert.equal(git(fixture, ["rev-parse", `${exactTree}:scripts/prepare-sites-build.mjs`]), git(root, ["rev-parse", `${exactTree}:scripts/prepare-sites-build.mjs`]));
    assert.equal(git(fixture, ["rev-parse", `${exactTree}:scripts/release-build.mjs`]), git(root, ["rev-parse", `${exactTree}:scripts/release-build.mjs`]));
    assert.equal(git(fixture, ["rev-parse", `${exactTree}:scripts/release-preflight.mjs`]), git(root, ["rev-parse", `${exactTree}:scripts/release-preflight.mjs`]));

    runCli(fixture, "scripts/release-candidate-check.mjs", [], env);
    runCli(fixture, "scripts/release-candidate-freeze.mjs", [], env);
    runNpm(fixture, ["run", "qa:browser:install-policy"], env);
    const approvalScript = path.join(fixture, ".content-workspace", "fixture-elon-approve.mjs");
    await writeFile(approvalScript, `import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
const root = process.cwd();
const tx = await import(pathToFileURL(path.join(root, "scripts/lib/release-transaction.mjs")).href);
const version = "${version}";
const candidate = JSON.parse(await readFile(tx.candidateIdentityPath(root, version), "utf8"));
const approval = tx.createApprovalRecord({ root, version, candidate });
await mkdir(path.dirname(tx.approvalRecordPath(root, version)), { recursive: true });
await writeFile(tx.approvalRecordPath(root, version), JSON.stringify(approval, null, 2) + "\\n");
`);
    run(fixture, process.execPath, [approvalScript], env);
    runCli(fixture, "scripts/release-closeout-check.mjs", [], env);
    runCli(fixture, "scripts/release-commit.mjs", ["--approval", `.content-workspace/qa/${version}/approval-record.json`], env);
    const committedHead = git(fixture, ["rev-parse", "HEAD"]);
    const tagObject = git(fixture, ["rev-parse", `refs/tags/${version}`]);
    assert.equal(git(fixture, ["rev-parse", `${committedHead}^{tree}`]), exactTree);
    assert.equal(git(fixture, ["rev-parse", `${committedHead}^`]), baseHead);
    assert.equal(git(fixture, ["cat-file", "-t", `refs/tags/${version}`]), "tag");

    runNpm(fixture, ["run", "release:build", "--", "--approval", `.content-workspace/qa/${version}/approval-record.json`], env);
    const artifact = await readProductArtifact({ clientDirectory: path.join(fixture, "dist", "client"), sourceRoot: fixture, version, commit: committedHead });
    assert.equal(artifact.productCommit, committedHead);
    assert.equal(artifact.approvedTreeOid, exactTree);
    assert.equal(artifact.documents.baseSiteArtifact.materializationKind, "client");
    assert.equal(artifact.documents.baseSiteArtifact.clientPath, `.content-workspace/base-site-artifacts/${artifact.baseSiteArtifactId}/client`);
    assert.equal(await exists(path.join(fixture, ".content-workspace", "base-site-artifacts", artifact.baseSiteArtifactId, "source")), false);
    runNpm(fixture, ["run", "release:preflight"], env);
    const closurePath = path.join(fixture, ".content-workspace", "qa", version, "closure-report.json");
    assert.equal(await exists(closurePath), true);
    const closure = JSON.parse(await readFile(closurePath, "utf8"));
    assert.equal(closure.commit, committedHead);
    assert.equal(closure.tag, version);
    assert.equal(closure.invariants.every((entry) => entry.result === "PASS"), true);

    // Product tag/cache recovery belongs to the release transaction boundary
    // and is completed before the independent content active tuple changes
    // the protected content-data facts.
    await rm(path.join(fixture, ".content-workspace", "qa", version, "candidate-identity.json"));
    await rm(path.join(fixture, ".content-workspace", "qa", version, "approval-record.json"));
    runNpm(fixture, ["run", "release:preflight"], env);
    const recovered = JSON.parse(await readFile(closurePath, "utf8"));
    assert.equal(recovered.commit, committedHead);
    assert.equal(git(fixture, ["rev-parse", `refs/tags/${version}`]), tagObject);

    // The content CLI is now part of the same exact-tree transaction. Both
    // prepare and build consume the persisted immutable intent; build also
    // materializes/validates a temporary upload root and runs a real browser
    // runtime smoke without transport or active-tuple mutation.
    const contentEnv = { ...env };
    delete contentEnv.XINGBUILD_CONTENT_ROOT;
    const parseCliJson = (result) => {
      const lines = `${result.stdout || ""}\n${result.stderr || ""}`.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const line = lines.reverse().find((value) => value.startsWith("{") && value.endsWith("}"));
      assert.ok(line, `content CLI did not return machine JSON: status=${result.status} signal=${result.signal || ""} stdout=${result.stdout || ""} stderr=${result.stderr || ""}`);
      return JSON.parse(line);
    };
    const prepareOutput = parseCliJson(runCli(fixture, "scripts/content-release.mjs", ["--prepare", "--kind", "home", "--slug", "home"], contentEnv));
    const preparedCli = prepareOutput;
    assert.equal(preparedCli.mode, "prepared");
    assert.match(preparedCli.intentId, /^content-publication-intent-/);
    const candidateStatePath = path.join(fixture, ".content-workspace", "content-state", "sets", preparedCli.contentSetId, "content-set.json");
    assert.equal(await exists(candidateStatePath), true, `prepared ContentSet candidate is missing: ${candidateStatePath}`);
    const changeFiles = await readdir(path.join(fixture, ".content-workspace", "changes")).catch(() => []);
    assert.equal(changeFiles.length > 0, true, `prepared ChangeSet is missing; files=${changeFiles.join(",")}`);
    const builtCli = parseCliJson(runCli(fixture, "scripts/content-release.mjs", ["--build", "--kind", "home", "--slug", "home"], contentEnv));
    assert.equal(builtCli.mode, "built");
    assert.equal(builtCli.intentId, preparedCli.intentId);
    assert.equal(builtCli.materialization, "validated-cleaned");
    const buildEvidence = JSON.parse(await readFile(path.join(fixture, builtCli.evidencePath), "utf8"));
    assert.equal(buildEvidence.browserRuntime.result, "PASS");
    assert.equal(buildEvidence.transport, "not-run");
    assert.equal(buildEvidence.activeTuple, "not-written");
    const intent = await readContentPublicationIntent({ sourceRoot: fixture, intentId: preparedCli.intentId });
    assert.equal(intent.intentHash, preparedCli.intentHash);
    assert.equal(intent.siteSnapshot.schemaVersion, "site-snapshot-v1");
    const beforeActiveTuple = await exists(path.join(fixture, ".content-workspace", "content-state", "content-data-active.json"));
    assert.equal(beforeActiveTuple, false);

    // Recovery must start from the real persisted v0.28.3 incident, not from
    // a new v0.28.4 publication with an injected failure. Copy only the
    // immutable publication/run bytes into the isolated repository.
    const incidentPublicationName = "v0.28.3-85e8c3d080f9-0f0dd6c9be883e84";
    const incidentPublication = path.join(fixture, ".content-workspace", "site-publications", incidentPublicationName);
    await cp(path.join(root, ".content-workspace", "site-publications", incidentPublicationName), incidentPublication, { recursive: true });
    const incidentRunId = "publication-run-site-snapshot-0f0dd6c9be883e840fa0e5385ad35317bd9c1dd3e0f6d7f52acbc91ba0dbf8f2";
    const incidentRunDirectory = path.join(fixture, ".content-workspace", "publication-runs", incidentRunId);
    await mkdir(incidentRunDirectory, { recursive: true });
    await cp(path.join(root, ".content-workspace", "publication-runs", incidentRunId), incidentRunDirectory, { recursive: true });
    const publication = await readSitePublicationRecord(incidentPublication);
    const incidentRun = await readPublicationRun({ sourceRoot: fixture, publicationRunId: incidentRunId });
    assert.equal(publication.state, "failed");
    assert.equal(publication.phase, "verified");
    assert.equal(publication.runtimeAcceptanceSpec, undefined);
    assert.equal(publication.publicVerify, null);
    assert.equal(incidentRun.state, "failed");
    assert.equal(incidentRun.deploymentCount, 1);
    assert.equal(incidentRun.publicVerify, null);
    const incidentStart = {
      publicationState: publication.state,
      publicationPhase: publication.phase,
      failurePhase: publication.failure?.phase || null,
      runtimeAcceptanceSpec: publication.runtimeAcceptanceSpec || null,
      publicVerify: publication.publicVerify,
      runState: incidentRun.state,
      runPublicVerify: incidentRun.publicVerify,
      deploymentId: publication.deploymentId,
      deploymentCount: incidentRun.deploymentCount,
      activeTupleAbsent: true,
    };
    const nonExactPublication = path.join(fixture, ".content-workspace", "site-publications", `${incidentPublicationName}-nonexact`);
    await cp(incidentPublication, nonExactPublication, { recursive: true });
    const nonExactRecordPath = path.join(nonExactPublication, "site-publication.json");
    const nonExactRecord = JSON.parse(await readFile(nonExactRecordPath, "utf8"));
    nonExactRecord.productCommit = "0000000000000000000000000000000000000000";
    await writeFile(nonExactRecordPath, `${JSON.stringify(nonExactRecord, null, 2)}\n`);
    await assert.rejects(() => recoverExistingSitePublication({
      publicationDirectory: nonExactPublication,
      sourceRoot: fixture,
      argv: ["--authorize-publish"],
      maxAttempts: 1,
      initialDelayMs: 0,
      maxDelayMs: 0,
      sleepImpl: async () => {},
    }), /v0\.28\.3 recovery compatibility identity mismatch/);
    const http = await serveDirectory(incidentPublication);
    let released;
    try {
      const failedPublication = await readSitePublicationRecord(incidentPublication);
      const failedRun = await readPublicationRun({ sourceRoot: fixture, publicationRunId: incidentRunId });
      assert.equal(failedPublication.state, "failed");
      assert.equal(failedPublication.phase, "verified");
      assert.equal(failedPublication.publicVerify, null);
      assert.equal(failedPublication.deploymentId, "dpgr0trnxfcv");
      assert.equal(failedRun.state, "failed");
      assert.equal(failedRun.publicVerify, null);
      assert.equal(failedRun.deploymentCount, 1);
      await assert.rejects(() => readActiveContentDataTuple({ sourceRoot: fixture }), /ENOENT|active ContentData tuple/);

      const failedRecordBytes = await readFile(path.join(incidentPublication, "site-publication.json"));
      const publicationCli = await import(pathToFileURL(path.join(fixture, "scripts/site-publication.mjs")).href);
      await assert.rejects(() => publicationCli.main([
        "--recover-existing",
        "--publication",
        path.relative(fixture, incidentPublication),
      ]), /publish authorization is required/);
      await assert.rejects(() => recoverExistingSitePublication({
        publicationDirectory: incidentPublication,
        sourceRoot: fixture,
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        argv: [],
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      }), /publish authorization is required/);
      assert.deepEqual(await readFile(path.join(incidentPublication, "site-publication.json")), failedRecordBytes);

      const leaseDirectory = path.join(fixture, ".content-workspace", "site-publications", ".site-lease");
      const leasePath = path.join(leaseDirectory, "lease.json");
      await mkdir(leaseDirectory, { recursive: true });
      await writeFile(leasePath, `${JSON.stringify({
        idempotencyKey: sitePublicationIdempotencyKey({ sitePublicationId: publication.sitePublicationId, snapshotHash: publication.snapshotHash }),
        contentReleaseId: publication.sitePublicationId,
        pid: process.pid + 1,
        expiresAt: Date.now() + 900000,
      })}\n`);
      await assert.rejects(() => recoverExistingSitePublication({
        publicationDirectory: incidentPublication,
        sourceRoot: fixture,
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        argv: ["--authorize-publish"],
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      }), /lease is held/);
      await rm(leasePath, { force: true });

      const recoveryFailure = new Error("injected recovery verifier failure");
      recoveryFailure.code = "PUBLICATION_RUNTIME_RECOVERY_INCIDENT";
      recoveryFailure.recoverable = true;
      await assert.rejects(() => recoverExistingSitePublication({
        publicationDirectory: incidentPublication,
        sourceRoot: fixture,
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        argv: ["--authorize-publish"],
        browserRuntimeVerify: async () => { throw recoveryFailure; },
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      }), /injected recovery verifier failure/);
      const recoveryFailedPublication = await readSitePublicationRecord(incidentPublication);
      const recoveryFailedRun = await readPublicationRun({ sourceRoot: fixture, publicationRunId: incidentRunId });
      assert.equal(recoveryFailedPublication.state, "recoverable");
      assert.equal(recoveryFailedPublication.publicVerify, null);
      assert.equal(recoveryFailedRun.state, "recoverable");
      assert.equal(recoveryFailedRun.publicVerify, null);
      assert.equal(recoveryFailedRun.deploymentCount, 1);
      assert.ok(recoveryFailedPublication.failureHistory?.length >= 1);
      assert.ok(recoveryFailedPublication.verificationAttempts?.some((attempt) => attempt.result === "recoverable"));
      assert.ok(recoveryFailedPublication.verificationAttempts?.some((attempt) => attempt.runtimeAcceptanceSpec && attempt.runtimeAcceptanceSpecHash));
      assert.ok(recoveryFailedRun.recoveryAttempts?.some((attempt) => attempt.result === "recoverable"));
      assert.ok(recoveryFailedRun.recoveryAttempts?.some((attempt) => attempt.runtimeAcceptanceSpec && attempt.runtimeAcceptanceSpecHash));
      await assert.rejects(() => readActiveContentDataTuple({ sourceRoot: fixture }), /ENOENT|active ContentData tuple/);
      assert.equal((await readdir(leaseDirectory).catch(() => [])).length, 0);

      // The exact incident starts failed/recoverable after transport success;
      // recovery now verifies that one deployment and finalizes the tuple once.
      const recovery = await recoverExistingSitePublication({
        publicationDirectory: incidentPublication,
        sourceRoot: fixture,
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        argv: ["--authorize-publish"],
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      });
      released = recovery;
      assert.equal(recovery.state, "released");
      assert.equal(recovery.deploymentId, "dpgr0trnxfcv");
      assert.equal(recovery.recovery.transportCalls, 0);
      assert.equal(recovery.recovery.deploymentCount, 1);
      assert.equal(recovery.recovery.result, "finalized");
      assert.ok(recovery.failureHistory?.length >= 1);
      assert.ok(recovery.verificationAttempts?.some((attempt) => attempt.result === "verified"));
      assert.ok(recovery.verificationAttempts?.some((attempt) => attempt.runtimeAcceptanceSpec && attempt.runtimeAcceptanceSpecHash));
      const recoveredRun = await readPublicationRun({ sourceRoot: fixture, publicationRunId: incidentRunId });
      assert.equal(recoveredRun.state, "released");
      assert.equal(recoveredRun.publicVerify != null, true);
      assert.equal(recoveredRun.recovery.result, "finalized");
      assert.equal(recoveredRun.runtimeAcceptanceSpecHash, recovery.runtimeAcceptanceSpecHash);
      assert.deepEqual(recoveredRun.runtimeAcceptanceSpec, recovery.runtimeAcceptanceSpec);
      assert.ok(recoveredRun.recoveryAttempts?.some((attempt) => attempt.result === "recoverable"));
      assert.ok(recoveredRun.recoveryAttempts?.some((attempt) => attempt.result === "verified"));
      assert.ok(recoveredRun.recoveryAttempts?.some((attempt) => attempt.runtimeAcceptanceSpec && attempt.runtimeAcceptanceSpecHash));
      const activeTuple = await readActiveContentDataTuple({ sourceRoot: fixture });
      assert.equal(activeTuple.tupleHash, released.activeTupleHash);
      assert.equal(recovery.publicVerify.contentData.verified, true);
      assert.equal(recovery.publicVerify.browserRuntime.verified, true);
      const repeatedRecovery = await recoverExistingSitePublication({
        publicationDirectory: incidentPublication,
        sourceRoot: fixture,
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        argv: ["--authorize-publish"],
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      });
      assert.equal(repeatedRecovery.state, "released");
      assert.equal(repeatedRecovery.deploymentId, "dpgr0trnxfcv");
      assert.equal(repeatedRecovery.recovery.transportCalls, 0);
      assert.equal(repeatedRecovery.activeTupleHash, activeTuple.tupleHash);
      const leaseEntries = await readdir(path.join(fixture, ".content-workspace", "site-publications", ".site-lease")).catch(() => []);
      assert.equal(leaseEntries.length, 0);

    // Retain the isolated post-commit reports for independent machine
    // readback after the temporary exact-tree repository is removed. Only the
    // ignored QA evidence is copied; the canonical product/worktree remains
    // unchanged and no production fact is imported from the fixture.
      const chainEvidenceRoot = path.join(root, ".content-workspace", "qa", version, "canonical-positive-chain");
    await mkdir(chainEvidenceRoot, { recursive: true });
    const retainedClosurePath = path.join(chainEvidenceRoot, "closure-report.json");
    const retainedBuildEvidencePath = path.join(chainEvidenceRoot, "content-build-evidence.json");
    await cp(closurePath, retainedClosurePath);
    await cp(path.join(fixture, builtCli.evidencePath), retainedBuildEvidencePath);
    const evidencePath = path.join(root, ".content-workspace", "qa", version, "canonical-positive-chain.json");
    await mkdir(path.dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, `${JSON.stringify({
      schemaVersion: "canonical-positive-chain-v1",
      phase: "pre-commit-self-qa",
      executionSource: "isolated-git-alternate-exact-staged-tree",
      version,
      canonicalBaseHead: baseHead,
      canonicalStagedTreeOid: exactTree,
      isolatedBaseHead: git(fixture, ["rev-parse", `${committedHead}^`]),
      isolatedStagedTreeOid: exactTree,
      isolatedCommit: committedHead,
      isolatedTagObject: tagObject,
      productArtifactId: artifact.productArtifactId,
      productArtifactHash: artifact.productArtifactHash,
      closurePath: path.relative(root, retainedClosurePath),
      cacheRecovery: "PASS",
      contentChain: {
        prepareCommand: "node scripts/content-release.mjs --prepare --kind home --slug home",
        buildCommand: "node scripts/content-release.mjs --build --kind home --slug home",
        intentId: preparedCli.intentId,
        intentHash: preparedCli.intentHash,
        snapshotSchemaVersion: intent.siteSnapshot.schemaVersion,
        buildEvidencePath: path.relative(root, retainedBuildEvidencePath),
        materialization: buildEvidence.validation,
        browserRuntime: buildEvidence.browserRuntime,
        sitePublicationId: released.sitePublicationId,
        deploymentId: released.deploymentId,
        publicVerify: released.publicVerify,
        sameDeploymentRecovery: {
          incidentStart,
          state: recovery.state,
          deploymentId: recovery.deploymentId,
          deploymentCount: recovery.recovery.deploymentCount,
          transportCalls: recovery.recovery.transportCalls,
          runtimeAcceptanceSpec: recovery.verificationAttempts?.find((attempt) => attempt.runtimeAcceptanceSpec)?.runtimeAcceptanceSpec || null,
          runtimeAcceptanceSpecSource: recovery.verificationAttempts?.find((attempt) => attempt.runtimeAcceptanceSpec)?.runtimeAcceptanceSpecSource || null,
          verificationAttempts: recovery.verificationAttempts || [],
        },
        finalizedActiveTupleHash: activeTuple.tupleHash,
        legacyActivePointerUnchanged: true,
        temporaryRootCleanup: buildEvidence.cleanup,
      },
      productionEntries: ["release:candidate-check", "release:candidate-freeze", "release:closeout-check", "release:commit", "release:build", "prepare-sites-build", "release:preflight", "content:prepare", "content:build", "existing-v0.28.3-SitePublication-Run-deployment-bytes", "site-publication.mjs --recover-existing --authorize-publish", "SitePublicationCoordinator", "verifyPublicSitePublication", "finalizeSitePublication", "tag-recovery"],
      }, null, 2)}\n`);
      await http.close();
    } finally {
      await http.close().catch(() => {});
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
  const after = { baseHead: git(root, ["rev-parse", "HEAD"]), exactTree: stagedTreeOid(root), blockedTagObject: git(root, ["rev-parse", "refs/tags/v0.28.1"]), blockedTagType: git(root, ["cat-file", "-t", "refs/tags/v0.28.1"]), blockedPeeledCommit: git(root, ["rev-parse", "refs/tags/v0.28.1^{}"]), blockedApprovalHash: sha256Bytes(await readFile(approvalRecordPath(root, "v0.28.1"))), working: workingIdentity(root), protectedHash: captureProtectedFacts(root).hash };
  assert.deepEqual(after, before);
});

async function fsTempDirectory(prefix) {
  return await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), prefix)));
}

async function exists(file) {
  return await import("node:fs/promises").then(({ access }) => access(file).then(() => true).catch(() => false));
}

async function serveDirectory(directory) {
  const resolvedRoot = path.resolve(directory);
  const server = createServer(async (request, response) => {
    const pathname = decodeURIComponent(new URL(request.url || "/", "http://127.0.0.1").pathname);
    const relative = pathname.replace(/^\/+/, "") || "index.html";
    const candidate = path.resolve(resolvedRoot, relative);
    if (candidate !== resolvedRoot && !candidate.startsWith(`${resolvedRoot}${path.sep}`)) {
      response.writeHead(400); response.end("path traversal"); return;
    }
    try {
      const body = await readFile(candidate);
      const type = candidate.endsWith(".json") ? "application/json" : candidate.endsWith(".js") ? "text/javascript" : candidate.endsWith(".css") ? "text/css" : candidate.endsWith(".svg") ? "image/svg+xml" : candidate.endsWith(".mp4") ? "video/mp4" : "text/html";
      response.writeHead(200, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
      response.end(body);
    } catch (error) {
      if (!pathname.startsWith("/content-data/") && pathname !== "/content-data/active.json") {
        try {
          const index = await readFile(path.join(resolvedRoot, "index.html"));
          response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(index); return;
        } catch { /* return 404 below */ }
      }
      response.writeHead(error.code === "ENOENT" ? 404 : 500); response.end(error.message);
    }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  return { baseUrl: `http://127.0.0.1:${address.port}/`, async close() { await new Promise((resolve) => server.close(resolve)); } };
}

/* The stable route loads only the current transaction authority. Historical
   suites remain visible to test:sites and its retained-baseline classifier,
   but cannot redefine the current release contract. */
if (process.env.npm_lifecycle_event === "test:release-transaction" || process.env.XINGBUILD_TRANSACTION_SELF_QA === "1") {
  await import("./release-transaction-v0285-authority.test.mjs");
}
