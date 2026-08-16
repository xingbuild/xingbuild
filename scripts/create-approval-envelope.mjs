#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { approvalRecordPath, createApprovalRecord, readCandidateIdentity } from "./lib/release-transaction.mjs";

const root = process.cwd();
if (process.argv.includes("--help")) { console.log("Usage: npm run release:approve -- [--output <path>]"); process.exit(0); }
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); const version = `v${packageJson.version}`;
const candidate = await readCandidateIdentity(root, version, { requireCurrentIdentity: true }); const approval = createApprovalRecord({ root, version, candidate });
const outputIndex = process.argv.indexOf("--output"); const outputPath = outputIndex >= 0 ? path.resolve(root, process.argv[outputIndex + 1]) : approvalRecordPath(root, version);
await mkdir(path.dirname(outputPath), { recursive: true }); await writeFile(outputPath, `${JSON.stringify(approval, null, 2)}\n`);
console.log(JSON.stringify({ outputPath, version, candidateHash: approval.candidateHash, approvedTreeOid: approval.approvedTreeOid, approvalHash: approval.approvalHash, approver: approval.approver }, null, 2));
