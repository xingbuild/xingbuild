#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { assertProductContentCompatibility } from "./lib/content-compatibility.mjs";
import { readContentTargetRegistry } from "./lib/content-targets.mjs";
import { resolveContentPreviewTargetImpact } from "./lib/content-preview.mjs";
import { verifyResumeArtifact } from "./lib/resume-artifact.mjs";

const requiredFiles = [
  "AGENTS.md",
  "VERSION.md",
  "docs/iterations/current.md",
  "docs/rules/00-baseline-index.md",
  "docs/rules/responsibility-and-workflows.md",
  "docs/rules/collaboration-workflow.md",
  "docs/rules/iteration-and-release.md",
  "docs/rules/engineering-architecture-and-principles.md",
  "src/App.jsx",
  "src/content/siteContent.js",
  "src/content/homeContentAdapter.js",
  "src/content/showcaseRepository.js",
  "src/content/profileRepository.js",
  "src/content/longFormDocument.js",
  "src/content/resumeArtifact.js",
  "src/content/practiceRepository.js",
  "src/content/practiceAction.js",
  "src/content/observationRepository.js",
  "src/content/sourceUrls.js",
  "src/lib/visitQualification.js",
  "content/schema/observation.schema.json",
  "src/styles.css",
  "src/styles/tokens.css",
  "src/styles/foundations.css",
  "src/styles/layout.css",
  "src/styles/components.css",
  "src/styles/pages.css",
  "src/components/site/SiteHeader.jsx",
  "src/components/reading/Article.jsx",
  "src/components/reading/EvergreenArticle.jsx",
  "src/components/reading/ReadingTOC.jsx",
  "src/components/reading/RichDocument.jsx",
  "src/components/reading/EnterpriseArchitectureViews.jsx",
  "src/components/reading/enterpriseArchitectureViews.js",
  "src/content/evergreenArticleRepository.js",
  "src/content/diagramFigureAssets.js",
  "src/content/pageDefinitions.js",
  "src/content/pageContentResolver.js",
  "src/components/page-compositions/PageCompositionRenderer.jsx",
  "scripts/generate-evergreen-figures.mjs",
  "scripts/lib/qa-browser-runtime.mjs",
  "scripts/lib/publication-assets.mjs",
  "scripts/lib/publication-evidence.mjs",
  "scripts/lib/publication-runtime.mjs",
  "scripts/qa-browser-install-check.mjs",
  ".puppeteerrc.cjs",
  "scripts/qa-browser-check.mjs",
  "scripts/generate-enterprise-architecture-views.mjs",
  "src/architecture/enterprise-operating-system/model.c4",
  "scripts/article-content-check.mjs",
  "scripts/article-scope-check.mjs",
  "scripts/practice-scope-check.mjs",
  "scripts/verify-practice-release.mjs",
  "scripts/verify-article-release.mjs",
  "publish-xingbuild.command",
  "publish-content.command",
  "publish-practice.command",
  "publish-article.command",
  "scripts/release-preflight.mjs",
  "scripts/release-closeout-check.mjs",
  "scripts/lib/release-readiness.mjs",
  "scripts/content-review.mjs",
  "scripts/content-promote.mjs",
  "scripts/content-approve.mjs",
  "scripts/content-supersede.mjs",
  "scripts/content-scope-check.mjs",
  "scripts/content-release.mjs",
  "scripts/site-publication.mjs",
  "scripts/lib/site-publication-coordinator.mjs",
  "scripts/lib/content-compatibility.mjs",
  "scripts/content-target.mjs",
  "scripts/lib/publish-target.mjs",
  "scripts/unified-publish.mjs",
  "scripts/lib/unified-release.mjs",
  "scripts/lib/content-release-lease.mjs",
  "scripts/lib/content-targets.mjs",
  "scripts/lib/content-root.mjs",
  "scripts/lib/content-preview.mjs",
  "scripts/lib/long-form-document.mjs",
  "scripts/lib/content-preview-runtime-v2.mjs",
  "scripts/lib/resume-artifact.mjs",
  "scripts/lib/base-site-artifact.mjs",
  "scripts/lib/content-finalize.mjs",
  "scripts/lib/content-approval.mjs",
  "scripts/lib/content-release-readiness.mjs",
  "scripts/lib/content-package-reconcile.mjs",
  "scripts/lib/content-lifecycle-adapter.mjs",
  "scripts/lib/content-replacement.mjs",
  "scripts/lib/content-slot-registry.mjs",
  "scripts/lib/content-set.mjs",
  "scripts/lib/home-content-adapter.mjs",
  "scripts/lib/content-set-candidate.mjs",
  "scripts/lib/site-snapshot.mjs",
  "scripts/lib/publication-run.mjs",
  "scripts/lib/product-artifact.mjs",
  "scripts/release-build.mjs",
  "scripts/content-set-migrate.mjs",
  "scripts/content-site-preview.mjs",
  "start-content-preview.command",
  "public/resume/resume.pdf",
  "scripts/lib/content-lifecycle-time.mjs",
  "scripts/lib/content-lifecycle-governance.mjs",
  "scripts/lib/governance-cli-runtime.mjs",
  "scripts/lib/qa-browser-install-policy.mjs",
  "scripts/governance-cli.mjs",
  "scripts/qa-v0279-governance.mjs",
  "scripts/content-lifecycle-governance.mjs",
  "tests/product-content-isolation.test.mjs",
  "scripts/verify-public-release.mjs",
  "edgeone.json",
  ".openai/hosting.json",
  "worker/index.js",
  "tests/visit-overview.test.mjs",
  "tests/framework-layout.test.mjs",
  "tests/framework-experience.test.mjs",
  "tests/content-publish.test.mjs",
  "tests/ops-scheduling-governance.test.mjs",
  "tests/task-handoff-governance.test.mjs",
  "tests/baseline-governance.test.mjs",
  "tests/content-targets.test.mjs",
  "tests/content-package-reconcile.test.mjs",
  "tests/content-slot-registry.test.mjs",
  "tests/content-lifecycle-adapter.test.mjs",
  "tests/v02620-content-preview.test.mjs",
  "tests/v02621-content-preview.test.mjs",
  "tests/v02622-content-preview-runtime.test.mjs",
  "tests/v02627-content-preview-navigation.test.mjs",
  "tests/v02628-content-preview.test.mjs",
  "tests/v02630-content-expression.test.mjs",
  "tests/v02631-resume-artifact.test.mjs",
  "scripts/qa-v02631-content-preview-evidence.mjs",
  "tests/v0270-content-lifecycle-governance.test.mjs",
  "scripts/content-storage-governance-v0274.mjs",
  "scripts/lib/content-storage-governance.mjs",
  "tests/v0274-content-storage-governance.test.mjs",
  "scripts/lib/content-lifecycle-evidence-v0275.mjs",
  "scripts/lib/content-lifecycle-evidence.mjs",
  "scripts/lib/lifecycle-evidence-path.mjs",
  "scripts/content-lifecycle-evidence-v0275.mjs",
  "scripts/content-lifecycle-evidence.mjs",
  "tests/v0275-content-lifecycle-evidence.test.mjs",
  "tests/v0278-lifecycle-evidence.test.mjs",
  "tests/v0279-governance-cli.test.mjs",
];

