import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
import { createSitePublication } from "../scripts/lib/site-publication.mjs";
import { readActiveContentDataTuple } from "../scripts/lib/content-data-plane.mjs";
import { transportSitePublication } from "../scripts/lib/site-publication-coordinator.mjs";

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

test("V283 canonical positive chain uses exact staged-tree Git objects and real production entries", async () => {
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

    const publication = await createSitePublication({
      productClient: path.join(fixture, "dist", "client"),
      releasesRoot: path.join(fixture, ".content-workspace", "releases"),
      publicationRoot: path.join(fixture, ".content-workspace", "site-publications"),
      sourceRoot: fixture,
      contentPublicationIntent: intent,
      assemble: false,
    });
    assert.equal(publication.siteSnapshot.schemaVersion, "site-snapshot-v1");
    const http = await serveDirectory(publication.client);
    let released;
    try {
      const runCaptureImpl = (_command, args) => args[0] === "whoami"
        ? "authenticated"
        : JSON.stringify({ status: "success", deploymentId: "deployment-v0283-exact-chain", projectId: "makers-ze0f6txvlhco" });
      released = await transportSitePublication({
        publication,
        sourceRoot: fixture,
        argv: ["--authorize-publish"],
        env: {},
        edgeonePath: "edgeone",
        baseUrl: http.baseUrl,
        fetchImpl: fetch,
        runCaptureImpl,
        maxAttempts: 1,
        initialDelayMs: 0,
        maxDelayMs: 0,
        sleepImpl: async () => {},
      });
    } finally {
      await http.close();
    }
    assert.equal(released.state, "released");
    assert.equal(released.activeTupleHash, intent.activeTuple.tupleHash);
    const activeTuple = await readActiveContentDataTuple({ sourceRoot: fixture });
    assert.equal(activeTuple.tupleHash, intent.activeTuple.tupleHash);
    assert.equal(released.publicVerify.contentData.verified, true);
    assert.equal(released.publicVerify.browserRuntime.verified, true);
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
        finalizedActiveTupleHash: activeTuple.tupleHash,
        legacyActivePointerUnchanged: true,
        temporaryRootCleanup: buildEvidence.cleanup,
      },
      productionEntries: ["release:candidate-check", "release:candidate-freeze", "release:closeout-check", "release:commit", "release:build", "prepare-sites-build", "release:preflight", "content:prepare", "content:build", "createSitePublication", "SitePublicationCoordinator", "verifyPublicSitePublication", "finalizeSitePublication", "tag-recovery"],
    }, null, 2)}\n`);
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

/* Stable route: historical transaction tests are loaded only by the stable
   command/self-QA.  test:sites runs the legacy file as its own test input. */
if (process.env.npm_lifecycle_event === "test:release-transaction" || process.env.XINGBUILD_TRANSACTION_SELF_QA === "1") {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  for (const file of (await readdir(directory)).filter((name) => /release-transaction.*\.test\.mjs$/.test(name) && name !== path.basename(fileURLToPath(import.meta.url))).sort()) {
    await import(`./${file}`);
  }
}
