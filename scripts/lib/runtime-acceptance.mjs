import { createHash } from "node:crypto";
import { canonicalJson } from "./release-scope-classifier.mjs";
import { responsiveTextValue } from "./responsive-text-slot.mjs";

/**
 * Runtime acceptance is an immutable projection of the existing publication
 * intent/SiteSnapshot.  It is deliberately not a content authority: callers
 * must derive it from the same content manifest that created the snapshot and
 * then carry its hash through browser evidence and recovery.
 */
export const RUNTIME_ACCEPTANCE_SPEC_SCHEMA_VERSION = "runtime-acceptance-v1";
const SHA256 = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`RuntimeAcceptanceSpec ${field} is required`);
  return value;
}

export function normalizeRuntimeText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function runtimeTextHash(value) {
  return sha256(normalizeRuntimeText(value));
}

function homeTitleValue(contentManifest = {}) {
  const homeContent = contentManifest?.homeContent;
  if (!homeContent || typeof homeContent !== "object") throw new Error("RuntimeAcceptanceSpec homeContent is required");
  if (homeContent.homeTitle == null) throw new Error("RuntimeAcceptanceSpec homeContent.homeTitle is required");
  return normalizeRuntimeText(responsiveTextValue(homeContent.homeTitle, {
    projection: "home.positioning.title",
    profile: "web",
  }));
}

function identityOf(source = {}) {
  const publication = source.publication || source;
  const snapshot = source.siteSnapshot || publication.siteSnapshot || null;
  const contentManifest = source.contentManifest || publication.contentManifest || snapshot?.contentManifest || null;
  const sitePublicationId = source.sitePublicationId || publication.sitePublicationId || null;
  const snapshotHash = source.snapshotHash || publication.snapshotHash || snapshot?.snapshotHash || null;
  const activeTupleHash = source.activeTupleHash || publication.activeTupleHash || snapshot?.activeTupleHash || null;
  return { sitePublicationId, snapshotHash, activeTupleHash, contentManifest };
}

export function deriveRuntimeAcceptanceSpec(source = {}) {
  const { sitePublicationId, snapshotHash, activeTupleHash, contentManifest } = identityOf(source);
  requiredText(sitePublicationId, "sitePublicationId");
  requiredText(snapshotHash, "snapshotHash");
  requiredText(activeTupleHash, "activeTupleHash");
  if (!SHA256.test(snapshotHash) || !SHA256.test(activeTupleHash)) throw new Error("RuntimeAcceptanceSpec snapshot/tuple hash must be SHA-256");
  const normalizedValue = homeTitleValue(contentManifest);
  if (!normalizedValue) throw new Error("RuntimeAcceptanceSpec expected home value is empty");
  const route = {
    route: "/",
    targetId: "home:home",
    expectations: [{
      kind: "normalized-text-hash",
      selector: "main h1",
      normalizedValue,
      valueHash: runtimeTextHash(normalizedValue),
    }],
  };
  const payload = {
    schemaVersion: RUNTIME_ACCEPTANCE_SPEC_SCHEMA_VERSION,
    sitePublicationId,
    snapshotHash,
    activeTupleHash,
    routes: [route],
  };
  const specHash = sha256(canonicalJson(payload));
  return { ...payload, specHash };
}

export function assertRuntimeAcceptanceSpecShape(spec = {}) {
  if (spec.schemaVersion !== RUNTIME_ACCEPTANCE_SPEC_SCHEMA_VERSION) throw new Error("RuntimeAcceptanceSpec schemaVersion is invalid");
  requiredText(spec.sitePublicationId, "sitePublicationId");
  requiredText(spec.snapshotHash, "snapshotHash");
  requiredText(spec.activeTupleHash, "activeTupleHash");
  if (!SHA256.test(spec.snapshotHash) || !SHA256.test(spec.activeTupleHash)) throw new Error("RuntimeAcceptanceSpec identity hash is invalid");
  if (!Array.isArray(spec.routes) || spec.routes.length !== 1) throw new Error("RuntimeAcceptanceSpec must declare exactly one route");
  const [route] = spec.routes;
  if (route?.route !== "/" || route.targetId !== "home:home") throw new Error("RuntimeAcceptanceSpec home route is invalid");
  if (!Array.isArray(route.expectations) || route.expectations.length !== 1) throw new Error("RuntimeAcceptanceSpec must declare exactly one home expectation");
  const [expectation] = route.expectations;
  if (expectation?.kind !== "normalized-text-hash" || expectation.selector !== "main h1" || typeof expectation.normalizedValue !== "string" || !expectation.normalizedValue) throw new Error("RuntimeAcceptanceSpec expectation is invalid");
  const expectedValueHash = runtimeTextHash(expectation.normalizedValue);
  if (expectation.valueHash !== expectedValueHash) throw new Error("RuntimeAcceptanceSpec expected value hash drift");
  const payload = {
    schemaVersion: spec.schemaVersion,
    sitePublicationId: spec.sitePublicationId,
    snapshotHash: spec.snapshotHash,
    activeTupleHash: spec.activeTupleHash,
    routes: spec.routes,
  };
  if (spec.specHash !== sha256(canonicalJson(payload))) throw new Error("RuntimeAcceptanceSpec specHash drift");
  return spec;
}

export function assertRuntimeAcceptanceSpec(spec = {}, expected = null) {
  assertRuntimeAcceptanceSpecShape(spec);
  if (!expected) {
    if (spec.sitePublicationId !== "standalone-runtime") {
      throw new Error("RuntimeAcceptanceSpec approved content manifest is required");
    }
    return spec;
  }
  const identity = identityOf(expected);
  for (const field of ["sitePublicationId", "snapshotHash", "activeTupleHash"]) {
    if (identity[field] == null) throw new Error(`RuntimeAcceptanceSpec ${field} authority is required`);
    if (spec[field] !== identity[field]) throw new Error(`RuntimeAcceptanceSpec ${field} mismatch`);
  }
  if (!identity.contentManifest) throw new Error("RuntimeAcceptanceSpec approved content manifest is required");
  const canonical = deriveRuntimeAcceptanceSpec({
    sitePublicationId: identity.sitePublicationId,
    snapshotHash: identity.snapshotHash,
    activeTupleHash: identity.activeTupleHash,
    contentManifest: identity.contentManifest,
  });
  if (canonicalJson(spec) !== canonicalJson(canonical)) {
    throw new Error("RuntimeAcceptanceSpec approved content manifest projection drift");
  }
  return spec;
}

export function readOrDeriveRuntimeAcceptanceSpec(source = {}, { allowDerived = false } = {}) {
  const existing = source.runtimeAcceptanceSpec || source.publication?.runtimeAcceptanceSpec || null;
  if (existing) return assertRuntimeAcceptanceSpec(existing, source);
  if (!allowDerived) {
    const error = new Error("RuntimeAcceptanceSpec is required at the canonical publication boundary");
    error.code = "RUNTIME_ACCEPTANCE_SPEC_MISSING";
    throw error;
  }
  return deriveRuntimeAcceptanceSpec(source);
}
