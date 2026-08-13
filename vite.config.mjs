import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  assertValidObservation,
  draftsDirectory,
  isFile,
  readJson,
} from "./scripts/lib/observation-content.mjs";
import {
  createContentPreviewRevisionState,
  listContentPreviewTargetIds,
  readContentPreviewSourceState,
  reduceContentPreviewTargetUpdate,
  resolveContentPreviewTarget,
} from "./scripts/lib/content-preview.mjs";
import { createPreviewRuntimeV2 } from "./scripts/lib/content-preview-runtime-v2.mjs";
import { readContentAuthoringTarget, writeContentAuthoringTarget } from "./scripts/lib/content-preview-authoring.mjs";

const ROBOTAXI_RELEASE_ENDPOINT = "https://robotaxi.xingbuild.top/deployment-manifest.json";

function projectRobotaxiRelease(payload) {
  if (!payload || typeof payload !== "object" || !/^v\d+\.\d+\.\d+$/.test(payload.version || "") || !/^[a-f0-9]{40}$/.test(payload.commit || "")) return null;
  if (payload.production_url !== "https://robotaxi.xingbuild.top/") return null;
  return {
    version: payload.version,
    commit: payload.commit,
    production_url: payload.production_url,
    verifiedAt: new Date().toISOString(),
  };
}

function robotaxiReleaseAdapter() {
  return {
    name: "xingbuild-robotaxi-release-adapter",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__xingbuild/robotaxi-release", async (request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4500);
        try {
          const upstream = await fetch(ROBOTAXI_RELEASE_ENDPOINT, { signal: controller.signal, cache: "no-store" });
          if (!upstream.ok) throw new Error(`upstream returned ${upstream.status}`);
          const release = projectRobotaxiRelease(await upstream.json());
          if (!release) throw new Error("upstream identity failed validation");
          response.statusCode = 200;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "public, max-age=300, stale-while-revalidate=86400");
          response.end(request.method === "HEAD" ? undefined : JSON.stringify(release));
        } catch (error) {
          response.statusCode = 502;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify({ error: "robotaxi-release-unavailable", detail: error.message }));
        } finally {
          clearTimeout(timeout);
        }
      });
    },
  };
}

function contentMediaPreview() {
  const contentMediaRoot = path.resolve(".content-workspace/content/media");
  return {
    name: "xingbuild-content-media-preview",
    apply: "serve",
    configureServer(server) {
      if (process.env.XINGBUILD_CONTENT_BUILD !== "1") return;
      server.middlewares.use("/media", async (request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        const relative = decodeURIComponent((request.url || "").split("?")[0].replace(/^\/+/, ""));
        if (!relative || relative.includes("..") || relative.includes("\\")) return next();
        const file = path.resolve(contentMediaRoot, relative);
        if (!file.startsWith(`${contentMediaRoot}${path.sep}`)) return next();
        try {
          const body = await readFile(file);
          const extension = path.extname(file).toLowerCase();
          const contentType = extension === ".mp4" ? "video/mp4"
            : extension === ".png" ? "image/png"
              : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
                : extension === ".webp" ? "image/webp" : "application/octet-stream";
          response.statusCode = 200;
          response.setHeader("Content-Type", contentType);
          response.setHeader("Content-Length", String(body.byteLength));
          response.setHeader("Accept-Ranges", "bytes");
          response.setHeader("Cache-Control", "no-store");
          response.end(request.method === "HEAD" ? undefined : body);
        } catch {
          next();
        }
      });
    },
  };
}

function isolatedDraftPreview() {
  return {
    name: "xingbuild-isolated-draft-preview",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__xingbuild/drafts", async (request, response) => {
        const slug = decodeURIComponent((request.url || "").split("?")[0].replace(/^\/+/, ""));
        if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) {
          response.statusCode = 400;
          response.end("Invalid draft slug");
          return;
        }
        const file = path.join(draftsDirectory, `${slug}.json`);
        if (!(await isFile(file))) {
          response.statusCode = 404;
          response.end("Draft not found");
          return;
        }
        try {
          const draft = assertValidObservation(await readJson(file), { expectedStatus: "draft" });
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(draft));
        } catch (error) {
          response.statusCode = 422;
          response.end(error.message);
        }
      });
    },
  };
}

