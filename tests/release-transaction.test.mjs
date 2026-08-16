import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

test("V282 stable scope and protected-facts contracts keep v0.28.1 read-only legacy", () => {
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

test("V282 canonical positive chain uses exact staged-tree Git objects and real production entries", async () => {
  const exactTree = stagedTreeOid(root);
  const baseHead = git(root, ["rev-parse", "HEAD"]);
  const blockedTagObject = git(root, ["rev-parse", "refs/tags/v0.28.1"]);
  const blockedTagType = git(root, ["cat-file", "-t", "refs/tags/v0.28.1"]);
  const blockedPeeledCommit = git(root, ["rev-parse", "refs/tags/v0.28.1^{}"]);
  const blockedApprovalHash = sha256Bytes(await readFile(approvalRecordPath(root, "v0.28.1")));
  const before = { baseHead, exactTree, blockedTagObject, blockedTagType, blockedPeeledCommit, blockedApprovalHash, working: workingIdentity(root), protectedHash: captureProtectedFacts(root).hash };
  const fixture = await fsTempDirectory("xingbuild-v0282-positive-");
  const contentRoot = path.join(root, ".content-workspace");
  const env = {
    XINGBUILD_CANONICAL_ROOT: root,
    XINGBUILD_CONTENT_ROOT: contentRoot,
  };
  try {
    git(fixture, ["init", "-q"]);
    await mkdir(path.join(fixture, ".git", "objects", "info"), { recursive: true });
    await writeFile(path.join(fixture, ".git", "objects", "info", "alternates"), `${path.join(root, ".git", "objects")}\n`);
    git(fixture, ["config", "user.email", "v0282-test@example.invalid"]);
    git(fixture, ["config", "user.name", "v0.28.2 isolated positive"]);
    git(fixture, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    git(fixture, ["update-ref", "refs/heads/main", baseHead]);
    git(fixture, ["read-tree", exactTree]);
    git(fixture, ["checkout-index", "-a", "-f"]);
    await symlink(path.join(root, "node_modules"), path.join(fixture, "node_modules"));
    await writeFile(path.join(fixture, ".git", "info", "exclude"), "node_modules\n");
    await mkdir(path.join(fixture, ".content-workspace", "qa", version), { recursive: true });
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

    await rm(path.join(fixture, ".content-workspace", "qa", version, "candidate-identity.json"));
    await rm(path.join(fixture, ".content-workspace", "qa", version, "approval-record.json"));
    runNpm(fixture, ["run", "release:preflight"], env);
    const recovered = JSON.parse(await readFile(closurePath, "utf8"));
    assert.equal(recovered.commit, committedHead);
    assert.equal(git(fixture, ["rev-parse", `refs/tags/${version}`]), tagObject);

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
      closurePath: path.relative(root, closurePath),
      cacheRecovery: "PASS",
      productionEntries: ["release:candidate-check", "release:candidate-freeze", "release:closeout-check", "release:commit", "release:build", "prepare-sites-build", "release:preflight"],
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

/* Stable route: historical transaction tests are loaded only by the stable
   command/self-QA.  test:sites runs the legacy file as its own test input. */
if (process.env.npm_lifecycle_event === "test:release-transaction" || process.env.XINGBUILD_TRANSACTION_SELF_QA === "1") {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  for (const file of (await readdir(directory)).filter((name) => /release-transaction.*\.test\.mjs$/.test(name) && name !== path.basename(fileURLToPath(import.meta.url))).sort()) {
    await import(`./${file}`);
  }
}
