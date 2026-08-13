import { watch, watchFile, unwatchFile } from "node:fs";
import path from "node:path";
import {
  createContentPreviewRevisionState,
  readContentPreviewSourceState,
  reduceContentPreviewTargetUpdate,
} from "./content-preview.mjs";

export const CONTENT_PREVIEW_RUNTIME_V2_SCHEMA = "content-preview-runtime-v2";
export const CONTENT_PREVIEW_EVENT_SCHEMA = "content-preview-event-v2";

function invalidatePreviewModuleChain(server, sourcePath) {
  const roots = server.moduleGraph.getModulesByFile?.(sourcePath) || new Set();
  const queue = [...roots];
  const seen = new Set();
  while (queue.length) {
    const module = queue.shift();
    if (!module || seen.has(module)) continue;
    seen.add(module);
    for (const importer of module.importers || []) queue.push(importer);
    server.moduleGraph.invalidateModule(module);
  }
}

function json(value) {
  return JSON.stringify(value);
}

function eventKey(event) {
  return [
    event.status,
    event.revision,
    event.sourceHash || "",
    event.afterValueHash || event.valueHash || "",
    event.error?.code || "",
  ].join("|");
}

function routeViews(consumerViews = []) {
  return consumerViews.map((view) => ({ route: view.route, viewport: view.viewport }));
}

function normalizeEvent({
  sessionId,
  targetId,
  consumerViews = [],
  state,
  eventType = "ready",
  refresh = false,
  sourceHash = state.sourceHash || state.lastValidSourceHash || null,
  valueHash = state.valueHash || state.lastValidValueHash || null,
  error = state.lastError || null,
  observedAt = new Date().toISOString(),
  reason = null,
} = {}) {
  const status = eventType === "valid"
    ? (state.status === "valid-updated" ? "valid-updated" : "ready")
    : eventType;
  return Object.freeze({
    schemaVersion: CONTENT_PREVIEW_EVENT_SCHEMA,
    runtimeSchemaVersion: CONTENT_PREVIEW_RUNTIME_V2_SCHEMA,
    sessionId,
    targetId,
    status,
    eventType,
    refresh: Boolean(refresh),
    sourceHash,
    valueHash,
    revision: Number(state.revision || 0),
    consumerViews: routeViews(consumerViews),
    error,
    reason,
    observedAt,
  });
}

/**
 * A single local SSE channel owned by the preview runtime. It is deliberately
 * independent from Vite's HMR client and only accepts events from this session.
 */
export function createPreviewEventBroker({
  sessionId,
  targetId,
  consumerViews = [],
  state,
} = {}) {
  const clients = new Set();
  let sequence = 0;
  let closed = false;
  let current = normalizeEvent({ sessionId, targetId, consumerViews, state });

  function frame(event) {
    sequence += 1;
    return "id: " + sessionId + ":" + sequence
      + "\nevent: preview-state\ndata: " + json(event) + "\n\n";
  }

  function send(response, event) {
    if (!closed && !response.writableEnded) {
      try { response.write(frame(event)); } catch { clients.delete(response); }
    }
  }

  function connect(request, response) {
    if (closed) {
      response.statusCode = 410;
      response.end("Preview runtime closed");
      return () => {};
    }
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Content-Preview-Session", sessionId);
    response.flushHeaders?.();
    clients.add(response);
    send(response, current);
    const cleanup = () => clients.delete(response);
    request?.on?.("close", cleanup);
    response.on?.("close", cleanup);
    return cleanup;
  }

  function publish(event) {
    if (closed) return;
    current = Object.freeze({
      ...current,
      ...event,
      schemaVersion: CONTENT_PREVIEW_EVENT_SCHEMA,
      runtimeSchemaVersion: CONTENT_PREVIEW_RUNTIME_V2_SCHEMA,
      sessionId,
      targetId,
      consumerViews: routeViews(event.consumerViews || consumerViews),
    });
    for (const response of clients) send(response, current);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const response of clients) {
      try { response.end(); } catch { /* client already closed */ }
    }
    clients.clear();
  }

  return Object.freeze({
    connect,
    publish,
    close,
    getState: () => current,
    getClientCount: () => clients.size,
    getClosed: () => closed,
  });
}

