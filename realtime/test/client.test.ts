import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import {
  RealtimeClient,
  loadMultiplayerConfig,
  type RealtimeConnectionState,
  type RealtimeError,
  type RealtimeStatus,
} from "../../app/realtime-client.ts";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, String(value));
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  clear() {
    this.values.clear();
  }
}

class BrowserWindow extends EventTarget {
  readonly localStorage = new MemoryStorage();
}

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  readonly sent: string[] = [];

  constructor(url: string | URL) {
    super();
    this.url = String(url);
    FakeWebSocket.instances.push(this);
  }

  open() {
    if (this.readyState !== FakeWebSocket.CONNECTING) return;
    this.readyState = FakeWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(value: unknown) {
    const event = new Event("message") as Event & { data: string };
    Object.defineProperty(event, "data", { value: JSON.stringify(value) });
    this.dispatchEvent(event);
  }

  send(value: string) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket is not open");
    this.sent.push(String(value));
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    const event = new Event("close") as Event & { code: number; reason: string };
    Object.defineProperties(event, {
      code: { value: code },
      reason: { value: reason },
    });
    this.dispatchEvent(event);
  }
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");

beforeEach(() => {
  FakeWebSocket.instances = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: new BrowserWindow(),
  });
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { onLine: true },
  });
  const documentTarget = new EventTarget();
  Object.defineProperty(documentTarget, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentTarget,
  });
});

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
  if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
  else Reflect.deleteProperty(globalThis, "navigator");
  if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
  else Reflect.deleteProperty(globalThis, "document");
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function delayedJsonResponse(value: unknown, delayMs: number, status = 200) {
  return new Promise<Response>((resolve) => {
    setTimeout(() => resolve(jsonResponse(value, status)), delayMs);
  });
}

function serviceFetch() {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/multiplayer/config")) {
      return jsonResponse({
        enabled: true,
        protocolVersion: 1,
        realtimeOrigin: "https://realtime.example",
      });
    }
    if (url.includes("/v1/session")) {
      return jsonResponse({
        actorId: "actor-1",
        resumeToken: "resume-1",
        roomId: "field-1",
        wsUrl: "wss://realtime.example/v1/connect?ticket=one",
        capacity: 1_000,
        count: 0,
      });
    }
    return new Response(null, { status: 404 });
  };
}

function welcome(protocol = 1) {
  return {
    t: "welcome",
    protocol,
    selfId: "actor-1",
    roomId: "field-1",
    count: 12,
    capacity: 1_000,
    players: [
      {
        id: "actor-1",
        x: 0,
        z: 18,
        vx: 0,
        vz: 0,
        heading: 0,
        carrying: null,
        sleeping: false,
        profile: {
          name: "Tester",
          city: "Vancouver",
          countryCode: "CA",
          countryFlag: "🇨🇦",
          waitReason: "A smoke test",
        },
      },
    ],
    stones: [],
    serverTime: Date.now(),
  };
}

function createClient(
  statuses: RealtimeConnectionState[],
  errors: RealtimeError[] = [],
) {
  return new RealtimeClient({
    profile: {
      name: "Tester",
      city: "Vancouver",
      countryCode: "CA",
      waitReason: "A smoke test",
    },
    fetchImpl: serviceFetch() as typeof fetch,
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    onStatus: (status) => statuses.push(status.state),
    onError: (error) => errors.push(error),
  });
}

test("multiplayer config accepts only a usable realtime origin", async () => {
  const enabled = await loadMultiplayerConfig(
    "/config",
    (async () =>
      jsonResponse({
        enabled: true,
        protocolVersion: 1,
        realtimeOrigin: "https://realtime.example",
      })) as typeof fetch,
  );
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.realtimeOrigin, "https://realtime.example");

  const unsafe = await loadMultiplayerConfig(
    "/config",
    (async () =>
      jsonResponse({
        enabled: true,
        protocolVersion: 1,
        realtimeOrigin: "http://public.example",
      })) as typeof fetch,
  );
  assert.equal(unsafe.enabled, false);
  assert.equal(unsafe.reason, "not-configured");
});

test("a newer tab replacement is terminal and does not reconnect-loop", async () => {
  const statuses: RealtimeConnectionState[] = [];
  const client = createClient(statuses);
  await client.start();
  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message(welcome());
  assert.equal(client.status.state, "online");

  socket.close(4001, "replaced by a newer connection");
  assert.equal(client.status.state, "replaced");
  client.wake();
  await Promise.resolve();
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.equal(statuses.at(-1), "replaced");
  client.destroy();
});

