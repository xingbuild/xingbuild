import { findBusinessObservation } from "./showcaseRepository.js";
import { findEvergreenArticle } from "./evergreenArticleRepository.js";
import { selectObservationBriefs } from "./observationRepository.js";
import { findPractice } from "./practiceRepository.js";
import { profile } from "./profileRepository.js";
import { site } from "./siteContent.js";
import { home } from "./homeContentAdapter.js";
import { normalizeLongFormDocument } from "./longFormDocument.js";
import { resolveRuntimeContentData } from "./contentDataArtifact.js";
import { projectRuntimePractice, resolveRuntimeObservationBriefs } from "./runtimeContentProjection.js";

const contentResolvers = Object.freeze({
  home: (reference) => reference.id === "home" ? home : null,
  site: (reference) => reference.id === "site" ? site : null,
  profile: (reference) => profile?.id === reference.id ? profile : null,
  practice: (reference) => findPractice(reference.id),
  businessObservation: (reference) => findBusinessObservation(reference.id),
  evergreenArticle: (reference) => findEvergreenArticle(reference.id),
  observationBriefs: (reference) => selectObservationBriefs({ scope: reference.scope === "all" ? undefined : reference.scope }),
});

function runtimeLogicalContentId(reference) {
  const kindByType = {
    home: "home",
    profile: "profile",
    practice: "practice",
    businessObservation: "businessObservation",
    evergreenArticle: "article",
  };
  const kind = kindByType[reference?.type];
  return kind && reference?.id ? `${kind}:${reference.id}` : null;
}

function resolveRuntimeReference(reference, runtimeData = null) {
  if (!runtimeData) return { enabled: false, value: null };
  if (reference?.type === "observationBriefs") {
    return {
      enabled: true,
      value: resolveRuntimeObservationBriefs({ data: runtimeData, scope: reference.scope }),
    };
  }
  const logicalContentId = runtimeLogicalContentId(reference);
  if (!logicalContentId) return { enabled: true, value: null };
  const resolved = resolveRuntimeContentData({ logicalContentId, data: runtimeData });
  return { enabled: Boolean(runtimeData), value: resolved ?? null };
}

/** Resolve only approved repository objects referenced by a validated page definition. */
export function resolvePageContent(definition, { runtimeData = null } = {}) {
  const content = {};
  for (const [key, reference] of Object.entries(definition.contentRefs)) {
    const resolver = contentResolvers[reference.type];
    const runtime = resolveRuntimeReference(reference, runtimeData);
    const runtimeValue = reference.type === "practice"
      ? projectRuntimePractice(runtime.value)
      : runtime.value;
    const value = runtime.enabled && (runtimeLogicalContentId(reference) || reference.type === "observationBriefs")
      ? runtimeValue
      : resolver?.(reference);
    const resolved = reference.type === "observationBriefs" && !Array.isArray(value) ? [] : value ?? null;
    content[key] = ["profile", "evergreenArticle"].includes(reference.type) && resolved
      ? normalizeLongFormDocument(resolved, { documentId: resolved.slug || resolved.id })
      : resolved;
  }
  return content;
}

export { contentResolvers };
