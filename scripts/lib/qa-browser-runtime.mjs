#!/usr/bin/env node

import { AsyncLocalStorage } from "node:async_hooks";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";

export const QA_BROWSER_RUNTIME_VERSION = "qa-browser-runtime-v1";
export const QA_BROWSER_RUNTIME_ROOT = ".content-workspace/qa-browser-runtime";
export const QA_BROWSER_RUNTIME_ERRORS = Object.freeze({
  unavailable: "QA_BROWSER_RUNTIME_UNAVAILABLE",
  forbiddenPath: "QA_BROWSER_RUNTIME_FORBIDDEN_PATH",
  orphan: "QA_BROWSER_RUNTIME_ORPHAN",
  residueUnknown: "QA_BROWSER_RUNTIME_RESIDUE_UNKNOWN",
  timeout: "QA_BROWSER_RUNTIME_TIMEOUT",
  leaseTimeout: "QA_BROWSER_RUNTIME_LEASE_TIMEOUT",
});

const qaBrowserSessionStorage = new AsyncLocalStorage();

const FORBIDDEN_PATH_PATTERNS = [
  /Google Chrome for Testing\.app/i,
  /(?:^|[\\/])\.cache[\\/]puppeteer(?:[\\/]|$)/i,
  /Library[\\/]Caches[\\/]ms-playwright/i,
  /playwright(?:[\\/]|$).*chrom/i,
];

function runtimeError(code, message, details = {}) {
  const error = new Error(`${code}: ${message}`);
  error.code = code;
  error.details = details;
  return error;
}

function projectRoot() {
  return path.resolve(new URL("../..", import.meta.url).pathname);
}

function registeredExecutablePath(platform = process.platform) {
  if (platform === "darwin") return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
  if (platform === "linux") return "/usr/bin/google-chrome";
  if (platform === "win32") return "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
  return null;
}

function assertPathPolicy(executablePath) {
  if (FORBIDDEN_PATH_PATTERNS.some((pattern) => pattern.test(executablePath))) {
    throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.forbiddenPath, `拒绝自动下载或 Chrome Testing 路径：${executablePath}`, { executablePath });
  }
}

async function inspectExecutable(executablePath) {
  assertPathPolicy(executablePath);
  try {
    const info = await stat(executablePath);
    if (!info.isFile()) throw new Error("not a file");
    await access(executablePath, fsConstants.X_OK);
  } catch (error) {
    throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.unavailable, `受控浏览器不存在或不可执行：${executablePath}`, { executablePath, cause: error.message });
  }
  let version = "unknown";
  try {
    version = execFileSync(executablePath, ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim() || version;
  } catch (error) {
    throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.unavailable, `无法读取受控浏览器版本：${executablePath}`, { executablePath, cause: error.message });
  }
  if (!/(?:Google )?Chrome|Chromium/i.test(version)) {
    throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.unavailable, `受控 executable 不是 Chrome/Chromium：${executablePath}`, { executablePath, version });
  }
  return { executablePath, version };
}

export async function resolveQaBrowserRuntime({
  executablePath = process.env.XINGBUILD_QA_BROWSER_PATH || registeredExecutablePath(),
  platform = process.platform,
} = {}) {
  if (!executablePath) throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.unavailable, `平台 ${platform} 没有登记的受控浏览器路径`);
  const inspected = await inspectExecutable(path.resolve(executablePath));
  return Object.freeze({
    runtimeVersion: QA_BROWSER_RUNTIME_VERSION,
    executablePath: inspected.executablePath,
    browserFamily: "Google Chrome",
    version: inspected.version,
    source: process.env.XINGBUILD_QA_BROWSER_PATH ? "explicit-env" : "platform-registered",
    policyVersion: QA_BROWSER_RUNTIME_VERSION,
  });
}

function now() {
  return new Date().toISOString();
}

function processSnapshot() {
  try {
    return execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.*)$/);
        return match ? { pid: Number(match[1]), command: match[2] } : null;
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ownedProcesses(runId, userDataDir) {
  return processSnapshot().filter(({ command }) => command.includes(runId) || command.includes(userDataDir));
}

