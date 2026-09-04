import assert from "node:assert/strict";
import test from "node:test";
import worker, {
  FieldRoom,
  Lobby,
  PitCoordinator,
  PitFanout,
} from "../src/index.ts";
import {
  FIELD_STONE_COUNT,
  MIN_NEAR_PIT_STONES,
  createInitialPitState,
  advancePitState,
  isPitState,
  getPitLayout,
  type PitState,
  isNearPitStonePosition,
} from "../../shared/world.ts";
import {
  ACTIVE_NEW_JOIN_LOBBY_SHARDS,
  LOBBY_SHARD_COUNT,
  isActiveNewJoinLobbyId,
  isLobbyId,
  legacyLobbyDirectoryForActor,
  lobbyDirectoryForActor,
} from "../src/sharding.ts";
import { SLEEP_RETENTION_MS } from "../src/domain.ts";
import { signToken, verifyToken } from "../src/tokens.ts";
import type { Env, ResumeClaims, StoredPlayer } from "../src/types.ts";

class MemoryStorage {
  readonly records = new Map<string, unknown>();
  alarm: number | null = null;
  failNextSetAlarm = false;
  private transactionQueue: Promise<unknown> = Promise.resolve();

  constructor(initial: Record<string, unknown> = {}) {
    for (const [key, value] of Object.entries(initial)) this.records.set(key, value);
  }

  async get<T>(key: string) {
    return this.records.get(key) as T | undefined;
  }

  async put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
    if (typeof keyOrEntries === "string") {
      this.records.set(keyOrEntries, value);
      return;
    }
    for (const [key, entry] of Object.entries(keyOrEntries)) this.records.set(key, entry);
  }

  async delete(keyOrKeys: string | string[]) {
    if (typeof keyOrKeys === "string") return this.records.delete(keyOrKeys);
    let deleted = 0;
    for (const key of keyOrKeys) if (this.records.delete(key)) deleted += 1;
    return deleted;
  }

  async list<T>(options: { prefix?: string; limit?: number } = {}) {
    const result = new Map<string, T>();
    for (const [key, value] of this.records) {
      if (options.prefix && !key.startsWith(options.prefix)) continue;
      result.set(key, value as T);
      if (options.limit && result.size >= options.limit) break;
    }
    return result;
  }

  async transaction<T>(closure: (transaction: DurableObjectTransaction) => Promise<T>) {
    const transaction: DurableObjectTransaction = {
      get: async <Value>(key: string) => this.records.get(key) as Value | undefined,
      put: async <Value>(key: string, value: Value) => {
        this.records.set(key, value);
      },
      delete: async (key: string) => this.records.delete(key),
    };
    const operation = this.transactionQueue.then(async () => {
      const before = structuredClone(this.records);
      try { return await closure(transaction); }
      catch (error) {
        this.records.clear();
        for (const [key, value] of before) this.records.set(key, value);
        throw error;
      }
    });
    this.transactionQueue = operation.catch(() => undefined);
    return operation;
  }

  async getAlarm() {
    return this.alarm;
  }

  async setAlarm(value: number | Date) {
    if (this.failNextSetAlarm) {
      this.failNextSetAlarm = false;
      throw new Error("simulated-alarm-write-failure");
    }
    this.alarm = value instanceof Date ? value.getTime() : value;
  }

  async deleteAlarm() {
    this.alarm = null;
  }
}

class MockState {
  readonly id = { toString: () => "test-object" };
  readonly waited: Promise<unknown>[] = [];
  ready: Promise<unknown> = Promise.resolve();
  autoResponse: unknown;

  constructor(
    readonly storage: MemoryStorage,
    readonly sockets: WebSocket[] = [],
  ) {}

  blockConcurrencyWhile<T>(callback: () => Promise<T>) {
    const pending = callback();
    this.ready = pending;
    return pending;
  }

  acceptWebSocket() {}

  getWebSockets() {
    return this.sockets;
  }

  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair) {
    this.autoResponse = pair;
  }

  waitUntil(promise: Promise<unknown>) {
    this.waited.push(promise);
  }

  async flushWaitUntil() {
    await Promise.all(this.waited);
  }
}

type StubFetch = (objectName: string, request: Request) => Promise<Response>;

function namespace<T = never>(fetch: StubFetch): DurableObjectNamespace<T> {
  return {
    idFromName(name) {
      return { toString: () => name };
    },
    get(id) {
      return {
        fetch: (input, init) => fetch(id.toString(), new Request(input, init)),
      };
    },
  };
}

function unusedNamespace(): DurableObjectNamespace<never> {
  return namespace(async () => new Response(null, { status: 500 }));
}

function envWith(overrides: Partial<Env>): Env {
  const unused = unusedNamespace();
  return {
    LOBBY: unused,
    ROOMS: unused,
    PIT: unused,
    PIT_FANOUT: unused,
    SESSION_SECRET: "test-only-secret-that-is-at-least-thirty-two-characters",
    ALLOWED_ORIGINS: "https://waitland.app",
    ...overrides,
  };
}

function uuid(index: number) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function actorsInSameDirectory(count: number) {
  const groups = new Map<string, string[]>();
  for (let index = 1; index < 100_000; index += 1) {
    const actorId = uuid(index);
    const directory = lobbyDirectoryForActor(actorId);
    const actors = groups.get(directory) || [];
    actors.push(actorId);
    if (actors.length === count) return actors;
    groups.set(directory, actors);
  }
  throw new Error("could-not-build-test-cohort");
}

function assignRequest(
  actorId: string,
  ticketNonce: string,
  directoryId = lobbyDirectoryForActor(actorId),
  preferredRoomId?: string,
) {
  return new Request("https://lobby/assign", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actorId, ticketNonce, directoryId, preferredRoomId }),
  });
}

async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 100 && !check(); attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(check(), true, "timed out waiting for asynchronous test state");
}

