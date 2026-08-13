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
              authoring: target.authoring,
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
        const requestedPage = query.get("page");
        const activeRoute = (requestedPage === "/observations" && routes.find((route) => route.startsWith("/observations/")))
          || (requestedPage && requestedPage.startsWith("/") ? requestedPage : routes[0] || "/");
        const routeUrl = (route, viewport) => `${route}${route.includes("?") ? "&" : "?"}__xingbuild_content_preview=${viewport}`;
        const baseline = authored?.activeBaseline || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE") || {};
        const sourcePath = authored?.sourcePath || process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || "";
        const fieldPath = authored?.fieldPath || process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH || "";
        const sourceHash = authored?.sourceHash || process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_HASH || "";
        const valueHash = authored?.valueHash || process.env.XINGBUILD_CONTENT_PREVIEW_VALUE_HASH || "";
        const consumerViews = authored?.consumerViews || parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_CONSUMER_VIEWS") || [];
        const frames = [
          { route: activeRoute, viewport: "web-1280", title: `${activeRoute} · Web 1280`, width: 1280, height: 900 },
          { route: activeRoute, viewport: "mobile-390", title: `${activeRoute} · Mobile 390`, width: 390, height: 844 },
        ];
        const frameHtml = frames.map((frame) => `
      <section class="view" data-frame-shell data-route="${escapeHtml(frame.route)}" data-viewport="${escapeHtml(frame.viewport)}" aria-label="${escapeHtml(frame.title)}">
        <h2>${escapeHtml(frame.title)}</h2>
        <iframe data-preview-frame data-route="${escapeHtml(frame.route)}" data-viewport="${escapeHtml(frame.viewport)}" data-revision="0" data-base-src="${escapeHtml(routeUrl(frame.route, frame.viewport))}" title="${escapeHtml(frame.title)}" width="${frame.width}" height="${frame.height}" src="${escapeHtml(routeUrl(frame.route, frame.viewport))}"></iframe>
      </section>`).join("");
        const authoring = authored?.authoring || null;
        const responsive = authoring?.valueType === "responsive-text-slot-v1";
        const pageLabels = { "/": "首页", "/products": "B端产品", "/business-observations": "经营观察", "/observations": "观察文章", "/about": "关于我" };
        const fieldName = targetId ? targetId.split(".").at(-1) : "";
        const fieldLabels = { title: "标题", summary: "摘要", intro: "页面说明", why: "为什么做", description: "说明", homeTitle: "首页标题", evidenceBoundary: "证据边界", navLabel: "导航名称", text: "正文" };
        const editorLabel = fieldLabels[fieldName] || fieldName || "页面内容";
        const affectedPages = routes.map((route) => pageLabels[route] || route).join("、");
        const editorHtml = targetId ? `<section class="editor" data-editor>
          <div class="editor-heading"><div><h2>编辑内容</h2><p>${authored?.editable ? "修改后会立即更新右侧页面。" : "该对象属于媒体或非文本内容，当前仅可查看。"}</p></div><span class="pill">${responsive ? "响应式文本" : "普通文本"}</span></div>
          <div class="editor-context" data-editor-context><strong>${escapeHtml(editorLabel)}</strong><span>影响：${escapeHtml(affectedPages || pageLabels[activeRoute] || activeRoute)}</span></div>
          <textarea data-editor-web rows="6" ${authored?.editable ? "" : "readonly"}>${escapeHtml(authoring?.text || "")}</textarea>
          ${responsive ? `<label class="mobile-toggle"><input type="checkbox" data-mobile-enabled ${authoring?.mobileText && authoring.mobileText !== authoring.text ? "checked" : ""}> 移动端需要单独换行</label><textarea data-editor-mobile rows="6" ${authored?.editable ? "" : "readonly"}>${escapeHtml(authoring?.mobileText || authoring?.text || "")}</textarea>` : ""}
          <div class="editor-actions"><button data-save ${authored?.editable ? "" : "disabled"}>保存并预览</button><span data-save-status>未发布</span></div>
        </section>` : "";
        const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>xingbuild 本地内容预览</title>
    <style>
      :root { color-scheme: light; font-family: system-ui, -apple-system, sans-serif; color: #0f172a; background: #f8fafc; }
      body { margin: 0; padding: 16px 24px 24px; }
      header { max-width: 1600px; margin: 0 auto 10px; }
      h1 { font-size: 22px; margin: 0; }
      p { margin: 4px 0; color: #475569; }
      code { font-family: ui-monospace, SFMono-Regular, monospace; word-break: break-all; }
      .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
      .workbench-shell { position: relative; max-width: 1600px; margin: 0 auto; }
      .workbench-controls { position: sticky; top: 0; z-index: 5; padding: 10px 0; background: rgba(248,250,252,.97); border-bottom: 1px solid #e2e8f0; backdrop-filter: blur(8px); }
      .page-select-row { display: flex; align-items: end; justify-content: space-between; gap: 16px; margin-bottom: 10px; }
      .page-select-row label { display: grid; gap: 3px; color: #475569; font-size: 12px; font-weight: 600; }
      .page-select-row select { min-width: 220px; padding: 9px 34px 9px 11px; color: #0f172a; background: #fff; border: 1px solid #94a3b8; border-radius: 8px; font: inherit; font-size: 14px; }
      .page-select-help { color: #64748b; font-size: 12px; }
      .workbench-body { display: grid; grid-template-columns: minmax(240px, 300px) minmax(0, 1fr); gap: 16px; height: calc(100vh - 118px); margin-top: 14px; align-items: start; }
      .editor-column { min-width: 0; height: 100%; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
      .preview-column { position: sticky; top: 98px; min-width: 0; max-height: 100%; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; }
      .preview-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin: 0 0 10px; }
      .preview-heading h2 { margin: 0; font-size: 18px; }
      .preview-heading span { color: #64748b; font-size: 12px; }
      .views { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: start; }
      .view { position: relative; min-width: 0; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; padding: 12px; overflow: auto; }
      .view.is-related { border-color: #0f766e; box-shadow: 0 0 0 2px rgba(15,118,110,.14); }
      .view h2 { margin: 0 0 8px; font-size: 16px; }
      iframe { display: block; border: 0; background: #fff; }
      .editor, .page-panel { padding: 14px; background: #fff; border: 1px solid #cbd5e1; border-radius: 12px; }
      .editor-heading { display: flex; justify-content: space-between; gap: 16px; align-items: start; }
      .editor h2 { margin: 0 0 4px; font-size: 17px; }
      .editor label { display: block; margin: 14px 0 6px; font-weight: 600; }
      textarea { display: block; width: 100%; box-sizing: border-box; resize: vertical; min-height: 120px; padding: 12px; border: 1px solid #94a3b8; border-radius: 8px; font: inherit; line-height: 1.6; }
      .mobile-toggle { font-weight: 400 !important; color: #475569; }
      .editor-actions { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
      button { border: 0; border-radius: 8px; padding: 10px 16px; color: #fff; background: #0f766e; font: inherit; cursor: pointer; }
      button:disabled { background: #94a3b8; cursor: not-allowed; }
      .pill { background: #e0f2fe; color: #075985; padding: 4px 8px; border-radius: 999px; font-size: 12px; }
      .editor-context { display: grid; gap: 3px; margin: 10px 0 8px; padding: 8px 10px; background: #f0fdfa; border: 1px solid #99f6e4; border-radius: 8px; }
      .editor-context strong { color: #0f766e; font-size: 13px; }
      .editor-context span { color: #64748b; font-size: 11px; }
      .empty-editor { padding: 18px 4px; color: #64748b; font-size: 13px; }
      .relation-layer { position: absolute; inset: 0; z-index: 3; pointer-events: none; overflow: visible; }
      .relation-layer path { fill: none; stroke: #0f766e; stroke-width: 2; stroke-dasharray: 5 4; opacity: .82; }
      .relation-layer circle { fill: #0f766e; }
      .relation-caption { fill: #0f766e; font-size: 11px; font-weight: 600; }
      @media (max-width: 980px) { .workbench-body { grid-template-columns: 1fr; height: auto; } .editor-column, .preview-column { position: static; height: auto; max-height: none; overflow: visible; } .views { grid-template-columns: 1fr; } .relation-layer { display: none; } }
      @media (max-width: 700px) { body { padding: 12px; } .page-select-row { align-items: start; flex-direction: column; gap: 8px; } }
    </style>
  </head>
  <body data-content-preview-mode="content-preview" data-target-id="${escapeHtml(targetId || "__all__")}">
    <header>
      <h1>本地编辑预览工具</h1>
      <div class="sr-only" aria-live="polite"><strong data-preview-status>ready</strong> revision=<span data-preview-revision>0</span> <span data-preview-error>无</span></div>
    </header>
    <main class="workbench-shell">
      <section class="workbench-controls" data-workbench-controls>
        <div class="page-select-row">
          <label for="content-preview-page">选择页面<select id="content-preview-page" data-page-select aria-label="选择页面"><option>正在读取页面…</option></select></label>
          <span class="page-select-help">点击右侧页面内容选择要编辑的位置</span>
        </div>
      </section>
      <section class="workbench-body">
        <aside class="editor-column">${editorHtml || `<section class="editor empty-editor" data-editor-empty>选择上方内容字段后，在这里输入内容；下方会显示真实页面预览。</section>`}</aside>
        <section class="preview-column" data-preview-scroll>
          <div class="preview-heading"><h2>页面实时预览</h2><span>预览区可独立上下移动；选中字段会高亮并显示连线</span></div>
          <div class="views" data-views>
            ${frameHtml || `<section class="view empty-editor">请选择一个字段查看真实页面预览</section>`}
          </div>
        </section>
      </section>
      <svg class="relation-layer" data-relation-layer aria-hidden="true"></svg>
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
      const shell = document.querySelector(".workbench-shell");
      const relationLayer = document.querySelector("[data-relation-layer]");
      const pageSelect = document.querySelector("[data-page-select]");
      const PAGE_LABELS = { "/": "首页", "/products": "B端产品", "/business-observations": "经营观察", "/observations": "观察文章", "/about": "关于我" };
      const queryPage = new URLSearchParams(location.search).get("page");
      const currentTargetId = targetId;
      let targetCatalog = [];
      let activePage = queryPage || routes[0] || "/";
      const activeRoute = frames[0]?.dataset.route || activePage;
      let saveTimer = null;
      const routeGroup = (route) => route === "/" || PAGE_LABELS[route] ? route : route.startsWith("/observations/") ? "/observations" : route;
      const pageLabel = (route) => PAGE_LABELS[route] || route;
      const targetFieldLabel = (target) => {
        const field = target.targetId.split(".").at(-1);
        return ({ title: "标题", summary: "摘要", intro: "页面说明", why: "为什么做", description: "说明", homeTitle: "首页标题", evidenceBoundary: "证据边界", navLabel: "导航名称" })[field] || field;
      };
      const targetRoutes = (target) => (target.projectionRoutes || []).map(routeGroup);
      const fieldHref = (id, page) => "?target-id=" + encodeURIComponent(id) + "&page=" + encodeURIComponent(page);
      function renderPageSelect() {
        if (!pageSelect) return;
        const routesInCatalog = new Set(targetCatalog.flatMap((target) => targetRoutes(target)));
        Object.keys(PAGE_LABELS).forEach((route) => routesInCatalog.add(route));
        pageSelect.replaceChildren(...[...routesInCatalog].map((route) => {
          const option = document.createElement("option");
          option.value = route;
          option.textContent = pageLabel(route);
          return option;
        }));
        pageSelect.value = activePage;
      }
      async function loadTargetCatalog() {
        try { const response = await fetch("/__xingbuild/content-targets"); const payload = await response.json(); targetCatalog = payload.targets || []; renderPageSelect(); requestMarkers(); }
        catch (error) { if (errorNode) errorNode.textContent = "页面内容读取失败：" + error.message; }
      }
      pageSelect?.addEventListener("change", () => {
        activePage = pageSelect.value;
        const next = targetCatalog
          .filter((target) => target.editable && target.authoring?.text && targetRoutes(target).includes(activePage))
          .sort((left, right) => targetRoutes(left).length - targetRoutes(right).length)[0];
        location.href = next ? fieldHref(next.targetId, activePage) : "?page=" + encodeURIComponent(activePage);
      });
      if (mobileEnabled && mobileEditor) {
        mobileEditor.hidden = !mobileEnabled.checked;
        mobileEnabled.addEventListener("change", () => { mobileEditor.hidden = !mobileEnabled.checked; });
      }
      loadTargetCatalog();
      function normalizeText(value) { return String(value || "").replace(/\s+/g, "").replace(/[，。！？；：、“”‘’（）()]/g, ""); }
      function clearMarkers() {
        frames.forEach((frame) => {
          frame.closest("[data-frame-shell]")?.classList.remove("is-related");
          try { frame.contentDocument?.querySelectorAll("[data-xingbuild-content-target]").forEach((element) => { element.style.outline = element.dataset.xingbuildOriginalOutline || ""; element.style.boxShadow = element.dataset.xingbuildOriginalShadow || ""; element.style.cursor = element.dataset.xingbuildOriginalCursor || ""; delete element.dataset.xingbuildContentTarget; }); } catch {}
        });
        markerMap.clear();
        if (relationLayer) relationLayer.replaceChildren();
      }
      const markerMap = new Map();
      window.addEventListener("message", (event) => {
        const payload = event.data;
        if (!payload) return;
        if (payload.type === "xingbuild-content-target-click" && payload.targetId) {
          const route = routeGroup(payload.route || activePage);
          location.href = fieldHref(payload.targetId, route);
          return;
        }
        if (payload.type !== "xingbuild-content-target-marker" || !payload.targetId) return;
        const frame = frames.find((candidate) => candidate.dataset.route === payload.route && candidate.dataset.viewport === payload.viewport);
        if (!frame) return;
        markerMap.set(payload.targetId + ":" + payload.route + ":" + payload.viewport, { targetId: payload.targetId, frame, rect: payload.rect, found: payload.found === true });
        drawRelations();
      });
      function requestMarkers() {
        if (!targetCatalog.length) return;
        clearMarkers();
        const pageTargets = targetCatalog.filter((target) => target.editable && target.authoring?.text && (targetRoutes(target).includes(activePage) || (target.projectionRoutes || []).includes(activeRoute)));
        frames.forEach((frame) => frame.contentWindow?.postMessage({
          type: "xingbuild-content-target-request",
          targets: pageTargets.map((target) => ({
            targetId: target.targetId,
            text: target.authoring.text || "",
            mobileText: target.authoring.mobileText || target.authoring.text || "",
          })),
          selectedTargetId: currentTargetId,
          viewport: frame.dataset.viewport,
        }, "*"));
      }
      function locateFrameTarget(frame) {
        if (!currentTargetId || !authored?.authoring?.text) return null;
        try {
          const doc = frame.contentDocument;
          if (!doc) return null;
          const expected = normalizeText(frame.dataset.viewport === "mobile-390" && authored.authoring.mobileText ? authored.authoring.mobileText : authored.authoring.text);
          if (!expected) return null;
          const candidates = [...doc.querySelectorAll("main h1, main h2, main h3, main p, main article, main section, main li, main dt, main dd, main figcaption")].filter((element) => normalizeText(element.textContent).includes(expected.slice(0, Math.min(48, expected.length))));
          const element = candidates.sort((left, right) => left.textContent.length - right.textContent.length)[0];
          if (!element) return null;
          element.dataset.xingbuildOriginalOutline = element.style.outline;
          element.dataset.xingbuildOriginalShadow = element.style.boxShadow;
          element.dataset.xingbuildContentTarget = currentTargetId;
          element.style.outline = "3px solid #0f766e";
          element.style.boxShadow = "0 0 0 5px rgba(15,118,110,.14)";
          frame.closest("[data-frame-shell]")?.classList.add("is-related");
          return element;
        } catch { return null; }
      }
      function drawRelations() {
        if (!relationLayer || !shell || !currentTargetId || window.matchMedia("(max-width: 980px)").matches) return;
        const source = document.querySelector("[data-editor-context]");
        if (!source) return;
        const shellRect = shell.getBoundingClientRect();
        relationLayer.setAttribute("width", String(shell.clientWidth)); relationLayer.setAttribute("height", String(shell.clientHeight)); relationLayer.setAttribute("viewBox", "0 0 " + shell.clientWidth + " " + shell.clientHeight);
        const sourceRect = source.getBoundingClientRect();
        frames.forEach((frame) => {
          const marker = markerMap.get(currentTargetId + ":" + frame.dataset.route + ":" + frame.dataset.viewport); if (!marker?.found) return;
          frame.closest("[data-frame-shell]")?.classList.add("is-related");
          const frameRect = frame.getBoundingClientRect(); const elementRect = marker.rect;
          const x1 = sourceRect.right - shellRect.left; const y1 = sourceRect.top + sourceRect.height / 2 - shellRect.top;
          const x2 = frameRect.left + elementRect.left - shellRect.left; const y2 = frameRect.top + elementRect.top + elementRect.height / 2 - shellRect.top;
          const bend = Math.max(24, (x2 - x1) * .45);
          const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M " + x1 + " " + y1 + " C " + (x1 + bend) + " " + y1 + ", " + (x2 - bend) + " " + y2 + ", " + x2 + " " + y2); relationLayer.append(path);
          [ [x1, y1], [x2, y2] ].forEach(([x, y]) => { const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle"); circle.setAttribute("cx", String(x)); circle.setAttribute("cy", String(y)); circle.setAttribute("r", "3"); relationLayer.append(circle); });
        });
      }
      frames.forEach((frame) => frame.addEventListener("load", () => setTimeout(requestMarkers, 220)));
      window.addEventListener("resize", () => setTimeout(drawRelations, 30));
      document.querySelector("[data-preview-scroll]")?.addEventListener("scroll", () => drawRelations(), { passive: true });
      setTimeout(requestMarkers, 600);
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
      async function saveAuthoring() {
        const web = document.querySelector("[data-editor-web]")?.value ?? "";
        const mobile = mobileEditor && mobileEnabled?.checked ? mobileEditor.value : undefined;
        if (saveStatus) saveStatus.textContent = "正在保存本地预览…";
        try {
          const response = await fetch("/__xingbuild/content-authoring", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ targetId, text: web, mobileText: mobile, sourceHash: authored?.sourceHash, valueHash: authored?.valueHash }) });
          const payload = await response.json();
          if (!response.ok) throw new Error(payload.detail || payload.error || "保存失败");
          authored.sourceHash = payload.sourceHash; authored.valueHash = payload.valueHash;
          if (saveStatus) saveStatus.textContent = payload.unchanged
            ? "内容未变化，未写入源文件 · 未审核 · 未发布"
            : "已更新本地预览，受影响页面已刷新 · 未审核 · 未发布";
        } catch (error) { if (saveStatus) saveStatus.textContent = "保存失败：" + error.message; }
      }
      document.querySelector("[data-save]")?.addEventListener("click", saveAuthoring);
      document.querySelectorAll("[data-editor-web], [data-editor-mobile]").forEach((input) => input.addEventListener("input", () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveAuthoring, 650); }));
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

export function contentPreviewFrameMarker() {
  return {
    name: "xingbuild-content-preview-frame-marker",
    apply: "serve",
    transformIndexHtml(html) {
      if (process.env.XINGBUILD_PREVIEW_MODE !== "content-preview") return html;
      const script = `<script>
(() => {
  const normalize = (value) => String(value || "").replace(/\\s+/g, "").replace(/[，。！？；：、“”‘’（）()]/g, "");
  const marked = new Map();
  const clear = () => { marked.forEach((element) => { element.style.outline = element.dataset.xingbuildOriginalOutline || ""; element.style.boxShadow = element.dataset.xingbuildOriginalShadow || ""; element.style.cursor = element.dataset.xingbuildOriginalCursor || ""; delete element.dataset.xingbuildContentTarget; }); marked.clear(); };
  const markTarget = (target, viewport, selectedTargetId) => {
    const expected = normalize(viewport === "mobile-390" ? target.mobileText : target.text);
    if (!expected) { parent.postMessage({ type: "xingbuild-content-target-marker", targetId: target.targetId, route: location.pathname, viewport, found: false }, "*"); return; }
    const candidates = [...document.querySelectorAll("main h1, main h2, main h3, main p, main article, main section, main li, main dt, main dd, main figcaption")].filter((element) => normalize(element.textContent).includes(expected.slice(0, Math.min(48, expected.length))));
    const element = candidates.sort((left, right) => left.textContent.length - right.textContent.length)[0] || null;
    if (!element) { parent.postMessage({ type: "xingbuild-content-target-marker", targetId: target.targetId, route: location.pathname, viewport, found: false }, "*"); return; }
    element.dataset.xingbuildOriginalOutline = element.style.outline; element.dataset.xingbuildOriginalShadow = element.style.boxShadow; element.dataset.xingbuildOriginalCursor = element.style.cursor; element.dataset.xingbuildContentTarget = target.targetId;
    element.style.outline = target.targetId === selectedTargetId ? "3px solid #0f766e" : "1px dashed rgba(15,118,110,.58)";
    element.style.boxShadow = target.targetId === selectedTargetId ? "0 0 0 5px rgba(15,118,110,.14)" : "0 0 0 2px rgba(15,118,110,.06)";
    element.style.cursor = "pointer";
    marked.set(target.targetId, element);
    const rect = element.getBoundingClientRect();
    parent.postMessage({ type: "xingbuild-content-target-marker", targetId: target.targetId, route: location.pathname, viewport, found: true, rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height } }, "*");
  };
  document.addEventListener("click", (event) => { const target = event.target?.closest?.("[data-xingbuild-content-target]"); if (!target) return; event.preventDefault(); event.stopPropagation(); parent.postMessage({ type: "xingbuild-content-target-click", targetId: target.dataset.xingbuildContentTarget, route: location.pathname, viewport: new URL(location.href).searchParams.get("__xingbuild_content_preview") || "web-1280" }, "*"); }, true);
  window.addEventListener("message", (event) => { if (event.data?.type !== "xingbuild-content-target-request") return; clear(); const viewport = event.data.viewport || "web-1280"; setTimeout(() => (event.data.targets || []).forEach((target) => markTarget(target, viewport, event.data.selectedTargetId)), 80); });
})();
</script>`;
      return html.replace("</head>", script + "</head>");
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
  plugins: [isolatedDraftPreview(), previewMetadata(), contentPreviewAuthoringApi(), contentPreviewWorkbench(), contentPreviewFrameMarker(), contentPreviewRuntimeV2(), robotaxiReleaseAdapter(), contentMediaPreview(), react()],
});
