#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { currentIdentity, previewPort } from "./preview-runtime.mjs";
import {
  CONTENT_PREVIEW_MODE,
  listContentPreviewTargetIds,
  resolveContentPreviewTarget,
  sessionEnvironment,
  sessionOutput,
} from "./lib/content-preview.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] || null : null;
}

function samePreviewOwner(served, expected) {
  return served?.mode === CONTENT_PREVIEW_MODE
    && served?.cwd === expected.cwd
    && served?.commit === expected.commit
    && served?.version === expected.version
    && served?.taskId === expected.taskId;
}

async function probePreviewPort({ identity } = {}) {
  const url = `http://127.0.0.1:${previewPort}/__xingbuild/preview-meta`;
  try {
    const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(800) });
    let served = null;
    try { served = await response.json(); } catch { /* an occupied non-preview port is still a hard failure */ }
    if (samePreviewOwner(served, identity)) return { occupied: true, reusable: true, served };
    const error = new Error(`CONTENT_PREVIEW_PORT_OCCUPIED: 4317 is served by an unknown or mismatched process${served ? ` (${JSON.stringify(served)})` : ""}`);
    error.code = "CONTENT_PREVIEW_PORT_OCCUPIED";
    throw error;
  } catch (error) {
    if (error.code === "CONTENT_PREVIEW_PORT_OCCUPIED") throw error;
    await new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: "127.0.0.1", port: previewPort });
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; socket.destroy(); fn(value); };
      socket.setTimeout(600, () => finish(resolve));
      socket.once("connect", () => {
        const occupied = new Error("CONTENT_PREVIEW_PORT_OCCUPIED: 4317 is occupied by a non-preview process");
        occupied.code = "CONTENT_PREVIEW_PORT_OCCUPIED";
        finish(reject, occupied);
      });
      socket.once("error", (socketError) => {
        if (socketError.code === "ECONNREFUSED" || socketError.code === "EHOSTUNREACH") finish(resolve);
        else {
          const occupied = new Error(`CONTENT_PREVIEW_PORT_OCCUPIED: unable to classify 4317 (${socketError.code || socketError.message})`);
          occupied.code = "CONTENT_PREVIEW_PORT_OCCUPIED";
          finish(reject, occupied);
        }
      });
    });
    return { occupied: false, reusable: false };
  }
}

export async function createContentPreviewSession({ targetId, rootDirectory = root, taskId = process.env.XBUILD_TASK_ID || "local" } = {}) {
  const selectedTargetId = targetId || "__all__";
  const contexts = selectedTargetId === "__all__"
    ? await Promise.all((await listContentPreviewTargetIds({ rootDirectory })).map((id) => resolveContentPreviewTarget(id, { rootDirectory }).catch(() => null))).then((items) => items.filter(Boolean))
    : [];
  const context = selectedTargetId === "__all__" ? null : await resolveContentPreviewTarget(selectedTargetId, { rootDirectory });
  if (selectedTargetId === "__all__" && contexts.length === 0) {
    const error = new Error("Content preview has no registered target sources");
    error.code = "CONTENT_PREVIEW_TARGETS_EMPTY";
    throw error;
  }
  const sessionId = process.env.XINGBUILD_PREVIEW_SESSION_ID || `content-preview-${randomUUID()}`;
  const identity = currentIdentity(rootDirectory, { mode: CONTENT_PREVIEW_MODE, sessionId });
  identity.targetId = selectedTargetId;
  return {
    context,
    contexts,
    identity,
    taskId,
    environment: sessionEnvironment(context, { identity, taskId, contexts }),
    output: context ? sessionOutput(context, { identity, taskId, port: previewPort }) : {
      schemaVersion: "content-preview-session-v1",
      mode: CONTENT_PREVIEW_MODE,
      cwd: identity.cwd,
      commit: identity.commit,
      version: identity.version,
      taskId,
      sessionId,
      pid: null,
      port: previewPort,
      targetId: selectedTargetId,
      targetCount: contexts.length,
      readOnly: false,
      statusText: "本地内容编辑与预览 · 未审核 · 未发布",
    },
  };
}

export async function runContentPreview({ targetId, rootDirectory = root, taskId = process.env.XBUILD_TASK_ID || "local", noOpen = false } = {}) {
  const session = await createContentPreviewSession({ targetId, rootDirectory, taskId });
  const portState = await probePreviewPort({ identity: session.identity });
  if (portState.reusable) {
    console.log(JSON.stringify({ ...session.output, reused: true, served: portState.served }, null, 2));
    console.log(`Content preview workbench already running: http://127.0.0.1:${previewPort}/__xingbuild/content-preview`);
    return { ...session, output: { ...session.output, reused: true, served: portState.served } };
  }
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
  console.log(`Content preview workbench: http://127.0.0.1:${previewPort}/__xingbuild/content-preview`);
  if (session.context) {
    console.log(`Source: ${session.context.sourcePath}#${session.context.fieldPath}`);
    console.log(`Routes: ${session.context.projectionRoutes.join(", ")}`);
    console.log(`Active ContentSet baseline: ${session.context.activeBaseline.activeContentSetId} (${session.context.activeBaseline.contentSetHash}) [read-only]`);
  } else {
    console.log(`Targets: ${session.contexts.length} registered source target(s)`);
  }

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