test("new actors share one deterministic packing directory", () => {
  assert.equal(ACTIVE_NEW_JOIN_LOBBY_SHARDS, 1);
  const directories = new Set<string>();
  for (let index = 1; index <= 100; index += 1) {
    const actorId = uuid(index);
    const first = lobbyDirectoryForActor(actorId);
    directories.add(first);
    assert.equal(lobbyDirectoryForActor(actorId), first);
    const shard = Number.parseInt(first.slice("directory-".length), 10);
    assert.ok(shard >= 0 && shard < LOBBY_SHARD_COUNT);
    assert.equal(isLobbyId(first), true);
  }
  assert.deepEqual([...directories], ["directory-0"]);

  assert.equal(isLobbyId("directory-0"), true);
  assert.equal(isLobbyId(`directory-${LOBBY_SHARD_COUNT - 1}`), true);
  assert.equal(isActiveNewJoinLobbyId("directory-0"), true);
  assert.equal(isActiveNewJoinLobbyId("directory-1"), false);
  for (const invalid of ["directory", "directory-00", "directory--1", `directory-${LOBBY_SHARD_COUNT}`]) {
    assert.equal(isLobbyId(invalid), false);
  }
});

test("fresh and resumed sessions preserve their owning allocator directory", async () => {
  const secret = "test-only-secret-that-is-at-least-thirty-two-characters";
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const freshRoomId = `field-${uuid(10_100)}`;
  const legacyRoomId = `field-${uuid(10_101)}`;
  const assignments: Array<{
    objectName: string;
    actorId: string;
    directoryId: string;
    preferredRoomId?: string;
  }> = [];
  const lobby = namespace(async (objectName, request) => {
    const input = (await request.json()) as {
      actorId: string;
      directoryId: string;
      preferredRoomId?: string;
    };
    assignments.push({ objectName, ...input });
    return Response.json({ roomId: input.preferredRoomId || freshRoomId });
  });
  const execution = {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext;
  const requestSession = (body: unknown) =>
    worker.fetch(
      new Request("https://realtime.example/v1/session", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://waitland.app",
        },
        body: JSON.stringify(body),
      }),
      envWith({ LOBBY: lobby, SESSION_SECRET: secret }),
      execution,
    );
  const profile = {
    name: "Traveler",
    city: "Somewhere",
    waitReason: "Waiting",
  };

  const freshResponse = await requestSession({ profile });
  assert.equal(freshResponse.status, 200);
  const fresh = (await freshResponse.json()) as {
    actorId: string;
    roomId: string;
    resumeToken: string;
  };
  assert.equal(assignments[0].objectName, "directory-0");
  assert.equal(assignments[0].directoryId, "directory-0");
  const freshClaims = await verifyToken<ResumeClaims>(
    fresh.resumeToken,
    "resume",
    secret,
    nowSeconds,
  );
  assert.equal(freshClaims?.directoryId, "directory-0");

  const resumedResponse = await requestSession({ profile, resumeToken: fresh.resumeToken });
  assert.equal(resumedResponse.status, 200);
  const resumed = (await resumedResponse.json()) as {
    roomId: string;
    resumeToken: string;
  };
  assert.equal(assignments[1].objectName, "directory-0");
  assert.equal(assignments[1].directoryId, "directory-0");
  assert.equal(assignments[1].preferredRoomId, fresh.roomId);
  assert.equal(resumed.roomId, fresh.roomId);

  const staleResponse = await requestSession({
    profile,
    resumeToken: "token-from-an-expired-session-secret",
  });
  assert.equal(staleResponse.status, 200);
  const stale = (await staleResponse.json()) as { actorId: string; roomId: string };
  assert.notEqual(stale.actorId, fresh.actorId);
  assert.equal(stale.roomId, freshRoomId);
  assert.equal(assignments[2].objectName, "directory-0");
  assert.equal(assignments[2].directoryId, "directory-0");
  assert.equal(assignments[2].preferredRoomId, undefined);

  let legacyActorId = uuid(10_200);
  while (legacyLobbyDirectoryForActor(legacyActorId) === "directory-0") {
    const next = Number.parseInt(legacyActorId.slice(-12), 16) + 1;
    legacyActorId = uuid(next);
  }
  const legacyDirectoryId = legacyLobbyDirectoryForActor(legacyActorId);
  const legacyToken = await signToken(
    {
      v: 1,
      kind: "resume",
      actorId: legacyActorId,
      roomId: legacyRoomId,
      iat: nowSeconds,
      exp: nowSeconds + 60,
    },
    secret,
  );
  const legacyResponse = await requestSession({ profile, resumeToken: legacyToken });
  assert.equal(legacyResponse.status, 200);
  const legacy = (await legacyResponse.json()) as { resumeToken: string; roomId: string };
  assert.equal(assignments[3].objectName, legacyDirectoryId);
  assert.equal(assignments[3].directoryId, legacyDirectoryId);
  assert.equal(assignments[3].preferredRoomId, legacyRoomId);
  assert.equal(legacy.roomId, legacyRoomId);
  const upgradedLegacyClaims = await verifyToken<ResumeClaims>(
    legacy.resumeToken,
    "resume",
    secret,
    nowSeconds,
  );
  assert.equal(upgradedLegacyClaims?.directoryId, legacyDirectoryId);

  const malformedDirectoryToken = await signToken(
    {
      v: 1,
      kind: "resume",
      actorId: uuid(10_300),
      roomId: `field-${uuid(10_301)}`,
      directoryId: "directory-99",
      iat: nowSeconds,
      exp: nowSeconds + 60,
    } as ResumeClaims,
    secret,
  );
  const malformedResponse = await requestSession({
    profile,
    resumeToken: malformedDirectoryToken,
  });
  assert.equal(malformedResponse.status, 401);
  assert.equal(assignments.length, 4);
});

test("readiness checks the required bindings and global pit", async () => {
  const pit = namespace(async (_name, request) => {
    assert.equal(new URL(request.url).pathname, "/state");
    return Response.json({ count: 12, capacity: 1_000 });
  });
  const execution = {
    waitUntil() {},
    passThroughOnException() {},
  } as ExecutionContext;
  const ready = await worker.fetch(
    new Request("https://realtime.example/ready"),
    envWith({ PIT: pit }),
    execution,
  );
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), {
    ok: true,
    protocol: 1,
    pit: { count: 12, capacity: 1_000 },
  });
  assert.equal(ready.headers.get("cache-control"), "no-store");

  const unavailable = await worker.fetch(
    new Request("https://realtime.example/ready"),
    envWith({ SESSION_SECRET: "short" }),
    execution,
  );
  assert.equal(unavailable.status, 503);
});

