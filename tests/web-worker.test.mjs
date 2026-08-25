import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  return (await import(workerUrl.href)).default;
}

const context = {
  waitUntil() {},
  passThroughOnException() {},
};

const assets = {
  fetch: async () => new Response("Not found", { status: 404 }),
};

test("web Worker health and multiplayer config are production-ready", async () => {
  const worker = await loadWorker();
  const env = {
    ASSETS: assets,
    REALTIME_ORIGIN: "https://realtime.waitland.app",
  };

  const health = await worker.fetch(
    new Request("https://waitland.app/health"),
    env,
    context,
  );
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, service: "waitland-web" });
  assert.equal(health.headers.get("cache-control"), "no-store");

  const config = await worker.fetch(
    new Request("https://waitland.app/api/multiplayer/config"),
    env,
    context,
  );
  assert.equal(config.status, 200);
  assert.deepEqual(await config.json(), {
    enabled: true,
    protocolVersion: 1,
    realtimeOrigin: "https://realtime.waitland.app",
  });
  assert.equal(config.headers.get("cache-control"), "no-store");
});

test("web Worker canonicalizes www and fails closed on an invalid realtime origin", async () => {
  const worker = await loadWorker();

  const redirect = await worker.fetch(
    new Request("https://www.waitland.app/?from=www"),
    { ASSETS: assets, REALTIME_ORIGIN: "https://realtime.waitland.app" },
    context,
  );
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "https://waitland.app/?from=www");

  const invalid = await worker.fetch(
    new Request("https://waitland.app/api/multiplayer/config"),
    { ASSETS: assets, REALTIME_ORIGIN: "http://realtime.waitland.app/path" },
    context,
  );
  assert.deepEqual(await invalid.json(), {
    enabled: false,
    protocolVersion: 1,
    reason: "invalid-configuration",
  });
});