for (const file of requiredFiles) {
  const info = await stat(new URL(`../${file}`, import.meta.url));
  assert(info.isFile(), `${file} must be a file`);
}

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
assert.equal(packageJson.scripts["content:publish"], "node scripts/content-release.mjs", "content publish must use the independent content engine");
assert.equal(packageJson.scripts["content:prepare"], "node scripts/content-release.mjs --prepare", "content prepare must stay explicit");
assert.equal(packageJson.scripts["content:build"], "node scripts/content-release.mjs --build", "content build must stay explicit");
assert.equal(packageJson.scripts["release:build"], "node scripts/release-build.mjs", "final release build must use the exact HEAD/tag builder");
assert.equal(packageJson.scripts["site-publication"], "node scripts/site-publication.mjs", "site publication must have one coordinator entry point");
assert.equal(packageJson.scripts["content:preview:site"], "node scripts/content-site-preview.mjs", "content site preview must use the single dev-only entry point");
assert.equal(packageJson.scripts["qa:resume-artifact"], "node scripts/lib/resume-artifact.mjs", "resume artifact verification must use the single registry check");
assert.equal(packageJson.scripts["qa:content-preview:evidence"], "node scripts/qa-v02631-content-preview-evidence.mjs", "content preview evidence must use the exact-head evidence entry point");
assert.match(packageJson.scripts["content:lifecycle"], /^node scripts\/content-lifecycle-governance\.mjs inventory --dry-run .*--output \.content-workspace\/qa\/v0279-lifecycle-evidence\.json$/, "content lifecycle governance must stay bounded and explicit");
assert.match(packageJson.scripts["content:storage:check"], /^node scripts\/content-storage-governance\.mjs inventory --dry-run .*--output \.content-workspace\/qa\/v0279-storage-evidence\.json$/, "content storage governance must stay bounded and explicit");
assert.equal(packageJson.scripts["content:storage:check:v0274"], "node scripts/content-storage-governance-v0274.mjs", "v0.27.4 storage evidence must use the sole reducer entry point");
assert.equal(packageJson.scripts["content:lifecycle:evidence:v0275"], "node scripts/content-lifecycle-evidence-v0275.mjs", "v0.27.5 lifecycle evidence must use the sole stage-aware entry point");
assert.equal(packageJson.scripts["content:lifecycle:evidence"], "node scripts/content-lifecycle-evidence.mjs", "current lifecycle evidence must use the version-aware entry point");
assert.match(packageJson.scripts["release:prepare"], /node scripts\/content-lifecycle-evidence\.mjs --precommit$/, "release:prepare must use current version lifecycle evidence");
const version = await readFile(new URL("../VERSION.md", import.meta.url), "utf8");
const current = await readFile(
  new URL("../docs/iterations/current.md", import.meta.url),
  "utf8",
);
assertProductContentCompatibility({ currentText: current });
const contentTargetRegistry = await readContentTargetRegistry();
for (const target of contentTargetRegistry.targets) {
  resolveContentPreviewTargetImpact(target);
}
const resumeEvidence = await verifyResumeArtifact();
assert.equal(resumeEvidence.verified, true, "career resume artifact must be byte-verified before a product check can pass");
const siteContent = await readFile(
  new URL("../src/content/siteContent.js", import.meta.url),
  "utf8",
);
const resumeModule = await readFile(new URL("../src/content/resumeArtifact.js", import.meta.url), "utf8");
const resumeActions = await readFile(new URL("../src/components/profile/ResumeActions.jsx", import.meta.url), "utf8");
assert(!resumeModule.includes("Kami") && !resumeModule.includes("htmlPath"), "public resume registry must not expose legacy HTML/template identity");
assert(!resumeActions.includes("productConfiguration.resumeArtifact"), "ResumeActions must resolve the protected artifact through its registry");
assert(resumeActions.includes("resolveResumeArtifact"), "ResumeActions must consume the shared resolver");
const observationRepository = await readFile(
  new URL("../src/content/observationRepository.js", import.meta.url),
  "utf8",
);
const practiceRepository = await readFile(
  new URL("../src/content/practiceRepository.js", import.meta.url),
  "utf8",
);
const app = await readFile(
  new URL("../src/App.jsx", import.meta.url),
  "utf8",
);
const worker = await readFile(
  new URL("../worker/index.js", import.meta.url),
  "utf8",
);
const edgeOneConfig = JSON.parse(
  await readFile(new URL("../edgeone.json", import.meta.url), "utf8"),
);

