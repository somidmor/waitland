#!/usr/bin/env node
/** Real workerd integration; all state and sockets are isolated on localhost. */
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const { build } = wranglerRequire("esbuild");
const { Miniflare, convertV4MiniflareOptions } = wranglerRequire("miniflare");
const directory = await mkdtemp(join(tmpdir(), "waitland-lifecycle-"));
const bundle = join(directory, "worker.mjs");
const webOrigin = "http://localhost:5173";
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clients = [];
let runtime;
let origin;

async function until(check, label, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = check();
    if (result) return result;
    await pause(20);
  }
  throw new Error(`Timed out: ${label}`);
}

async function start() {
  runtime = new Miniflare(convertV4MiniflareOptions({
    name: "waitland-lifecycle-test", modules: true, script: await readFile(bundle, "utf8"),
    compatibilityDate: "2026-08-25",
    bindings: { SESSION_SECRET: "isolated-test-secret-never-used-in-production", ALLOWED_ORIGINS: webOrigin },
    durableObjects: Object.fromEntries([
      ["LOBBY", "Lobby"], ["ROOMS", "FieldRoom"], ["PIT", "PitCoordinator"], ["PIT_FANOUT", "PitFanout"],
    ].map(([binding, className]) => [binding, { className, useSQLite: true }])),
    resourcePersistencePath: join(directory, "state"),
  }));
  origin = (await runtime.ready).origin;
}

async function connect(reason, resumeToken) {
  const response = await fetch(`${origin}/v1/session`, {
    method: "POST", headers: { "content-type": "application/json", Origin: webOrigin },
    body: JSON.stringify({ profile: { waitReason: reason }, ...(resumeToken ? { resumeToken } : {}) }),
  });
  assert.equal(response.status, 200);
  const session = await response.json();
  assert.equal(new URL(session.wsUrl).origin.replace("ws:", "http:"), origin);
  const client = { socket: new WebSocket(session.wsUrl), session, events: [], stones: new Map(), players: new Map(), seq: 0, pit: null, self: null };
  client.socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    client.events.push(message);
    if (message.t === "welcome") {
      client.pit = message.pit;
      for (const player of message.players) client.players.set(player.id, player);
      client.self = client.players.get(message.selfId);
      for (const stone of message.stones) client.stones.set(stone.id, stone);
    } else if (message.t === "frame") {
      for (const player of message.players) {
        client.players.set(player.id, { ...client.players.get(player.id), ...player });
        if (player.id === session.actorId) client.self = client.players.get(player.id);
      }
    } else if (message.t === "stone" && message.stone) client.stones.set(message.stone.id, message.stone);
    else if (message.t === "pit" && message.pit.totalStones >= (client.pit?.totalStones ?? 0)) client.pit = message.pit;
  });
  clients.push(client);
  await until(() => client.self, "welcome");
  return client;
}

async function moveTo(client, target) {
  const deadline = Date.now() + 25_000;
  while (Math.hypot(client.self.x - target.x, client.self.z - target.z) > 0.75) {
    assert.ok(Date.now() < deadline, "movement reached target");
    const dx = target.x - client.self.x;
    const dz = target.z - client.self.z;
    const distance = Math.hypot(dx, dz);
    const step = Math.min(0.48, distance);
    client.socket.send(JSON.stringify({ t: "move", seq: ++client.seq,
      x: client.self.x + dx / distance * step, z: client.self.z + dz / distance * step,
      heading: Math.atan2(-dx, -dz), vx: dx / distance * 3.4, vz: dz / distance * 3.4,
    }));
    await pause(150);
  }
  client.socket.send(JSON.stringify({ t: "move", seq: ++client.seq, x: client.self.x, z: client.self.z, vx: 0, vz: 0, heading: 0 }));
}

function action(client, kind, stoneId) {
  const id = crypto.randomUUID();
  client.socket.send(JSON.stringify({ t: kind, id, stoneId }));
  return until(() => client.events.find((message) => message.t === "action" && message.id === id), kind);
}

