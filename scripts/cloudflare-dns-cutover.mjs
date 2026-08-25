const API_ROOT = "https://api.cloudflare.com/client/v4";
const ZONE_NAME = "waitland.app";
const HOSTNAMES = ["waitland.app", "www.waitland.app"];
const BLOCKING_TYPES = new Set(["A", "AAAA", "CNAME"]);

const apiToken = process.env.CLOUDFLARE_API_TOKEN?.trim();
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();

if (!apiToken || !accountId) {
  throw new Error("Cloudflare deployment credentials are missing.");
}

async function cloudflare(path, init = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });

  const payload = await response.json();
  if (!response.ok || !payload.success) {
    const messages = [...(payload.errors ?? []), ...(payload.messages ?? [])]
      .map((entry) => entry.message)
      .filter(Boolean)
      .join("; ");
    throw new Error(messages || `Cloudflare API request failed with ${response.status}.`);
  }

  return payload.result;
}

const zoneQuery = new URLSearchParams({
  name: ZONE_NAME,
  "account.id": accountId,
  status: "active",
  per_page: "50",
});
const zones = await cloudflare(`/zones?${zoneQuery}`);

if (zones.length !== 1) {
  throw new Error(`Expected one active ${ZONE_NAME} zone, found ${zones.length}.`);
}

const zoneId = zones[0].id;
let removed = 0;

for (const hostname of HOSTNAMES) {
  const recordQuery = new URLSearchParams({ name: hostname, per_page: "100" });
  const records = await cloudflare(`/zones/${zoneId}/dns_records?${recordQuery}`);
  const blockers = records.filter(
    (record) => record.name === hostname && BLOCKING_TYPES.has(record.type),
  );

  for (const record of blockers) {
    await cloudflare(`/zones/${zoneId}/dns_records/${record.id}`, { method: "DELETE" });
    console.log(`Removed legacy ${record.type} record for ${hostname}.`);
    removed += 1;
  }
}

console.log(`DNS cutover cleanup complete; removed ${removed} blocking record(s).`);
