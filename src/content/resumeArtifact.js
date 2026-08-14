/**
 * Public, browser-safe registry for the single protected career resume PDF.
 *
 * Source provenance and byte verification live in scripts/lib/resume-artifact.mjs;
 * this module intentionally contains only the public projection consumed by the
 * page so an absolute career filesystem path can never enter the client bundle.
 */
export const RESUME_ARTIFACT_REGISTRY_SCHEMA = "resume-artifact-registry-v1";
export const RESUME_ARTIFACT_ID = "resume-career-pdf-261";
export const RESUME_ARTIFACT_PDF_SHA256 = "1a8a8bc55fc25cc7dd168f9e68814a7f91ea2969fe0dd54c16448e1800897e5f";

const registryArtifacts = Object.freeze({
  [RESUME_ARTIFACT_ID]: Object.freeze({
    artifactId: RESUME_ARTIFACT_ID,
    sourceProofId: "career-resume-261",
    sourceOwner: "career",
    mimeType: "application/pdf",
    pdfPath: "/resume/resume.pdf",
    pdfSha256: RESUME_ARTIFACT_PDF_SHA256,
    publicStatus: "verified",
  }),
});

export const resumeArtifactRegistry = Object.freeze({
  schemaVersion: RESUME_ARTIFACT_REGISTRY_SCHEMA,
  defaultArtifactId: RESUME_ARTIFACT_ID,
  artifacts: registryArtifacts,
});

function requestedArtifactId(ref) {
  if (typeof ref === "string") return ref;
  if (ref && typeof ref === "object") return ref.artifactId || ref.id || null;
  return resumeArtifactRegistry.defaultArtifactId;
}

/**
 * Resolve an optional content ResumeArtifactRef without allowing callers to
 * supply paths or hashes. Unknown, unverified, non-PDF, and drifted references
 * are intentionally non-renderable.
 */
export function resolveResumeArtifact(ref = null) {
  const artifact = resumeArtifactRegistry.artifacts[requestedArtifactId(ref)];
  if (!artifact) return null;
  if (artifact.publicStatus !== "verified" || artifact.mimeType !== "application/pdf") return null;
  if (!/^\/resume\/[a-z0-9-]+\.pdf$/.test(artifact.pdfPath)) return null;
  if (artifact.pdfSha256 !== RESUME_ARTIFACT_PDF_SHA256) return null;
  return artifact;
}

export const resumeArtifact = resolveResumeArtifact();
