import { findBusinessObservation } from "./showcaseRepository.js";
import { findEvergreenArticle } from "./evergreenArticleRepository.js";
import { selectObservationBriefs } from "./observationRepository.js";
import { findPractice } from "./practiceRepository.js";
import { profile } from "./profileRepository.js";
import { site } from "./siteContent.js";
import { home } from "./homeContentAdapter.js";
import { normalizeLongFormDocument } from "./longFormDocument.js";

const contentResolvers = Object.freeze({
  home: (reference) => reference.id === "home" ? home : null,
  site: (reference) => reference.id === "site" ? site : null,
  profile: (reference) => profile?.id === reference.id ? profile : null,
  practice: (reference) => findPractice(reference.id),
  businessObservation: (reference) => findBusinessObservation(reference.id),
  evergreenArticle: (reference) => findEvergreenArticle(reference.id),
  observationBriefs: (reference) => selectObservationBriefs({ scope: reference.scope === "all" ? undefined : reference.scope }),
});

/** Resolve only approved repository objects referenced by a validated page definition. */
export function resolvePageContent(definition) {
  const content = {};
  for (const [key, reference] of Object.entries(definition.contentRefs)) {
    const resolver = contentResolvers[reference.type];
    const value = resolver?.(reference);
    const resolved = reference.type === "observationBriefs" && !Array.isArray(value) ? [] : value ?? null;
    content[key] = ["profile", "evergreenArticle"].includes(reference.type) && resolved
      ? normalizeLongFormDocument(resolved, { documentId: resolved.slug || resolved.id })
      : resolved;
  }
  return content;
}

export { contentResolvers };