test("lobby enforces actor affinity and optimistically caps concurrent room claims", async () => {
  type PendingRoomCall = { roomId: string; resolve: (response: Response) => void };
  const pending: PendingRoomCall[] = [];
  const rooms = namespace(
    (roomId) => new Promise<Response>((resolve) => pending.push({ roomId, resolve })),
  );
  const state = new MockState(new MemoryStorage());
  const lobby = new Lobby(state as unknown as DurableObjectState, envWith({ ROOMS: rooms }));
  await state.ready;

  const actors = actorsInSameDirectory(65);
  const directoryId = lobbyDirectoryForActor(actors[0]);
  const wrongDirectory = "directory-1";
  const rejected = await lobby.fetch(assignRequest(actors[0], uuid(20_000), wrongDirectory));
  assert.equal(rejected.status, 400);
  assert.equal(pending.length, 0);

  const assignments = actors.map((actorId, index) =>
    lobby.fetch(assignRequest(actorId, uuid(30_000 + index), directoryId)),
  );
  await waitFor(() => pending.length === actors.length);

  const callsByRoom = new Map<string, PendingRoomCall[]>();
  for (const call of pending) {
    const calls = callsByRoom.get(call.roomId) || [];
    calls.push(call);
    callsByRoom.set(call.roomId, calls);
  }
  assert.deepEqual(
    [...callsByRoom.values()].map((calls) => calls.length).sort((left, right) => right - left),
    [64, 1],
  );

  for (const calls of callsByRoom.values()) {
    calls.forEach((call, index) => {
      call.resolve(Response.json({ ok: true, active: 0, reserved: index + 1, sleepers: 0 }));
    });
  }
  const responses = await Promise.all(assignments);
  assert.equal(responses.every((response) => response.ok), true);
  assert.equal(new Set(await Promise.all(responses.map(async (response) => (await response.json()).roomId))).size, 2);
  await state.flushWaitUntil();
});

test("lobby admits a preferred-room resume through a valid legacy directory", async () => {
  let actorId = uuid(35_000);
  while (legacyLobbyDirectoryForActor(actorId) === "directory-0") {
    actorId = uuid(Number.parseInt(actorId.slice(-12), 16) + 1);
  }
  const legacyDirectoryId = legacyLobbyDirectoryForActor(actorId);
  const preferredRoomId = `field-${uuid(35_100)}`;
  let reservation: Record<string, unknown> | undefined;
  const rooms = namespace(async (_roomId, request) => {
    reservation = (await request.json()) as Record<string, unknown>;
    return Response.json({ ok: true, active: 0, reserved: 1, sleepers: 1 });
  });
  const state = new MockState(new MemoryStorage());
  const lobby = new Lobby(state as unknown as DurableObjectState, envWith({ ROOMS: rooms }));
  await state.ready;

  const response = await lobby.fetch(
    assignRequest(actorId, uuid(35_200), legacyDirectoryId, preferredRoomId),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { roomId: preferredRoomId });
  assert.equal(reservation?.directoryId, legacyDirectoryId);
  assert.equal(reservation?.resume, true);
});

test("a failed provisional lobby claim is rolled back", async () => {
  const roomIds: string[] = [];
  const rooms = namespace(async (roomId) => {
    roomIds.push(roomId);
    if (roomIds.length === 1) throw new Error("simulated-room-failure");
    return Response.json({ ok: true, active: 0, reserved: 1, sleepers: 0 });
  });
  const state = new MockState(new MemoryStorage());
  const lobby = new Lobby(state as unknown as DurableObjectState, envWith({ ROOMS: rooms }));
  await state.ready;
  const [firstActor, secondActor] = actorsInSameDirectory(2);
  const directoryId = lobbyDirectoryForActor(firstActor);

  const failed = await lobby.fetch(assignRequest(firstActor, uuid(40_000), directoryId));
  assert.equal(failed.status, 503);
  const recovered = await lobby.fetch(assignRequest(secondActor, uuid(40_001), directoryId));
  assert.equal(recovered.status, 200);
  assert.equal(roomIds.length, 2);
  assert.notEqual(roomIds[0], roomIds[1]);
  await state.flushWaitUntil();
});

test("pit retries only failed fanout shards and persists the latest targets", async () => {
  const calls = new Map<string, number>();
  const fanout = namespace(async (shardName, request) => {
    assert.equal(new URL(request.url).pathname, "/pit-update");
    const attempt = (calls.get(shardName) || 0) + 1;
    calls.set(shardName, attempt);
    if (shardName === "fanout-7" && attempt === 1) {
      return Response.json({ error: "temporary" }, { status: 503 });
    }
    return Response.json({ ok: true });
  });
  const storage = new MemoryStorage({
    count: 0,
    "subscriber-shards": [3, 7],
  });
  const state = new MockState(storage);
  const coordinator = new PitCoordinator(
    state as unknown as DurableObjectState,
    envWith({ PIT_FANOUT: fanout }),
  );
  await state.ready;

  const deposit = await coordinator.fetch(new Request("https://pit/deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionKey: "field:test:stone-1:0" }),
  }));
  assert.equal(deposit.status, 200);
  assert.deepEqual(storage.records.get("pending-fanout-targets"), { "3": 1, "7": 1 });

  storage.alarm = null;
  await coordinator.alarm();
  assert.deepEqual(storage.records.get("pending-fanout-targets"), { "7": 1 });
  assert.equal(storage.records.get("fanout-retry-ms"), 2_000);
  assert.equal(calls.get("fanout-3"), 1);
  assert.equal(calls.get("fanout-7"), 1);

  storage.alarm = null;
  await coordinator.alarm();
  assert.deepEqual(storage.records.get("pending-fanout-targets"), {});
  assert.equal(storage.records.get("fanout-retry-ms"), 1_000);
  assert.equal(calls.get("fanout-3"), 1);
  assert.equal(calls.get("fanout-7"), 2);

  const secondDeposit = await coordinator.fetch(new Request("https://pit/deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionKey: "field:test:stone-2:0" }),
  }));
  assert.equal((await secondDeposit.json()).count, 2);
  const duplicateOldDeposit = await coordinator.fetch(new Request("https://pit/deposit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ actionKey: "field:test:stone-1:0" }),
  }));
  assert.equal((await duplicateOldDeposit.json()).count, 1);
  const currentState = await coordinator.fetch(new Request("https://pit/state"));
  assert.equal((await currentState.json()).count, 2);
  assert.deepEqual(storage.records.get("pending-fanout-targets"), { "3": 2, "7": 2 });
});

