import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { access, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  QA_BROWSER_RUNTIME_ERRORS,
  createQaBrowserRun,
  resolveQaBrowserRuntime,
  withQaBrowser,
  runQaBrowserCommand,
} from "../scripts/lib/qa-browser-runtime.mjs";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const controlledChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("resolver rejects Chrome Testing and browser-cache paths before filesystem access", async () => {
  await assert.rejects(
    resolveQaBrowserRuntime({ executablePath: "/Users/test/.cache/puppeteer/chrome/Google Chrome for Testing.app/Contents/MacOS/Google Chrome" }),
    (error) => error.code === QA_BROWSER_RUNTIME_ERRORS.forbiddenPath,
  );
  await assert.rejects(
    resolveQaBrowserRuntime({ executablePath: "/Users/test/Library/Caches/ms-playwright/chromium/chrome" }),
    (error) => error.code === QA_BROWSER_RUNTIME_ERRORS.forbiddenPath,
  );
});

test("static browser gate rejects no direct launch and reports the controlled runtime", () => {
  const output = execFileSync("node", ["scripts/qa-browser-check.mjs"], { cwd: root, encoding: "utf8" });
  assert.match(output, /"staticEntrypoints": "passed"/);
  assert.match(output, /Google Chrome/);
});

test("run manifest and temporary profile are cleaned on normal and assertion failure paths", async () => {
  const runtime = await resolveQaBrowserRuntime({ executablePath: controlledChrome });
  for (const exitState of ["success", "failed"]) {
    const run = await createQaBrowserRun({ root, runtime, taskId: `v02613-${exitState}` });
    const manifest = await run.cleanup({ exitState, error: exitState === "failed" ? new Error("fixture assertion") : null });
    assert.equal(manifest.exitState, exitState);
    assert.equal(manifest.cleanup.status, "verified");
    await assert.rejects(access(run.userDataDir));
    const persisted = JSON.parse(await readFile(run.manifestPath, "utf8"));
    assert.equal(persisted.cleanup.ownedProcessCount, 0);
  }
});

test("Puppeteer entry uses resolver launch options and cleans after failure", async () => {
  const fakeBrowser = {
    process: () => ({ pid: null }),
    close: async () => {},
  };
  const fakePuppeteer = {
    launch: async (options) => {
      assert.equal(options.headless, true);
      assert.equal(options.executablePath, controlledChrome);
      assert.match(options.userDataDir, /qa-browser-runtime/);
      assert.ok(options.args.some((arg) => arg.startsWith("--xingbuild-qa-run-id=")));
      return fakeBrowser;
    },
  };
  await assert.rejects(
    withQaBrowser({ puppeteer: fakePuppeteer, executablePath: controlledChrome, taskId: "v02613-puppeteer-failure" }, async () => {
      throw new Error("fixture assertion");
    }),
    /fixture assertion/,
  );
});

test("command timeout is bounded and cleans its owned process group/profile", async () => {
  await assert.rejects(
    runQaBrowserCommand(process.execPath, ["-e", "setTimeout(() => {}, 10000)"], {
      root,
      taskId: "v02613-timeout",
      puppeteerConfig: false,
      timeoutMs: 80,
    }),
    (error) => error.code === QA_BROWSER_RUNTIME_ERRORS.timeout,
  );
});

test("SIGTERM lifecycle path records signal state and removes the temporary profile", () => {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { readFile } from "node:fs/promises";
    import { withQaBrowser } from "./scripts/lib/qa-browser-runtime.mjs";
    const fakeBrowser = { process: () => ({ pid: null }), close: async () => {} };
    let runtime;
    await withQaBrowser({ puppeteer: { launch: async () => fakeBrowser }, executablePath: ${JSON.stringify(controlledChrome)}, taskId: "v02613-sigterm" }, async ({ runtime: current }) => {
      runtime = current;
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 20);
      await new Promise((resolve) => setTimeout(resolve, 90));
    });
    console.log(JSON.stringify(JSON.parse(await readFile(runtime.manifestPath, "utf8"))));
  `], { cwd: root, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const manifest = JSON.parse(child.stdout.trim().split("\n").at(-1) || "{}");
  assert.equal(manifest.exitState, "signal");
  assert.equal(manifest.signal, "SIGTERM");
  assert.equal(manifest.cleanup.status, "verified");
});

test("Mermaid and Puppeteer share the same runtime policy and no environment cache override", async () => {
  const source = await readFile(path.join(root, "scripts/generate-evergreen-figures.mjs"), "utf8");
  assert.match(source, /runQaBrowserCommand/);
  assert.doesNotMatch(source, /MERMAID_PUPPETEER_EXECUTABLE_PATH/);
  assert.doesNotMatch(source, /puppeteer\.launch/);
  const runtime = await resolveQaBrowserRuntime({ executablePath: controlledChrome });
  assert.equal(runtime.policyVersion, "qa-browser-runtime-v1");
});