function canSignal(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function acquireQaBrowserLease({ root, runId, taskId, timeoutMs = 120000, pollMs = 50, ttlMs = Math.max(timeoutMs + 30000, 60000) } = {}) {
  const runtimeRoot = path.join(root, QA_BROWSER_RUNTIME_ROOT);
  const leasePath = path.join(runtimeRoot, "browser-lease.json");
  const startedAt = Date.now();
  await mkdir(runtimeRoot, { recursive: true });
  while (true) {
    const record = { schemaVersion: QA_BROWSER_RUNTIME_VERSION, runId, taskId, pid: process.pid, acquiredAt: now(), expiresAt: Date.now() + ttlMs };
    let handle;
    try {
      handle = await open(leasePath, "wx");
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
      await handle.close();
      let released = false;
      return Object.freeze({
        leasePath,
        waitMs: Date.now() - startedAt,
        async release() {
          if (released) return;
          released = true;
          const current = await readJson(leasePath).catch(() => null);
          if (current?.runId === runId && current.pid === process.pid) await rm(leasePath, { force: true });
        },
      });
    } catch (error) {
      if (handle) await handle.close().catch(() => {});
      if (error.code !== "EEXIST") throw error;
      const current = await readJson(leasePath).catch(() => null);
      const stale = current && Number(current.expiresAt) <= Date.now() && !processIsAlive(Number(current.pid));
      if (stale) { await rm(leasePath, { force: true }); continue; }
      if (Date.now() - startedAt >= timeoutMs) throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.leaseTimeout, `等待 QA browser lease 超时（${timeoutMs}ms）`, { timeoutMs, leasePath, holder: current });
      await wait(pollMs);
    }
  }
}

function signalProcessGroup(pid, signal) {
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(-pid, signal);
  } catch {
    if (canSignal(pid)) {
      try { process.kill(pid, signal); } catch { /* process exited */ }
    }
  }
}

async function writeJson(file, value) {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function createQaBrowserRun({
  root = projectRoot(),
  taskId = process.env.XBUILD_TASK_ID || "local",
  runtime,
  executablePath,
  runId = `qa-${Date.now()}-${randomUUID()}`,
} = {}) {
  const identity = runtime || await resolveQaBrowserRuntime({ executablePath });
  const runDirectory = path.join(root, QA_BROWSER_RUNTIME_ROOT, runId);
  const userDataDir = path.join(runDirectory, "profile");
  const manifestPath = path.join(runDirectory, "run.json");
  await mkdir(runDirectory, { recursive: true });
  await mkdir(userDataDir, { recursive: true });
  const manifest = {
    schemaVersion: QA_BROWSER_RUNTIME_VERSION,
    runId,
    taskId,
    parentPid: process.pid,
    browserPid: null,
    commandPid: null,
    processGroupId: null,
    startedAt: now(),
    endedAt: null,
    executablePath: identity.executablePath,
    browserFamily: identity.browserFamily,
    browserVersion: identity.version,
    runtimeIdentity: identity,
    userDataDir,
    exitState: "running",
    resources: {
      browserLaunchCount: 0,
      browserCommandCount: 0,
      contextCount: 0,
      activeContextCount: 0,
      peakContextCount: 0,
      leaseWaitMs: null,
    },
    cleanup: { profileRemoved: false, ownedProcessCount: null, status: "pending" },
  };
  await writeJson(manifestPath, manifest);
  let cleanupPromise = null;
  let browser = null;
  let command = null;

  const update = async (changes) => {
    Object.assign(manifest, changes);
    await writeJson(manifestPath, manifest);
  };

  const launchOptions = Object.freeze({
    headless: true,
    executablePath: identity.executablePath,
    userDataDir,
    args: Object.freeze(["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", `--xingbuild-qa-run-id=${runId}`]),
  });

  const writePuppeteerConfig = async () => {
    const configPath = path.join(runDirectory, "puppeteer.json");
    await writeJson(configPath, launchOptions);
    return configPath;
  };

  const setBrowser = async (value) => {
    browser = value;
    const browserProcess = value?.process?.();
    await update({ browserPid: browserProcess?.pid || null });
  };

  const setCommand = async (value) => {
    command = value;
    await update({ commandPid: value?.pid || null, processGroupId: value?.pid || null });
  };

  const recordResources = async (changes) => update({ resources: { ...manifest.resources, ...changes } });

  const cleanup = ({ exitState = "success", error = null, signal = null } = {}) => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
    if (browser) {
      try { await browser.close(); } catch { /* cleanup below remains authoritative */ }
    }
    if (command && canSignal(command.pid)) signalProcessGroup(command.pid, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ownedBeforeProfileRemoval = ownedProcesses(runId, userDataDir);
    for (const processRecord of ownedBeforeProfileRemoval) {
      if (processRecord.pid !== process.pid) signalProcessGroup(processRecord.pid, "SIGKILL");
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    const ownedAfterSignals = ownedProcesses(runId, userDataDir).filter(({ pid }) => pid !== process.pid);
    if (ownedAfterSignals.length) {
      manifest.cleanup = { profileRemoved: false, ownedProcessCount: ownedAfterSignals.length, status: "failed", residue: ownedAfterSignals };
      manifest.exitState = "incident";
      manifest.endedAt = now();
      manifest.error = { code: QA_BROWSER_RUNTIME_ERRORS.orphan, message: "本次 run 仍有可归属浏览器残留", residue: ownedAfterSignals };
      await writeJson(manifestPath, manifest);
      throw runtimeError(QA_BROWSER_RUNTIME_ERRORS.orphan, "本次 run 仍有可归属浏览器残留", { residue: ownedAfterSignals, manifestPath });
    }
    await rm(userDataDir, { recursive: true, force: true });
    await rm(path.join(runDirectory, "puppeteer.json"), { force: true });
    const profileExists = await stat(userDataDir).then(() => true).catch(() => false);
    manifest.cleanup = { profileRemoved: !profileExists, ownedProcessCount: 0, status: profileExists ? "failed" : "verified" };
    manifest.exitState = exitState;
    manifest.endedAt = now();
    if (signal) manifest.signal = signal;
    if (error) manifest.error = { code: error.code || "QA_BROWSER_RUNTIME_RUN_FAILED", message: error.message };
    await writeJson(manifestPath, manifest);
      return JSON.parse(JSON.stringify(manifest));
    })();
    return cleanupPromise;
  };

  return Object.freeze({
    ...identity,
    runId,
    taskId,
    root,
    runDirectory,
    userDataDir,
    manifestPath,
    launchOptions,
    writePuppeteerConfig,
    setBrowser,
    setCommand,
    recordResources,
    cleanup,
  });
}

