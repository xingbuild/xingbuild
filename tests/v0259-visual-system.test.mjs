import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { projectRobotaxiRelease } from "../src/content/robotaxiRelease.js";
import { robotaxiProductConfiguration } from "../src/content/productConfiguration.js";
import { RESUME_ARTIFACT_ID, RESUME_ARTIFACT_PDF_SHA256, resumeArtifact } from "../src/content/resumeArtifact.js";

test("Robotaxi release reference only projects the verified product identity", () => {
  const verified = projectRobotaxiRelease({
    version: "v049.13.23",
    commit: "242fca774a787b8922bdb02ceaa780d28c6cd3e8",
    production_url: "https://robotaxi.xingbuild.top/",
    ignored: "not projected",
  }, { verifiedAt: "2026-08-05T00:00:00.000Z", source: "fixture" });
  assert.deepEqual(verified, {
    version: "v049.13.23",
    commit: "242fca774a787b8922bdb02ceaa780d28c6cd3e8",
    production_url: "https://robotaxi.xingbuild.top/",
    sourceEndpoint: "https://robotaxi.xingbuild.top/deployment-manifest.json",
    source: "fixture",
    verifiedAt: "2026-08-05T00:00:00.000Z",
  });
  assert.equal(projectRobotaxiRelease({ version: "v049.13.23", commit: "a".repeat(40), production_url: "https://example.com/" }), null);
  assert.equal(projectRobotaxiRelease({ version: "latest", commit: "a".repeat(40), production_url: "https://robotaxi.xingbuild.top/" }), null);
});

test("product actions and resume artifact keep their owner and safety boundaries", async () => {
  assert.deepEqual(robotaxiProductConfiguration.heroActions.map(({ id, href }) => ({ id, href })), [
    { id: "enter-robotaxi", href: "https://robotaxi.xingbuild.top/" },
    { id: "browse-observations", href: "/business-observations" },
  ]);
  assert.equal(robotaxiProductConfiguration.closing.action.href, "https://robotaxi.xingbuild.top/");
  assert.deepEqual(robotaxiProductConfiguration.homeActions.map(({ label, href }) => ({ label, href })), [
    { label: "查看最新B端产品", href: "/products" },
    { label: "浏览经营观察", href: "/business-observations" },
  ]);
  assert.equal(resumeArtifact.artifactId, RESUME_ARTIFACT_ID);
  assert.equal(resumeArtifact.pdfPath, "/resume/resume.pdf");
  assert.equal(resumeArtifact.pdfSha256, RESUME_ARTIFACT_PDF_SHA256);
  assert.equal(resumeArtifact.mimeType, "application/pdf");
  for (const file of ["src/components/showcase/MediaStage.jsx", "src/components/showcase/ShowcaseFlow.jsx", "src/components/showcase/ShowcaseModule.jsx", "src/components/profile/ResumeActions.jsx", "vite.config.mjs"]) {
    assert.ok((await readFile(new URL(`../${file}`, import.meta.url), "utf8")).length > 0, `${file} should be present`);
  }
});

test("MediaStage and the same-origin adapter keep media behavior explicit", async () => {
  const mediaStage = await readFile(new URL("../src/components/showcase/MediaStage.jsx", import.meta.url), "utf8");
  const vite = await readFile(new URL("../vite.config.mjs", import.meta.url), "utf8");
  assert.match(mediaStage, /autoPlay=\{!isReducedMotion\}/);
  assert.match(mediaStage, /muted/);
  assert.match(mediaStage, /loop/);
  assert.match(mediaStage, /playsInline/);
  assert.doesNotMatch(mediaStage, /controls=/);
  assert.match(mediaStage, /IntersectionObserver/);
  assert.match(mediaStage, /aria-label="进入 Robotaxi运营平台"/);
  assert.match(vite, /\/__xingbuild\/robotaxi-release/);
  assert.match(vite, /contentMediaPreview/);
  assert.match(vite, /Cache-Control/);
});
