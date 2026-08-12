#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const QA_BROWSER_INSTALL_POLICY_VERSION = "qa-browser-install-policy-v1";
export const QA_BROWSER_INSTALL_POLICY_ERRORS = Object.freeze({
  missingConfig: "QA_BROWSER_INSTALL_POLICY_MISSING_CONFIG",
  invalidConfig: "QA_BROWSER_INSTALL_POLICY_INVALID_CONFIG",
  forbiddenEnvironment: "QA_BROWSER_INSTALL_POLICY_FORBIDDEN_ENV",
  forbiddenCache: "QA_BROWSER_INSTALL_POLICY_FORBIDDEN_CACHE",
  drift: "QA_BROWSER_INSTALL_POLICY_DRIFT",
  sideEffect: "QA_BROWSER_INSTALL_POLICY_SIDE_EFFECT",
});

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const configPath = path.join(root, ".puppeteerrc.cjs");
export const QA_BROWSER_INSTALL_CACHE_DIRECTORY = path.join(
  root,
  ".content-workspace",
  "qa-browser-runtime",
  "puppeteer-cache",
);
const evidencePath = path.join(root, ".content-workspace", "qa", "v02614", "qa-browser-install-policy.json");
const forbiddenEnvironmentNames = Object.freeze([
  "PUPPETEER_CACHE_DIR",
  "PUPPETEER_EXECUTABLE_PATH",
  "PUPPETEER_BROWSER",
  "PUPPETEER_SKIP_DOWNLOAD",
  "PUPPETEER_SKIP_CHROME_DOWNLOAD",
  "PUPPETEER_SKIP_CHROME_HEADLESS_SHELL_DOWNLOAD",
  "PUPPETEER_SKIP_FIREFOX_DOWNLOAD",
  "PUPPETEER_CHROME_SKIP_DOWNLOAD",
  "PUPPETEER_CHROME_HEADLESS_SHELL_SKIP_DOWNLOAD",
  "PUPPETEER_FIREFOX_SKIP_DOWNLOAD",
  "PUPPETEER_TMP_DIR",
]);

function policyError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function now() {
  return new Date().toISOString();
}

function resolveConfig() {
  try {
    return createRequire(import.meta.url)(configPath);
  } catch (error) {
    throw policyError(QA_BROWSER_INSTALL_POLICY_ERRORS.invalidConfig, `无法读取项目 Puppeteer 配置：${error.message}`, { configPath });
  }
}

function assertEnvironment(env) {
  const present = forbiddenEnvironmentNames.filter((name) => env[name] !== undefined);
  if (present.length) {
    throw policyError(
      QA_BROWSER_INSTALL_POLICY_ERRORS.forbiddenEnvironment,
      `禁止通过环境变量覆盖项目安装/运行策略：${present.join(", ")}`,
      { present },
    );
  }
}

function assertCacheDirectory(cacheDirectory) {
  const resolved = path.resolve(cacheDirectory || "");
  const expected = path.resolve(QA_BROWSER_INSTALL_CACHE_DIRECTORY);
  const globalCache = path.resolve(os.homedir(), ".cache", "puppeteer");
  if (resolved !== expected || resolved === globalCache || !resolved.startsWith(`${path.resolve(root, ".content-workspace")}${path.sep}`)) {
    throw policyError(
      QA_BROWSER_INSTALL_POLICY_ERRORS.forbiddenCache,
      `Puppeteer cacheDirectory 必须位于项目 ignored 隔离目录：${resolved}`,
      { expected, resolved, globalCache },
    );
  }
  return resolved;
}

function processSnapshot() {
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => /Chrome for Testing|install\.mjs/i.test(line));
  } catch {
    return [];
  }
}

async function snapshotDirectory(directory) {
  const entries = [];
  const visit = async (current, depth = 0) => {
    if (depth > 3) return;
    try {
      const info = await stat(current);
      entries.push({ path: path.relative(root, current), type: info.isDirectory() ? "directory" : "file", size: info.size, mtimeMs: info.mtimeMs });
      if (info.isDirectory()) {
        for (const entry of await readdir(current)) await visit(path.join(current, entry), depth + 1);
      }
    } catch {
      // Missing cache directories are the expected no-install state.
    }
  };
  await visit(directory);
  return entries;
}

function changedSnapshot(before, after) {
  return JSON.stringify(before) !== JSON.stringify(after);
}