function withTimeout(promise, timeoutMs, label) {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(runtimeError(QA_BROWSER_RUNTIME_ERRORS.timeout, `${label} 超时（${timeoutMs}ms）`, { timeoutMs })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export async function withQaBrowser({ puppeteer, timeoutMs = 120000, taskId, ...options }, action) {
  if (!puppeteer?.launch) throw new TypeError("withQaBrowser requires the Puppeteer module");
  const session = qaBrowserSessionStorage.getStore();
  if (session) return session.run(action, { timeoutMs });
  const run = await createQaBrowserRun({ taskId, ...options });
  let browser;
  let lease;
  let failure = null;
  let exitState = "success";
  const signalHandlers = new Map();
  const onSignal = (signal) => {
    exitState = "signal";
    const handler = signalHandlers.get(signal);
    if (!handler.promise) {
      handler.promise = (async () => {
        try { if (browser) await browser.close(); } finally {
          try { await run.cleanup({ exitState, signal }); } finally { await lease?.release(); }
        }
      })();
    }
    handler.promise.catch(() => {});
  };
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = { promise: null };
      signalHandlers.set(signal, handler);
      process.once(signal, onSignal);
    }
    lease = await acquireQaBrowserLease({ root: run.root, runId: run.runId, taskId: run.taskId, timeoutMs });
    await run.recordResources({ leaseWaitMs: lease.waitMs });
    browser = await puppeteer.launch(run.launchOptions);
    await run.recordResources({ browserLaunchCount: 1 });
    await run.setBrowser(browser);
    const result = await withTimeout(action({ browser, runtime: run }), timeoutMs, "Puppeteer QA run");
    return result;
  } catch (error) {
    failure = error;
    exitState = error.code === QA_BROWSER_RUNTIME_ERRORS.timeout || error.code === QA_BROWSER_RUNTIME_ERRORS.leaseTimeout ? "timeout" : "failed";
    throw error;
  } finally {
    for (const signal of signalHandlers.keys()) process.removeListener(signal, onSignal);
    try { await run.cleanup({ exitState, error: failure }); } finally { await lease?.release(); }
  }
}

