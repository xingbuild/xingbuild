const contentBuildEnabled = typeof __XINGBUILD_CONTENT_BUILD__ !== "undefined" && __XINGBUILD_CONTENT_BUILD__;
import { normalizeLongFormDocument } from "./longFormDocument.js";

const profileModules = contentBuildEnabled
  ? import.meta.glob("../../.content-workspace/content/profile/*.json", { eager: true, import: "default" })
  : {};

const profileSource = Object.values(profileModules).find((item) => item?.id === "about") || null;

export const profile = profileSource ? normalizeLongFormDocument(profileSource, { documentId: "about" }) : null;
