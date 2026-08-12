import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  QA_BROWSER_INSTALL_CACHE_DIRECTORY,
  QA_BROWSER_INSTALL_POLICY_ERRORS,
  assertStaticConfig,
  runInstallGuard,
  runInstallPolicyCheck,
} from "../scripts/qa-browser-install-check.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);

test("project Puppeteer configuration disables every browser download and isolates cache", async () => {
  const evidence = await runInstallPolicyCheck({ writeEvidence: false });
  assert.equal(evidence.status, "passed");
  assert.equal(evidence.installPolicy.skipDownload, true);
  assert.match(evidence.installPolicy.cacheDirectory, /^\.content-workspace[\\/]qa-browser-runtime[\\/]puppeteer-cache$/);
  assert.equal(QA_BROWSER_INSTALL_CACHE_DIRECTORY.includes(".content-workspace"), true);
});

test("install guard rejects environment and cache policy overrides before dependency install", () => {
  assert.throws(
    () => runInstallGuard({ env: { PUPPETEER_CACHE_DIR: "/Users/test/.cache/puppeteer" } }),
    (error) => error.code === QA_BROWSER_INSTALL_POLICY_ERRORS.forbiddenEnvironment,
  );
  assert.throws(
    () => runInstallGuard({ env: { PUPPETEER_EXECUTABLE_PATH: "/tmp/chrome" } }),
    (error) => error.code === QA_BROWSER_INSTALL_POLICY_ERRORS.forbiddenEnvironment,
  );
});

test("configuration drift is a hard failure", () => {
  assert.throws(
    () => assertStaticConfig({ skipDownload: false, cacheDirectory: QA_BROWSER_INSTALL_CACHE_DIRECTORY }),
    (error) => error.code === QA_BROWSER_INSTALL_POLICY_ERRORS.drift,
  );
  assert.throws(
    () => assertStaticConfig({ skipDownload: true, chrome: { skipDownload: true }, "chrome-headless-shell": { skipDownload: true }, firefox: { skipDownload: true }, cacheDirectory: "/Users/test/.cache/puppeteer" }),
    (error) => error.code === QA_BROWSER_INSTALL_POLICY_ERRORS.forbiddenCache,
  );
});

test("policy command is repeatable and writes machine-readable evidence without downloads", () => {
  const first = execFileSync("node", ["scripts/qa-browser-install-check.mjs"], { cwd: root, encoding: "utf8" });
  const second = execFileSync("node", ["scripts/qa-browser-install-check.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(first, /"status": "passed"/);
  assert.match(second, /"downloadSideEffect": "none-observed"/);
});

test("Puppeteer postinstall simulation honors the project policy without a network download", () => {
  const output = execFileSync(process.execPath, ["node_modules/puppeteer/install.mjs"], {
    cwd: root,
    encoding: "utf8",
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("PUPPETEER_"))),
  });
  assert.match(output, /Skipping downloading browsers as instructed/);
});

test("static policy rejects global cache configuration", async () => {
  const source = await readFile(path.join(root, ".puppeteerrc.cjs"), "utf8");
  assert.match(source, /skipDownload:\s*true/);
  assert.match(source, /qa-browser-runtime/);
  assert.doesNotMatch(source, /\.cache[\\/]puppeteer/);
});
