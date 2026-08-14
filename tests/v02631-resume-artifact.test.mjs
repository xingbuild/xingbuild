import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readlink, lstat } from "node:fs/promises";
import test from "node:test";
import { resolveResumeArtifact, RESUME_ARTIFACT_ID, RESUME_ARTIFACT_PDF_SHA256 } from "../src/content/resumeArtifact.js";
import { validateResumeArtifactRegistry, verifyResumeArtifact } from "../scripts/lib/resume-artifact.mjs";

const sourcePath = "/Users/kingjin/Documents/career/简历/对外简历/金星-简历261 copy.pdf";
const publicPath = new URL("../public/resume/resume.pdf", import.meta.url);

test("career resume registry and public asset are one protected PDF identity", async () => {
  const evidence = await verifyResumeArtifact();
  assert.equal(evidence.artifactId, RESUME_ARTIFACT_ID);
  assert.equal(evidence.sourceSha256, RESUME_ARTIFACT_PDF_SHA256);
  assert.equal(evidence.publicSha256, RESUME_ARTIFACT_PDF_SHA256);
  assert.equal(evidence.mimeType, "application/pdf");
  const [source, published] = await Promise.all([readFile(sourcePath), readFile(publicPath)]);
  assert.deepEqual(published, source);
  assert.equal(createHash("sha256").update(published).digest("hex"), RESUME_ARTIFACT_PDF_SHA256);
  assert.equal((await lstat(publicPath)).isSymbolicLink(), false);
});

test("resume resolver only returns registered verified artifacts and view/download share the URL", () => {
  validateResumeArtifactRegistry();
  const artifact = resolveResumeArtifact();
  assert.equal(artifact.pdfPath, "/resume/resume.pdf");
  assert.equal(resolveResumeArtifact(RESUME_ARTIFACT_ID).pdfPath, artifact.pdfPath);
  assert.equal(resolveResumeArtifact({ artifactId: "unknown" }), null);
});

test("resume source and UI do not expose legacy template or HTML identity", async () => {
  const [moduleSource, actionsSource] = await Promise.all([
    readFile(new URL("../src/content/resumeArtifact.js", import.meta.url), "utf8"),
    readFile(new URL("../src/components/profile/ResumeActions.jsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(moduleSource, /htmlPath|Kami|金星-Kami/);
  assert.doesNotMatch(actionsSource, /productConfiguration\.resumeArtifact|htmlPath|Kami/);
  assert.match(actionsSource, /resolveResumeArtifact/);
  assert.match(actionsSource, /查看简历/);
  assert.match(actionsSource, /下载简历/);
  assert.match(actionsSource, /金星简历\$\{now\.getFullYear\(\)\}/);
});
