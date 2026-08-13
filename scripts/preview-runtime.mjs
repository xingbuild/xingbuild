import { execFileSync, spawn } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const previewPort = 4317;
export const previewRecordPath = `/tmp/xingbuild-preview-${previewPort}.json`;

function projectRoot() {
  return path.resolve(fileURLToPath(new URL("..", import.meta.url)));
}

export function currentIdentity(root = projectRoot(), { mode = process.env.XINGBUILD_PREVIEW_MODE || "product-preview" } = {}) {
  const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const jsonEnv = (name) => {
    try { return process.env[name] ? JSON.parse(process.env[name]) : null; } catch { return null; }
  };
  return {
    cwd: root,
    commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    version: `v${packageJson.version}`,
    mode,
    taskId: process.env.XINGBUILD_PREVIEW_TASK_ID || process.env.XBUILD_TASK_ID || "local",
    targetId: process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID || null,
    sourcePath: process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || null,
    fieldPath: process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH || null,
    projectionRoutes: jsonEnv("XINGBUILD_CONTENT_PREVIEW_ROUTES"),
    projectionKeys: jsonEnv("XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS"),
    activeBaseline: jsonEnv("XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE"),
  };
}

export function isPreviewRecordFor(record, identity) {
  if (!record || record.port !== previewPort) return false;
  for (const key of ["cwd", "commit", "version", "mode", "taskId", "targetId", "sourcePath", "fieldPath"]) {
    if (identity[key] !== undefined && identity[key] !== null && record[key] !== identity[key]) return false;
  }
  for (const key of ["projectionRoutes", "projectionKeys", "activeBaseline"]) {
    if (identity[key] !== undefined && identity[key] !== null && JSON.stringify(record[key] || null) !== JSON.stringify(identity[key])) return false;
  }
  return true;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readRecord() {
  if (!existsSync(previewRecordPath)) return null;
  try {
    return JSON.parse(await readFile(previewRecordPath, "utf8"));
  } catch {
    return null;
  }
}

async function releaseRecord(pid) {
  const record = await readRecord();
  if (record?.pid === pid) await unlink(previewRecordPath).catch(() => {});
}

async function checkExisting(url, identity) {
  try {
    const response = await fetch(new URL("/__xingbuild/preview-meta", url), { cache: "no-store" });
    if (!response.ok) return false;
    const served = await response.json();
    const matches = isPreviewRecordFor(served, identity);
    if (!matches) {
      console.error(`Preview identity mismatch: served=${JSON.stringify(served)} expected=${JSON.stringify(identity)}`);
    }
    return matches;
  } catch {
    return false;
  }
}

async function reserve(identity) {
  const existing = await readRecord();
  if (existing && isProcessAlive(existing.pid)) {
    throw new Error(`Preview lease is owned by PID ${existing.pid} (${existing.cwd}, ${existing.commit})`);
  }
  if (existing) await unlink(previewRecordPath).catch(() => {});
  const record = {
    ...identity,
    pid: process.pid,
    port: previewPort,
    taskId: process.env.XBUILD_TASK_ID || "local",
    startedAt: new Date().toISOString(),
  };
  await writeFile(previewRecordPath, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return record;
}

async function runPreview() {
  const root = projectRoot();
  const identity = currentIdentity(root);
  await reserve(identity);
  const env = {
    ...process.env,
    XINGBUILD_PREVIEW_CWD: identity.cwd,
    XINGBUILD_PREVIEW_COMMIT: identity.commit,
    XINGBUILD_PREVIEW_VERSION: identity.version,
    XINGBUILD_PREVIEW_TASK_ID: process.env.XBUILD_TASK_ID || "local",
  };
  const openPath = process.env.XINGBUILD_PREVIEW_OPEN_PATH || "/";
  const openArgs = process.env.XINGBUILD_PREVIEW_NO_OPEN === "1" ? [] : ["--open", openPath];
  const child = spawn("npm", ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(previewPort), "--strictPort", ...openArgs], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  let stopping = false;
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (!child.killed) child.kill(signal);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGHUP", () => stop("SIGHUP"));
  const exitCode = await new Promise((resolve) => {
    child.once("error", (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  await releaseRecord(process.pid);
  process.exitCode = exitCode;
}

async function main() {
  const [command, url] = process.argv.slice(2);
  const identity = currentIdentity();
  if (command === "check") {
    process.exitCode = await checkExisting(url || `http://127.0.0.1:${previewPort}/`, identity) ? 0 : 1;
    return;
  }
  await runPreview();
}

if (fileURLToPath(import.meta.url) === path.resolve(process.argv[1] || "")) await main();
