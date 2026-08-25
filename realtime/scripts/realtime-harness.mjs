#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

const argumentsSet = new Set(process.argv.slice(2));
const mode = argumentsSet.has("--load") ? "load" : "smoke";

if (argumentsSet.has("--load") && argumentsSet.has("--smoke")) {
  throw new Error("Choose either --smoke or --load, not both.");
}
if (typeof WebSocket !== "function") {
  throw new Error("This harness requires Node.js 22.13 or newer with global WebSocket support.");
}

function numberSetting(name, fallback, minimum, maximum) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function checkedOrigin(raw, name) {
  if (!raw) throw new Error(`${name} is required.`);
  const url = new URL(raw);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && local))
  ) {
    throw new Error(`${name} must be an HTTPS origin, or an HTTP localhost origin.`);
  }
  return url.origin;
}

const realtimeOrigin = checkedOrigin(process.env.REALTIME_ORIGIN, "REALTIME_ORIGIN");
const webOrigin = checkedOrigin(
  process.env.WEB_ORIGIN ?? "https://waitland.app",
  "WEB_ORIGIN",
);
const clientCount = Math.floor(
  mode === "smoke" ? 1 : numberSetting("CLIENTS", 64, 1, 512),
);
const durationSeconds = numberSetting(
  "DURATION_SECONDS",
  mode === "smoke" ? 6 : 30,
  2,
  3_600,
);
const movesPerSecond = numberSetting("MOVES_PER_SECOND", 8, 1, 12);
const joinConcurrency = Math.floor(numberSetting("JOIN_CONCURRENCY", 8, 1, 32));

if (mode === "load" && process.env.ALLOW_LOAD_TEST !== "yes") {
  throw new Error("Load mode is guarded. Set ALLOW_LOAD_TEST=yes after confirming the target.");
}

const stateHash = createHash("sha256").update(realtimeOrigin).digest("hex").slice(0, 12);
const stateFile =
  process.env.HARNESS_STATE_FILE ??
  join(tmpdir(), `waiting-pit-realtime-harness-${stateHash}.json`);

const statistics = {
  requestedClients: clientCount,
  openedClients: 0,
  failedClients: 0,
  unexpectedCloses: 0,
  frames: 0,
  chats: 0,
  pongs: 0,
  serverErrors: 0,
  movementMessages: 0,
  welcomeMilliseconds: [],
  frameAgeMilliseconds: [],
  failures: [],
};

function recordFailure(message) {
  statistics.failures.push(String(message).slice(0, 240));
}

async function readState() {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    return Array.isArray(parsed.resumeTokens) ? parsed.resumeTokens : [];
  } catch {
    return [];
  }
}

async function writeState(resumeTokens) {
  await writeFile(
    stateFile,
    `${JSON.stringify({ realtimeOrigin, updatedAt: new Date().toISOString(), resumeTokens }, null, 2)}\n`,
    { mode: 0o600 },
  );
  await chmod(stateFile, 0o600);
}

