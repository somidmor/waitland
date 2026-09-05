import assert from "node:assert/strict";
import test from "node:test";

test("renders Waitland production metadata without host-specific markers", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /<title>Waitland[^<]*Throw rocks while you wait\.<\/title>/i);
  assert.match(html, /<meta[^>]+name=["']description["'][^>]+content=["'][^"']*shared pit/i);
  assert.match(html, /What are you waiting for\?/);
  assert.match(html, /No account/i);
  assert.match(html, /name="reason"/);
  assert.doesNotMatch(html, /name="(?:city|country|email|password)"/);
  assert.doesNotMatch(html, /Opening the field/);
  assert.doesNotMatch(html, /codex-preview|chatgpt\.site/i);
});