async function acquire(client, excluded = new Set()) {
  const pit = client.pit;
  const candidates = [...client.stones.values()].filter((stone) => !stone.holderId && !excluded.has(stone.id));
  candidates.sort((a, b) => Math.hypot(a.x - client.self.x, a.z - client.self.z) - Math.hypot(b.x - client.self.x, b.z - client.self.z));
  const stone = candidates.find((entry) => (entry.x - pit.center.x) * (client.self.x - pit.center.x) + (entry.z - pit.center.z) * (client.self.z - pit.center.z) >= 0) ?? candidates[0];
  assert.ok(stone);
  excluded.add(stone.id);
  await moveTo(client, stone);
  assert.equal((await action(client, "pickup", stone.id)).ok, true);
  const dx = client.self.x - pit.center.x;
  const dz = client.self.z - pit.center.z;
  const distance = Math.hypot(dx, dz);
  if (distance > pit.throwRadius - 1) await moveTo(client, { x: pit.center.x + dx / distance * (pit.throwRadius - 1.5), z: pit.center.z + dz / distance * (pit.throwRadius - 1.5) });
  return stone.id;
}

try {
  await build({ entryPoints: [fileURLToPath(new URL("../src/index.ts", import.meta.url))], bundle: true, format: "esm", target: "es2022", platform: "neutral", external: ["cloudflare:workers"], outfile: bundle });
  await start();
  const namespace = await runtime.getDurableObjectNamespace("PIT");
  const coordinator = namespace.get(namespace.idFromName("global-pit"));
  // Seed through the real private DO binding. No HTTP test route is introduced.
  await Promise.all(Array.from({ length: 99 }, (_, index) => coordinator.fetch("http://pit/deposit", {
    method: "POST", body: JSON.stringify({ actionKey: `integration-seed-${index}` }),
  }).then((response) => assert.equal(response.status, 200))));
  const first = await connect("A friend");
  const second = await connect("The train");
  assert.equal(first.session.roomId, second.session.roomId);
  await until(() => first.players.has(second.session.actorId), "mutual presence");
  assert.equal(second.players.has(first.session.actorId), true);
  assert.equal(first.pit.count, 99);
  assert.equal(first.self.profile.name, "");
  assert.equal(first.self.profile.city, "");
  const excluded = new Set();
  const firstStone = await acquire(first, excluded);
  const secondStone = await acquire(second, excluded);
  const final = await action(first, "throw", firstStone);
  assert.equal(final.deposited, true);
  await until(() => first.pit.round === 2 && second.pit.round === 2, "round-two fanout");
  assert.equal(first.pit.count, 0);
  assert.equal(first.pit.capacity, 200);
  assert.deepEqual(first.pit.monuments, second.pit.monuments);
  assert.equal(first.pit.monuments[0].stoneCount, 100);
  assert.ok(first.pit.monuments[0].completedAt >= first.pit.monuments[0].startedAt);
  const target = { x: second.pit.center.x - second.pit.throwRadius + 2, z: second.pit.center.z };
  await moveTo(second, target);
  const next = await action(second, "throw", secondStone);
  assert.equal(next.deposited, true);
  await until(() => first.pit.totalStones === 101 && second.pit.totalStones === 101, "next-round count");
  const expected = structuredClone(first.pit);
  const resume = second.session.resumeToken;
  const actorId = second.session.actorId;
  for (const client of clients) client.socket.close();
  await pause(150);
  await runtime.dispose();
  await start();
  const restored = await fetch(`${origin}/v1/pit`).then((response) => response.json());
  assert.deepEqual(restored, expected);
  const resumed = await connect("The train", resume);
  assert.equal(resumed.session.actorId, actorId);
  assert.equal(resumed.pit.totalStones, 101);
  assert.equal(resumed.self.carrying, null);
  console.log(JSON.stringify({ ok: true, runtime: "workerd", clients: 2, lastDeposit: 100, round: restored.round, capacity: restored.capacity, count: restored.count, monument: restored.monuments[0].name, durableRestart: true, resumeIdentity: true }, null, 2));
} finally {
  for (const client of clients) client.socket.close();
  if (runtime) await runtime.dispose();
  await rm(directory, { recursive: true, force: true });
}