test("the final deposit atomically survives a crash before its fanout alarm", async () => {
  const delivered: Array<{ shard: string; count: number }> = [];
  const fanout = namespace(async (shard, request) => {
    assert.equal(new URL(request.url).pathname, "/pit-update");
    const update = (await request.json()) as { count: number };
    delivered.push({ shard, count: update.count });
    return Response.json({ ok: true });
  });
  const storage = new MemoryStorage({
    count: 99,
    "subscriber-shards": [3],
  });
  const firstState = new MockState(storage);
  const first = new PitCoordinator(
    firstState as unknown as DurableObjectState,
    envWith({ PIT_FANOUT: fanout }),
  );
  await firstState.ready;

  // Model the process disappearing after the transaction commits but before
  // setAlarm completes. Count, idempotency record, and target must already be
  // one atomic durable state at that point.
  storage.failNextSetAlarm = true;
  await assert.rejects(
    () => first.fetch(new Request("https://pit/deposit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actionKey: "field:test:stone-final:0" }),
    })),
    /simulated-alarm-write-failure/,
  );
  assert.equal(storage.records.get("count"), 0);
  assert.equal((storage.records.get("pit-state") as PitState).round, 2);
  assert.equal((storage.records.get("monument:1") as { stoneCount: number }).stoneCount, 100);
  assert.deepEqual(storage.records.get("deposit:field:test:stone-final:0"), { count: 0 });
  assert.deepEqual(storage.records.get("pending-fanout-targets"), { "3": 100 });

  // A fresh isolate reconstructs the pending target, arms the alarm, and
  // delivers the otherwise 100th deposit and the next excavation without another deposit.
  const recoveredState = new MockState(storage);
  const recovered = new PitCoordinator(
    recoveredState as unknown as DurableObjectState,
    envWith({ PIT_FANOUT: fanout }),
  );
  await recoveredState.ready;
  assert.ok(storage.alarm !== null);
  await recovered.alarm();
  assert.deepEqual(delivered, [{ shard: "fanout-3", count: 0 }]);
  assert.deepEqual(storage.records.get("pending-fanout-targets"), {});
});

test("field rooms register hibernatable heartbeats and reject new actors at the sleeper soft limit", async () => {
  class AutoResponsePair {
    constructor(
      readonly request: string | ArrayBuffer,
      readonly response: string | ArrayBuffer,
    ) {}
  }
  Object.defineProperty(globalThis, "WebSocketRequestResponsePair", {
    configurable: true,
    value: AutoResponsePair,
  });

  const actorId = uuid(90_000);
  const roomId = `field-${uuid(90_001)}`;
  const directoryId = lobbyDirectoryForActor(actorId);
  const initial: Record<string, unknown> = {
    "room-id": roomId,
    "directory-id": directoryId,
    "pit-count": 12,
  };
  const now = Date.now();
  for (let index = 0; index < 1_024; index += 1) {
    const sleeperId = uuid(91_000 + index);
    const sleeper: StoredPlayer = {
      id: sleeperId,
      x: 10,
      z: 10,
      vx: 0,
      vz: 0,
      heading: 0,
      carrying: null,
      sleeping: true,
      profile: {
        name: "Sleeper",
        city: "Somewhere",
        countryCode: "XX",
        countryFlag: "🌍",
        waitReason: "Waiting",
      },
      lastMoveAt: now,
      lastSeenAt: now,
      lastSeq: -1,
      actionHistory: [],
    };
    initial[`player:${sleeperId}`] = sleeper;
  }

  const state = new MockState(new MemoryStorage(initial));
  const room = new FieldRoom(state as unknown as DurableObjectState, envWith({}));
  await state.ready;
  const pair = state.autoResponse as AutoResponsePair;
  assert.equal(pair.request, '{"t":"ping"}');
  assert.equal(pair.response, '{"t":"pong"}');

  const stalePitUpdate = await room.fetch(new Request("https://room/pit-update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ count: 8, capacity: 1_000 }),
  }));
  assert.equal(stalePitUpdate.status, 200);
  await state.flushWaitUntil();
  assert.equal(state.storage.records.get("pit-count"), 12);

  const response = await room.fetch(new Request("https://room/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      roomId,
      actorId,
      directoryId,
      nonce: uuid(95_000),
      resume: false,
    }),
  }));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).reason, "room-sleeper-limit");
});

test("field initialization repairs a fixed stone pool and keeps ten available near the pit", async () => {
  const initial: Record<string, unknown> = {};
  for (let index = 0; index < FIELD_STONE_COUNT; index += 1) {
    initial[`stone:stone-${index}`] = {
      id: `stone-${index}`,
      x: 2_000 + index,
      z: -2_000,
      generation: 0,
      holderId: null,
    };
  }
  const state = new MockState(new MemoryStorage(initial));
  new FieldRoom(state as unknown as DurableObjectState, envWith({}));
  await state.ready;

  const storedStones = [...state.storage.records.entries()]
    .filter(([key]) => key.startsWith("stone:"))
    .map(([, value]) => value as { x: number; z: number; holderId: string | null });
  assert.equal(storedStones.length, FIELD_STONE_COUNT);
  assert.ok(
    storedStones.filter(
      (stone) => !stone.holderId && isNearPitStonePosition(stone.x, stone.z),
    ).length >= MIN_NEAR_PIT_STONES,
  );
});