async function verifyFrontDoor() {
  const healthResponse = await fetch(new URL("/ready", realtimeOrigin), {
    signal: AbortSignal.timeout(10_000),
  });
  const health = await healthResponse.json().catch(() => null);
  if (!healthResponse.ok || health?.ok !== true || health?.protocol !== 1) {
    throw new Error(`Readiness check failed (${healthResponse.status}).`);
  }

  const preflight = await fetch(new URL("/v1/session", realtimeOrigin), {
    method: "OPTIONS",
    headers: {
      Origin: webOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (
    preflight.status !== 204 ||
    preflight.headers.get("access-control-allow-origin") !== webOrigin
  ) {
    throw new Error(
      `CORS preflight failed (${preflight.status}); expected Access-Control-Allow-Origin ${webOrigin}.`,
    );
  }
}

async function createSession(index, resumeToken) {
  const response = await fetch(new URL("/v1/session", realtimeOrigin), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Origin: webOrigin,
    },
    body: JSON.stringify({
      profile: {
        name: `Harness ${index + 1}`,
        city: "Load Test",
        countryCode: "CA",
        countryFlag: "🇨🇦",
        waitReason: mode === "smoke" ? "Smoke test" : "Load test",
      },
      ...(typeof resumeToken === "string" && resumeToken ? { resumeToken } : {}),
    }),
    signal: AbortSignal.timeout(12_000),
  });

  // A seven-day token may expire between runs. Retry once as a new anonymous
  // actor instead of turning an expected expiry into a false service failure.
  if ((response.status === 401 || response.status === 403) && resumeToken) {
    return createSession(index, undefined);
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Session ${index + 1} failed (${response.status}).`);
  if (
    !body ||
    body.protocol !== 1 ||
    typeof body.resumeToken !== "string" ||
    typeof body.wsUrl !== "string"
  ) {
    throw new Error(`Session ${index + 1} returned an invalid response.`);
  }
  return body;
}

function openSocket(index, session) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const socket = new WebSocket(session.wsUrl);
    const client = {
      index,
      socket,
      actorId: session.actorId,
      resumeToken: session.resumeToken,
      x: 0,
      z: 0,
      heading: (index * 0.618) % (Math.PI * 2),
      seq: 0,
      expectedClose: false,
      movementTimer: undefined,
      heartbeatTimer: undefined,
    };
    let welcomed = false;
    const timeout = setTimeout(() => {
      if (!welcomed) {
        client.expectedClose = true;
        socket.close(4000, "harness welcome timeout");
        reject(new Error(`Client ${index + 1} did not receive welcome within 12 seconds.`));
      }
    }, 12_000);

    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }

      if (message.t === "welcome" && !welcomed) {
        const self = Array.isArray(message.players)
          ? message.players.find((player) => player?.id === message.selfId)
          : undefined;
        if (!self || typeof self.x !== "number" || typeof self.z !== "number") {
          clearTimeout(timeout);
          client.expectedClose = true;
          socket.close(4000, "invalid welcome");
          reject(new Error(`Client ${index + 1} received an invalid welcome.`));
          return;
        }
        welcomed = true;
        clearTimeout(timeout);
        client.x = self.x;
        client.z = self.z;
        statistics.openedClients += 1;
        statistics.welcomeMilliseconds.push(performance.now() - startedAt);
        resolve(client);
        return;
      }
      if (message.t === "frame") {
        statistics.frames += 1;
        if (typeof message.serverTime === "number") {
          statistics.frameAgeMilliseconds.push(Math.max(0, Date.now() - message.serverTime));
        }
      } else if (message.t === "chat") {
        statistics.chats += 1;
      } else if (message.t === "pong") {
        statistics.pongs += 1;
      } else if (message.t === "error") {
        statistics.serverErrors += 1;
        recordFailure(`Server error for client ${index + 1}: ${message.code ?? "unknown"}`);
      }
    });

    socket.addEventListener("close", (event) => {
      clearTimeout(timeout);
      if (!client.expectedClose) {
        statistics.unexpectedCloses += 1;
        recordFailure(
          `Unexpected close for client ${index + 1}: ${event.code} ${event.reason || "no reason"}`,
        );
      }
      if (!welcomed) reject(new Error(`Client ${index + 1} closed before welcome.`));
    });

    socket.addEventListener("error", () => {
      if (!welcomed) {
        client.expectedClose = true;
        socket.close(4000, "harness socket error");
        reject(new Error(`Client ${index + 1} WebSocket failed.`));
      }
    });
  });
}

function startTraffic(client) {
  const movementInterval = 1_000 / movesPerSecond;
  client.movementTimer = setInterval(() => {
    if (client.socket.readyState !== WebSocket.OPEN) return;
    client.heading += 0.11 + (client.index % 5) * 0.006;
    const step = Math.min(0.28, 3.2 / movesPerSecond);
    let nextX = client.x + Math.cos(client.heading) * step;
    let nextZ = client.z + Math.sin(client.heading) * step;
    const radius = Math.hypot(nextX, nextZ);
    if (radius < 7 || radius > 70) {
      client.heading += Math.PI;
      nextX = client.x + Math.cos(client.heading) * step;
      nextZ = client.z + Math.sin(client.heading) * step;
    }
    client.x = nextX;
    client.z = nextZ;
    client.seq += 1;
    client.socket.send(
      JSON.stringify({
        t: "move",
        seq: client.seq,
        x: Number(client.x.toFixed(3)),
        z: Number(client.z.toFixed(3)),
        heading: client.heading,
      }),
    );
    statistics.movementMessages += 1;
  }, movementInterval);

  const ping = () => {
    if (client.socket.readyState === WebSocket.OPEN) {
      // Match the browser's constant payload so the hibernating room can use
      // Cloudflare's WebSocket auto-response without waking its isolate.
      client.socket.send(JSON.stringify({ t: "ping" }));
    }
  };
  ping();
  client.heartbeatTimer = setInterval(ping, 15_000);

  if (mode === "smoke") {
    client.socket.send(
      JSON.stringify({ t: "chat", id: `smoke-${Date.now()}`, text: "smoke check" }),
    );
  }
}

function stopClient(client) {
  clearInterval(client.movementTimer);
  clearInterval(client.heartbeatTimer);
  client.expectedClose = true;
  if (
    client.socket.readyState === WebSocket.OPEN ||
    client.socket.readyState === WebSocket.CONNECTING
  ) {
    client.socket.close(1000, "harness complete");
  }
}

async function mapWithConcurrency(values, concurrency, operation) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const value = values[nextIndex];
      nextIndex += 1;
      await operation(value);
    }
  });
  await Promise.all(workers);
}

function percentile(values, percentileValue) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentileValue))].toFixed(1));
}

async function main() {
  console.log(
    `Waitland ${mode}: ${clientCount} client${clientCount === 1 ? "" : "s"}, ${movesPerSecond} moves/s, ${durationSeconds}s`,
  );
  console.log(`Realtime: ${realtimeOrigin}`);
  console.log(`Browser origin under test: ${webOrigin}`);
  await verifyFrontDoor();

  const storedTokens = await readState();
  const nextTokens = [...storedTokens];
  const clients = [];
  await mapWithConcurrency(
    Array.from({ length: clientCount }, (_, index) => index),
    joinConcurrency,
    async (index) => {
      try {
        const session = await createSession(index, storedTokens[index]);
        nextTokens[index] = session.resumeToken;
        const client = await openSocket(index, session);
        clients.push(client);
        startTraffic(client);
      } catch (error) {
        statistics.failedClients += 1;
        recordFailure(error instanceof Error ? error.message : error);
      }
    },
  );
  try {
    await writeState(nextTokens.slice(0, Math.max(clientCount, storedTokens.length)));
  } catch (error) {
    statistics.failedClients += 1;
    recordFailure(
      `Could not persist harness resume tokens: ${error instanceof Error ? error.message : error}`,
    );
  }

  if (clients.length) {
    await new Promise((resolve) => setTimeout(resolve, durationSeconds * 1_000));
  }
  for (const client of clients) stopClient(client);
  await new Promise((resolve) => setTimeout(resolve, 250));

  const summary = {
    mode,
    realtimeOrigin,
    webOrigin,
    requestedClients: statistics.requestedClients,
    openedClients: statistics.openedClients,
    failedClients: statistics.failedClients,
    unexpectedCloses: statistics.unexpectedCloses,
    movementMessages: statistics.movementMessages,
    frames: statistics.frames,
    chats: statistics.chats,
    pongs: statistics.pongs,
    serverErrors: statistics.serverErrors,
    welcomeP95Ms: percentile(statistics.welcomeMilliseconds, 0.95),
    frameAgeP95Ms: percentile(statistics.frameAgeMilliseconds, 0.95),
    stateFile,
    failures: statistics.failures.slice(0, 20),
  };
  console.log(JSON.stringify(summary, null, 2));

  const smokeSignalsMissing =
    mode === "smoke" &&
    (statistics.frames < 1 || statistics.chats < 1 || statistics.pongs < 1);
  if (
    statistics.openedClients !== clientCount ||
    statistics.failedClients > 0 ||
    statistics.unexpectedCloses > 0 ||
    statistics.serverErrors > 0 ||
    smokeSignalsMissing
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
