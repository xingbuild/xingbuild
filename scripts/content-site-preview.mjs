#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { currentIdentity, previewPort } from "./preview-runtime.mjs";
import {
  CONTENT_PREVIEW_MODE,
  resolveContentPreviewTarget,
  sessionEnvironment,
  sessionOutput,
} from "./lib/content-preview.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

export async function createContentPreviewSession({ targetId, rootDirectory = root, taskId = process.env.XBUILD_TASK_ID || "local" } = {}) {
  if (!targetId) {
    const error = new Error("Usage: npm run content:preview:site -- --target-id <registered targetId>");
    error.code = "CONTENT_PREVIEW_TARGET_REQUIRED";
    throw error;
  }
  const context = await resolveContentPreviewTarget(targetId, { rootDirectory });
  const sessionId = process.env.XINGBUILD_PREVIEW_SESSION_ID || `content-preview-${randomUUID()}`;
  const identity = currentIdentity(rootDirectory, { mode: CONTENT_PREVIEW_MODE, sessionId });
  return {
    context,
    identity,
    taskId,
    environment: sessionEnvironment(context, { identity, taskId }),
    output: sessionOutput(context, { identity, taskId, port: previewPort }),
  };
}

export async function runContentPreview({ targetId, rootDirectory = root, taskId = process.env.XBUILD_TASK_ID || "local", noOpen = false } = {}) {
  const session = await createContentPreviewSession({ targetId, rootDirectory, taskId });
  const environment = {
    ...process.env,
    ...session.environment,
    ...(noOpen ? { XINGBUILD_PREVIEW_NO_OPEN: "1" } : {}),
  };
  const child = spawn(process.execPath, [path.join(rootDirectory, "scripts", "preview-runtime.mjs")], {
    cwd: rootDirectory,
    env: environment,
    stdio: "inherit",
  });
  const output = { ...session.output, pid: child.pid || null };
  console.log(JSON.stringify(output, null, 2));
  console.log(`Content preview workbench: http://127.0.0.1:${previewPort}/__xingbuild/content-preview?target-id=${encodeURIComponent(targetId)}`);
  console.log(`Source: ${session.context.sourcePath}#${session.context.fieldPath}`);
  console.log(`Routes: ${session.context.projectionRoutes.join(", ")}`);
  console.log(`Active ContentSet baseline: ${session.context.activeBaseline.activeContentSetId} (${session.context.activeBaseline.contentSetHash}) [read-only]`);

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
  process.exitCode = exitCode;
  return { ...session, output };
}

async function main(argv = process.argv.slice(2)) {
  const targetId = option(argv, "--target-id");
  const noOpen = argv.includes("--no-open");
  await runContentPreview({ targetId, noOpen });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await main();
  } catch (error) {
    console.error(`Content preview stopped: ${error.message}`);
    process.exitCode = 1;
  }
}