test("picking up the tenth nearby stone immediately replenishes the fixed pool", async () => {
  const actorId = uuid(95_050);
  const connectionId = uuid(95_051);
  const now = Date.now();
  const nearbyStoneId = "stone-0";
  const player: StoredPlayer = {
    id: actorId,
    x: 8,
    z: 0,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: null,
    sleeping: false,
    profile: {
      name: "Collector",
      city: "Somewhere",
      countryCode: "XX",
      countryFlag: "🌍",
      waitReason: "Waiting",
    },
    lastMoveAt: now,
    lastSeenAt: now,
    lastSeq: -1,
    actionHistory: [],
  };
  const initial: Record<string, unknown> = {
    "room-id": `field-${uuid(95_052)}`,
    [`player:${actorId}`]: player,
  };
  for (let index = 0; index < FIELD_STONE_COUNT; index += 1) {
    initial[`stone:stone-${index}`] = {
      id: `stone-${index}`,
      x: index < MIN_NEAR_PIT_STONES ? 8 + index * 0.8 : 2_000 + index,
      z: index < MIN_NEAR_PIT_STONES ? 0 : -2_000,
      generation: 0,
      holderId: null,
    };
  }

  const messages: Array<Record<string, unknown>> = [];
  const socket = {
    deserializeAttachment: () => ({ actorId, connectionId }),
    send: (message: string) => messages.push(JSON.parse(message) as Record<string, unknown>),
  } as unknown as WebSocket;
  const state = new MockState(new MemoryStorage(initial), [socket]);
  const room = new FieldRoom(state as unknown as DurableObjectState, envWith({}));
  await state.ready;

  await room.webSocketMessage(
    socket,
    JSON.stringify({ t: "pickup", id: "pickup-tenth-nearby", stoneId: nearbyStoneId }),
  );

  const storedStones = [...state.storage.records.entries()]
    .filter(([key]) => key.startsWith("stone:"))
    .map(
      ([, value]) =>
        value as {
          id: string;
          x: number;
          z: number;
          generation: number;
          holderId: string | null;
        },
    );
  const nearbyAvailable = storedStones.filter(
    (stone) => !stone.holderId && isNearPitStonePosition(stone.x, stone.z),
  );
  assert.equal(storedStones.length, FIELD_STONE_COUNT);
  assert.equal(nearbyAvailable.length, MIN_NEAR_PIT_STONES);
  assert.equal(
    (state.storage.records.get(`stone:${nearbyStoneId}`) as { holderId: string | null }).holderId,
    actorId,
  );
  assert.equal(
    (state.storage.records.get(`player:${actorId}`) as StoredPlayer).carrying,
    nearbyStoneId,
  );

  const replenished = nearbyAvailable.find((stone) => stone.generation > 0);
  assert.ok(replenished);
  const stoneMessages = messages.filter((message) => message.t === "stone");
  assert.ok(
    stoneMessages.some(
      (message) =>
        (message.stone as { id?: string } | undefined)?.id === replenished.id,
    ),
  );
  const actionMessageIndex = messages.findIndex(
    (message) => message.t === "action" && message.id === "pickup-tenth-nearby",
  );
  const replenishedMessageIndex = messages.findIndex(
    (message) =>
      message.t === "stone" &&
      (message.stone as { id?: string } | undefined)?.id === replenished.id,
  );
  assert.ok(replenishedMessageIndex >= 0);
  assert.ok(actionMessageIndex > replenishedMessageIndex);
});

test("a failed delayed throw keeps ownership and can be retried without losing the stone", async () => {
  const actorId = uuid(95_100);
  const connectionId = uuid(95_101);
  const now = Date.now();
  const carriedStoneId = "stone-0";
  const storedPlayer: StoredPlayer = {
    id: actorId,
    x: 10,
    z: 0,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: carriedStoneId,
    sleeping: false,
    profile: {
      name: "Thrower",
      city: "Somewhere",
      countryCode: "XX",
      countryFlag: "🌍",
      waitReason: "Waiting",
    },
    lastMoveAt: now,
    lastSeenAt: now,
    lastSeq: -1,
    actionHistory: [],
  };
  const messages: Array<Record<string, unknown>> = [];
  const socket = {
    deserializeAttachment: () => ({ actorId, connectionId }),
    send: (message: string) => messages.push(JSON.parse(message) as Record<string, unknown>),
  } as unknown as WebSocket;
  const storage = new MemoryStorage({
    "room-id": `field-${uuid(95_102)}`,
    [`player:${actorId}`]: storedPlayer,
    [`stone:${carriedStoneId}`]: {
      id: carriedStoneId,
      x: storedPlayer.x,
      z: storedPlayer.z,
      generation: 0,
      holderId: actorId,
    },
  });
  let markDepositStarted: (() => void) | undefined;
  const depositStarted = new Promise<void>((resolve) => {
    markDepositStarted = resolve;
  });
  let finishDeposit: ((response: Response) => void) | undefined;
  const pit = namespace(async (_name, request) => {
    assert.equal(new URL(request.url).pathname, "/deposit");
    markDepositStarted?.();
    return new Promise<Response>((resolve) => {
      finishDeposit = resolve;
    });
  });
  const state = new MockState(storage, [socket]);
  const room = new FieldRoom(
    state as unknown as DurableObjectState,
    envWith({ PIT: pit }),
  );
  await state.ready;

  const actionId = "delayed-throw";
  const throwing = room.webSocketMessage(
    socket,
    JSON.stringify({ t: "throw", id: actionId, stoneId: carriedStoneId }),
  );
  await depositStarted;
  await room.webSocketMessage(
    socket,
    JSON.stringify({ t: "move", seq: 0, x: 10, z: 0, heading: Math.PI }),
  );
  assert.ok(finishDeposit);
  finishDeposit(Response.json({ accepted: false, count: 1_000 }));
  await throwing;

  const action = messages.find((message) => message.t === "action" && message.id === actionId);
  assert.equal(action?.ok, false);
  assert.equal(action?.reason, "pit-unavailable");
  assert.equal((storage.records.get(`player:${actorId}`) as StoredPlayer).carrying, carriedStoneId);
  assert.equal((storage.records.get(`stone:${carriedStoneId}`) as { holderId: string }).holderId, actorId);
  assert.equal((storage.records.get(`player:${actorId}`) as StoredPlayer).actionHistory.some((entry) => entry.id === actionId), false);
});