/** Own one Chrome for a bounded batch; nested browser calls are isolated and serial. */
export async function withQaBrowserSession({ puppeteer, timeoutMs = 120000, taskId, ...options }, action) {
  if (!puppeteer?.launch) throw new TypeError("withQaBrowserSession requires the Puppeteer module");
  if (qaBrowserSessionStorage.getStore()) throw new Error("nested QA browser sessions are not allowed");
  const run = await createQaBrowserRun({ taskId, ...options });
  let browser;
  let lease;
  let failure = null;
  let exitState = "success";
  let queue = Promise.resolve();
  let contextCount = 0;
  let activeContextCount = 0;
  let peakContextCount = 0;
  const signalHandlers = new Map();
  const onSignal = (signal) => {
    exitState = "signal";
    const handler = signalHandlers.get(signal);
    if (!handler.promise) {
      handler.promise = (async () => {
        try { if (browser) await browser.close(); } finally {
          try { await run.cleanup({ exitState, signal }); } finally { await lease?.release(); }
        }
      })();
    }
    handler.promise.catch(() => {});
  };
  try {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
      const handler = { promise: null };
      signalHandlers.set(signal, handler);
      process.once(signal, onSignal);
    }
    lease = await acquireQaBrowserLease({ root: run.root, runId: run.runId, taskId: run.taskId, timeoutMs });
    await run.recordResources({ leaseWaitMs: lease.waitMs });
    browser = await puppeteer.launch(run.launchOptions);
    await run.setBrowser(browser);
    await run.recordResources({ browserLaunchCount: 1 });
    const session = Object.freeze({
      runtime: run,
      run(contextAction, { timeoutMs: contextTimeoutMs = timeoutMs } = {}) {
        const execute = async () => {
          const context = typeof browser.createBrowserContext === "function" ? await browser.createBrowserContext() : browser;
          contextCount += 1;
          activeContextCount += 1;
          peakContextCount = Math.max(peakContextCount, activeContextCount);
          await run.recordResources({ contextCount, activeContextCount, peakContextCount });
          try {
            return await withTimeout(contextAction({ browser: context, browserProcess: browser, context, runtime: run }), contextTimeoutMs, "Puppeteer QA context");
          } finally {
            if (context !== browser) await context.close().catch(() => {});
            activeContextCount -= 1;
            await run.recordResources({ contextCount, activeContextCount, peakContextCount });
          }
        };
        const scheduled = queue.then(execute, execute);
        queue = scheduled.catch(() => {});
        return scheduled;
      },
    });
    const result = await withTimeout(qaBrowserSessionStorage.run(session, () => action(session)), timeoutMs, "Puppeteer QA session");
    await queue;
    return result;
  } catch (error) {
    failure = error;
    exitState = error.code === QA_BROWSER_RUNTIME_ERRORS.timeout || error.code === QA_BROWSER_RUNTIME_ERRORS.leaseTimeout ? "timeout" : "failed";
    throw error;
  } finally {
    for (const signal of signalHandlers.keys()) process.removeListener(signal, onSignal);
    try { await run.cleanup({ exitState, error: failure }); } finally { await lease?.release(); }
  }
}

export async function runQaBrowserCommand(commandPath, args, {
  taskId,
  timeoutMs = 120000,
  cwd = projectRoot(),
  env = process.env,
  puppeteerConfig = true,
  configFlag = ["-p"],
  ...options
} = {}) {
  const run = await createQaBrowserRun({ root: cwd, taskId, ...options });
  const configPath = puppeteerConfig ? await run.writePuppeteerConfig() : null;
  const commandArgs = puppeteerConfig ? [...args, ...configFlag, configPath] : args;
  let child;
  let failure = null;
  let exitState = "success";
  let lease;
  try {
    lease = await acquireQaBrowserLease({ root: run.root, runId: run.runId, taskId: run.taskId, timeoutMs });
    await run.recordResources({ leaseWaitMs: lease.waitMs, browserCommandCount: 1 });
    child = spawn(commandPath, commandArgs, { cwd, env: { ...env, XINGBUILD_QA_RUN_ID: run.runId }, detached: true, stdio: "inherit" });
    await run.setCommand(child);
    await withTimeout(new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => code === 0 ? resolve() : reject(new Error(`${commandPath} exited with ${code ?? signal ?? "unknown"}`)));
    }), timeoutMs, "QA browser command");
  } catch (error) {
    failure = error;
    exitState = error.code === QA_BROWSER_RUNTIME_ERRORS.timeout || error.code === QA_BROWSER_RUNTIME_ERRORS.leaseTimeout ? "timeout" : "failed";
    throw error;
  } finally {
    if (failure && child) signalProcessGroup(child.pid, "SIGTERM");
    try { await run.cleanup({ exitState, error: failure }); } finally { await lease?.release(); }
  }
}
