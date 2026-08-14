function hasText(value) {
  return typeof value === "string" && value.trim() !== "";
}

export function chineseEquivalentLength(value) {
  return Array.from(value.trim()).reduce((length, character) => length + (/^[\x00-\x7F]$/.test(character) ? 0.5 : 1), 0);
}

function readerBody(brief) {
  return hasText(brief.body) ? brief.body : brief.statement;
}

export function validateBriefDefinition(observation) {
  if (observation.presentation !== "brief") return observation.brief === undefined ? [] : ["brief requires presentation=brief"];
  const errors = [];
  const brief = observation.brief;
  if (!brief || typeof brief !== "object" || Array.isArray(brief)) return ["brief must be an object"];

  if (!/^\d{4}-\d{2}-\d{2}$/.test(observation.eventAt || "")) {
    errors.push("brief requires publication.eventAt as YYYY-MM-DD");
  }

  const allowed = new Set(["subject", "statement", "body", "sourceRefs", "isOpinion", "articlePreview"]);
  for (const key of Object.keys(brief)) if (!allowed.has(key)) errors.push(`brief.${key} is not allowed`);
  for (const field of ["subject"]) {
    if (!hasText(brief[field])) errors.push(`brief.${field} must be a non-empty string`);
  }
  if (hasText(brief.subject) && chineseEquivalentLength(brief.subject) > 16) {
    errors.push("brief.subject must be at most 16 Chinese-equivalent characters");
  }
  const body = readerBody(brief);
  if (!hasText(body)) {
    errors.push("brief.body or brief.statement must be an explicit 80–160 Chinese-equivalent-character reader body");
  } else {
    const length = chineseEquivalentLength(body);
    if (length < 80 || length > 160) errors.push("brief reader body must be 80–160 Chinese-equivalent characters");
  }
  if (!Array.isArray(brief.sourceRefs) || !brief.sourceRefs.length || new Set(brief.sourceRefs).size !== brief.sourceRefs.length) {
    errors.push("brief.sourceRefs must contain unique source ids");
  }
  const sourceIds = new Set((observation.sources || []).map((source) => source.id));
  for (const sourceRef of brief.sourceRefs || []) {
    if (!sourceIds.has(sourceRef)) errors.push(`brief.sourceRefs references missing ${sourceRef}`);
  }
  if (typeof brief.isOpinion !== "boolean") errors.push("brief.isOpinion must be boolean");
  return errors;
}

export function projectObservationBrief(observation) {
  if (observation.status !== "published" || observation.presentation !== "brief" || !observation.brief) return null;
  return {
    id: `brief-${observation.slug}`,
    slug: observation.slug,
    eventAt: observation.eventAt,
    publishedAt: observation.publishedAt,
    subject: observation.brief.subject,
    primaryDimension: observation.primaryDimension,
    body: readerBody(observation.brief),
    bodyTargetField: hasText(observation.brief.body) ? "body" : "statement",
    statement: observation.brief.statement,
    isOpinion: observation.brief.isOpinion,
    sourceRefs: observation.brief.sourceRefs,
    sources: observation.sources,
    relatedWorks: observation.relatedWorks,
    articlePreview: observation.brief.articlePreview,
  };
}
