import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  QA_BROWSER_INSTALL_POLICY_VERSION,
  qaBrowserInstallPolicyEvidencePath,
  readQaBrowserInstallPolicyEvidence,
} from "../scripts/lib/qa-browser-install-policy.mjs";

test("release gates read current-version install evidence and reject missing historical evidence", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-gate-"));
  const currentPath = qaBrowserInstallPolicyEvidencePath(root, "v0.27.9");
  await mkdir(path.dirname(currentPath), { recursive: true });
  await writeFile(currentPath, `${JSON.stringify({ policyVersion: QA_BROWSER_INSTALL_POLICY_VERSION, version: "v0.27.9", status: "passed" })}\n`, "utf8");
  const current = await readQaBrowserInstallPolicyEvidence({ root, version: "v0.27.9" });
  assert.equal(current.version, "v0.27.9");
  await assert.rejects(() => readQaBrowserInstallPolicyEvidence({ root, version: "v0.26.14" }), /QA_BROWSER_INSTALL_POLICY_MISSING/);
});

test("current evidence version drift is rejected rather than masquerading as a pass", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "xingbuild-v0279-gate-drift-"));
  const currentPath = qaBrowserInstallPolicyEvidencePath(root, "v0.27.9");
  await mkdir(path.dirname(currentPath), { recursive: true });
  await writeFile(currentPath, `${JSON.stringify({ policyVersion: QA_BROWSER_INSTALL_POLICY_VERSION, version: "v0.26.14", status: "passed" })}\n`, "utf8");
  await assert.rejects(() => readQaBrowserInstallPolicyEvidence({ root, version: "v0.27.9" }), /VERSION_MISMATCH/);
});

test("closeout and preflight use the shared current-version reader", async () => {
  const root = path.resolve(new URL("..", import.meta.url).pathname);
  const closeout = await readFile(path.join(root, "scripts/release-closeout-check.mjs"), "utf8");
  const preflight = await readFile(path.join(root, "scripts/release-preflight.mjs"), "utf8");
  assert.doesNotMatch(`${closeout}\n${preflight}`, /v02614/);
  assert.match(closeout, /readQaBrowserInstallPolicyEvidence/);
  assert.match(preflight, /readQaBrowserInstallPolicyEvidence/);
});
