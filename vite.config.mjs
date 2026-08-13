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
          mode: process.env.XINGBUILD_PREVIEW_MODE || "product-preview",
          targetId: process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID || null,
          sourcePath: process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || null,
          fieldPath: process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH || null,
          projectionRoutes: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ROUTES"),
          projectionKeys: parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_PROJECTION_KEYS"),
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

function contentPreviewWorkbench() {
  return {
    name: "xingbuild-content-preview-workbench",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__xingbuild/content-preview", (request, response, next) => {
        const enabled = process.env.XINGBUILD_PREVIEW_MODE === "content-preview"
          && Boolean(process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID);
        if (!enabled) return next();
        if (request.method !== "GET" && request.method !== "HEAD") return next();
        const query = new URL(request.url || "/", "http://127.0.0.1").searchParams;
        const targetId = process.env.XINGBUILD_CONTENT_PREVIEW_TARGET_ID;
        if (query.get("target-id") && query.get("target-id") !== targetId) {
          response.statusCode = 409;
          response.setHeader("Content-Type", "text/plain; charset=utf-8");
          response.end("Content preview target identity mismatch");
          return;
        }
        const routes = parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ROUTES") || [];
        const route = routes[0] || "/products";
        const routeUrl = (viewport) => `${route}${route.includes("?") ? "&" : "?"}__xingbuild_content_preview=${viewport}`;
        const baseline = parsePreviewJson("XINGBUILD_CONTENT_PREVIEW_ACTIVE_BASELINE") || {};
        const sourcePath = process.env.XINGBUILD_CONTENT_PREVIEW_SOURCE_PATH || "";
        const fieldPath = process.env.XINGBUILD_CONTENT_PREVIEW_FIELD_PATH || "";
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
    </style>
  </head>
  <body data-content-preview-mode="content-preview" data-target-id="${escapeHtml(targetId)}">
    <header>
      <h1>本地内容预览</h1>
      <p class="readonly">本地内容预览 · 未审核 · 未发布</p>
      <div class="status">
        <p><strong>targetId：</strong><code>${escapeHtml(targetId)}</code></p>
        <p><strong>source：</strong><code>${escapeHtml(sourcePath)}</code></p>
        <p><strong>fieldPath：</strong><code>${escapeHtml(fieldPath)}</code></p>
        <p><strong>projectionRoutes：</strong><code>${escapeHtml(JSON.stringify(routes))}</code></p>
        <p><strong>active ContentSet（只读基线）：</strong><code>${escapeHtml(baseline.activeContentSetId || "missing")}</code></p>
        <p><strong>contentSetHash：</strong><code>${escapeHtml(baseline.contentSetHash || "missing")}</code></p>
      </div>
    </header>
    <main class="views">
      <section class="view" aria-label="Web 1280 预览">
        <h2>Web 1280</h2>
        <iframe title="Web 1280 preview" width="1280" height="900" src="${escapeHtml(routeUrl("web-1280"))}"></iframe>
      </section>
      <section class="view" aria-label="Mobile 390 预览">
        <h2>Mobile 390</h2>
        <iframe title="Mobile 390 preview" width="390" height="844" src="${escapeHtml(routeUrl("mobile-390"))}"></iframe>
      </section>
    </main>
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

function contentPreviewHmr() {
  const contentRoot = path.resolve(".content-workspace/content");
  return {
    name: "xingbuild-content-preview-hmr",
    apply: "serve",
    handleHotUpdate({ file, server }) {
      if (process.env.XINGBUILD_PREVIEW_MODE !== "content-preview") return;
      if (!file.startsWith(`${contentRoot}${path.sep}`) || !file.endsWith(".json")) return;
      server.ws.send({ type: "full-reload", path: "*" });
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
  plugins: [isolatedDraftPreview(), previewMetadata(), contentPreviewWorkbench(), contentPreviewHmr(), robotaxiReleaseAdapter(), contentMediaPreview(), react()],
});
