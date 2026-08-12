import { createHash } from "node:crypto";

export const PUBLICATION_RUNTIME_EVIDENCE_V3 = "publication-runtime-evidence-v3";
export const PUBLICATION_RUNTIME_EVIDENCE_V4 = "publication-runtime-evidence-v4";
export const PUBLICATION_RUNTIME_VERSION = PUBLICATION_RUNTIME_EVIDENCE_V4;

const PHASES = Object.freeze(["verifying-assets", "verifying-app", "verifying-media"]);
const ROLES = Object.freeze(["assets", "app", "media"]);
const RESULTS = Object.freeze(["running", "verified", "recoverable", "failed"]);
const ROLE_PHASE = Object.freeze({
  assets: "verifying-assets",
  app: "verifying-app",
  media: "verifying-media",
});
const ROLE_PAYLOAD = Object.freeze({ assets: "assets", app: "routes", media: "media" });

function iso() { return new Date().toISOString(); }

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) { return stable(left) === stable(right); }

function text(value, field) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Publication evidence ${field} is required`);
  return value;
}

function resultVerified(result, verified) {
  if (!RESULTS.includes(result)) throw new Error(`Publication evidence result is invalid: ${result}`);
  if (typeof verified !== "boolean") throw new Error("Publication evidence verified is required");
  if (verified !== (result === "verified")) throw new Error("Publication evidence result/verified mismatch");
}

function roleForPhase(phase) {
  const role = Object.entries(ROLE_PHASE).find(([, value]) => value === phase)?.[0] || null;
  return role;
}

function assertFailure(failure, { required = false } = {}) {
  if (failure == null) {
    if (required) throw new Error("Publication evidence failure is required");
    return null;
  }
  if (typeof failure !== "object" || typeof failure.code !== "string" || typeof failure.phase !== "string" || !("lastEvidence" in failure)) {
    throw new Error("Publication evidence failure requires code, phase and lastEvidence");
  }
  return failure;
}

function assertIdentity(input, expectedIdentity = null) {
  if (!input || typeof input !== "object") throw new Error("Publication evidence publicationIdentity is required");
  text(input.sitePublicationId, "publicationIdentity.sitePublicationId");
  text(input.snapshotHash, "publicationIdentity.snapshotHash");
  if (expectedIdentity && !same(input, expectedIdentity)) {
    const error = new Error("Publication evidence identity drift");
    error.code = "PUBLICATION_EVIDENCE_IDENTITY_DRIFT";
    error.expectedIdentity = expectedIdentity;
    error.observedIdentity = input;
    throw error;
  }
  return input;
}

function phasePayloadForRole(evidence, role) {
  const key = ROLE_PAYLOAD[role];
  const payload = evidence[key];
  if (payload == null) throw new Error(`Publication evidence ${key} payload is required`);
  if (typeof payload !== "object") throw new Error(`Publication evidence ${key} payload must be an object`);
  return payload;
}

export function isLegacyPublicationPhaseEvidence(value) {
  return Boolean(value && typeof value === "object" && value.schemaVersion === PUBLICATION_RUNTIME_EVIDENCE_V3);
}

export function validatePublicationPhaseEvidence(value, { expectedIdentity = null, expectedAttemptId = null, allowLegacyV3 = false } = {}) {
  if (isLegacyPublicationPhaseEvidence(value)) {
    if (!allowLegacyV3) throw new Error("legacy publication-runtime-evidence-v3 is read-only and cannot enter v4 aggregation");
    return Object.freeze({ ...value, legacyReadOnly: true });
  }
  if (!value || typeof value !== "object" || value.schemaVersion !== PUBLICATION_RUNTIME_EVIDENCE_V4) {
    throw new Error("Publication evidence must use publication-runtime-evidence-v4");
  }
  assertIdentity(value.publicationIdentity, expectedIdentity);
  text(value.attemptId, "attemptId");
  if (!("lastEvidence" in value)) throw new Error("Publication evidence lastEvidence is required");
  if (expectedAttemptId && value.attemptId !== expectedAttemptId) {
    const error = new Error("Publication evidence attempt identity drift");
    error.code = "PUBLICATION_EVIDENCE_ATTEMPT_DRIFT";
    throw error;
  }
  if (!PHASES.includes(value.phase) && value.phase !== "verified" && value.phase !== "recoverable" && value.phase !== "failed") {
    throw new Error(`Publication evidence phase is invalid: ${value.phase}`);
  }
  resultVerified(value.result, value.verified);
  if (!value.startedAt) throw new Error("Publication evidence startedAt is required");
  if (value.result !== "running" && !value.finishedAt) throw new Error("completed publication evidence requires finishedAt");
  if (value.result === "running" && value.finishedAt != null) throw new Error("running publication evidence cannot have finishedAt");
  assertFailure(value.failure, { required: value.result === "recoverable" || value.result === "failed" });
  const role = roleForPhase(value.phase);
  if (role) phasePayloadForRole(value, role);
  return value;
}

export function createPublicationPhaseEvidence({
  publicationIdentity,
  attemptId,
  phase,
  startedAt = iso(),
  finishedAt = null,
  result = "running",
  verified = result === "verified",
  lastEvidence = null,
  assets = undefined,
  routes = undefined,
  media = undefined,
  failure = null,
  ...extra
} = {}) {
  const role = roleForPhase(phase);
  if (!role && !["verified", "recoverable", "failed"].includes(phase)) throw new Error(`Publication evidence phase is invalid: ${phase}`);
  const payload = { ...extra, schemaVersion: PUBLICATION_RUNTIME_EVIDENCE_V4, publicationIdentity, attemptId, phase, startedAt, finishedAt, result, verified, lastEvidence };
  if (assets !== undefined) payload.assets = assets;
  if (routes !== undefined) payload.routes = routes;
  if (media !== undefined) payload.media = media;
  if (failure !== null) payload.failure = failure;
  if (payload.lastEvidence == null) payload.lastEvidence = role ? payload[ROLE_PAYLOAD[role]] || null : null;
  return Object.freeze(validatePublicationPhaseEvidence(payload));
}

export function createPublicationEvidenceReducer({ publicationIdentity, attemptId } = {}) {
  assertIdentity(publicationIdentity);
  text(attemptId, "attemptId");
  const phases = new Map();
  return Object.freeze({
    add(evidence) {
      const validated = validatePublicationPhaseEvidence(evidence, { expectedIdentity: publicationIdentity, expectedAttemptId: attemptId });
      const role = roleForPhase(validated.phase);
      if (!role || validated.result !== "verified" || validated.verified !== true) {
        throw new Error("Publication evidence reducer accepts one verified assets/app/media phase per role");
      }
      if (phases.has(role)) throw new Error(`Publication evidence duplicate phase: ${role}`);
      phases.set(role, validated);
      return validated;
    },
    aggregate() {
      return aggregatePublicationPhaseEvidence({ publicationIdentity, attemptId, phases: Object.fromEntries(phases) });
    },
    snapshot() { return Object.freeze(Object.fromEntries(phases)); },
  });
}

export function aggregatePublicationPhaseEvidence({ publicationIdentity, attemptId, phases } = {}) {
  assertIdentity(publicationIdentity);
  text(attemptId, "attemptId");
  const entries = Array.isArray(phases)
    ? phases.map((phase) => [roleForPhase(phase?.phase), phase])
    : Object.entries(phases || {});
  const byRole = new Map();
  for (const [declaredRole, value] of entries) {
    const validated = validatePublicationPhaseEvidence(value, { expectedIdentity: publicationIdentity, expectedAttemptId: attemptId });
    const role = roleForPhase(validated.phase);
    if (!role || (declaredRole && declaredRole !== role)) throw new Error("Publication evidence phase role mismatch");
    if (byRole.has(role)) throw new Error(`Publication evidence duplicate phase: ${role}`);
    if (validated.result !== "verified" || validated.verified !== true) throw new Error(`Publication evidence phase is not verified: ${role}`);
    byRole.set(role, validated);
  }
  for (const role of ROLES) if (!byRole.has(role)) throw new Error(`Publication evidence phase is missing: ${role}`);
  const ordered = ROLES.map((role) => byRole.get(role));
  const aggregate = {
    schemaVersion: PUBLICATION_RUNTIME_EVIDENCE_V4,
    publicationIdentity,
    attemptId,
    phase: "verified",
    phaseOrder: [...ROLES],
    startedAt: ordered.map((item) => item.startedAt).sort()[0],
    finishedAt: ordered.map((item) => item.finishedAt).sort().at(-1),
    result: "verified",
    verified: true,
    phases: { assets: ordered[0], app: ordered[1], media: ordered[2] },
    lastEvidence: { assets: ordered[0].lastEvidence, app: ordered[1].lastEvidence, media: ordered[2].lastEvidence },
  };
  return Object.freeze(assertPublicationPhaseAggregate(aggregate));
}

export function assertPublicationPhaseAggregate(value, { expectedIdentity = null, expectedAttemptId = null } = {}) {
  validatePublicationPhaseEvidence(value, { expectedIdentity, expectedAttemptId });
  if (value.phase !== "verified" || value.result !== "verified" || value.verified !== true) throw new Error("Publication evidence aggregate must be verified");
  if (!Array.isArray(value.phaseOrder) || stable(value.phaseOrder) !== stable(ROLES)) throw new Error("Publication evidence aggregate phase order is invalid");
  if (!value.phases || typeof value.phases !== "object") throw new Error("Publication evidence aggregate phases are required");
  const reducer = createPublicationEvidenceReducer({ publicationIdentity: value.publicationIdentity, attemptId: value.attemptId });
  for (const role of ROLES) reducer.add(value.phases[role]);
  return value;
}

export function publicationEvidenceHash(value) {
  return createHash("sha256").update(stable(value)).digest("hex");
}

export const PUBLICATION_EVIDENCE_PHASES = PHASES;
export const PUBLICATION_EVIDENCE_ROLES = ROLES;