assert.match(packageJson.version, /^\d+\.\d+\.\d+$/, "package version must use x.y.z");
assert(
  version.includes(`v${packageJson.version}`),
  "VERSION.md must contain the package version",
);
assert(
  current.includes(`v${packageJson.version}`),
  "current iteration must contain the package version",
);
const showcaseRepository = await readFile(new URL("../src/content/showcaseRepository.js", import.meta.url), "utf8");
const profileRepository = await readFile(new URL("../src/content/profileRepository.js", import.meta.url), "utf8");
assert(showcaseRepository.includes("import.meta.glob"), "showcase content must use the independent repository glob");
assert(showcaseRepository.includes("__XINGBUILD_CONTENT_BUILD__"), "showcase content must be gated to content builds");
assert(profileRepository.includes("import.meta.glob"), "profile content must use the independent repository glob");
assert(profileRepository.includes("__XINGBUILD_CONTENT_BUILD__"), "profile content must be gated to content builds");
assert(!siteContent.includes("export const observations"), "observations must not be inlined in site content");
assert(!siteContent.includes("export const practices"), "practices must use the controlled content repository");
assert(observationRepository.includes("import.meta.glob"), "published observations must use the repository");
assert(practiceRepository.includes("import.meta.glob"), "practice content must use the independent repository glob");
assert(practiceRepository.includes("__XINGBUILD_CONTENT_BUILD__"), "practice content must be gated to content builds");
const evergreenRepository = await readFile(new URL("../src/content/evergreenArticleRepository.js", import.meta.url), "utf8");
assert(evergreenRepository.includes("import.meta.glob"), "framework article must use the independent repository glob");
assert(evergreenRepository.includes("__XINGBUILD_CONTENT_BUILD__"), "framework article must be gated to content builds");
const siteBuild = await readFile(new URL("../scripts/prepare-sites-build.mjs", import.meta.url), "utf8");
assert(!siteBuild.includes("contentRootDirectory"), "product Sites preparation must not read the independent content root");
assert(!siteBuild.includes("independentMediaRoot"), "product Sites preparation must not copy independent media");
const unifiedPublish = await readFile(new URL("../scripts/unified-publish.mjs", import.meta.url), "utf8");
const contentRelease = await readFile(new URL("../scripts/content-release.mjs", import.meta.url), "utf8");
const siteCoordinator = await readFile(new URL("../scripts/lib/site-publication-coordinator.mjs", import.meta.url), "utf8");
const contentSetCandidate = await readFile(new URL("../scripts/lib/content-set-candidate.mjs", import.meta.url), "utf8");
const homeContentAdapter = await readFile(new URL("../scripts/lib/home-content-adapter.mjs", import.meta.url), "utf8");
assert(!/makers[\"']?,?\s*[\"']deploy/.test(unifiedPublish), "product wrapper must not call EdgeOne deploy directly");
assert(!/makers[\"']?,?\s*[\"']deploy/.test(contentRelease), "content wrapper must not call EdgeOne deploy directly");
assert(siteCoordinator.includes("[\"makers\", \"deploy\""), "site coordinator must own EdgeOne deploy");
assert(contentSetCandidate.includes("readCanonicalHomeContent"), "Home Candidate must read canonical home content");
assert(!contentSetCandidate.includes("src/content/siteContent.js"), "Home Candidate must not read legacy site content");
assert(contentRelease.includes("readCanonicalHomeContent"), "content prepare must use canonical Home source");
assert(homeContentAdapter.includes("CONTENT_HOME_SOURCE_MISSING"), "Home adapter must hard-fail missing canonical source");
const pageDefinitions = await readFile(new URL("../src/content/pageDefinitions.js", import.meta.url), "utf8");
const compositionRenderer = await readFile(new URL("../src/components/page-compositions/PageCompositionRenderer.jsx", import.meta.url), "utf8");
assert(pageDefinitions.includes("pageDefinitionRegistry"), "page definitions must expose a controlled registry");
for (const composition of ["HomeComposition", "ShowcaseComposition", "CollectionComposition", "ReadingComposition"]) {
  assert(pageDefinitions.includes(composition), `page definitions must register ${composition}`);
  assert(compositionRenderer.includes(composition), `composition renderer must support ${composition}`);
}
assert(app.includes("findPageDefinitionByRoute"), "app routes must resolve through the page definition registry");
assert(app.includes("PageCompositionRenderer"), "app routes must use the shared composition renderer");
const viteConfig = await readFile(new URL("../vite.config.mjs", import.meta.url), "utf8");
assert(viteConfig.includes("xingbuild:content-target-update"), "content preview must use the target update event");
assert(viteConfig.includes("contentPreviewRuntimeV2"), "content preview must use the explicit runtime v2");
assert(viteConfig.includes("preview-events"), "content preview must expose the explicit event channel");
assert(viteConfig.includes("new EventSource"), "content preview workbench must use the explicit event channel");
assert(!viteConfig.includes("import.meta.hot"), "content preview workbench must not depend on implicit Vite HMR");
assert(!viteConfig.includes('type: "full-reload"'), "content preview must not trigger a global full reload");
for (const route of ["/products", "/business-observations", "/observations", "/about"]) {
  assert(app.includes(route), `app must include the ${route} route`);
}
assert.deepEqual(edgeOneConfig.redirects, [
  {
    source: "$wwwhost",
    destination: "$host",
    statusCode: 301,
  },
]);
assert(app.includes("startVisitQualification"), "app must start the formal-site visit qualifier");
assert(app.includes("/business-observations#digital-implementation"), "legacy digital view must replace to its evergreen anchor");
for (const contract of [
  "visitKv",
  "visitHashSecret",
  "XINGBUILD",
  "/api/visits/qualify",
  "Asia/Shanghai",
]) {
  assert(worker.includes(contract), `worker must retain visit contract: ${contract}`);
}

console.log(`xingbuild project check passed for v${packageJson.version}`);