function previewMetadata() {
  return {
    name: "xingbuild-preview-metadata",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__xingbuild/preview-meta", (_request, response) => {
        response.statusCode = 200;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify({
          cwd: process.env.XINGBUILD_PREVIEW_CWD || null,
          commit: process.env.XINGBUILD_PREVIEW_COMMIT || null,
          version: process.env.XINGBUILD_PREVIEW_VERSION || null,
          taskId: process.env.XINGBUILD_PREVIEW_TASK_ID || null,
          sessionId: process.env.XINGBUILD_PREVIEW_SESSION_ID || process.env.XINGBUILD_CONTENT_PREVIEW_SESSION_ID || null,
          previewRuntime: process.env.XINGBUILD_PREVIEW_RUNTIME || null,
          mode: process.env.XINGBUILD_PREVIEW_MODE || "product-preview",
          targetId: process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID || null,
          sourcePath: process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || null,
          fieldPath: process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH || null,
          projectionRoutes: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ROUTES"),
          consumerRoutes: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_CONSUMER_ROUTES"),
          consumerViews: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_CONSUMER_VIEWS"),
          projectionKeys: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS"),
          sourceHash: process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH || null,
          valueHash: process.env.XINGBUILD_CONTENT_PREVIEW_VALUE_HASH || null,
          valueType: process.env.XINGBUILD_CONTENT_PREVIEW_VALUE_TYPE || null,
          revision: Number(process.env.XINGBUILD_CONTENT_PREVIEW_REVISION || 0),
          activeBaseline: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE"),
          port: 4317,
        }));
      });
    },
  };
}

function parsePreviewJson(name) {
  try { return process.env[name] ? JSON.parse(process.env[name]) : null; } catch { return null; }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function readRequestBody(request, { maxBytes = 256 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error("content authoring request is too large"), { code: "CONTENT_AUTHORING_BODY_TOO_LARGE" }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")); }
      catch (error) { reject(Object.assign(new Error("content authoring request JSON is invalid"), { code: "CONTENT_AUTHORING_INVALID_JSON", cause: error })); }
    });
    request.on("error", reject);
  });
}

function contentPreviewAuthoringApi() {
  return {
    name: "xingbuild-content-preview-authoring-api",
    apply: "serve",
    configureServer(server) {
      if (process.env.XINGBUILD_PREVIEW_MODE !== "content-preview") return;
      const jsonResponse = (response, status, payload) => {
        response.statusCode = status;
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(payload));
      };
      server.middlewares.use("/__xingbuild/content-targets", async (request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        try {
          const ids = await listContentPreviewTargetIds();
          const targets = (await Promise.all(ids.map((targetId) => readContentAuthoringTarget(targetId).catch(() => null))))
            .filter(Boolean)
            .map((target) => ({
              targetId: target.targetId,
              kind: target.kind,
              valueType: target.valueType,
              editable: target.editable,
              projectionRoutes: target.projectionRoutes,
              consumerViews: target.consumerViews,
              sourcePath: target.sourcePath,
              fieldPath: target.fieldPath,
            }));
          jsonResponse(response, 200, { schemaVersion: "content-authoring-target-list-v1", targets });
        } catch (error) {
          jsonResponse(response, 500, { error: error.code || "CONTENT_AUTHORING_TARGETS_FAILED", detail: error.message });
        }
      });
      server.middlewares.use("/__xingbuild/content-authoring", async (request, response, next) => {
        const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        try {
          if (request.method === "GET" || request.method === "HEAD") {
            const targetId = query.get("target-id");
            if (!targetId) return jsonResponse(response, 400, { error: "CONTENT_AUTHORING_TARGET_REQUIRED" });
            return jsonResponse(response, 200, await readContentAuthoringTarget(targetId));
          }
          if (request.method !== "POST") return next();
          const body = await readRequestBody(request);
          if (typeof body?.targetId !== "string") return jsonResponse(response, 400, { error: "CONTENT_AUTHORING_TARGET_REQUIRED" });
          const result = await writeContentAuthoringTarget(body);
          return jsonResponse(response, 200, { schemaVersion: "content-authoring-write-v1", ...result });
        } catch (error) {
          const status = /CONFLICT|SOURCE_CHANGED|VALUE_CHANGED/.test(error.code || "") ? 409 : 422;
          return jsonResponse(response, status, { error: error.code || "CONTENT_AUTHORING_WRITE_FAILED", detail: error.message });
        }
      });
    },
  };
}