test("a dormant field room expires sleepers on its alarm and schedules the next retention deadline", async () => {
  const baseNow = Date.now();
  const expiredSoonId = uuid(96_000);
  const futureSleeperId = uuid(96_001);
  const roomId = `field-${uuid(96_002)}`;
  const directoryId = lobbyDirectoryForActor(expiredSoonId);
  const profile = {
    name: "Sleeper",
    city: "Somewhere",
    countryCode: "XX",
    countryFlag: "🌍",
    waitReason: "Waiting",
  };
  const player = (id: string, lastSeenAt: number): StoredPlayer => ({
    id,
    x: 10,
    z: 10,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: null,
    sleeping: true,
    profile,
    lastMoveAt: lastSeenAt,
    lastSeenAt,
    lastSeq: -1,
    actionHistory: [],
  });
  const storage = new MemoryStorage({
    "room-id": roomId,
    "directory-id": directoryId,
    "pit-count": 12,
    [`player:${expiredSoonId}`]: player(
      expiredSoonId,
      baseNow - SLEEP_RETENTION_MS + 10_000,
    ),
    [`player:${futureSleeperId}`]: player(futureSleeperId, baseNow),
  });
  const reports: Array<{ roomId: string; active: number; reserved: number; sleepers: number }> = [];
  const lobby = namespace(async (_name, request) => {
    assert.equal(new URL(request.url).pathname, "/report");
    reports.push(
      (await request.json()) as {
        roomId: string;
        active: number;
        reserved: number;
        sleepers: number;
      },
    );
    return Response.json({ ok: true });
  });
  const state = new MockState(storage);
  new FieldRoom(state as unknown as DurableObjectState, envWith({ LOBBY: lobby }));
  await state.ready;
  assert.equal(storage.alarm, baseNow + 10_000);

  let wakeState: MockState | undefined;
  const originalNow = Date.now;
  try {
    Date.now = () => baseNow + 10_000;
    storage.alarm = null; // Cloudflare clears the fired alarm before the handler runs.
    // Alarm delivery reconstructs the Durable Object first. The constructor can
    // therefore perform the actual expiry before alarm() is invoked.
    wakeState = new MockState(storage);
    const wokenRoom = new FieldRoom(
      wakeState as unknown as DurableObjectState,
      envWith({ LOBBY: lobby }),
    );
    await wakeState.ready;
    await wokenRoom.alarm();
  } finally {
    Date.now = originalNow;
  }
  assert.ok(wakeState);
  await wakeState.flushWaitUntil();

  assert.equal(storage.records.has(`player:${expiredSoonId}`), false);
  assert.equal(storage.records.has(`player:${futureSleeperId}`), true);
  assert.equal(storage.alarm, baseNow + SLEEP_RETENTION_MS);
  assert.deepEqual(reports, [{ roomId, active: 0, reserved: 0, sleepers: 1 }]);
});