export function assertStaticConfig(config) {
  if (config?.skipDownload !== true || config?.chrome?.skipDownload !== true || config?.["chrome-headless-shell"]?.skipDownload !== true || config?.firefox?.skipDownload !== true) {
    throw policyError(QA_BROWSER_INSTALL_POLICY_ERRORS.drift, "项目 Puppeteer 配置未明确跳过全部浏览器下载", { config });
  }
  return assertCacheDirectory(config.cacheDirectory);
}

async function readRuntimeConfiguration() {
  const puppeteer = (await import("puppeteer")).default;
  if (typeof puppeteer?.configuration !== "function") {
    throw policyError(QA_BROWSER_INSTALL_POLICY_ERRORS.invalidConfig, "Puppeteer configuration API 不可用");
  }
  return puppeteer.configuration();
}

export async function runInstallPolicyCheck({ env = process.env, writeEvidence = true, loadConfiguration = true } = {}) {
  const startedAt = now();
  await access(configPath).catch(() => {
    throw policyError(QA_BROWSER_INSTALL_POLICY_ERRORS.missingConfig, `缺少项目 Puppeteer 配置：${configPath}`, { configPath });
  });
  assertEnvironment(env);
  const staticConfig = resolveConfig();
  const staticCacheDirectory = assertStaticConfig(staticConfig);
  const globalCacheDirectory = path.join(os.homedir(), ".cache", "puppeteer");
  const cacheBefore = await snapshotDirectory(staticCacheDirectory);
  const globalCacheBefore = await snapshotDirectory(globalCacheDirectory);
  const processesBefore = processSnapshot();
  const runtimeConfig = loadConfiguration ? await readRuntimeConfiguration() : null;
  const runtimeCacheDirectory = runtimeConfig ? assertStaticConfig(runtimeConfig) : staticCacheDirectory;
  const cacheAfter = await snapshotDirectory(staticCacheDirectory);
  const globalCacheAfter = await snapshotDirectory(globalCacheDirectory);
  const processesAfter = processSnapshot();
  if (changedSnapshot(cacheBefore, cacheAfter) || changedSnapshot(globalCacheBefore, globalCacheAfter) || JSON.stringify(processesBefore) !== JSON.stringify(processesAfter)) {
    throw policyError(QA_BROWSER_INSTALL_POLICY_ERRORS.sideEffect, "安装策略检查产生了缓存或浏览器进程副作用", { cacheBefore, cacheAfter, globalCacheBefore, globalCacheAfter, processesBefore, processesAfter });
  }
  if (runtimeCacheDirectory !== staticCacheDirectory) {
    throw policyError(QA_BROWSER_INSTALL_POLICY_ERRORS.drift, "Puppeteer configuration API 与项目配置 cacheDirectory 不一致", { staticCacheDirectory, runtimeCacheDirectory });
  }
  const evidence = {
    policyVersion: QA_BROWSER_INSTALL_POLICY_VERSION,
    status: "passed",
    startedAt,
    completedAt: now(),
    configPath: path.relative(root, configPath),
    installPolicy: {
      skipDownload: true,
      chromeSkipDownload: true,
      chromeHeadlessShellSkipDownload: true,
      firefoxSkipDownload: true,
      cacheDirectory: path.relative(root, staticCacheDirectory),
      globalCacheRejected: true,
      forbiddenEnvironmentRejected: true,
    },
    configurationApi: loadConfiguration ? "puppeteer.configuration()" : "static-only-guard",
    cacheSnapshot: { projectBefore: cacheBefore, projectAfter: cacheAfter, globalBefore: globalCacheBefore, globalAfter: globalCacheAfter },
    processSnapshot: { before: processesBefore, after: processesAfter },
    downloadSideEffect: "none-observed",
  };
  if (writeEvidence) {
    await mkdir(path.dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  return evidence;
}

export function runInstallGuard({ env = process.env } = {}) {
  assertEnvironment(env);
  const config = resolveConfig();
  assertStaticConfig(config);
  return { policyVersion: QA_BROWSER_INSTALL_POLICY_VERSION, status: "passed", mode: "install-guard" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const evidence = process.argv.includes("--install-guard")
      ? runInstallGuard()
      : await runInstallPolicyCheck();
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    console.error(`${error.code || QA_BROWSER_INSTALL_POLICY_ERRORS.invalidConfig}: ${error.message}`);
    process.exitCode = 1;
  }
}
