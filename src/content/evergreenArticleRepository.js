const contentBuildEnabled = typeof __XINGBUILD_CONTENT_BUILD__ !== "undefined" && __XINGBUILD_CONTENT_BUILD__;
import { normalizeLongFormDocument } from "./longFormDocument.js";

const articleModules = contentBuildEnabled
  ? import.meta.glob("../../.content-workspace/content/articles/*.json", { eager: true, import: "default" })
  : {};

export const evergreenArticles = Object.values(articleModules).map((article) => normalizeLongFormDocument(article, { documentId: article?.slug || article?.id }));

export function findEvergreenArticle(slug) {
  return evergreenArticles.find((article) => article.slug === slug && article.status === "published");
}
