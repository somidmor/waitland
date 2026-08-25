#!/usr/bin/env node

const endpoints = [
  {
    url: "https://realtime.waitland.app/health",
    validate: (body) => body?.ok === true && body?.protocol === 1,
  },
  {
    url: "https://realtime.waitland.app/ready",
    validate: (body) =>
      body?.ok === true &&
      body?.protocol === 1 &&
      Number.isFinite(body?.pit?.count) &&
      body?.pit?.capacity === 1_000,
  },
  {
    url: "https://waitland.app/health",
    validate: (body) => body?.ok === true && body?.service === "waitland-web",
  },
  {
    url: "https://waitland.app/api/multiplayer/config",
    validate: (body) =>
      body?.enabled === true &&
      body?.protocolVersion === 1 &&
      body?.realtimeOrigin === "https://realtime.waitland.app",
  },
];

const delay = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function verifyEndpoint({ url, validate }) {
  let lastError = "no response";
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && validate(body)) {
        console.log(`verified ${url}`);
        return;
      }
      lastError = `HTTP ${response.status} with an unexpected body`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < 20) await delay(3_000);
  }
  throw new Error(`Could not verify ${url}: ${lastError}`);
}

for (const endpoint of endpoints) await verifyEndpoint(endpoint);
