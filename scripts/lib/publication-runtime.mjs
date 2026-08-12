import puppeteer from "puppeteer";
import { withQaBrowser } from "./qa-browser-runtime.mjs";

export const PUBLICATION_RUNTIME_VERSION = "publication-runtime-evidence-v2";
export const PUBLICATION_ROUTES = Object.freeze(["/", "/products", "/business-observations", "/observations", "/about"]);

function iso() { return new Date().toISOString(); }

function runtimeFailure(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  error.recoverable = code.startsWith("PUBLICATION_RUNTIME_");
  error.propagation = error.recoverable;
  error.runtimeEvidence = details.evidence || null;
  return error;
}

function withDeadline(promise, timeoutMs, code = "PUBLICATION_RUNTIME_TIMEOUT") {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(runtimeFailure(code, `publication runtime deadline exceeded after ${timeoutMs}ms`, { timeoutMs })), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function verifyRoute({ browser, base, route, routeTimeoutMs, onEvidence, routeEvidence }) {
  const startedAt = iso();
  const pageStarted = Date.now();
  const page = await browser.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const requestFailures = [];
  let domcontentloadedAt = null;
  try {
    page.on("console", (message) => {
      const item = { type: message.type(), text: message.text() };
      if (message.type() === "error") consoleErrors.push(item);
      else if (message.type() === "warning") consoleWarnings.push(item);
    });
    page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
    page.on("requestfailed", (request) => {
      const type = request.resourceType();
      if (["script", "stylesheet", "media"].includes(type)) {
        requestFailures.push({ url: request.url(), resourceType: type, failure: request.failure()?.errorText || "unknown" });
      }
    });
    const response = await withDeadline(page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded", timeout: routeTimeoutMs }), routeTimeoutMs);
    domcontentloadedAt = iso();
    if (!response || !response.ok()) throw runtimeFailure("PUBLICATION_RUNTIME_ROUTE_HTTP", `public browser route ${route} returned HTTP ${response?.status() || "unknown"}`, { route, status: response?.status() || null });
    await withDeadline(page.waitForFunction(() => {
      const root = document.querySelector("#root");
      return Boolean(root?.children.length && root.textContent?.trim() && document.querySelector("main") && document.querySelector("h1") && document.body?.textContent?.trim());
    }, { timeout: routeTimeoutMs }), routeTimeoutMs);
    const dom = await page.evaluate(() => {
      const media = [...document.querySelectorAll("video, audio")].map((element) => ({
        tagName: element.tagName.toLowerCase(), currentSrc: element.currentSrc || element.src || null,
        readyState: element.readyState, error: element.error ? { code: element.error.code, message: element.error.message || null } : null,
      }));
      return {
        rootChildren: document.querySelector("#root")?.children.length || 0,
        rootTextLength: document.querySelector("#root")?.textContent?.trim().length || 0,
        main: document.querySelectorAll("main").length,
        h1: document.querySelectorAll("h1").length,
        bodyTextLength: document.body?.textContent?.trim().length || 0,
        media,
      };
    });
    const mediaFailures = dom.media.filter((item) => item.error || !item.currentSrc || item.readyState < 2);
    const hardAssetFailures = requestFailures.filter((item) => item.resourceType !== "media");
    const cancelledMedia = requestFailures.filter((item) => item.resourceType === "media" && /ABORTED|CANCELLED/i.test(item.failure) && dom.media.every((item) => item.readyState >= 2 && !item.error));
    const effectiveRequestFailures = [...hardAssetFailures, ...requestFailures.filter((item) => item.resourceType === "media" && !cancelledMedia.includes(item))];
    const evidence = {
      route, status: response.status(), startedAt, domcontentloadedAt, appReadyAt: iso(), finishedAt: iso(),
      durationMs: Date.now() - pageStarted, ...dom,
      consoleErrors, consoleWarnings, pageErrors, assetFailures: effectiveRequestFailures,
      mediaFailures, mediaCancelled: cancelledMedia, verified: !consoleErrors.length && !pageErrors.length && !effectiveRequestFailures.length && !mediaFailures.length && dom.rootChildren > 0 && dom.rootTextLength > 0 && dom.bodyTextLength > 0 && dom.main === 1 && dom.h1 === 1,
    };
    routeEvidence[route] = evidence;
    await onEvidence?.({ phase: "verifying-runtime", route, result: evidence });
    if (!evidence.verified) throw runtimeFailure("PUBLICATION_RUNTIME_ROUTE_FAILED", `public browser runtime failed on ${route}`, { route, evidence });
    return evidence;
  } catch (error) {
    const evidence = routeEvidence[route] || { route, startedAt, finishedAt: iso(), durationMs: Date.now() - pageStarted, consoleErrors, consoleWarnings, pageErrors, assetFailures: requestFailures, verified: false };
    routeEvidence[route] = { ...evidence, failure: { code: error.code || "PUBLICATION_RUNTIME_ROUTE_FAILED", message: error.message }, verified: false };
    await onEvidence?.({ phase: "verifying-runtime", route, result: routeEvidence[route] });
    if (!error.code?.startsWith("PUBLICATION_RUNTIME_")) throw runtimeFailure("PUBLICATION_RUNTIME_ROUTE_FAILED", error.message, { route, evidence: routeEvidence[route] });
    error.details = { ...(error.details || {}), route, evidence: routeEvidence[route] };
    error.runtimeEvidence = routeEvidence;
    throw error;
  } finally {
    await page.close().catch(() => {});
  }
}

export async function verifyPublicBrowserRuntime({
  baseUrl, routes = PUBLICATION_ROUTES, taskId = "site-publication-public-verify", timeoutMs = 60000,
  routeTimeoutMs = Math.min(12000, timeoutMs), publicationIdentity = null, attemptId = null, onEvidence = null,
} = {}) {
  const base = new URL(baseUrl);
  const startedAt = iso();
  const routeEvidence = {};
  const envelope = {
    schemaVersion: PUBLICATION_RUNTIME_VERSION, publicationIdentity, attemptId: attemptId || `attempt-${Date.now()}`,
    phase: "verifying-runtime", startedAt, finishedAt: null, routes: routeEvidence, assets: null, result: "running",
  };
  await onEvidence?.({ phase: "verifying-runtime", result: envelope });
  try {
    const result = await withQaBrowser({ puppeteer, taskId, timeoutMs }, async ({ browser, runtime }) => {
      for (const route of routes) await verifyRoute({ browser, base, route, routeTimeoutMs, onEvidence, routeEvidence });
      return { runtime: { runtimeVersion: runtime.runtimeVersion, executablePath: runtime.executablePath, browserVersion: runtime.version } };
    });
    envelope.runtime = result.runtime;
    envelope.finishedAt = iso();
    envelope.result = "verified";
    envelope.verified = true;
    await onEvidence?.({ phase: "verified", result: envelope });
    return envelope;
  } catch (error) {
    envelope.finishedAt = iso();
    envelope.result = "recoverable";
    envelope.verified = false;
    envelope.failure = { code: error.code || "PUBLICATION_RUNTIME_FAILED", message: error.message, phase: "verifying-runtime", lastEvidence: routeEvidence };
    envelope.routes = routeEvidence;
    await onEvidence?.({ phase: "recoverable", result: envelope });
    error.recoverable = true;
    error.propagation = true;
    error.runtimeEvidence = envelope;
    throw error;
  }
}
