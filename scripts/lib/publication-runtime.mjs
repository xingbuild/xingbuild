import puppeteer from "puppeteer";
import { withQaBrowser } from "./qa-browser-runtime.mjs";

export const PUBLICATION_RUNTIME_VERSION = "publication-runtime-verify-v1";
export const PUBLICATION_ROUTES = Object.freeze(["/", "/products", "/business-observations", "/observations", "/about"]);

export async function verifyPublicBrowserRuntime({
  baseUrl,
  routes = PUBLICATION_ROUTES,
  taskId = "site-publication-public-verify",
  timeoutMs = 120000,
} = {}) {
  const base = new URL(baseUrl);
  return withQaBrowser({ puppeteer, taskId, timeoutMs }, async ({ browser, runtime }) => {
    const pages = {};
    for (const route of routes) {
      const page = await browser.newPage();
      const consoleMessages = [];
      const pageErrors = [];
      const assetFailures = [];
      page.on("console", (message) => {
        if (["error", "warning"].includes(message.type())) consoleMessages.push({ type: message.type(), text: message.text() });
      });
      page.on("pageerror", (error) => pageErrors.push(String(error?.message || error)));
      page.on("requestfailed", (request) => {
        if (["script", "stylesheet", "media"].includes(request.resourceType())) {
          assetFailures.push({ url: request.url(), resourceType: request.resourceType(), failure: request.failure()?.errorText || "unknown" });
        }
      });
      const response = await page.goto(new URL(route, base).href, { waitUntil: "networkidle2", timeout: timeoutMs });
      if (!response || !response.ok()) throw new Error("public browser route " + route + " returned HTTP " + (response?.status() || "unknown"));
      const dom = await page.evaluate(() => ({
        rootChildren: document.querySelector("#root")?.children.length || 0,
        rootText: document.querySelector("#root")?.textContent?.trim() || "",
        main: document.querySelectorAll("main").length,
        h1: document.querySelectorAll("h1").length,
        bodyText: document.body?.textContent?.trim() || "",
      }));
      if (!dom.rootChildren || !dom.rootText || !dom.bodyText || dom.main !== 1 || dom.h1 !== 1) {
        throw new Error("public browser runtime did not mount route " + route);
      }
      if (consoleMessages.length || pageErrors.length || assetFailures.length) {
        throw new Error("public browser runtime errors on " + route);
      }
      pages[route] = {
        status: response.status(),
        ...dom,
        console: consoleMessages,
        pageErrors,
        assetFailures,
        verified: true,
      };
      await page.close();
    }
    return {
      schemaVersion: PUBLICATION_RUNTIME_VERSION,
      runtime: { runtimeVersion: runtime.runtimeVersion, executablePath: runtime.executablePath, browserVersion: runtime.version },
      pages,
      verified: true,
    };
  });
}