test("actions flush the newest movement and protocol mismatch blocks the session", async () => {
  const statuses: RealtimeConnectionState[] = [];
  const errors: RealtimeError[] = [];
  const client = createClient(statuses, errors);
  await client.start();
  const socket = FakeWebSocket.instances[0];
  socket.open();
  socket.message(welcome());
  socket.sent.length = 0;

  client.sendMovement({ x: 1, z: 18, heading: 0, vx: 1, vz: 0 });
  client.sendMovement({ x: 2, z: 18, heading: 0, vx: 1, vz: 0 });
  assert.ok(client.pickup("stone-1"));
  assert.deepEqual(
    socket.sent.map((item) => JSON.parse(item).t),
    ["move", "move", "pickup"],
  );

  socket.message(welcome(99));
  assert.equal(client.status.state, "incompatible");
  assert.equal(errors.at(-1)?.recoverable, false);
  client.wake();
  await Promise.resolve();
  assert.equal(FakeWebSocket.instances.length, 1);
  client.destroy();
});

test("a hidden page sleeps immediately and wakes with a fresh ticket", async () => {
  const statuses: RealtimeConnectionState[] = [];
  const client = createClient(statuses);
  await client.start();
  const firstSocket = FakeWebSocket.instances[0];
  firstSocket.open();
  firstSocket.message(welcome());
  assert.equal(client.status.state, "online");

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(client.status.state, "offline");
  assert.equal(firstSocket.readyState, FakeWebSocket.CLOSED);

  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  });
  document.dispatchEvent(new Event("visibilitychange"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(FakeWebSocket.instances.length, 2);
  assert.equal(client.status.state, "connecting");
  client.destroy();
});

test("config and stale-resume recovery each receive a full HTTP timeout budget", async () => {
  window.localStorage.setItem(
    "waiting-pit-realtime-resume-v1",
    JSON.stringify({ actorId: "actor-old", resumeToken: "stale", roomId: "field-old" }),
  );
  let sessionRequests = 0;
  const errors: RealtimeError[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/api/multiplayer/config")) {
      return delayedJsonResponse(
        {
          enabled: true,
          protocolVersion: 1,
          realtimeOrigin: "https://realtime.example",
        },
        15,
      );
    }
    if (url.includes("/v1/session")) {
      sessionRequests += 1;
      const body = JSON.parse(String(init?.body ?? "{}")) as { resumeToken?: string };
      if (body.resumeToken) return delayedJsonResponse({ error: "invalid-resume-token" }, 15, 401);
      return delayedJsonResponse(
        {
          actorId: "actor-1",
          resumeToken: "resume-1",
          roomId: "field-1",
          wsUrl: "wss://realtime.example/v1/connect?ticket=one",
          capacity: 1_000,
          count: 0,
        },
        15,
      );
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const client = new RealtimeClient({
    profile: {
      name: "Tester",
      city: "Vancouver",
      countryCode: "CA",
      waitReason: "A smoke test",
    },
    fetchImpl,
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    requestTimeoutMs: 25,
    onError: (error) => errors.push(error),
  });

  await client.start();
  assert.equal(sessionRequests, 2);
  assert.equal(FakeWebSocket.instances.length, 1);
  assert.deepEqual(errors, []);
  client.destroy();
});

test("a rate-limited session honors Retry-After instead of retrying rapidly", async () => {
  const statuses: RealtimeStatus[] = [];
  const errors: RealtimeError[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/multiplayer/config")) {
      return jsonResponse({
        enabled: true,
        protocolVersion: 1,
        realtimeOrigin: "https://realtime.example",
      });
    }
    return new Response(JSON.stringify({ error: "rate-limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": "9" },
    });
  }) as typeof fetch;
  const client = new RealtimeClient({
    profile: {
      name: "Tester",
      city: "Vancouver",
      countryCode: "CA",
      waitReason: "A smoke test",
    },
    fetchImpl,
    webSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    onStatus: (status) => statuses.push(status),
    onError: (error) => errors.push(error),
  });

  await client.start();
  assert.equal(client.status.state, "offline");
  assert.match(client.status.reason ?? "", /busy/i);
  assert.ok((client.status.retryInMs ?? 0) >= 9_000);
  assert.equal(errors.at(-1)?.code, "session_rate_limited");
  assert.equal(statuses.at(-1)?.state, "offline");
  client.destroy();
});
