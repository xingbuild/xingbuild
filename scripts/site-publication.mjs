#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { finalizeSitePublication, readSitePublicationRecord, recoverExistingSitePublication, rollbackSitePublication, transportSitePublication, verifyPublicSitePublication } from "./lib/site-publication-coordinator.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export async function main(argv = process.argv.slice(2)) {
  const valueFor = (name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] || null : null;
  };
  const publicationDirectory = valueFor("--publication");
  if (!publicationDirectory || !["--plan", "--deploy", "--resume", "--verify", "--finalize", "--rollback", "--recover-existing"].some((flag) => argv.includes(flag))) {
    throw new Error("Usage: node scripts/site-publication.mjs --plan|--deploy|--resume|--verify|--finalize|--rollback|--recover-existing --publication <directory>");
  }
  const publication = await readSitePublicationRecord(path.resolve(root, publicationDirectory));
  if (argv.includes("--plan")) {
    console.log(JSON.stringify({ sitePublicationId: publication.sitePublicationId, productVersion: publication.productVersion, contentReleaseIds: publication.contentReleaseIds || [], state: publication.state || "intent" }));
    return;
  }
  if (argv.includes("--verify")) {
    const verified = await verifyPublicSitePublication({ publication });
    console.log(JSON.stringify(verified));
    return;
  }
  if (argv.includes("--recover-existing")) {
    const recovered = await recoverExistingSitePublication({
      publicationDirectory: path.resolve(root, publicationDirectory),
      sourceRoot: root,
      argv,
      env: process.env,
    });
    console.log(JSON.stringify({ sitePublicationId: recovered.sitePublicationId, state: recovered.state, deploymentId: recovered.deploymentId || null, deploymentCount: recovered.recovery?.deploymentCount || 1, transportCalls: recovered.recovery?.transportCalls || 0 }));
    return;
  }
  if (argv.includes("--finalize")) {
    const finalized = await finalizeSitePublication({ publicationDirectory: path.resolve(root, publicationDirectory), publicVerify: publication.publicVerify });
    console.log(JSON.stringify({ sitePublicationId: finalized.sitePublicationId, state: finalized.state }));
    return;
  }
  if (argv.includes("--rollback")) {
    const rolledBack = await rollbackSitePublication({ publicationDirectory: path.resolve(root, publicationDirectory) });
    console.log(JSON.stringify({ sitePublicationId: rolledBack.sitePublicationId, state: rolledBack.state }));
    return;
  }
  const edgeonePath = path.join(root, "node_modules", ".bin", "edgeone");
  const result = await transportSitePublication({ publication: { ...publication, client: path.resolve(root, publicationDirectory) }, sourceRoot: root, argv, env: process.env, edgeonePath });
  console.log(JSON.stringify({ sitePublicationId: result.sitePublicationId, state: result.state, deploymentId: result.deploymentId || null, publicVerify: result.publicVerify || null }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await main(); } catch (error) {
    console.error(`站点发布已停止：${error.message}${error.recoveryId ? ` recoveryId=${error.recoveryId}` : ""}`);
    process.exitCode = 1;
  }
}
