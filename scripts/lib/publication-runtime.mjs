import puppeteer from "puppeteer";
import { withQaBrowser } from "./qa-browser-runtime.mjs";
import {
  createPublicationPhaseEvidence,
  PUBLICATION_RUNTIME_EVIDENCE_V4,
} from "./publication-evidence.mjs";
import {
  assertRuntimeAcceptanceSpec,
  normalizeRuntimeText,
  runtimeTextHash,
} from "./runtime-acceptance.mjs";

export const PUBLICATION_RUNTIME_VERSION = PUBLICATION_RUNTIME_EVIDENCE_V4;
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

function throwIfAborted(signal) {
  if (signal?.aborted) throw runtimeFailure("PUBLICATION_RUNTIME_ABORTED", "publication browser runtime was aborted");
}

function withDeadline(promise, timeoutMs, code = "PUBLICATION_RUNTIME_TIMEOUT", signal = null) {
  if ((!timeoutMs || timeoutMs <= 0) && !signal) return promise;
  let timer;
  let abortHandler;
  const timeout = timeoutMs && timeoutMs > 0
    ? new Promise((_, reject) => {
      timer = setTimeout(() => reject(runtimeFailure(code, `publication runtime deadline exceeded after ${timeoutMs}ms`, { timeoutMs })), timeoutMs);
    })
    : null;
  const aborted = signal
    ? new Promise((_, reject) => {
      abortHandler = () => reject(runtimeFailure("PUBLICATION_RUNTIME_ABORTED", "publication browser runtime was aborted"));
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    })
    : null;
  const racers = [promise];
  if (timeout) racers.push(timeout);
  if (aborted) racers.push(aborted);
  return Promise.race(racers).finally(() => {
    if (timer) clearTimeout(timer);
    if (signal && abortHandler) signal.removeEventListener("abort", abortHandler);
  });
}

function mediaCancellation(failure = "") {
  return /ABORTED|CANCELLED|ERR_ABORTED|ERR_CANCELED/i.test(String(failure));
}

