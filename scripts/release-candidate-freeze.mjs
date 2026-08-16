#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { candidateIdentityPath, readCandidateIdentity, validateCandidateIdentity } from "./lib/release-transaction.mjs";

const root = process.cwd(); const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")); const version = `v${packageJson.version}`;
const identity = await readCandidateIdentity(root, version, { requireCurrentIdentity: true }); validateCandidateIdentity(identity, { root, version, requireCurrentIdentity: true });
console.log(JSON.stringify({ candidateIdentityPath: candidateIdentityPath(root, version), version, baseHead: identity.baseHead, treeOid: identity.treeOid, scopeDigest: identity.scopeDigest, candidateHash: identity.candidateHash }, null, 2));