test("the shared field-room alarm keeps pit retries ahead of later sleeper cleanup", async () => {
  const baseNow = Date.now();
  const activeActorId = uuid(97_000);
  const sleeperId = uuid(97_001);
  const roomId = `field-${uuid(97_002)}`;
  const directoryId = lobbyDirectoryForActor(activeActorId);
  const profile = {
    name: "Traveler",
    city: "Somewhere",
    countryCode: "XX",
    countryFlag: "🌍",
    waitReason: "Waiting",
  };
  const player = (id: string, sleeping: boolean): StoredPlayer => ({
    id,
    x: 10,
    z: 10,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: null,
    sleeping,
    profile,
    lastMoveAt: baseNow,
    lastSeenAt: baseNow,
    lastSeq: -1,
    actionHistory: [],
  });
  const storage = new MemoryStorage({
    "room-id": roomId,
    "directory-id": directoryId,
    "pit-count": 12,
    "pit-retry-at": baseNow + 5_000,
    "pit-retry-ms": 2_000,
    [`player:${activeActorId}`]: player(activeActorId, false),
    [`player:${sleeperId}`]: player(sleeperId, true),
  });
  const connectionId = uuid(97_003);
  const socket = {
    deserializeAttachment: () => ({ actorId: activeActorId, connectionId }),
  } as unknown as WebSocket;
  let pitSubscribeCalls = 0;
  const pit = namespace(async (_name, request) => {
    assert.equal(new URL(request.url).pathname, "/subscribe");
    pitSubscribeCalls += 1;
    return Response.json({ error: "temporary" }, { status: 503 });
  });
  const state = new MockState(storage, [socket]);
  const room = new FieldRoom(state as unknown as DurableObjectState, envWith({ PIT: pit }));
  await state.ready;
  assert.equal(storage.alarm, baseNow + 5_000);

  const retryNow = baseNow + 5_000;
  const originalNow = Date.now;
  try {
    Date.now = () => retryNow;
    storage.alarm = null;
    await room.alarm();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(pitSubscribeCalls, 1);
  assert.equal(storage.alarm, retryNow + 2_000);
  assert.equal(storage.records.has(`player:${sleeperId}`), true);
});

test("a sleeper alarm cannot run a later durable pit retry early or reset its backoff", async () => {
  const baseNow = Date.now();
  const actorId = uuid(97_100);
  const sleeperId = uuid(97_101);
  const connectionId = uuid(97_102);
  const roomId = `field-${uuid(97_103)}`;
  const directoryId = lobbyDirectoryForActor(actorId);
  const profile = {
    name: "Traveler",
    city: "Somewhere",
    countryCode: "XX",
    countryFlag: "🌍",
    waitReason: "Waiting",
  };
  const player = (id: string, sleeping: boolean, lastSeenAt: number): StoredPlayer => ({
    id,
    x: 10,
    z: 10,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: null,
    sleeping,
    profile,
    lastMoveAt: lastSeenAt,
    lastSeenAt,
    lastSeq: -1,
    actionHistory: [],
  });
  const retryAt = baseNow + 10_000;
  const storage = new MemoryStorage({
    "room-id": roomId,
    "directory-id": directoryId,
    "pit-count": 12,
    "pit-retry-at": retryAt,
    "pit-retry-ms": 2_000,
    [`player:${actorId}`]: player(actorId, false, baseNow),
    [`player:${sleeperId}`]: player(
      sleeperId,
      true,
      baseNow - SLEEP_RETENTION_MS + 5_000,
    ),
  });
  const socket = {
    deserializeAttachment: () => ({ actorId, connectionId }),
  } as unknown as WebSocket;
  let pitSubscribeCalls = 0;
  const pit = namespace(async (_name, request) => {
    assert.equal(new URL(request.url).pathname, "/subscribe");
    pitSubscribeCalls += 1;
    return Response.json({ error: "temporary" }, { status: 503 });
  });
  const env = envWith({ PIT: pit });

  const initialState = new MockState(storage, [socket]);
  new FieldRoom(initialState as unknown as DurableObjectState, env);
  await initialState.ready;
  assert.equal(storage.alarm, baseNow + 5_000);

  const originalNow = Date.now;
  try {
    Date.now = () => baseNow + 5_000;
    storage.alarm = null;
    const sleeperWakeState = new MockState(storage, [socket]);
    const sleeperWakeRoom = new FieldRoom(
      sleeperWakeState as unknown as DurableObjectState,
      env,
    );
    await sleeperWakeState.ready;
    await sleeperWakeRoom.alarm();
    assert.equal(pitSubscribeCalls, 0);
    assert.equal(storage.alarm, retryAt);

    Date.now = () => retryAt;
    storage.alarm = null;
    const retryWakeState = new MockState(storage, [socket]);
    const retryWakeRoom = new FieldRoom(
      retryWakeState as unknown as DurableObjectState,
      env,
    );
    await retryWakeState.ready;
    await retryWakeRoom.alarm();
  } finally {
    Date.now = originalNow;
  }

  assert.equal(pitSubscribeCalls, 1);
  assert.equal(storage.alarm, retryAt + 2_000);
  assert.equal(storage.records.get("pit-retry-at"), retryAt + 2_000);
  assert.equal(storage.records.get("pit-retry-ms"), 4_000);
});

test("a last-player disconnect during pit subscribe removes the raced subscription", async () => {
  const now = Date.now();
  const actorId = uuid(98_000);
  const connectionId = uuid(98_001);
  const roomId = `field-${uuid(98_002)}`;
  const directoryId = lobbyDirectoryForActor(actorId);
  const player: StoredPlayer = {
    id: actorId,
    x: 10,
    z: 10,
    vx: 0,
    vz: 0,
    heading: 0,
    carrying: null,
    sleeping: false,
    profile: {
      name: "Traveler",
      city: "Somewhere",
      countryCode: "XX",
      countryFlag: "🌍",
      waitReason: "Waiting",
    },
    lastMoveAt: now,
    lastSeenAt: now,
    lastSeq: -1,
    actionHistory: [],
  };
  const storage = new MemoryStorage({
    "room-id": roomId,
    "directory-id": directoryId,
    "pit-count": 12,
    "pit-retry-at": now,
    "pit-retry-ms": 2_000,
    [`player:${actorId}`]: player,
  });
  const socketMessages: string[] = [];
  const socket = {
    deserializeAttachment: () => ({ actorId, connectionId }),
    send: (message: string) => socketMessages.push(message),
  } as unknown as WebSocket;

  let markSubscribeStarted: (() => void) | undefined;
  const subscribeStarted = new Promise<void>((resolve) => {
    markSubscribeStarted = resolve;
  });
  let finishSubscribe: ((response: Response) => void) | undefined;
  let unsubscribeCalls = 0;
  const pit = namespace(async (_name, request) => {
    const path = new URL(request.url).pathname;
    if (path === "/subscribe") {
      markSubscribeStarted?.();
      return new Promise<Response>((resolve) => {
        finishSubscribe = resolve;
      });
    }
    assert.equal(path, "/unsubscribe");
    unsubscribeCalls += 1;
    return Response.json({ ok: true });
  });
  const state = new MockState(storage, [socket]);
  const room = new FieldRoom(state as unknown as DurableObjectState, envWith({ PIT: pit }));
  await state.ready;

  const alarm = room.alarm();
  await subscribeStarted;
  await room.webSocketClose(socket);
  assert.ok(finishSubscribe);
  finishSubscribe(Response.json({ count: 12, capacity: 1_000 }));
  await alarm;

  assert.equal(unsubscribeCalls, 1);
  assert.equal((storage.records.get(`player:${actorId}`) as StoredPlayer).sleeping, true);
  assert.deepEqual(
    socketMessages.map((message) => JSON.parse(message)),
    [{ t: "player_leave", playerId: actorId }],
  );
});


test("concurrent deposits roll over exactly once and old retries preserve the current pit", async () => {
  const storage = new MemoryStorage({ count: 99 });
  const state = new MockState(storage);
  const coordinator = new PitCoordinator(state as unknown as DurableObjectState, envWith({}));
  await state.ready;
  const deposit = (key: string) => coordinator.fetch(new Request("https://pit/deposit", {
    method: "POST", body: JSON.stringify({ actionKey: key }),
  })).then((response) => response.json() as Promise<{ count: number; duplicate: boolean; pit: PitState }>);
  const results = await Promise.all(Array.from({ length: 12 }, (_, index) => deposit(`race-${index}`)));
  assert.equal(results.filter((result) => result.pit.count === 0).length, 1);
  const current = await coordinator.fetch(new Request("https://pit/state")).then((response) => response.json() as Promise<PitState>);
  assert.equal(current.round, 2);
  assert.equal(current.count, 11);
  assert.equal(current.totalStones, 111);
  assert.equal(current.monuments.length, 1);
  assert.equal(isPitState(current), true);
  const retry = await deposit("race-0");
  assert.equal(retry.duplicate, true);
  assert.equal(retry.pit.totalStones, 111);
  assert.equal(retry.pit.round, 2);
  assert.equal([...storage.records.keys()].filter((key) => key.startsWith("monument:")).length, 1);
});

test("legacy deposits migrate without loss and the coordinator restores all monument metadata", async () => {
  const storage = new MemoryStorage({ count: 999 });
  const firstState = new MockState(storage);
  const first = new PitCoordinator(firstState as unknown as DurableObjectState, envWith({}));
  await firstState.ready;
  const firstPit = await first.fetch(new Request("https://pit/state")).then((response) => response.json() as Promise<PitState>);
  assert.equal(firstPit.round, 4);
  assert.equal(firstPit.count, 399);
  assert.equal(firstPit.totalStones, 999);
  assert.equal(firstPit.monuments.length, 3);
  const secondState = new MockState(storage);
  const second = new PitCoordinator(secondState as unknown as DurableObjectState, envWith({}));
  await secondState.ready;
  const restored = await second.fetch(new Request("https://pit/state")).then((response) => response.json());
  assert.deepEqual(restored, firstPit);
});

test("fanout keeps active room subscriptions after a monument is completed", async () => {
  const roomId = `field-${uuid(97_000)}`;
  const storage = new MemoryStorage({ [`room:${roomId}`]: Date.now() });
  const state = new MockState(storage);
  let deliveries = 0;
  const rooms = namespace(async () => { deliveries += 1; return Response.json({ active: 2 }); });
  const fanout = new PitFanout(state as unknown as DurableObjectState, envWith({ ROOMS: rooms }));
  await state.ready;
  let pit = { ...createInitialPitState(), count: 99, totalStones: 99 };
  pit = advancePitState(pit);
  for (let index = 0; index < 2; index += 1) {
    const response = await fanout.fetch(new Request("https://fanout/pit-update", {
      method: "POST", body: JSON.stringify({ count: pit.count, capacity: pit.capacity, pit }),
    }));
    assert.equal(response.status, 200);
    pit = advancePitState(pit);
  }
  assert.equal(deliveries, 2);
  assert.equal(storage.records.has(`room:${roomId}`), true);
});

test("room rollover moves the stone supply and corrects visitors inside the new excavation", async () => {
  const actorId = uuid(97_100);
  const connectionId = uuid(97_101);
  const nextLayout = getPitLayout(2);
  const now = Date.now();
  const player: StoredPlayer = {
    id: actorId, x: nextLayout.center.x, z: nextLayout.center.z, vx: 0, vz: 0, heading: 0,
    carrying: null, sleeping: false,
    profile: { name: "", city: "", countryCode: "", countryFlag: "", waitReason: "A friend" },
    lastMoveAt: now, lastSeenAt: now, lastSeq: -1, actionHistory: [],
  };
  const messages: Array<Record<string, unknown>> = [];
  const socket = {
    deserializeAttachment: () => ({ actorId, connectionId }),
    send: (message: string) => messages.push(JSON.parse(message) as Record<string, unknown>),
  } as unknown as WebSocket;
  const before = { ...createInitialPitState(now), count: 99, totalStones: 99 };
  const storage = new MemoryStorage({ "pit-state": before, [`player:${actorId}`]: player });
  const state = new MockState(storage, [socket]);
  const room = new FieldRoom(state as unknown as DurableObjectState, envWith({}));
  await state.ready;
  const next = advancePitState(before, now + 100);
  await room.fetch(new Request("https://room/pit-update", { method: "POST", body: JSON.stringify({ ...next, pit: next }) }));
  const stored = storage.records.get(`player:${actorId}`) as StoredPlayer;
  assert.ok(Math.hypot(stored.x - next.center.x, stored.z - next.center.z) >= next.wallRadius);
  const stones = [...storage.records.entries()].filter(([key]) => key.startsWith("stone:")).map(([, stone]) => stone as { x: number; z: number });
  assert.equal(stones.length, FIELD_STONE_COUNT);
  assert.ok(stones.filter((stone) => isNearPitStonePosition(stone.x, stone.z, next)).length >= MIN_NEAR_PIT_STONES);
  // A delayed old-round fanout must never resurrect the previous pit.
  await room.fetch(new Request("https://room/pit-update", { method: "POST", body: JSON.stringify({ ...before, pit: before }) }));
  assert.equal((storage.records.get("pit-state") as PitState).round, 2);
  assert.ok(messages.some((message) => message.t === "pit" && (message.pit as PitState).round === 2));
});


test("normal gameplay dedupe stays bounded per stone and retains legacy replay safety", async () => {
  const roomId = `field-${uuid(98_000)}`;
  const storage = new MemoryStorage({ count: 1, [`deposit:${roomId}:stone-0:0`]: { count: 1 } });
  const state = new MockState(storage);
  const coordinator = new PitCoordinator(state as unknown as DurableObjectState, envWith({}));
  await state.ready;
  const deposit = (generation: number) => coordinator.fetch(new Request("https://pit/deposit", {
    method: "POST", body: JSON.stringify({ actionKey: `${roomId}:stone-0:${generation}` }),
  })).then((response) => response.json() as Promise<{ duplicate: boolean; pit: PitState }>);
  assert.equal((await deposit(0)).duplicate, true);
  for (let generation = 1; generation <= 20; generation += 1) assert.equal((await deposit(generation)).duplicate, false);
  const staleRetry = await deposit(4);
  assert.equal(staleRetry.duplicate, true);
  assert.equal(staleRetry.pit.totalStones, 21);
  assert.equal([...storage.records.keys()].filter((key) => key.startsWith("deposit-latest:")).length, 1);
  assert.equal([...storage.records.keys()].filter((key) => key.startsWith("deposit:")).length, 1);
});
