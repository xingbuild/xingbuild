import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { verifyPublicBrowserRuntime, PUBLICATION_RUNTIME_VERSION } from "../scripts/lib/publication-runtime.mjs";

function serverFor(html) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(html);
  });
  return server;
}

async function listen(server) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test("publication runtime v2 uses app-ready evidence without network idle", async () => {
  const server = serverFor(`<!doctype html><title>xingbuild</title><div id="root"><main><h1>Ready</h1><p>App text</p></main></div>`);
  const baseUrl = await listen(server);
  try {
    const evidence = await verifyPublicBrowserRuntime({ baseUrl, routes: ["/"], timeoutMs: 20_000, routeTimeoutMs: 5_000, publicationIdentity: { sitePublicationId: "pub", snapshotHash: "snap" }, attemptId: "attempt-test" });
    assert.equal(evidence.schemaVersion, PUBLICATION_RUNTIME_VERSION);
    assert.equal(evidence.result, "verified");
    assert.equal(evidence.routes["/"].main, 1);
    assert.equal(evidence.routes["/"].h1, 1);
    assert.equal(evidence.routes["/"].verified, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("publication runtime timeout is recoverable and keeps last route evidence", async () => {
  const server = serverFor("<!doctype html><title>xingbuild</title><div id=\"root\"></div>");
  const baseUrl = await listen(server);
  try {
    await assert.rejects(
      verifyPublicBrowserRuntime({ baseUrl, routes: ["/"], timeoutMs: 5_000, routeTimeoutMs: 500, attemptId: "attempt-timeout" }),
      (error) => error.recoverable === true && error.runtimeEvidence?.result === "recoverable" && error.runtimeEvidence?.routes?.["/"]?.verified === false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("runtime implementation forbids networkidle2 completion semantics", async () => {
  const source = await readFile(new URL("../scripts/lib/publication-runtime.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("networkidle2"), false);
  assert.match(source, /domcontentloaded/);
  assert.match(source, /mediaCancelled/);
});