async function readSourceWithRetry(options, { attempts = 4, delayMs = 60 } = {}) {
  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      return await readContentPreviewSourceState(options);
    } catch (error) {
      lastError = error;
      if (!["ENOENT", "CONTENT_PREVIEW_SOURCE_MISSING", "CONTENT_PREVIEW_SOURCE_INVALID_JSON"].includes(error.code)) throw error;
      if (index + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}

/**
 * Watch only the selected canonical source directory. Atomic save/rename and
 * partial writes are debounced and validated before any frame event is sent.
 */
export function createPreviewSourceWatcher({
  sessionId,
  targetId,
  sourcePath,
  fieldPath,
  valueType,
  projectionKeys = [],
  maxLength = 400,
  consumerRoutes = [],
  consumerViews = [],
  broker,
  onSourceChange = null,
  debounceMs = 120,
} = {}) {
  if (!sourcePath || !broker) throw new TypeError("PreviewSourceWatcher requires sourcePath and broker");
  let state = createContentPreviewRevisionState({
    sourceHash: broker.getState().sourceHash,
    valueHash: broker.getState().valueHash,
  });
  let timer = null;
  let closed = false;
  let processing = false;
  let pending = false;
  let lastEventKey = eventKey(broker.getState());

  async function process() {
    if (closed) return;
    if (processing) {
      pending = true;
      return;
    }
    processing = true;
    let retryAfterInvalid = false;
    try {
      let reduction;
      try {
        const sourceState = await readSourceWithRetry({
          sourcePath,
          fieldPath,
          valueType,
          projectionKeys,
          maxLength,
        });
        reduction = reduceContentPreviewTargetUpdate({
          state,
          targetId,
          consumerRoutes,
          consumerViews,
          sourceState,
          now: new Date().toISOString(),
        });
      } catch (error) {
        reduction = reduceContentPreviewTargetUpdate({
          state,
          targetId,
          consumerRoutes,
          consumerViews,
          error,
          now: new Date().toISOString(),
        });
      }
      const event = normalizeEvent({
        sessionId,
        targetId,
        consumerViews,
        state: reduction.state,
        eventType: reduction.event.status,
        refresh: reduction.event.refresh,
        sourceHash: reduction.event.sourceHash || reduction.state.lastValidSourceHash || null,
        valueHash: reduction.event.afterValueHash || reduction.state.lastValidValueHash || null,
        error: reduction.event.error,
        observedAt: reduction.event.observedAt,
        reason: reduction.event.status === "outside-selected-target" ? "selected-target-value-unchanged" : null,
      });
      const nextKey = eventKey(event);
      if (nextKey !== lastEventKey) {
        state = reduction.state;
        lastEventKey = nextKey;
        onSourceChange?.();
        broker.publish(event);
        // Editors commonly save by truncating and rewriting the JSON file. A
        // transient parse error is useful evidence, but it must not become a
        // terminal preview state when the same save completes shortly after.
        // Retry once on a distinct invalid observation; the event-key gate
        // prevents an invalid file from creating an unbounded retry loop.
        retryAfterInvalid = event.status === "invalid";
      }
    } finally {
      processing = false;
      if (pending) {
        pending = false;
        void process();
      } else if (retryAfterInvalid && !closed) {
        timer = setTimeout(() => void process(), Math.max(debounceMs * 2, 200));
        timer.unref?.();
      }
    }
  }

  function schedule() {
    if (closed) return;
    clearTimeout(timer);
    timer = setTimeout(() => void process(), debounceMs);
    timer.unref?.();
  }

  const sourceDirectory = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
  let polling = false;
  const directoryWatcher = watch(sourceDirectory, { persistent: false }, (_eventType, filename) => {
    if (!filename || String(filename) === sourceName) schedule();
  });
  directoryWatcher.on("error", (error) => {
    // macOS can reject a directory watch with EMFILE when another local
    // browser/runtime consumer owns the descriptor budget. Keep the same
    // scoped source semantics with a file poller instead of turning a
    // watcher-capacity incident into a false content-invalid state.
    if (closed || polling) return;
    polling = true;
    try { directoryWatcher.close(); } catch { /* already closed */ }
    watchFile(sourcePath, { interval: Math.max(debounceMs, 100), persistent: false }, (previous, current) => {
      if (closed) return;
      if (previous.mtimeMs !== current.mtimeMs || previous.size !== current.size || previous.ino !== current.ino) schedule();
    });
  });

  // Reconcile once after the watcher is installed. This closes the small
  // atomic-save race where a write completes between session construction and
  // fs.watch/fs.watchFile registration (especially under descriptor pressure).
  schedule();

  return Object.freeze({
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      try { directoryWatcher.close(); } catch { /* already closed */ }
      if (polling) unwatchFile(sourcePath);
    },
    getState: () => state,
    getClosed: () => closed,
  });
}

export async function createPreviewRuntimeV2({
  context,
  sessionId,
  server,
  debounceMs = 120,
} = {}) {
  if (!context || !sessionId || !server) throw new TypeError("Preview Runtime v2 requires context, sessionId and server");
  const initialState = createContentPreviewRevisionState(context);
  const broker = createPreviewEventBroker({
    sessionId,
    targetId: context.targetId,
    consumerViews: context.consumerViews,
    state: initialState,
  });
  const watcher = createPreviewSourceWatcher({
    sessionId,
    targetId: context.targetId,
    sourcePath: context.sourcePath,
    fieldPath: context.fieldPath,
    valueType: context.valueType,
    projectionKeys: context.projectionKeys,
    maxLength: context.constraints?.maxLength || 400,
    consumerRoutes: context.consumerRoutes,
    consumerViews: context.consumerViews,
    broker,
    onSourceChange: () => {
      invalidatePreviewModuleChain(server, context.sourcePath);
    },
    debounceMs,
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    watcher.close();
    broker.close();
  };
  server.httpServer?.once("close", close);
  return Object.freeze({
    schemaVersion: CONTENT_PREVIEW_RUNTIME_V2_SCHEMA,
    sessionId,
    targetId: context.targetId,
    broker,
    watcher,
    close,
  });
}