async function verifyRoute({ browser, base, route, routeTimeoutMs, runtimeRouteSpec = null, runtimeAcceptanceSpec = null, onEvidence, routeEvidence, publicationIdentity, attemptId, signal }) {
  throwIfAborted(signal);
  const startedAt = iso();
  const pageStarted = Date.now();
  const routeDeadline = routeTimeoutMs > 0 ? pageStarted + routeTimeoutMs : null;
  const remainingBudget = () => routeDeadline ? Math.max(1, routeDeadline - Date.now()) : routeTimeoutMs;
  const page = await browser.newPage();
  const consoleErrors = [];
  const consoleWarnings = [];
  const pageErrors = [];
  const assetFailures = [];
  const mediaRequestFailures = [];
  const mediaCancelled = [];
  let domcontentloadedAt = null;
  let shellReadyAt = null;
  let runtimeObserved = null;
  const runtimeExpectation = runtimeRouteSpec?.expectations?.[0] || null;
  const runtimeSelector = runtimeExpectation?.selector || "main h1";
  try {
    page.on("console", (message) => {
      const item = { type: message.type(), text: message.text() };
      if (message.type() === "error") consoleErrors.push(item);
      else if (message.type() === "warning") consoleWarnings.push(item);
    });
    page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
    page.on("requestfailed", (request) => {
      const type = request.resourceType();
      const item = { url: request.url(), resourceType: type, failure: request.failure()?.errorText || "unknown" };
      if (["script", "stylesheet"].includes(type)) assetFailures.push(item);
      else if (["media"].includes(type)) {
        if (mediaCancellation(item.failure)) mediaCancelled.push(item);
        else mediaRequestFailures.push(item);
      }
    });
    const response = await withDeadline(page.goto(new URL(route, base).href, { waitUntil: "domcontentloaded", timeout: remainingBudget() }), remainingBudget(), "PUBLICATION_RUNTIME_ROUTE_TIMEOUT", signal);
    domcontentloadedAt = iso();
    if (!response || !response.ok()) throw runtimeFailure("PUBLICATION_RUNTIME_ROUTE_HTTP", `public browser route ${route} returned HTTP ${response?.status() || "unknown"}`, { route, status: response?.status() || null });
    await withDeadline(page.waitForFunction(() => {
      const root = document.querySelector("#root");
      return Boolean(root?.children.length && root.textContent?.trim() && document.querySelector("main") && document.querySelector("h1") && document.body?.textContent?.trim());
    }, { timeout: remainingBudget() }), remainingBudget(), "PUBLICATION_RUNTIME_APP_READY_TIMEOUT", signal);
    shellReadyAt = iso();
    throwIfAborted(signal);
    let runtimeReady = true;
    let runtimeReadyAt = null;
    if (runtimeRouteSpec) {
      runtimeReady = false;
      const selector = runtimeSelector;
      const expected = runtimeExpectation?.normalizedValue || "";
      try {
        await withDeadline(page.waitForFunction(({ selector: targetSelector, expectedValue }) => {
          const normalize = (value) => String(value ?? "")
            .normalize("NFKC")
            .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
            .replace(/\s+/g, " ")
            .trim();
          const element = document.querySelector(targetSelector);
          return Boolean(element && normalize(element.innerText ?? element.textContent) === expectedValue);
        }, { timeout: remainingBudget() }, { selector, expectedValue: expected }), remainingBudget(), "PUBLICATION_RUNTIME_DATA_TIMEOUT", signal);
        runtimeReady = true;
        runtimeReadyAt = iso();
      } catch (error) {
        const observed = await page.evaluate((targetSelector) => {
          const normalize = (value) => String(value ?? "")
            .normalize("NFKC")
            .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
            .replace(/\s+/g, " ")
            .trim();
          const element = document.querySelector(targetSelector);
          const rawValue = element?.innerText ?? element?.textContent ?? "";
          return { rawValue, normalizedValue: normalize(rawValue) };
        }, selector).catch(() => ({ rawValue: "", normalizedValue: "" }));
        runtimeObserved = { ...observed, valueHash: runtimeTextHash(observed.normalizedValue) };
        const contentFetchFailed = pageErrors.some((item) => /CONTENT_DATA_RUNTIME_FETCH_FAILED|content data (?:request|response|object|manifest|active)/i.test(item));
        const wrapped = error.code?.startsWith("PUBLICATION_RUNTIME_")
          ? error
          : runtimeFailure(contentFetchFailed ? "PUBLICATION_RUNTIME_CONTENT_FETCH_FAILED" : "PUBLICATION_RUNTIME_DATA_TIMEOUT", error.message, {});
        wrapped.details = { ...(wrapped.details || {}), route, runtimeAcceptanceSpecHash: runtimeAcceptanceSpec?.specHash || null, expectedNormalizedValue: expected, expectedValueHash: runtimeExpectation?.valueHash || null, observed: runtimeObserved };
        throw wrapped;
      }
    }
    const dom = await page.evaluate(() => {
      const media = [...document.querySelectorAll("video, audio")].map((element) => ({
        tagName: element.tagName.toLowerCase(), currentSrc: element.currentSrc || element.src || null,
        // Media readiness is deliberately informational in app phase. A lazy
        // element with readyState=0 is not an application failure.
        readyState: element.readyState, error: element.error ? { code: element.error.code, message: element.error.message || null } : null,
        browserProbe: "not-probed",
      }));
      return {
        rootChildren: document.querySelector("#root")?.children.length || 0,
        rootTextLength: document.querySelector("#root")?.textContent?.trim().length || 0,
        main: document.querySelectorAll("main").length,
        h1: document.querySelectorAll("h1").length,
        h1Text: document.querySelector("h1")?.textContent?.trim() || "",
        h1InnerText: document.querySelector("h1")?.innerText?.trim() || "",
        bodyText: document.body?.textContent?.trim() || "",
        bodyTextLength: document.body?.textContent?.trim().length || 0,
        media,
      };
    });
    if (runtimeRouteSpec && !runtimeObserved) {
      const rawValue = dom.h1InnerText || dom.h1Text;
      const normalizedValue = normalizeRuntimeText(rawValue);
      runtimeObserved = { rawValue, normalizedValue, valueHash: runtimeTextHash(normalizedValue) };
    }
    const evidence = {
      phase: "verifying-app", route, status: response.status(), appReady: true,
      shellReady: true, shellReadyAt, runtimeReady, runtimeReadyAt,
      ...(runtimeAcceptanceSpec ? { runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash, acceptanceSpecHash: runtimeAcceptanceSpec.specHash } : {}),
      ...(runtimeRouteSpec ? { runtimeExpectedNormalizedValue: runtimeExpectation?.normalizedValue || null, runtimeExpectedValueHash: runtimeExpectation?.valueHash || null, runtimeObserved } : {}),
      ...(runtimeRouteSpec ? { expectations: [{ selector: runtimeSelector, expectedValueHash: runtimeExpectation?.valueHash || null, observedValueHash: runtimeObserved?.valueHash || null, matched: runtimeReady }] } : {}),
      startedAt, domcontentloadedAt, appReadyAt: shellReadyAt, finishedAt: iso(),
      durationMs: Date.now() - pageStarted, ...dom,
      consoleErrors, consoleWarnings, pageErrors, assetFailures,
      mediaRequestFailures, mediaCancelled, mediaFailures: [],
      verified: !consoleErrors.length && !pageErrors.length && !assetFailures.length
        && dom.rootChildren > 0 && dom.rootTextLength > 0 && dom.bodyTextLength > 0 && dom.main === 1 && dom.h1 === 1
        && (!runtimeRouteSpec || runtimeReady),
    };
    routeEvidence[route] = evidence;
    await onEvidence?.({
      phase: "verifying-app",
      route,
      result: createPublicationPhaseEvidence({
        publicationIdentity,
        attemptId,
        phase: "verifying-app",
        result: "running",
        routes: { ...routeEvidence },
        lastEvidence: evidence,
      }),
    });
    if (!evidence.verified) throw runtimeFailure("PUBLICATION_RUNTIME_ROUTE_FAILED", `public browser app runtime failed on ${route}`, { route, evidence });
    return evidence;
  } catch (error) {
    const evidence = routeEvidence[route] || {
      phase: "verifying-app", route, startedAt, finishedAt: iso(), durationMs: Date.now() - pageStarted,
      ...(shellReadyAt ? { shellReady: true, shellReadyAt } : { shellReady: false, shellReadyAt: null }),
      ...(runtimeRouteSpec ? { runtimeReady: false, runtimeReadyAt: null, runtimeAcceptanceSpecHash: runtimeAcceptanceSpec?.specHash || null, acceptanceSpecHash: runtimeAcceptanceSpec?.specHash || null, runtimeExpectedNormalizedValue: runtimeRouteSpec.expectations?.[0]?.normalizedValue || null, runtimeExpectedValueHash: runtimeRouteSpec.expectations?.[0]?.valueHash || null, runtimeObserved: runtimeObserved || error.details?.observed || null, expectations: [{ selector: runtimeRouteSpec.expectations?.[0]?.selector || "main h1", expectedValueHash: runtimeRouteSpec.expectations?.[0]?.valueHash || null, observedValueHash: (runtimeObserved || error.details?.observed)?.valueHash || null, matched: false }] } : {}),
      consoleErrors, consoleWarnings, pageErrors, assetFailures, mediaRequestFailures, mediaCancelled,
      mediaFailures: [], verified: false,
    };
    routeEvidence[route] = { ...evidence, failure: { code: error.code || "PUBLICATION_RUNTIME_ROUTE_FAILED", message: error.message }, verified: false };
    await onEvidence?.({
      phase: "verifying-app",
      route,
      result: createPublicationPhaseEvidence({
        publicationIdentity,
        attemptId,
        phase: "verifying-app",
        result: "running",
        routes: { ...routeEvidence },
        lastEvidence: routeEvidence[route],
      }),
    });
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
  signal = null, runtimeAcceptanceSpec = null, runtimeAcceptanceExpected = null,
} = {}) {
  const base = new URL(baseUrl);
  const startedAt = iso();
  const routeEvidence = {};
  const resolvedAttemptId = attemptId || `attempt-${Date.now()}`;
  const resolvedIdentity = publicationIdentity || { sitePublicationId: "standalone-runtime", snapshotHash: "standalone-runtime" };
  if (runtimeAcceptanceSpec) {
    assertRuntimeAcceptanceSpec(runtimeAcceptanceSpec, runtimeAcceptanceExpected || (resolvedIdentity.sitePublicationId === "standalone-runtime" ? null : resolvedIdentity));
  }
  await onEvidence?.({
    phase: "verifying-app",
    result: createPublicationPhaseEvidence({
      publicationIdentity: resolvedIdentity,
      attemptId: resolvedAttemptId,
      phase: "verifying-app",
      startedAt,
      result: "running",
      routes: {},
      lastEvidence: null,
      ...(runtimeAcceptanceSpec ? { runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash, acceptanceSpecHash: runtimeAcceptanceSpec.specHash } : {}),
    }),
  });
  try {
    throwIfAborted(signal);
    const result = await withDeadline(withQaBrowser({ puppeteer, taskId, timeoutMs }, async ({ browser, runtime }) => {
      for (const route of routes) {
        const runtimeRouteSpec = runtimeAcceptanceSpec?.routes?.find((entry) => entry.route === route) || null;
        await verifyRoute({ browser, base, route, routeTimeoutMs, runtimeRouteSpec, runtimeAcceptanceSpec, onEvidence, routeEvidence, publicationIdentity: resolvedIdentity, attemptId: resolvedAttemptId, signal });
      }
      return { runtime: { runtimeVersion: runtime.runtimeVersion, executablePath: runtime.executablePath, browserVersion: runtime.version, runId: runtime.runId, manifestPath: runtime.manifestPath } };
    }), timeoutMs, "PUBLICATION_RUNTIME_TIMEOUT", signal);
    const cleanRoutes = { ...routeEvidence };
    const envelope = createPublicationPhaseEvidence({
      publicationIdentity: resolvedIdentity,
      attemptId: resolvedAttemptId,
      phase: "verifying-app",
      startedAt,
      finishedAt: iso(),
      result: "verified",
      verified: true,
      routes: cleanRoutes,
      runtime: result.runtime,
      lastEvidence: cleanRoutes,
      ...(runtimeAcceptanceSpec ? { runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash, acceptanceSpecHash: runtimeAcceptanceSpec.specHash } : {}),
    });
    await onEvidence?.({ phase: "verifying-app", result: envelope });
    return envelope;
  } catch (error) {
    const cleanRoutes = { ...routeEvidence };
    const envelope = createPublicationPhaseEvidence({
      publicationIdentity: resolvedIdentity,
      attemptId: resolvedAttemptId,
      phase: "recoverable",
      startedAt,
      finishedAt: iso(),
      result: "recoverable",
      verified: false,
      routes: cleanRoutes,
      lastEvidence: error.runtimeEvidence || cleanRoutes,
      ...(runtimeAcceptanceSpec ? { runtimeAcceptanceSpecHash: runtimeAcceptanceSpec.specHash, acceptanceSpecHash: runtimeAcceptanceSpec.specHash } : {}),
      failure: { code: error.code || "PUBLICATION_RUNTIME_FAILED", message: error.message, phase: error.details?.phase || "verifying-app", lastEvidence: error.runtimeEvidence || cleanRoutes },
    });
    await onEvidence?.({ phase: "recoverable", result: envelope });
    error.recoverable = true;
    error.propagation = true;
    error.runtimeEvidence = envelope;
    throw error;
  }
}
