import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RESUME_ARTIFACT_ID,
  RESUME_ARTIFACT_PDF_SHA256,
  RESUME_ARTIFACT_REGISTRY_SCHEMA,
  resumeArtifactRegistry,
} from "../../src/content/resumeArtifact.js";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const CAREER_RESUME_SOURCE_PATH = "/Users/kingjin/Documents/career/简历/对外简历/金星-简历261 copy.pdf";
export const PUBLIC_RESUME_ASSET_PATH = "public/resume/resume.pdf";
export const PUBLIC_RESUME_URL = "/resume/resume.pdf";
export const CAREER_RESUME_SHA256 = RESUME_ARTIFACT_PDF_SHA256;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readRegularFile(filePath, label) {
  const info = await lstat(filePath);
  assert.equal(info.isSymbolicLink(), false, `${label} must not be a symlink`);
  assert.equal(info.isFile(), true, `${label} must be a regular file`);
  return readFile(filePath);
}

export function validateResumeArtifactRegistry(registry = resumeArtifactRegistry) {
  assert.equal(registry?.schemaVersion, RESUME_ARTIFACT_REGISTRY_SCHEMA, "resume artifact registry schema is invalid");
  assert.equal(registry.defaultArtifactId, RESUME_ARTIFACT_ID, "resume artifact default identity is invalid");
  const artifact = registry.artifacts?.[RESUME_ARTIFACT_ID];
  assert.ok(artifact, "career resume artifact is not registered");
  assert.equal(artifact.sourceProofId, "career-resume-261", "resume source proof identity is invalid");
  assert.equal(artifact.sourceOwner, "career", "resume source owner must remain career");
  assert.equal(artifact.mimeType, "application/pdf", "resume artifact MIME must be application/pdf");
  assert.equal(artifact.pdfPath, PUBLIC_RESUME_URL, "resume public URL must use the registered public asset");
  assert.equal(artifact.pdfSha256, CAREER_RESUME_SHA256, "resume artifact hash is not the protected career hash");
  assert.equal(artifact.publicStatus, "verified", "resume artifact must be verified before rendering");
  return artifact;
}

/**
 * Verify the protected source and the public immutable asset are byte-identical.
 * This is intentionally a Node-side check and never becomes client bundle data.
 */
export async function verifyResumeArtifact({
  rootDirectory = projectRoot,
  sourcePath = CAREER_RESUME_SOURCE_PATH,
  publicAssetPath = path.join(rootDirectory, PUBLIC_RESUME_ASSET_PATH),
} = {}) {
  const artifact = validateResumeArtifactRegistry();
  const [sourceBytes, publicBytes] = await Promise.all([
    readRegularFile(sourcePath, "career resume source"),
    readRegularFile(publicAssetPath, "public resume asset"),
  ]);
  const sourceHash = sha256(sourceBytes);
  const publicHash = sha256(publicBytes);
  assert.equal(sourceHash, CAREER_RESUME_SHA256, "career resume source hash does not match the protected proof");
  assert.equal(publicHash, CAREER_RESUME_SHA256, "public resume asset hash does not match the protected proof");
  assert.deepEqual(publicBytes, sourceBytes, "public resume asset bytes must equal the career source");
  return Object.freeze({
    schemaVersion: RESUME_ARTIFACT_REGISTRY_SCHEMA,
    artifactId: RESUME_ARTIFACT_ID,
    sourcePath,
    sourceSha256: sourceHash,
    publicAssetPath: path.relative(rootDirectory, publicAssetPath),
    publicUrl: artifact.pdfPath,
    publicSha256: publicHash,
    bytes: publicBytes.length,
    mimeType: artifact.mimeType,
    publicStatus: artifact.publicStatus,
    verified: true,
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const evidence = await verifyResumeArtifact();
  console.log(JSON.stringify(evidence, null, 2));
}
