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
      Number.isSafeInteger(body?.pit?.round) && body.pit.round >= 1 &&
      body.pit.capacity === body.pit.round * 100 &&
      body.pit.count >= 0 && body.pit.count < body.pit.capacity &&
      Number.isFinite(body.pit.center?.x) && Number.isFinite(body.pit.center?.z) &&
      Array.isArray(body.pit.monuments),
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

async function verifyApplicationAssets() {
  const pageUrl = "https://waitland.app/";
  const response = await fetch(pageUrl, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    throw new Error(`Could not fetch ${pageUrl}: HTTP ${response.status}`);
  }

  const html = await response.text();
  const references = [...html.matchAll(/(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => new URL(match[1], pageUrl))
    .filter(
      (url) =>
        url.origin === "https://waitland.app" &&
        (url.pathname.startsWith("/assets/") ||
          url.pathname.startsWith("/_next/static/")),
    );
  const assets = [...new Map(references.map((url) => [url.href, url])).values()];
  const scripts = assets.filter((url) => /\.(?:m?js)$/i.test(url.pathname));
  const styles = assets.filter((url) => /\.css$/i.test(url.pathname));
  if (scripts.length === 0 || styles.length === 0) {
    throw new Error("Homepage did not reference both JavaScript and CSS assets");
  }

  await Promise.all(
    assets.map(async (url) => {
      const assetResponse = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!assetResponse.ok) {
        throw new Error(`Could not fetch ${url.href}: HTTP ${assetResponse.status}`);
      }
      const contentType = assetResponse.headers.get("content-type") ?? "";
      if (/\.css$/i.test(url.pathname) && !contentType.includes("text/css")) {
        throw new Error(`${url.href} returned unexpected content type ${contentType}`);
      }
      if (
        /\.(?:m?js)$/i.test(url.pathname) &&
        !/(?:javascript|ecmascript)/i.test(contentType)
      ) {
        throw new Error(`${url.href} returned unexpected content type ${contentType}`);
      }
    }),
  );
  console.log(`verified ${assets.length} application assets from ${pageUrl}`);
}

await verifyApplicationAssets();