export function contentPreviewWorkbench() {
  return {
    name: "xingbuild-content-preview-workbench",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__xingbuild/content-preview", async (request, response, next) => {
        const enabled = process.env.XINGBUILD_PREVIEW_MODE === "content-preview"
          && Boolean(process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID);
        if (!enabled) return next();
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        const sessionTargetId = process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID;
        const targetId = query.get("target-id") || (sessionTargetId === "__all__" ? null : sessionTargetId);
        let authored = null;
        if (targetId) {
          try { authored = await readContentAuthoringTarget(targetId); }
          catch (error) {
            response.statusCode = error.code === "CONTENT_PREVIEW_TARGETS_EMPTY" ? 404 : 422;
            response.setHeader("Content-Type", "text/plain; charset=utf-8");
            response.end(error.message);
            return;
          }
        }
        const routes = authored?.projectionRoutes || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_CONSUMER_ROUTES")
          || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ROUTES") || [];
        const routeUrl = (route, viewport) => `${route}${route.includes("?") ? "&" : "?"}__xingbuild_content_preview=${viewport}`;
        const baseline = authored?.activeBaseline || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE") || {};
        const sourcePath = authored?.sourcePath || process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || "";
        const fieldPath = authored?.fieldPath || process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH || "";
        const sourceHash = authored?.sourceHash || process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH || "";
        const valueHash = authored?.valueHash || process.env.XINGBUILD_CONTENT_PREVIEW_VALUE_HASH || "";
        const consumerViews = authored?.consumerViews || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_CONSUMER_VIEWS") || [];
        const frames = consumerViews.length ? consumerViews.map((view) => ({
          route: view.route,
          viewport: view.viewport,
          title: `${view.route} · ${view.viewport === "mobile-390" ? "Mobile 390" : "Web 1280"}`,
          width: view.viewport === "mobile-390" ? 390 : 1280,
          height: view.viewport === "mobile-390" ? 844 : 900,
        })) : routes.flatMap((route) => [
          { route, viewport: "web-1280", title: `${route} · Web 1280`, width: 1280, height: 900 },
          { route, viewport: "mobile-390", title: `${route} · Mobile 390`, width: 390, height: 844 },
        ]);
        const frameHtml = frames.map((frame) => `
      <section class="view" aria-label="${escapeHtml(frame.title)}">
        <h2>${escapeHtml(frame.title)}</h2>
        <iframe data-preview-frame data-route="${escapeHtml(frame.route)}" data-viewport="${escapeHtml(frame.viewport)}" data-revision="0" data-base-src="${escapeHtml(routeUrl(frame.route, frame.viewport))}" title="${escapeHtml(frame.title)}" width="${frame.width}" height="${frame.height}" src="${escapeHtml(routeUrl(frame.route, frame.viewport))}"></iframe>
      </section>`).join("");
        const authoring = authored?.authoring || null;
        const responsive = authoring?.valueType === "responsive-text-slot-v1";
        const targetListHtml = !targetId ? `<section class="target-list"><h2>选择要编辑的页面内容</h2><p>按页面和字段选择后，直接输入自然文本；保存只影响该字段对应的页面。</p><div data-target-list>正在读取可编辑字段…</div></section>` : "";
        const editorHtml = targetId ? `<section class="editor" data-editor>
          <div class="editor-heading"><div><h2>直接编辑内容</h2><p>${authored?.editable ? "在这里输入文字并按回车换行。保存只写入本地内容源。" : "该对象属于媒体或非文本内容，当前仅可查看。"}</p></div><span class="pill">${responsive ? "响应式文本" : "普通文本"}</span></div>
          <label>页面/字段 <code>${escapeHtml(targetId)}</code></label>
          <textarea data-editor-web rows="6" ${authored?.editable ? "" : "readonly"}>${escapeHtml(authoring?.text || "")}</textarea>
          ${responsive ? `<label class="mobile-toggle"><input type="checkbox" data-mobile-enabled> 移动端需要单独换行</label><textarea data-editor-mobile rows="6" ${authored?.editable ? "" : "readonly"}>${escapeHtml(authoring?.mobileText || authoring?.text || "")}</textarea>` : ""}
          <div class="editor-actions"><button data-save ${authored?.editable ? "" : "disabled"}>保存并预览</button><span data-save-status>本地草稿，未审核 · 未发布</span></div>
        </section>` : "";
        const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>xingbuild 本地内容预览</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, -apple-system, sans-serif; color: #0f172a; background: #f8fafc; }
      body { margin: 0; padding: 24px; }
      header { max-width: 1400px; margin: 0 auto 24px; }
      h1 { font-size: 24px; margin: 0 0 8px; }
      p { margin: 4px 0; color: #475569; }
      code { font-family: ui-monospace, SFMono-Regular, monospace; word-break: break-all; }
      .status { display: grid; gap: 4px; margin-top: 16px; padding: 16px; background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; }
      .views { display: flex; flex-wrap: wrap; gap: 24px; align-items: flex-start; margin: 24px auto 0; max-width: 1400px; }
      .view { background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px; overflow: auto; }
      .view h2 { margin: 0 0 8px; font-size: 16px; }
      iframe { display: block; border: 0; background: #fff; }
      .readonly { color: #0369a1; font-weight: 600; }
      .editor, .target-list { max-width: 1400px; margin: 24px auto 0; padding: 20px; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; }
      .editor-heading { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
      .editor h2, .target-list h2 { margin: 0 0 8px; font-size: 18px; }
      .editor label { display: block; margin: 14px 0 6px; font-weight: 600; }
      textarea { display: block; width: 100%; box-sizing: border-box; resize: vertical; min-height: 120px; padding: 12px; border: 1px solid #94a3b8; border-radius: 8px; font: inherit; line-height: 1.6; }
      .mobile-toggle { font-weight: 400 !important; color: #475569; }
      .editor-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
      button { border: 0; border-radius: 8px; padding: 10px 16px; color: #fff; background: #0f766e; font: inherit; cursor: pointer; }
      button:disabled { background: #94a3b8; cursor: not-allowed; }
      .pill { background: #e0f2fe; color: #075985; padding: 4px 8px; border-radius: 999px; font-size: 12px; }
      [data-target-list] { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 8px; }
      [data-target-list] a { display: block; padding: 10px 12px; border: 1px solid #e2e8f0; border-radius: 8px; color: #0f172a; text-decoration: none; }
      [data-target-list] a:hover { border-color: #0f766e; background: #f0fdfa; }
      .target-route { display: block; color: #64748b; font-size: 12px; margin-top: 3px; }
    </style>
  </head>
  <body data-content-preview-mode="content-preview" data-target-id="${escapeHtml(targetId || "__all__")}">
    <header>
      <h1>本地内容预览</h1>
      <p class="readonly">本地内容预览 · 未审核 · 未发布</p>
      <div class="status">
        <p><strong>targetId：</strong><code>${escapeHtml(targetId || "__all__")}</code></p>
        <p><strong>source：</strong><code>${escapeHtml(sourcePath)}</code></p>
        <p><strong>fieldPath：</strong><code>${escapeHtml(fieldPath)}</code></p>
        <p><strong>projectionRoutes：</strong><code>${escapeHtml(JSON.stringify(routes))}</code></p>
        <p><strong>consumerViews：</strong><code>${escapeHtml(JSON.stringify(consumerViews))}</code></p>
        <p><strong>状态：</strong><strong data-preview-status>ready</strong> · revision=<code data-preview-revision>0</code></p>
        <p><strong>最近错误：</strong><code data-preview-error>无</code></p>
        <p><strong>sourceHash：</strong><code>${escapeHtml(sourceHash)}</code></p>
        <p><strong>valueHash：</strong><code>${escapeHtml(valueHash)}</code></p>
        <p><strong>active ContentSet（只读基线）：</strong><code>${escapeHtml(baseline.activeContentSetId || "missing")}</code></p>
        <p><strong>contentSetHash：</strong><code>${escapeHtml(baseline.contentSetHash || "missing")}</code></p>
      </div>
      ${targetListHtml}
      ${editorHtml}
    </header>
    <main class="views">
      ${frameHtml}
    </main>
    <script type="module">
      const statusNode = document.querySelector("[data-preview-status]");
      const revisionNode = document.querySelector("[data-preview-revision]");
      const errorNode = document.querySelector("[data-preview-error]");
      const frames = Array.from(document.querySelectorAll("[data-preview-frame]"));
      const routes = ${safeJson(routes)};
      const consumerViews = ${safeJson(consumerViews)};
      const targetId = ${safeJson(targetId)};
      const sessionTargetId = ${safeJson(sessionTargetId)};
      const authored = ${safeJson(authored)};
      const editor = document.querySelector("[data-editor]");
      const saveStatus = document.querySelector("[data-save-status]");
      const mobileEnabled = document.querySelector("[data-mobile-enabled]");
      const mobileEditor = document.querySelector("[data-editor-mobile]");
      if (mobileEnabled && mobileEditor) {
        mobileEditor.hidden = !mobileEnabled.checked;
        mobileEnabled.addEventListener("change", () => { mobileEditor.hidden = !mobileEnabled.checked; });
      }
      const targetList = document.querySelector("[data-target-list]");
      if (targetList) {
        fetch("/__xingbuild/content-targets").then((response) => response.json()).then((payload) => {
          const links = (payload.targets || []).map((target) => {
            const link = document.createElement("a");
            link.href = "?target-id=" + encodeURIComponent(target.targetId);
            const name = document.createElement("strong");
            name.textContent = target.targetId;
            const routes = document.createElement("span");
            routes.className = "target-route";
            routes.textContent = (target.projectionRoutes || []).join(" · ");
            link.append(name, routes);
            return link;
          });
          targetList.replaceChildren(...links);
          if (!links.length) targetList.textContent = "没有可编辑文本字段";
        }).catch((error) => { targetList.textContent = "字段清单读取失败：" + error.message; });
      }
      function applyUpdate(payload) {
        if (!payload || payload.targetId !== targetId) return;
        statusNode.textContent = payload.status || payload.sessionStatus || "unknown";
        revisionNode.textContent = String(payload.revision || 0);
        errorNode.textContent = payload.error ? (payload.error.code + ": " + payload.error.message) : "无";
        if (payload.refresh !== true || !["valid", "valid-updated", "ready"].includes(payload.status || payload.sessionStatus)) return;
        const affected = new Set((payload.consumerViews || consumerViews).map((view) => view.route + ":" + view.viewport));
        frames.filter((frame) => affected.has(frame.dataset.route + ":" + frame.dataset.viewport)).forEach((frame) => {
          const separator = frame.dataset.baseSrc.includes("?") ? "&" : "?";
          frame.dataset.revision = String(payload.revision || 0);
          frame.src = frame.dataset.baseSrc + separator + "__xingbuild_content_preview_revision=" + encodeURIComponent(String(payload.revision || 0));
        });
      }
      if (targetId) {
        const eventSource = new EventSource("/__xingbuild/preview-events?target-id=" + encodeURIComponent(targetId));
        eventSource.addEventListener("preview-state", (event) => {
          try { applyUpdate(JSON.parse(event.data)); } catch (error) { errorNode.textContent = "PREVIEW_EVENT_INVALID: " + error.message; }
        });
        eventSource.onerror = () => { errorNode.textContent = "PREVIEW_RUNTIME_DISCONNECTED"; };
      }
      document.querySelector("[data-save]")?.addEventListener("click", async () => {
        const web = document.querySelector("[data-editor-web]")?.value ?? "";
        const mobile = mobileEditor && mobileEnabled?.checked ? mobileEditor.value : undefined;
        saveStatus.textContent = "正在保存本地预览…";
        try {
          const response = await fetch("/__xingbuild/content-authoring", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId, text: web, mobileText: mobile, sourceHash: authored?.sourceHash, valueHash: authored?.valueHash }) });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || payload.error || "保存失败");
          authored.sourceHash = payload.sourceHash; authored.valueHash = payload.valueHash;
          saveStatus.textContent = "已保存本地内容源，等待受影响页面刷新…";
        } catch (error) { saveStatus.textContent = "保存失败：" + error.message; }
      });
    </script>
  </body>
</html>`;
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(request.method === "HEAD" ? undefined : html);
      });
    },
  };
}

/**
 * Preview Runtime v2 owns the source watcher and a single explicit SSE event
 * channel. Vite HMR is deliberately not used as a content preview protocol.
 */
export function contentPreviewRuntimeV2() {
  return {
    name: "xingbuild-content-preview-runtime-v2",
    apply: "serve",
    configureServer(server) {
      const enabled = process.env.XINGBUILD_PREVIEW_MODE === "content-preview"
        && Boolean(process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID);
      if (!enabled) return;
      const targetId = process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID;
      const sessionId = process.env.XINGBUILD_CONTENT_PREVIEW_SESSION_ID
        || process.env.XINGBUILD_PREVIEW_SESSION_ID
        || "preview-session-unknown";
      const runtimeMap = new Map();
      const runtimeFor = async (requestedTargetId) => {
        if (!requestedTargetId || (targetId !== "__all__" && requestedTargetId !== targetId)) {
          throw new Error("Content preview target identity mismatch");
        }
        if (!runtimeMap.has(requestedTargetId)) {
          const runtimePromise = resolveContentPreviewTarget(requestedTargetId)
            .then((context) => createPreviewRuntimeV2({ context, sessionId: `${sessionId}:${requestedTargetId}`, server }));
          runtimeMap.set(requestedTargetId, runtimePromise);
        }
        return runtimeMap.get(requestedTargetId);
      };
      server.middlewares.use("/__xingbuild/preview-events", async (request, response, next) => {
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        const requestedTargetId = query.get("target-id") || (targetId === "__all__" ? null : targetId);
        if (!requestedTargetId) {
          response.statusCode = 409;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Content preview target-id is required");
          return;
        }
        try {
          const runtime = await runtimeFor(requestedTargetId);
          if (request.method === "HEAD") {
            response.statusCode = 200;
            response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
            response.end();
            return;
          }
          runtime.broker.connect(request, response);
        } catch (error) {
          response.statusCode = 503;
          response.setHeader("Content-Type", "application/json; charset=utf-8");
          response.end(JSON.stringify({ error: "CONTENT_PREVIEW_RUNTIME_UNAVAILABLE", detail: error.message }));
        }
      });
      server.httpServer?.once("close", () => Promise.all([...runtimeMap.values()].map((promise) => promise.then((runtime) => runtime.close()).catch(() => {}))));
    },
    handleHotUpdate() {
      return [];
    },
  };
}

export function contentPreviewHmr() {
  const contentRoot = path.resolve(process.cwd(), ".content-workspace/content");
  const selectedSourcePath = () => path.resolve(process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || "");
  let revisionState = null;
  return {
    name: "xingbuild-content-preview-hmr",
    apply: "serve",
    async handleHotUpdate({ file, server }) {
      if (process.env.XINGBUILD_PREVIEW_MODE !== "content-preview") return;
      if (!file.startsWith(`${contentRoot}${path.sep}`) || !file.endsWith(".json")) return;
      const targetId = process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID || "";
      const consumerRoutes = parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_CONSUMER_ROUTES")
        || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ROUTES") || [];
      if (!revisionState) {
        revisionState = createContentPreviewRevisionState({
          sourceHash: process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH || null,
          valueHash: process.env.XINGBUILD_CONTENT_PREVIEW_VALUE_HASH || null,
        }, { revision: Number(process.env.XINGBUILD_CONTENT_PREVIEW_REVISION || 0) });
      }
      const selectedSource = selectedSourcePath();
      let reduction;
      if (path.resolve(file) !== selectedSource) {
        reduction = reduceContentPreviewTargetUpdate({ state: revisionState, targetId, consumerRoutes, now: new Date().toISOString() });
      } else {
        try {
          const sourceState = await readContentPreviewSourceState({
            sourcePath: selectedSource,
            fieldPath: process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH,
            valueType: process.env.XINGBUILD_CONTENT_PREVIEW_VALUE_TYPE || "string",
            projectionKeys: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS") || [],
            maxLength: Number(process.env.XINGBUILD_CONTENT_PREVIEW_MAX_LENGTH || 400),
          });
          reduction = reduceContentPreviewTargetUpdate({ state: revisionState, targetId, consumerRoutes, sourceState, now: new Date().toISOString() });
        } catch (error) {
          reduction = reduceContentPreviewTargetUpdate({ state: revisionState, targetId, consumerRoutes, error, now: new Date().toISOString() });
        }
      }
      revisionState = reduction.state;
      server.ws.send({ type: "custom", event: "xingbuild:content-target-update", data: reduction.event });
      return [];
    },
  };
}

export default defineConfig({
  define: {
    __XINGBUILD_CONTENT_BUILD__: JSON.stringify(process.env.XINGBUILD_CONTENT_BUILD === "1"),
    __XINGBUILD_VISUAL_QA__: JSON.stringify(process.env.XINGBUILD_VISUAL_QA === "1"),
    __XINGBUILD_VERSION__: JSON.stringify(`v${JSON.parse(readFileSync(new URL("./package.json", import.meta.url))).version}`),
  },
  build: {
    outDir: "dist/client",
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "0.0.0.0",
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [isolatedDraftPreview(), previewMetadata(), contentPreviewAuthoringApi(), contentPreviewWorkbench(), contentPreviewRuntimeV2(), robotaxiReleaseAdapter(), contentMediaPreview(), react()],
});
