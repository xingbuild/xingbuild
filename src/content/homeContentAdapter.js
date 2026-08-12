import { homeContent as fallbackHomeContent } from "./siteContent.js";
import { normalizeResponsiveTextSlot } from "./responsiveTextSlot.js";

const contentBuildEnabled = typeof __XINGBUILD_CONTENT_BUILD__ !== "undefined" && __XINGBUILD_CONTENT_BUILD__;
const homeModules = contentBuildEnabled
  ? import.meta.glob("../../.content-workspace/content/home.json", { eager: true, import: "default" })
  : {};

function validHomeContent(value) {
  const empty = value?.emptyStates?.observations;
  let responsive = false;
  try {
    normalizeResponsiveTextSlot(value?.description, { maxLength: 400 });
    normalizeResponsiveTextSlot(value?.homeTitle, { maxLength: 400 });
    responsive = true;
  } catch {
    responsive = false;
  }
  return responsive
    && typeof empty?.message === "string"
    && typeof empty?.description === "string";
}

const activeHomeContent = Object.values(homeModules).find(validHomeContent) || null;

/**
 * Product-only builds use the frozen legacy copy as a safe fallback. A
 * content-enabled SiteSnapshot replaces it with the active ContentSet home
 * entry copied into the staging workspace.
 */
export function resolveHomeContent() {
  return activeHomeContent || fallbackHomeContent;
}

export const home = resolveHomeContent();
