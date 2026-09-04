import { DurableObject } from "cloudflare:workers";
import {
  FIELD_STONE_COUNT,
  MIN_NEAR_PIT_STONES,
  PIT_CAPACITY,
  PICKUP_RADIUS,
  WORLD_PROTOCOL_VERSION,
  advancePitState,
  clampPositionOutsidePit,
  createInitialPitState,
  isPitState,
  migrateLegacyPitState,
  type PitState,
  getNextNearbyStoneGeneration,
  getForwardStonePosition,
  getStoneDescriptor,
  headingTowardPit,
  isNearPitStonePosition,
  parseStoneIndex,
} from "../../shared/world.ts";
import {
  ACTION_HISTORY_LIMIT,
  SLEEP_RETENTION_MS,
  TokenBucket,
  movementCreditCapacity,
  publicPlayer,
  replenishedMovementCredit,
  safeSpawn,
  sanitizeActionId,
  sanitizeChat,
  sanitizeProfile,
  validateMovement,
} from "./domain.ts";
import { isActorId, isRoomId } from "./ids.ts";
import {
  isActiveNewJoinLobbyId,
  isLobbyId,
  legacyLobbyDirectoryForActor,
  lobbyDirectoryForActor,
  stableShard,
} from "./sharding.ts";
import { decodeInternalJson, encodeInternalJson, signToken, verifyToken } from "./tokens.ts";
import type {
  ActionResult,
  ClientMessage,
  MoveMessage,
  PublicProfile,
  ResumeClaims,
  StoneState,
  StoredPlayer,
  TicketClaims,
} from "./types.ts";

const ROOM_ACTIVE_LIMIT = 64;
const RESUME_OVERFLOW = 4;
const RESERVATION_TTL_MS = 75_000;
const RESUME_TTL_SECONDS = 7 * 24 * 60 * 60;
const TICKET_TTL_SECONDS = 60;
const FRAME_INTERVAL_MS = 80;
const MOVEMENT_PERSIST_INTERVAL_MS = 2_000;
const CHAT_RADIUS = 26;
const ROOM_SLEEPER_SOFT_LIMIT = 1_024;
const ROOM_SLEEPER_HARD_LIMIT = 2_048;
const PIT_FANOUT_SHARDS = 32;
const ROOM_HINT_TTL_MS = 30 * 60 * 1_000;
const MAX_ROOM_HINTS_PER_LOBBY = 2_048;
const MAX_SOCKET_MESSAGE_BYTES = 2_048;
const MAX_SESSION_BODY_BYTES = 2_048;
const MAX_QUEUED_ACTIONS = 128;
const HEARTBEAT_REQUEST = '{"t":"ping"}';
const HEARTBEAT_RESPONSE = '{"t":"pong"}';

type SocketAttachment = { actorId: string; connectionId: string };
type CloudflareServerWebSocket = WebSocket;
type Reservation = { expiresAt: number; resume: boolean; nonce: string };
type ReservationStore = Record<string, Reservation>;
type RoomHint = { active: number; reserved: number; sleepers: number; updatedAt: number };
type OptimisticRoomState = { baseOccupancy: number; claims: number; inFlight: number };
type FanoutTargetStore = Record<string, number>;

function json(value: unknown, status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

async function deleteStorageKeys(storage: DurableObjectStorage, keys: string[]) {
  for (let offset = 0; offset < keys.length; offset += 128) {
    await storage.delete(keys.slice(offset, offset + 128));
  }
}

async function putStorageRecords(
  storage: DurableObjectStorage,
  records: Record<string, unknown>,
) {
  const entries = Object.entries(records);
  for (let offset = 0; offset < entries.length; offset += 128) {
    await storage.put(Object.fromEntries(entries.slice(offset, offset + 128)));
  }
}

async function parseJsonBody(request: Request, maximumBytes: number) {
  const declaredLength = Number(request.headers.get("content-length") || "0");
  if (declaredLength > maximumBytes) throw new Error("body-too-large");
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > maximumBytes) throw new Error("body-too-large");
  return JSON.parse(raw) as unknown;
}

function allowedOrigins(env: Env) {
  return new Set(
    (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function corsHeaders(request: Request, env: Env): Record<string, string> | null {
  const origin = request.headers.get("origin");
  if (!origin) return { vary: "Origin" };
  if (!allowedOrigins(env).has(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
}

function websocketUrl(request: Request, ticket: string) {
  const url = new URL(request.url);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/v1/connect";
  url.search = `?ticket=${encodeURIComponent(ticket)}`;
  return url.toString();
}

async function pitState(env: Env) {
  const stub = env.PIT.get(env.PIT.idFromName("global-pit"));
  const response = await stub.fetch("https://pit/state");
  if (!response.ok) throw new Error("pit-unavailable");
  return (await response.json()) as { count: number; capacity: number };
}

async function createSession(request: Request, env: Env, cors: HeadersInit) {
  let input: Record<string, unknown>;
  try {
    const parsed = await parseJsonBody(request, MAX_SESSION_BODY_BYTES);
    if (!parsed || typeof parsed !== "object") throw new Error("invalid-body");
    input = parsed as Record<string, unknown>;
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid-body";
    return json({ error: code }, code === "body-too-large" ? 413 : 400, cors);
  }

  const profile = sanitizeProfile(input.profile);
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const ticketNonce = crypto.randomUUID();
  let actorId: string = crypto.randomUUID();
  let preferredRoomId: string | undefined;
  let directoryId: string | undefined;

  if (input.resumeToken !== undefined) {
    if (typeof input.resumeToken !== "string") return json({ error: "invalid-resume-token" }, 401, cors);
    const resume = await verifyToken<ResumeClaims>(input.resumeToken, "resume", env.SESSION_SECRET, nowSeconds);
    // Expired tokens and tokens signed before a secret rotation are ordinary
    // anonymous arrivals. Admitting them as a fresh actor avoids a second
    // browser POST, which is especially important behind edge rate limits.
    if (resume) {
      if (resume.directoryId !== undefined && !isLobbyId(resume.directoryId)) {
        return json({ error: "invalid-resume-token" }, 401, cors);
      }
      actorId = resume.actorId;
      preferredRoomId = resume.roomId;
      // Pre-directory tokens used the original 16-way actor hash. New tokens pin
      // the owning directory, so activating more allocators later cannot move an
      // existing actor away from the FieldRoom that stores their sleeping state.
      directoryId = resume.directoryId || legacyLobbyDirectoryForActor(actorId);
    }
  }

  directoryId ||= lobbyDirectoryForActor(actorId);
  let roomId: string;
  try {
    const lobby = env.LOBBY.get(env.LOBBY.idFromName(directoryId));
    const assignment = await lobby.fetch("https://lobby/assign", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ actorId, preferredRoomId, directoryId, ticketNonce }),
    });
    if (!assignment.ok) return json({ error: "rooms-unavailable" }, 503, cors);
    const result = (await assignment.json()) as { roomId?: string };
    if (!isRoomId(result.roomId)) return json({ error: "rooms-unavailable" }, 503, cors);
    roomId = result.roomId;
  } catch {
    // Cross-Durable-Object failures should be retryable application responses,
    // not uncaught Worker exceptions surfaced as Cloudflare 1101 pages.
    return json({ error: "rooms-unavailable" }, 503, cors);
  }

  const resumeClaims: ResumeClaims = {
    v: WORLD_PROTOCOL_VERSION,
    kind: "resume",
    actorId,
    roomId,
    directoryId,
    iat: nowSeconds,
    exp: nowSeconds + RESUME_TTL_SECONDS,
  };
  const ticketClaims: TicketClaims = {
    v: WORLD_PROTOCOL_VERSION,
    kind: "ticket",
    actorId,
    roomId,
    profile,
    nonce: ticketNonce,
    iat: nowSeconds,
    exp: nowSeconds + TICKET_TTL_SECONDS,
  };

  const [resumeToken, ticket] = await Promise.all([
    signToken(resumeClaims, env.SESSION_SECRET),
    signToken(ticketClaims, env.SESSION_SECRET),
  ]);

  return json(
    {
      protocol: WORLD_PROTOCOL_VERSION,
      actorId,
      resumeToken,
      roomId,
      wsUrl: websocketUrl(request, ticket),
      capacity: PIT_CAPACITY,
      // The authoritative count arrives in the room welcome. Avoid putting the
      // global coordinator on every anonymous session's hot path.
      count: 0,
    },
    200,
    { ...cors, "cache-control": "no-store" },
  );
}

async function connect(request: Request, env: Env) {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    return json({ error: "websocket-upgrade-required" }, 426);
  }
  if (!corsHeaders(request, env)) return json({ error: "origin-not-allowed" }, 403);

  const token = new URL(request.url).searchParams.get("ticket");
  if (!token) return json({ error: "missing-ticket" }, 401);
  const claims = await verifyToken<TicketClaims>(token, "ticket", env.SESSION_SECRET);
  if (!claims) return json({ error: "invalid-ticket" }, 401);

  try {
    const room = env.ROOMS.get(env.ROOMS.idFromName(claims.roomId));
    return await room.fetch("https://room/connect", {
      headers: {
        upgrade: "websocket",
        "x-waiting-pit-actor": claims.actorId,
        "x-waiting-pit-room": claims.roomId,
        "x-waiting-pit-nonce": claims.nonce,
        "x-waiting-pit-profile": encodeInternalJson(claims.profile),
      },
    });
  } catch {
    return json({ error: "room-unavailable" }, 503);
  }
}

const worker: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return cors ? new Response(null, { status: 204, headers: cors }) : json({ error: "origin-not-allowed" }, 403);
    }

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, protocol: WORLD_PROTOCOL_VERSION }, 200, cors || undefined);
    }
    if (url.pathname === "/ready" && request.method === "GET") {
      try {
        if (
          typeof env.SESSION_SECRET !== "string" ||
          env.SESSION_SECRET.length < 32 ||
          !env.LOBBY ||
          !env.ROOMS ||
          !env.PIT ||
          !env.PIT_FANOUT
        ) {
          throw new Error("bindings-not-ready");
        }
        const pit = await pitState(env);
        return json(
          { ok: true, protocol: WORLD_PROTOCOL_VERSION, pit },
          200,
          { ...(cors || {}), "cache-control": "no-store" },
        );
      } catch {
        return json(
          { ok: false, protocol: WORLD_PROTOCOL_VERSION },
          503,
          { ...(cors || {}), "cache-control": "no-store" },
        );
      }
    }
    if (!cors) return json({ error: "origin-not-allowed" }, 403);
    if (url.pathname === "/v1/session" && request.method === "POST") return createSession(request, env, cors);
    if (url.pathname === "/v1/connect" && request.method === "GET") return connect(request, env);
    if (url.pathname === "/v1/pit" && request.method === "GET") {
      try {
        return json(await pitState(env), 200, { ...cors, "cache-control": "no-store" });
      } catch {
        return json({ error: "pit-unavailable" }, 503, cors);
      }
    }
    return json({ error: "not-found" }, 404, cors);
  },
};

export default worker;

export class Lobby extends DurableObject<Env> {
  private rooms = new Map<string, RoomHint>();
  private availableRooms = new Set<string>();
  private optimisticRooms = new Map<string, OptimisticRoomState>();
  private provisionalRooms = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const records = await ctx.storage.list<RoomHint>({ prefix: "room:" });
      for (const [key, value] of records) {
        const roomId = key.slice(5);
        this.rooms.set(roomId, value);
        this.updateAvailability(roomId, value);
      }
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (request.method !== "POST") return json({ error: "method-not-allowed" }, 405);

    if (url.pathname === "/report") {
      const input = (await request.json()) as Partial<RoomHint> & { roomId?: string };
      if (!input.roomId || !isRoomId(input.roomId)) return json({ error: "invalid-room" }, 400);
      const hint = {
        active: Math.max(0, Math.trunc(input.active || 0)),
        reserved: Math.max(0, Math.trunc(input.reserved || 0)),
        sleepers: Math.max(0, Math.trunc(input.sleepers || 0)),
        updatedAt: Date.now(),
      };
      this.applyRoomHint(input.roomId, hint);
      await this.ctx.storage.put(`room:${input.roomId}`, hint);
      return json({ ok: true });
    }

    if (url.pathname !== "/assign") return json({ error: "not-found" }, 404);
    const input = (await request.json()) as {
      actorId?: string;
      preferredRoomId?: string;
      directoryId?: string;
      ticketNonce?: string;
    };
    if (!isActorId(input.actorId)) return json({ error: "invalid-actor" }, 400);
    if (!isActorId(input.ticketNonce)) return json({ error: "invalid-ticket-nonce" }, 400);
    const isResumeAssignment = Boolean(
      input.preferredRoomId && isRoomId(input.preferredRoomId),
    );
    if (
      !input.directoryId ||
      !isLobbyId(input.directoryId) ||
      (!isResumeAssignment && !isActiveNewJoinLobbyId(input.directoryId))
    ) {
      return json({ error: "invalid-directory" }, 400);
    }

    if (this.rooms.size > MAX_ROOM_HINTS_PER_LOBBY) await this.pruneRoomHints();

    if (input.preferredRoomId && isRoomId(input.preferredRoomId)) {
      const preferred = await this.reserve(
        input.preferredRoomId,
        input.actorId,
        input.directoryId,
        input.ticketNonce,
        true,
        false,
      );
      if (preferred) return json({ roomId: input.preferredRoomId });
    }

    // Only perform the bounded stale-hint refresh at a saturation boundary;
    // the ordinary join path remains O(1).
    if (this.availableRooms.size === 0) this.refreshStaleAvailability();
    const candidates: string[] = [];
    for (const roomId of this.availableRooms) {
      candidates.push(roomId);
      if (candidates.length >= 12) break;
    }
    for (const roomId of candidates) {
      if (await this.reserve(roomId, input.actorId, input.directoryId, input.ticketNonce, false, false)) {
        return json({ roomId });
      }
    }

    const roomId = `field-${crypto.randomUUID()}`;
    if (!(await this.reserve(roomId, input.actorId, input.directoryId, input.ticketNonce, false, true))) {
      return json({ error: "room-reservation-failed" }, 503);
    }
    return json({ roomId });
  }

  private async reserve(
    roomId: string,
    actorId: string,
    directoryId: string,
    nonce: string,
    resume: boolean,
    publishProvisional: boolean,
  ) {
    this.beginOptimisticReservation(roomId, publishProvisional);
    const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId));
    try {
      const response = await room.fetch("https://room/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId, actorId, directoryId, nonce, resume }),
      });
      const result = (await response.json()) as Partial<RoomHint> & { ok?: boolean };
      const hasHint =
        Number.isFinite(result.active) &&
        Number.isFinite(result.reserved) &&
        Number.isFinite(result.sleepers);
      let hint: RoomHint | undefined;
      if (hasHint) {
        hint = {
          active: Math.max(0, Math.trunc(result.active!)),
          reserved: Math.max(0, Math.trunc(result.reserved!)),
          sleepers: Math.max(0, Math.trunc(result.sleepers!)),
          updatedAt: Date.now(),
        };
        this.applyRoomHint(roomId, hint);
      }
      const accepted = response.ok && result.ok === true;
      this.finishOptimisticReservation(roomId, accepted);
      if (hint) {
        this.ctx.waitUntil(
          this.ctx.storage.put(`room:${roomId}`, hint).catch(() => undefined),
        );
      }
      if (this.rooms.size > MAX_ROOM_HINTS_PER_LOBBY) {
        this.ctx.waitUntil(this.pruneRoomHints());
      }
      return accepted;
    } catch {
      this.finishOptimisticReservation(roomId, false);
      return false;
    }
  }

  private async pruneRoomHints() {
    const excess = this.rooms.size - MAX_ROOM_HINTS_PER_LOBBY;
    if (excess <= 0) return;
    const now = Date.now();
    const removable = [...this.rooms.entries()]
      .filter(([roomId]) => !this.optimisticRooms.has(roomId))
      .sort((left, right) => {
        const rank = ([roomId, hint]: [string, RoomHint]) => {
          const stale = now - hint.updatedAt > ROOM_HINT_TTL_MS;
          const unavailable = !this.isRoomAvailable(roomId, hint, now);
          if (hint.active >= ROOM_ACTIVE_LIMIT || hint.sleepers >= ROOM_SLEEPER_SOFT_LIMIT) return 0;
          if (hint.active === 0 && stale) return 1;
          if (unavailable) return 2;
          if (stale) return 3;
          if (hint.active === 0) return 4;
          return 5;
        };
        return rank(left) - rank(right) || left[1].updatedAt - right[1].updatedAt;
      })
      .slice(0, excess)
      .map(([roomId]) => roomId);
    if (!removable.length) return;
    for (const roomId of removable) {
      this.rooms.delete(roomId);
      this.availableRooms.delete(roomId);
    }
    await deleteStorageKeys(
      this.ctx.storage,
      removable.map((roomId) => `room:${roomId}`),
    );
  }

  private isRoomAvailable(roomId: string, hint: RoomHint, now = Date.now()) {
    const reservationIsFresh = now - hint.updatedAt < RESERVATION_TTL_MS;
    const reserved = reservationIsFresh ? hint.reserved : 0;
    const authoritativeOccupancy = hint.active + reserved;
    const optimistic = this.optimisticRooms.get(roomId);
    const occupancy = optimistic
      ? Math.max(authoritativeOccupancy, optimistic.baseOccupancy + optimistic.claims)
      : authoritativeOccupancy;
    return occupancy < ROOM_ACTIVE_LIMIT && hint.sleepers < ROOM_SLEEPER_SOFT_LIMIT;
  }

  private updateAvailability(roomId: string, hint: RoomHint) {
    if (this.isRoomAvailable(roomId, hint)) {
      this.availableRooms.add(roomId);
    } else {
      this.availableRooms.delete(roomId);
    }
  }

  private applyRoomHint(roomId: string, hint: RoomHint) {
    this.rooms.set(roomId, hint);
    this.provisionalRooms.delete(roomId);
    this.updateAvailability(roomId, hint);
  }

  private beginOptimisticReservation(roomId: string, publishProvisional: boolean) {
    let hint = this.rooms.get(roomId);
    if (!hint && publishProvisional) {
      hint = { active: 0, reserved: 0, sleepers: 0, updatedAt: Date.now() };
      this.rooms.set(roomId, hint);
      this.provisionalRooms.add(roomId);
    }
    const fallback = hint || { active: 0, reserved: 0, sleepers: 0, updatedAt: Date.now() };
    const existing = this.optimisticRooms.get(roomId);
    const freshReserved = Date.now() - fallback.updatedAt < RESERVATION_TTL_MS
      ? fallback.reserved
      : 0;
    const state = existing || {
      baseOccupancy: fallback.active + freshReserved,
      claims: 0,
      inFlight: 0,
    };
    state.claims += 1;
    state.inFlight += 1;
    this.optimisticRooms.set(roomId, state);
    if (hint) this.updateAvailability(roomId, hint);
  }

  private finishOptimisticReservation(roomId: string, accepted: boolean) {
    const state = this.optimisticRooms.get(roomId);
    if (!state) return;
    if (!accepted) state.claims = Math.max(0, state.claims - 1);
    state.inFlight = Math.max(0, state.inFlight - 1);
    if (state.inFlight === 0) this.optimisticRooms.delete(roomId);
    const hint = this.rooms.get(roomId);
    if (this.provisionalRooms.has(roomId) && state.inFlight === 0) {
      this.provisionalRooms.delete(roomId);
      this.rooms.delete(roomId);
      this.availableRooms.delete(roomId);
      return;
    }
    if (hint) this.updateAvailability(roomId, hint);
  }

  private refreshStaleAvailability() {
    const now = Date.now();
    for (const [roomId, hint] of this.rooms) {
      if (now - hint.updatedAt >= RESERVATION_TTL_MS) {
        this.updateAvailability(roomId, hint);
      }
    }
  }
}

export class PitCoordinator extends DurableObject<Env> {
  private pit = createInitialPitState();
  private subscriberShards = new Set<number>();
  private pendingFanoutTargets = new Map<number, number>();
  private fanoutRetryMs = 1_000;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<PitState>("pit-state");
      this.pit = isPitState(saved) ? saved : migrateLegacyPitState((await ctx.storage.get<number>("count")) || 0);
      if (!isPitState(saved)) {
        const records: Record<string, unknown> = { "pit-state": this.pit, count: this.pit.count };
        for (const monument of this.pit.monuments) records[`monument:${monument.round}`] = monument;
        await ctx.storage.put(records);
      }
      const savedShards = (await ctx.storage.get<number[]>("subscriber-shards")) || [];
      this.subscriberShards = new Set(
        savedShards.filter(
          (shard) => Number.isInteger(shard) && shard >= 0 && shard < PIT_FANOUT_SHARDS,
        ),
      );
      const pending = (await ctx.storage.get<FanoutTargetStore>("pending-fanout-targets")) || {};
      for (const [rawShard, target] of Object.entries(pending)) {
        const shard = Number.parseInt(rawShard, 10);
        if (
          Number.isInteger(shard) &&
          shard >= 0 &&
          shard < PIT_FANOUT_SHARDS &&
          Number.isFinite(target)
        ) {
          this.pendingFanoutTargets.set(shard, Math.max(0, Math.trunc(target)));
        }
      }
      const storedRetryMs = await ctx.storage.get<number>("fanout-retry-ms");
      this.fanoutRetryMs = Number.isFinite(storedRetryMs)
        ? Math.max(1_000, Math.min(60_000, Math.trunc(storedRetryMs!)))
        : 1_000;
      if (this.pendingFanoutTargets.size > 0 && (await ctx.storage.getAlarm()) === null) {
        await ctx.storage.setAlarm(Date.now() + this.fanoutRetryMs);
      }
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/state" && request.method === "GET") {
      return json(this.pit);
    }

    if (url.pathname === "/subscribe" && request.method === "POST") {
      const { roomId } = (await request.json()) as { roomId?: string };
      if (!roomId || !isRoomId(roomId)) return json({ error: "invalid-room" }, 400);
      const shardNumber = pitFanoutShard(roomId);
      const fanout = this.env.PIT_FANOUT.get(this.env.PIT_FANOUT.idFromName(`fanout-${shardNumber}`));
      const subscription = await fanout.fetch("https://fanout/subscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId }),
      });
      if (!subscription.ok) return json({ error: "fanout-unavailable" }, 503);
      if (!this.subscriberShards.has(shardNumber)) {
        this.subscriberShards.add(shardNumber);
        await this.ctx.storage.put("subscriber-shards", [...this.subscriberShards]);
      }
      return json(this.pit);
    }

    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const { roomId } = (await request.json()) as { roomId?: string };
      if (roomId && isRoomId(roomId)) {
        const shardNumber = pitFanoutShard(roomId);
        const fanout = this.env.PIT_FANOUT.get(this.env.PIT_FANOUT.idFromName(`fanout-${shardNumber}`));
        const response = await fanout.fetch("https://fanout/unsubscribe", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomId }),
        });
        // Shard membership is intentionally monotonic and bounded to 32 values.
        // Keeping an empty shard registered removes subscribe/unsubscribe races.
        await response.arrayBuffer();
      }
      return json({ ok: true });
    }

    if (url.pathname !== "/deposit" || request.method !== "POST") return json({ error: "not-found" }, 404);
    const input = (await request.json()) as { actionKey?: string };
    if (!input.actionKey || !/^[A-Za-z0-9:_-]{1,160}$/.test(input.actionKey)) {
      return json({ error: "invalid-action" }, 400);
    }

    // Snapshot the monotonic subscriber set before entering the transaction.
    // Persisting these targets with the count/action commit closes the only
    // window where a crash after the final deposit could leave active rooms
    // permanently one update behind.
    const targetShards = [...this.subscriberShards];
    const parts = /^(field-[0-9a-f-]+):(stone-[0-9]+):([0-9]+)$/i.exec(input.actionKey);
    const generation = parts ? Number(parts[3]) : undefined;
    const stoneKey = parts && isRoomId(parts[1]) && parseStoneIndex(parts[2]) !== null &&
      Number.isSafeInteger(generation) && generation! >= 0 && generation! <= 0x7fff_ffff
      ? `deposit-latest:${parts[1]}:${parts[2]}` : null;
    const outcome = await this.ctx.storage.transaction(async (transaction) => {
      const legacyKey = `deposit:${input.actionKey}`;
      const actionKey = stoneKey ?? legacyKey;
      const prior = await transaction.get<{ count: number; generation?: number }>(actionKey);
      const saved = await transaction.get<PitState>("pit-state");
      const current = isPitState(saved) ? saved : this.pit;
      if (prior && (!stoneKey || (prior.generation ?? -1) >= generation!)) {
        return { accepted: true, duplicate: true, count: prior.count, pit: current };
      }
      // A stone's generations only increase. Keeping its latest accepted
      // generation bounds gameplay dedupe to the fixed stone pool per room.
      // Older prototype keys are read once for continuity and never erased.
      if (stoneKey) {
        const legacy = await transaction.get<{ count: number }>(legacyKey);
        if (legacy) {
          await transaction.put(stoneKey, { count: legacy.count, generation });
          return { accepted: true, duplicate: true, count: legacy.count, pit: current };
        }
      }
      // All validated throws are accepted, including throws already in flight
      // when another room completes the previous excavation.
      const next = advancePitState(current);
      await transaction.put("pit-state", next);
      await transaction.put("count", next.count);
      await transaction.put(actionKey, { count: next.count, ...(stoneKey ? { generation } : {}) });
      if (next.round !== current.round) {
        const monument = next.monuments[next.monuments.length - 1];
        await transaction.put(`monument:${monument.round}`, monument);
      }
      if (targetShards.length > 0) {
        await transaction.put(
          "pending-fanout-targets",
          Object.fromEntries(targetShards.map((shard) => [String(shard), next.totalStones])),
        );
      }
      return { accepted: true, duplicate: false, count: next.count, pit: next };
    });
    // totalStones is monotonic across both deposits and excavation rollovers.
    if (outcome.pit.totalStones >= this.pit.totalStones) this.pit = outcome.pit;

    if (outcome.accepted && !outcome.duplicate && targetShards.length > 0) {
      for (const shard of targetShards) this.pendingFanoutTargets.set(shard, this.pit.totalStones);
      await this.scheduleFanoutAlarm(250);
    } else if (this.pendingFanoutTargets.size > 0) {
      await this.scheduleFanoutAlarm(250);
    }
    return json({ ...outcome, capacity: outcome.pit.capacity });
  }

  async alarm() {
    const targets = [...this.pendingFanoutTargets.entries()];
    if (!targets.length) return;
    const failed = new Set<number>();
    for (let offset = 0; offset < targets.length; offset += 6) {
      const batch = targets.slice(offset, offset + 6);
      await Promise.all(
        batch.map(async ([shardNumber, targetCount]) => {
          try {
            const fanout = this.env.PIT_FANOUT.get(this.env.PIT_FANOUT.idFromName(`fanout-${shardNumber}`));
            const response = await fanout.fetch("https://fanout/pit-update", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ count: this.pit.count, capacity: this.pit.capacity, pit: this.pit }),
            });
            if (!response.ok) {
              failed.add(shardNumber);
              return;
            }
            await response.arrayBuffer();
            // A deposit can arrive while this alarm awaits a shard. Remove only
            // the exact target that was delivered; a newer target stays queued.
            if (this.pendingFanoutTargets.get(shardNumber) === targetCount) {
              this.pendingFanoutTargets.delete(shardNumber);
            }
          } catch {
            failed.add(shardNumber);
          }
        }),
      );
    }
    if (failed.size > 0) {
      await this.scheduleFanoutAlarm(this.fanoutRetryMs);
      this.fanoutRetryMs = Math.min(60_000, this.fanoutRetryMs * 2);
    } else if (this.pendingFanoutTargets.size > 0) {
      this.fanoutRetryMs = 1_000;
      await this.scheduleFanoutAlarm(250);
    } else {
      this.fanoutRetryMs = 1_000;
    }
    await this.ctx.storage.put({
      "pending-fanout-targets": this.serializedFanoutTargets(),
      "fanout-retry-ms": this.fanoutRetryMs,
    });
  }

  private serializedFanoutTargets(): FanoutTargetStore {
    return Object.fromEntries(
      [...this.pendingFanoutTargets.entries()].map(([shard, target]) => [String(shard), target]),
    );
  }

  private async scheduleFanoutAlarm(delayMs: number) {
    const alarmAt = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > alarmAt) await this.ctx.storage.setAlarm(alarmAt);
  }
}

/** Hierarchical fan-out keeps the single global counter from issuing one
 * subrequest per active room. Each shard handles only its fraction of rooms. */
export class PitFanout extends DurableObject<Env> {
  private rooms = new Set<string>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const subscriptions = await ctx.storage.list<number>({ prefix: "room:" });
      this.rooms = new Set([...subscriptions.keys()].map((key) => key.slice(5)));
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/subscribe" && request.method === "POST") {
      const { roomId } = (await request.json()) as { roomId?: string };
      if (!roomId || !isRoomId(roomId)) return json({ error: "invalid-room" }, 400);
      if (!this.rooms.has(roomId)) {
        this.rooms.add(roomId);
        await this.ctx.storage.put(`room:${roomId}`, Date.now());
      }
      return json({ size: this.rooms.size });
    }
    if (url.pathname === "/unsubscribe" && request.method === "POST") {
      const { roomId } = (await request.json()) as { roomId?: string };
      if (roomId && this.rooms.delete(roomId)) await this.ctx.storage.delete(`room:${roomId}`);
      return json({ size: this.rooms.size });
    }
    if (url.pathname !== "/pit-update" || request.method !== "POST") return json({ error: "not-found" }, 404);
    const update = (await request.json()) as { count: number; capacity: number };
    const stale: string[] = [];
    const failed = new Set<string>();
    const roomIds = [...this.rooms];
    for (let offset = 0; offset < roomIds.length; offset += 6) {
      await Promise.all(
        roomIds.slice(offset, offset + 6).map(async (roomId) => {
          try {
            const room = this.env.ROOMS.get(this.env.ROOMS.idFromName(roomId));
            const response = await room.fetch("https://room/pit-update", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(update),
            });
            if (!response.ok) {
              failed.add(roomId);
              return;
            }
            const state = (await response.json()) as { active?: number };
            if (!state.active) stale.push(roomId);
          } catch {
            failed.add(roomId);
          }
        }),
      );
    }
    // A completed excavation starts another; subscriptions survive rollover.
    if (stale.length) {
      for (const roomId of stale) this.rooms.delete(roomId);
      await this.deleteSubscriptions(stale);
    }
    return json(
      { size: this.rooms.size, failed: failed.size },
      failed.size > 0 ? 503 : 200,
    );
  }

  private async deleteSubscriptions(roomIds: string[]) {
    await deleteStorageKeys(
      this.ctx.storage,
      roomIds.map((roomId) => `room:${roomId}`),
    );
  }
}

export class FieldRoom extends DurableObject<Env> {
  private roomId = "";
  private directoryId = "";
  private pit = createInitialPitState();
  private pitSubscribed = false;
  private pitSubscribePromise: Promise<PitState> | null = null;
  private pitRetryMs = 1_000;
  private pitRetryAt: number | null = null;
  private roomHintDirty = false;
  private players = new Map<string, StoredPlayer>();
  private stones = new Map<string, StoneState>();
  private reservations = new Map<string, Reservation>();
  private connections = new Map<string, string>();
  private dirtyPlayers = new Set<string>();
  private dirtyProfiles = new Set<string>();
  private persistPlayers = new Set<string>();
  private lastPersistAt = new Map<string, number>();
  private chatLimits = new Map<string, TokenBucket>();
  private profileLimits = new Map<string, TokenBucket>();
  private moveLimits = new Map<string, TokenBucket>();
  private actionLimits = new Map<string, TokenBucket>();
  private messageLimits = new Map<string, TokenBucket>();
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private actionQueue: Promise<void> = Promise.resolve();
  private queuedActions = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Cloudflare can answer this exact heartbeat while the Durable Object stays
    // hibernated. The ordinary ping handler below remains for legacy payloads.
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(HEARTBEAT_REQUEST, HEARTBEAT_RESPONSE),
    );
    ctx.blockConcurrencyWhile(async () => {
      this.roomId = (await ctx.storage.get<string>("room-id")) || "";
      this.directoryId = (await ctx.storage.get<string>("directory-id")) || "";
      const savedPit = await ctx.storage.get<PitState>("pit-state");
      this.pit = isPitState(savedPit) ? savedPit : migrateLegacyPitState((await ctx.storage.get<number>("pit-count")) || 0);
      const savedPitRetryAt = await ctx.storage.get<number>("pit-retry-at");
      const savedPitRetryMs = await ctx.storage.get<number>("pit-retry-ms");
      this.pitRetryAt = Number.isFinite(savedPitRetryAt)
        ? Math.max(0, Math.trunc(savedPitRetryAt!))
        : null;
      this.pitRetryMs = Number.isFinite(savedPitRetryMs)
        ? Math.max(1_000, Math.min(30_000, Math.trunc(savedPitRetryMs!)))
        : 1_000;
      const playerRecords = await ctx.storage.list<StoredPlayer>({ prefix: "player:" });
      for (const [key, stored] of playerRecords) {
        this.players.set(key.slice(7), { ...stored, sleeping: true, vx: 0, vz: 0 });
      }
      const stoneRecords = await ctx.storage.list<StoneState>({ prefix: "stone:" });
      if (stoneRecords.size) {
        for (const [key, stone] of stoneRecords) {
          const stoneId = key.slice(6);
          if (parseStoneIndex(stoneId) === null || stone.id !== stoneId) continue;
          this.stones.set(stoneId, stone);
        }
      }
      const missingStoneRecords: Record<string, StoneState> = {};
      for (const stone of this.createStones()) {
        if (this.stones.has(stone.id)) continue;
        this.stones.set(stone.id, stone);
        missingStoneRecords[`stone:${stone.id}`] = stone;
      }
      if (Object.keys(missingStoneRecords).length) await ctx.storage.put(missingStoneRecords);

      const savedReservations = (await ctx.storage.get<ReservationStore>("reservations")) || {};
      this.reservations = new Map(Object.entries(savedReservations));
      this.cleanupReservations();

      // Hibernating sockets survive object eviction. Their attachments are the
      // source of truth for which persisted players are still awake.
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment() as SocketAttachment | null;
        if (!attachment) continue;
        this.connections.set(attachment.actorId, attachment.connectionId);
        const player = this.players.get(attachment.actorId);
        if (player) player.sleeping = false;
      }

      // A runtime reset can occur after a pickup but before the normal socket
      // close callback. Repair persisted ownership so a ghost holder cannot
      // strand a stone until sleeper expiry.
      const recoveryRecords: Record<string, unknown> = {};
      for (const player of this.players.values()) {
        if (!player.carrying) continue;
        const stone = this.stones.get(player.carrying);
        if (player.sleeping || !stone || stone.holderId !== player.id) {
          if (stone?.holderId === player.id) {
            Object.assign(stone, { x: player.x, z: player.z, holderId: null });
            recoveryRecords[`stone:${stone.id}`] = stone;
          }
          player.carrying = null;
          recoveryRecords[`player:${player.id}`] = player;
        }
      }
      for (const stone of this.stones.values()) {
        if (!stone.holderId) continue;
        const holder = this.players.get(stone.holderId);
        if (!holder || holder.sleeping || holder.carrying !== stone.id) {
          if (holder) Object.assign(stone, { x: holder.x, z: holder.z });
          stone.holderId = null;
          recoveryRecords[`stone:${stone.id}`] = stone;
        }
      }
      for (const stone of this.replenishNearbyStones()) {
        recoveryRecords[`stone:${stone.id}`] = stone;
      }
      if (Object.keys(recoveryRecords).length) {
        await putStorageRecords(ctx.storage, recoveryRecords);
      }
      if ((await this.pruneSleeping(Date.now())) > 0) this.roomHintDirty = true;
    });
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/reserve" && request.method === "POST") {
      return this.enqueueRoomTask(() => this.reserve(request));
    }
    if (url.pathname === "/connect" && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
      return this.enqueueRoomTask(() => this.connectWebSocket(request));
    }
    if (url.pathname === "/pit-update" && request.method === "POST") {
      const update = (await request.json()) as { count: number; capacity: number; pit?: PitState };
      const active = this.activeCount();
      this.pitSubscribed = active > 0;
      await this.applyPitState(update);
      this.broadcast({ t: "pit", count: this.pit.count, capacity: this.pit.capacity, pit: this.pit });
      return json({ active });
    }
    return json({ error: "not-found" }, 404);
  }

  async webSocketMessage(socket: CloudflareServerWebSocket, message: string | ArrayBuffer) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || this.connections.get(attachment.actorId) !== attachment.connectionId) return;
    const envelopeLimit =
      this.messageLimits.get(attachment.actorId) || new TokenBucket(24, 14, Date.now());
    this.messageLimits.set(attachment.actorId, envelopeLimit);
    if (!envelopeLimit.take()) {
      try {
        socket.close(4008, "message rate limit");
      } catch {
        // The close callback owns cleanup.
      }
      return;
    }
    if (typeof message !== "string" || new TextEncoder().encode(message).byteLength > MAX_SOCKET_MESSAGE_BYTES) {
      this.send(socket, { t: "error", code: "invalid-message" });
      return;
    }

    let input: ClientMessage;
    try {
      input = JSON.parse(message) as ClientMessage;
    } catch {
      this.send(socket, { t: "error", code: "invalid-json" });
      return;
    }
    if (!input || typeof input !== "object" || typeof input.t !== "string") return;

    if (input.t === "ping") {
      this.send(socket, { t: "pong", at: typeof input.at === "number" ? input.at : undefined, serverTime: Date.now() });
      return;
    }
    if (input.t === "move") {
      this.handleMove(attachment.actorId, input);
      return;
    }
    if (input.t === "profile") {
      await this.handleProfile(attachment.actorId, input.profile);
      return;
    }
    if (input.t === "chat") {
      this.handleChat(socket, attachment.actorId, input.id, input.text);
      return;
    }
    if (input.t === "pickup" || input.t === "throw") {
      const now = Date.now();
      const actionId = sanitizeActionId(input.id);
      if (!actionId) {
        this.send(socket, { t: "error", code: "invalid-action" });
        return;
      }
      const rejectQueuedAction = (reason: string) =>
        this.send(socket, {
          t: "action",
          id: actionId,
          ok: false,
          kind: input.t,
          ...(input.t === "throw" ? { deposited: false } : {}),
          reason,
        });
      const limit = this.actionLimits.get(attachment.actorId) || new TokenBucket(4, 1, now);
      this.actionLimits.set(attachment.actorId, limit);
      if (!limit.take(now)) {
        rejectQueuedAction("action-rate-limited");
        return;
      }
      if (this.queuedActions >= MAX_QUEUED_ACTIONS) {
        rejectQueuedAction("room-busy");
        return;
      }
      this.queuedActions += 1;
      const actionPit = this.pit;
      const action = this.enqueueRoomTask(() =>
        this.handleAction(socket, attachment.actorId, input, actionPit),
      );
      try {
        await action;
      } catch {
        rejectQueuedAction("action-failed");
      } finally {
        this.queuedActions -= 1;
      }
    }
  }

  async webSocketClose(socket: CloudflareServerWebSocket) {
    // Explicitly finish the close handshake as well as persisting departure.
    // This is safe with the runtime's automatic close reply and helps local
    // dev proxies release their TCP connection promptly.
    try { socket.close(); } catch { /* The runtime may have already closed it. */ }
    await this.enqueueRoomTask(() => this.disconnect(socket));
  }

  async webSocketError(socket: CloudflareServerWebSocket) {
    await this.enqueueRoomTask(() => this.disconnect(socket));
  }

  async alarm() {
    const now = Date.now();
    const prunedSleepers = await this.pruneSleeping(now, false);
    if (prunedSleepers > 0) this.roomHintDirty = true;
    if (this.roomHintDirty) {
      this.roomHintDirty = false;
      this.reportRoom();
    }

    const pitRetryDue = this.pitRetryAt !== null && this.pitRetryAt <= now;
    if (pitRetryDue) {
      if (this.activeCount() === 0 || this.pitSubscribed) {
        await this.clearPitRetry();
      } else {
        try {
          await this.ensurePitSubscription();
          // A close event can interleave while the cross-DO subscribe is pending.
          // If the last socket slept in that window, remove the just-created stale
          // subscription immediately instead of waiting for a later pit update.
          if (this.activeCount() === 0 && this.pitSubscribed) await this.unsubscribePit();
        } catch {
          await this.schedulePitRetry();
        }
      }
    }
    await this.scheduleNextFieldAlarm(Date.now(), true);
  }

  private async reserve(request: Request) {
    const input = (await request.json()) as {
      roomId?: string;
      actorId?: string;
      directoryId?: string;
      nonce?: string;
      resume?: boolean;
    };
    if (
      !input.roomId ||
      !isRoomId(input.roomId) ||
      !isActorId(input.actorId) ||
      !input.directoryId ||
      !isLobbyId(input.directoryId) ||
      !isActorId(input.nonce)
    ) {
      return json({ error: "invalid-reservation" }, 400);
    }
    if (!this.roomId) {
      this.roomId = input.roomId;
      this.directoryId = input.directoryId;
      await this.ctx.storage.put({
        "room-id": this.roomId,
        "directory-id": this.directoryId,
      });
    }
    if (this.roomId !== input.roomId || this.directoryId !== input.directoryId) {
      return json({ error: "room-mismatch" }, 409);
    }

    this.cleanupReservations();
    const existing = this.players.get(input.actorId);
    const alreadyActive = existing && !existing.sleeping;
    const active = this.activeCount();
    let sleepers = this.sleepingCount();
    if (!existing && sleepers >= ROOM_SLEEPER_SOFT_LIMIT) {
      // A quiet room may not have received a disconnect since some sleepers
      // crossed their retention deadline. Reclaim them at the admission edge
      // before declaring the room permanently unavailable to new actors.
      await this.pruneSleeping(Date.now());
      sleepers = this.sleepingCount();
    }
    if (!existing && sleepers >= ROOM_SLEEPER_SOFT_LIMIT) {
      return json(
        {
          ok: false,
          reason: "room-sleeper-limit",
          active,
          reserved: this.reservationsNotAlreadyActive(),
          sleepers,
        },
        409,
      );
    }
    const projected = active + this.reservationsNotAlreadyActive();
    const limit = input.resume && existing ? ROOM_ACTIVE_LIMIT + RESUME_OVERFLOW : ROOM_ACTIVE_LIMIT;
    if (!alreadyActive && !this.reservations.has(input.actorId) && projected >= limit) {
      return json(
        {
          ok: false,
          reason: "room-full",
          active,
          reserved: this.reservationsNotAlreadyActive(),
          sleepers,
        },
        409,
      );
    }

    this.reservations.set(input.actorId, {
      expiresAt: Date.now() + RESERVATION_TTL_MS,
      resume: Boolean(input.resume),
      nonce: input.nonce,
    });
    await this.persistReservations();
    return json({
      ok: true,
      active,
      reserved: this.reservationsNotAlreadyActive(),
      sleepers,
    });
  }

  private async connectWebSocket(request: Request) {
    const actorId = request.headers.get("x-waiting-pit-actor") || "";
    const requestedRoom = request.headers.get("x-waiting-pit-room") || "";
    const ticketNonce = request.headers.get("x-waiting-pit-nonce") || "";
    const profileHeader = request.headers.get("x-waiting-pit-profile") || "";
    if (!actorId || requestedRoom !== this.roomId || !isActorId(ticketNonce) || !profileHeader) {
      return json({ error: "invalid-ticket" }, 401);
    }

    this.cleanupReservations();
    const reservation = this.reservations.get(actorId);
    const prior = this.players.get(actorId);
    // A signed ticket is still single-use. Consuming the reservation on the
    // first upgrade prevents replaying its URL to replace a live socket.
    if (!reservation || reservation.nonce !== ticketNonce) {
      return json({ error: "reservation-expired" }, 409);
    }
    if (prior?.sleeping && this.activeCount() >= ROOM_ACTIVE_LIMIT + RESUME_OVERFLOW) {
      return json({ error: "room-full" }, 409);
    }
    if (!prior && this.activeCount() >= ROOM_ACTIVE_LIMIT) return json({ error: "room-full" }, 409);

    let profile: PublicProfile;
    try {
      profile = sanitizeProfile(decodeInternalJson<unknown>(profileHeader));
    } catch {
      return json({ error: "invalid-profile" }, 400);
    }

    const connectionId = crypto.randomUUID();
    for (const oldSocket of this.ctx.getWebSockets(actorId)) {
      try {
        oldSocket.close(4001, "replaced by a newer connection");
      } catch {
        // The old edge may already be closing.
      }
    }

    await this.ensurePitSubscription().catch(async () => {
      await this.schedulePitRetry();
    });
    const occupied = [...this.players.values()]
      .filter((player) => player.id !== actorId && !player.sleeping)
      .map(({ x, z }) => ({ x, z }));
    const spawn = safeSpawn(actorId, occupied, this.pit);
    const now = Date.now();
    const player: StoredPlayer = prior
      ? {
          ...prior,
          profile,
          sleeping: false,
          vx: 0,
          vz: 0,
          lastSeenAt: now,
          lastMoveAt: now,
          movementCredit: replenishedMovementCredit(prior, now),
          movementCreditAt: now,
          // Input sequence numbers are scoped to one WebSocket. Browsers reset
          // their sequence after a reload, so a resumed actor needs a new base.
          lastSeq: -1,
        }
      : {
          id: actorId,
          profile,
          x: spawn.x,
          z: spawn.z,
          vx: 0,
          vz: 0,
          heading: headingTowardPit(spawn.x, spawn.z, this.pit),
          carrying: null,
          sleeping: false,
          lastMoveAt: now,
          lastSeenAt: now,
          lastSeq: -1,
          movementCredit: movementCreditCapacity(false),
          movementCreditAt: now,
          actionHistory: [],
        };
    this.players.set(actorId, player);
    this.connections.set(actorId, connectionId);
    this.reservations.delete(actorId);
    await Promise.all([this.ctx.storage.put(`player:${actorId}`, player), this.persistReservations()]);

    if (this.connections.get(actorId) !== connectionId) {
      return json({ error: "connection-superseded" }, 409);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [actorId]);
    server.serializeAttachment({ actorId, connectionId } satisfies SocketAttachment);

    this.send(server, {
      t: "welcome",
      protocol: WORLD_PROTOCOL_VERSION,
      selfId: actorId,
      roomId: this.roomId,
      count: this.pit.count,
      capacity: this.pit.capacity,
      pit: this.pit,
      players: this.welcomePlayers(player),
      stones: [...this.stones.values()],
      serverTime: now,
    });

    this.dirtyPlayers.add(actorId);
    this.dirtyProfiles.add(actorId);
    this.scheduleFrame();
    // Reconcile the Lobby's reservation with authoritative active occupancy.
    // Without this report, an otherwise healthy room looks empty after the
    // reservation TTL and attracts avoidable failed assignments at scale.
    this.reportRoom();
    return new Response(null, { status: 101, webSocket: client } as ResponseInit & { webSocket: WebSocket });
  }

  private handleMove(actorId: string, message: MoveMessage) {
    const now = Date.now();
    const rate = this.moveLimits.get(actorId) || new TokenBucket(12, 10, now);
    this.moveLimits.set(actorId, rate);
    if (!rate.take(now)) return;
    const player = this.players.get(actorId);
    if (!player || player.sleeping) return;
    const wasMoving = Math.hypot(player.vx, player.vz) >= 0.05;
    const movement = validateMovement(player, message, now, this.pit);
    if (!movement) return;
    Object.assign(player, movement, { lastSeenAt: now });
    this.dirtyPlayers.add(actorId);
    const stopped = Math.hypot(movement.vx, movement.vz) < 0.05;
    if (
      (wasMoving && stopped) ||
      now - (this.lastPersistAt.get(actorId) || 0) >= MOVEMENT_PERSIST_INTERVAL_MS
    ) {
      this.persistPlayers.add(actorId);
      this.lastPersistAt.set(actorId, now);
    }
    this.scheduleFrame();
  }

  private handleChat(socket: CloudflareServerWebSocket, actorId: string, rawId: unknown, rawText: unknown) {
    const id = sanitizeActionId(rawId);
    const message = sanitizeChat(rawText);
    if (!id || !message) {
      this.send(socket, { t: "error", code: "invalid-chat" });
      return;
    }
    const now = Date.now();
    const limit = this.chatLimits.get(actorId) || new TokenBucket(3, 0.3, now);
    this.chatLimits.set(actorId, limit);
    if (!limit.take(now)) {
      this.send(socket, { t: "error", code: "chat-rate-limited" });
      return;
    }
    const sender = this.players.get(actorId);
    if (!sender || sender.sleeping) return;
    const event = { t: "chat", playerId: actorId, id, text: message, expiresAt: now + 7_000 };
    for (const recipient of this.ctx.getWebSockets()) {
      const attachment = recipient.deserializeAttachment() as SocketAttachment | null;
      const player = attachment ? this.players.get(attachment.actorId) : undefined;
      if (player && Math.hypot(player.x - sender.x, player.z - sender.z) <= CHAT_RADIUS) this.send(recipient, event);
    }
  }

  private async handleProfile(actorId: string, rawProfile: unknown) {
    const now = Date.now();
    const rate = this.profileLimits.get(actorId) || new TokenBucket(3, 1 / 30, now);
    this.profileLimits.set(actorId, rate);
    if (!rate.take(now)) return;
    const player = this.players.get(actorId);
    if (!player || player.sleeping) return;
    player.profile = sanitizeProfile(rawProfile);
    player.lastSeenAt = now;
    this.dirtyPlayers.add(actorId);
    this.dirtyProfiles.add(actorId);
    this.scheduleFrame();
    await this.ctx.storage.put(`player:${actorId}`, player);
  }

  private async handleAction(
    socket: CloudflareServerWebSocket,
    actorId: string,
    input: Extract<ClientMessage, { t: "pickup" | "throw" }>,
    actionPit: PitState = this.pit,
  ) {
    const id = sanitizeActionId(input.id);
    const stoneIndex = typeof input.stoneId === "string" ? parseStoneIndex(input.stoneId) : null;
    let player = this.players.get(actorId);
    if (!id || stoneIndex === null || !player || player.sleeping) {
      this.send(socket, { t: "error", code: "invalid-action" });
      return;
    }
    const cached = player.actionHistory.find((result) => result.id === id);
    if (cached) {
      this.send(socket, cached.kind === "throw" ? { ...cached, pit: this.pit } : cached);
      return;
    }

    const stone = this.stones.get(input.stoneId);
    let result: ActionResult;
    const changedActionStones = new Map<string, StoneState>();
    if (input.t === "pickup") {
      if (!stone || stone.holderId || player.carrying) {
        result = { t: "action", id, ok: false, kind: "pickup", reason: "stone-unavailable" };
      } else if (Math.hypot(player.x - stone.x, player.z - stone.z) > PICKUP_RADIUS) {
        result = { t: "action", id, ok: false, kind: "pickup", reason: "too-far" };
      } else {
        stone.holderId = actorId;
        player.carrying = stone.id;
        result = { t: "action", id, ok: true, kind: "pickup" };
        changedActionStones.set(stone.id, stone);
        this.broadcast({ t: "stone", op: "upsert", stone });
        for (const replenished of this.replenishNearbyStones()) {
          changedActionStones.set(replenished.id, replenished);
          this.broadcast({ t: "stone", op: "upsert", stone: replenished });
        }
      }
    } else if (!stone || player.carrying !== stone.id || stone.holderId !== actorId) {
      result = { t: "action", id, ok: false, kind: "throw", reason: "not-carrying" };
    } else {
      // The pit request below can yield long enough for newer movement to be
      // accepted. A non-deposit must still land from the pose that initiated
      // this action, matching the browser's visible throw.
      const throwPose = { x: player.x, z: player.z, heading: player.heading };
      const distanceFromPit = Math.hypot(player.x - actionPit.center.x, player.z - actionPit.center.z);
      let deposited = false;
      let count: number | undefined;
      let reason: string | undefined;
      if (distanceFromPit <= actionPit.throwRadius && distanceFromPit >= actionPit.wallRadius - 0.25) {
        const coordinator = this.env.PIT.get(this.env.PIT.idFromName("global-pit"));
        try {
          const response = await coordinator.fetch("https://pit/deposit", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ actionKey: `${this.roomId}:${stone.id}:${stone.generation}` }),
          });
          if (response.ok) {
            const outcome = (await response.json()) as { accepted: boolean; count: number; capacity?: number; pit?: PitState };
            deposited = outcome.accepted;
            count = outcome.count;
            await this.applyPitState(outcome);
            if (!deposited) reason = "pit-unavailable";
          } else reason = "pit-unavailable";
        } catch {
          reason = "pit-unavailable";
        }
      } else {
        reason = "too-far-from-pit";
      }

      if (reason === "pit-unavailable") {
        // Keep ownership when the coordinator is unavailable or its reply was
        // lost. Retrying the same stone generation is idempotent globally.
        this.send(socket, { t: "action", id, ok: false, kind: "throw", reason, pit: this.pit });
        return;
      }

      // The global deposit await can interleave with a reconnect, which
      // replaces the player's object in the map. Continue on the live object so
      // action history, carrying state, profile, and movement credit cannot
      // regress to the pre-reconnect copy.
      player = this.players.get(actorId) ?? player;
      player.carrying = null;
      if (deposited) {
        const descriptor = getStoneDescriptor(stoneIndex, stone.generation + 1, this.pit);
        Object.assign(stone, {
          x: descriptor.x,
          z: descriptor.z,
          generation: descriptor.generation,
          holderId: null,
        });
      } else {
        const dropped = getForwardStonePosition(
          throwPose.x,
          throwPose.z,
          throwPose.heading,
          undefined,
          this.pit,
        );
        Object.assign(stone, { x: dropped.x, z: dropped.z, holderId: null });
      }
      changedActionStones.set(stone.id, stone);
      for (const replenished of this.replenishNearbyStones(deposited ? undefined : stone.id)) {
        changedActionStones.set(replenished.id, replenished);
      }
      // Stone state intentionally precedes the action acknowledgement on this
      // socket. The browser defers that authoritative upsert until its visible
      // arc finishes, preventing an acknowledgement race from snapping it.
      for (const changed of changedActionStones.values()) {
        this.broadcast({ t: "stone", op: "upsert", stone: changed });
      }
      result = { t: "action", id, ok: reason !== "pit-unavailable", kind: "throw", deposited, count, reason, pit: this.pit };
    }

    // Keep cached acknowledgements small; the current pit snapshot is attached
    // at send time, so replaying an old action cannot regress a client.
    const cachedResult = { ...result };
    delete cachedResult.pit;
    player.actionHistory = [...player.actionHistory.filter((entry) => entry.id !== id), cachedResult].slice(
      -ACTION_HISTORY_LIMIT,
    );
    player.lastSeenAt = Date.now();
    this.dirtyPlayers.add(actorId);
    this.scheduleFrame();
    const actionRecords: Record<string, StoredPlayer | StoneState> = {
      [`player:${actorId}`]: player,
    };
    for (const changed of changedActionStones.values()) {
      actionRecords[`stone:${changed.id}`] = changed;
    }
    await this.ctx.storage.put(actionRecords);
    this.send(socket, result);
  }

  private async disconnect(socket: CloudflareServerWebSocket) {
    const attachment = socket.deserializeAttachment() as SocketAttachment | null;
    if (!attachment || this.connections.get(attachment.actorId) !== attachment.connectionId) return;
    this.connections.delete(attachment.actorId);
    this.chatLimits.delete(attachment.actorId);
    this.profileLimits.delete(attachment.actorId);
    this.moveLimits.delete(attachment.actorId);
    this.actionLimits.delete(attachment.actorId);
    this.messageLimits.delete(attachment.actorId);
    const player = this.players.get(attachment.actorId);
    if (!player) return;

    // Disconnected people are retained only as private resume state. They leave
    // the visible field immediately so every remaining client can play the
    // winged goodbye instead of turning the avatar into sleeping scenery.
    Object.assign(player, { sleeping: true, vx: 0, vz: 0, lastSeenAt: Date.now() });
    let releasedStone: StoneState | undefined;
    if (player.carrying) {
      const stone = this.stones.get(player.carrying);
      if (stone) {
        Object.assign(stone, { x: player.x, z: player.z, holderId: null });
        releasedStone = stone;
        this.broadcast({ t: "stone", op: "upsert", stone });
      }
      player.carrying = null;
    }
    this.dirtyPlayers.delete(player.id);
    this.dirtyProfiles.delete(player.id);
    this.persistPlayers.delete(player.id);
    this.broadcast({ t: "player_leave", playerId: player.id });
    await Promise.all([
      this.ctx.storage.put(`player:${player.id}`, player),
      ...(releasedStone
        ? [this.ctx.storage.put(`stone:${releasedStone.id}`, releasedStone)]
        : []),
    ]);
    await this.pruneSleeping(Date.now());
    this.reportRoom();
    if (this.activeCount() === 0 && this.pitSubscribed) {
      await this.unsubscribePit();
    }
  }

  private scheduleFrame() {
    if (this.flushTimer !== null) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.ctx.waitUntil(this.flushFrame());
    }, FRAME_INTERVAL_MS);
  }

  private enqueueRoomTask<T>(task: () => Promise<T>) {
    const result = this.actionQueue.then(task);
    this.actionQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async flushFrame() {
    const changed = [...this.dirtyPlayers];
    this.dirtyPlayers.clear();
    if (changed.length) {
      const profiles = this.dirtyProfiles;
      this.dirtyProfiles = new Set<string>();
      this.broadcast({
        t: "frame",
        serverTime: Date.now(),
        players: changed
          .map((id) => this.players.get(id))
          .filter(Boolean)
          .map((player) => {
            const value = publicPlayer(player!);
            if (profiles.has(value.id)) return value;
            return {
              id: value.id,
              x: value.x,
              z: value.z,
              vx: value.vx,
              vz: value.vz,
              heading: value.heading,
              carrying: value.carrying,
              sleeping: value.sleeping,
            };
          }),
      });
    }
    if (this.persistPlayers.size) {
      const records: Record<string, StoredPlayer> = {};
      for (const actorId of this.persistPlayers) {
        const player = this.players.get(actorId);
        if (player) records[`player:${actorId}`] = player;
      }
      this.persistPlayers.clear();
      if (Object.keys(records).length) await this.ctx.storage.put(records);
    }
  }

  private welcomePlayers(self: StoredPlayer) {
    return [...this.players.values()]
      .filter((player) => !player.sleeping)
      .sort(
        (left, right) =>
          Math.hypot(left.x - self.x, left.z - self.z) -
          Math.hypot(right.x - self.x, right.z - self.z),
      )
      .map(publicPlayer);
  }

  private createStones() {
    const stones: StoneState[] = [];
    for (let index = 0; index < FIELD_STONE_COUNT; index += 1) {
      const descriptor = getStoneDescriptor(index, 0, this.pit);
      stones.push({ id: descriptor.id, x: descriptor.x, z: descriptor.z, generation: 0, holderId: null });
    }
    return stones;
  }

  /** Keeps a fixed-size pool useful without growing room state over time. */
  private replenishNearbyStones(excludedStoneId?: string) {
    let nearbyCount = 0;
    const recyclable: StoneState[] = [];
    for (const stone of this.stones.values()) {
      if (stone.holderId) continue;
      if (isNearPitStonePosition(stone.x, stone.z, this.pit)) nearbyCount += 1;
      else if (stone.id !== excludedStoneId) recyclable.push(stone);
    }
    if (nearbyCount >= MIN_NEAR_PIT_STONES) return [];

    recyclable.sort((left, right) => {
      const distanceOrder = Math.hypot(right.x, right.z) - Math.hypot(left.x, left.z);
      return distanceOrder || left.id.localeCompare(right.id);
    });
    const changed: StoneState[] = [];
    for (const stone of recyclable) {
      if (nearbyCount >= MIN_NEAR_PIT_STONES) break;
      const index = parseStoneIndex(stone.id);
      if (index === null) continue;
      const descriptor = getStoneDescriptor(
        index,
        getNextNearbyStoneGeneration(stone.generation),
        this.pit,
      );
      Object.assign(stone, {
        x: descriptor.x,
        z: descriptor.z,
        generation: descriptor.generation,
        holderId: null,
      });
      changed.push(stone);
      nearbyCount += 1;
    }
    return changed;
  }

  private activeCount() {
    let count = 0;
    for (const player of this.players.values()) if (!player.sleeping) count += 1;
    return count;
  }

  private sleepingCount() {
    let count = 0;
    for (const player of this.players.values()) if (player.sleeping) count += 1;
    return count;
  }

  private reservationsNotAlreadyActive() {
    let count = 0;
    const now = Date.now();
    for (const [actorId, reservation] of this.reservations) {
      if (
        reservation.expiresAt > now &&
        this.players.get(actorId)?.sleeping !== false
      ) {
        count += 1;
      }
    }
    return count;
  }

  private cleanupReservations() {
    const now = Date.now();
    for (const [actorId, reservation] of this.reservations) {
      if (reservation.expiresAt <= now) this.reservations.delete(actorId);
    }
  }

  private persistReservations() {
    const entries = Object.fromEntries(this.reservations) as ReservationStore;
    return this.ctx.storage.put("reservations", entries);
  }

  private async pruneSleeping(now: number, scheduleAlarm = true) {
    const sleepers = [...this.players.values()]
      .filter((player) => player.sleeping)
      .sort((left, right) => right.lastSeenAt - left.lastSeenAt);
    const expired: string[] = [];
    for (let index = 0; index < sleepers.length; index += 1) {
      const player = sleepers[index];
      if (
        !Number.isFinite(player.lastSeenAt) ||
        now - player.lastSeenAt >= SLEEP_RETENTION_MS ||
        index >= ROOM_SLEEPER_HARD_LIMIT
      ) {
        const actorId = player.id;
        this.players.delete(actorId);
        this.connections.delete(actorId);
        this.lastPersistAt.delete(actorId);
        this.dirtyPlayers.delete(actorId);
        this.dirtyProfiles.delete(actorId);
        this.persistPlayers.delete(actorId);
        this.chatLimits.delete(actorId);
        this.profileLimits.delete(actorId);
        this.moveLimits.delete(actorId);
        this.actionLimits.delete(actorId);
        this.messageLimits.delete(actorId);
        expired.push(`player:${actorId}`);
        this.broadcast({ t: "player_leave", playerId: actorId });
      }
    }
    if (expired.length) await deleteStorageKeys(this.ctx.storage, expired);
    if (scheduleAlarm) await this.scheduleNextFieldAlarm(now);
    return expired.length;
  }

  private nextFieldAlarmAt() {
    let nextExpiry: number | null = null;
    for (const player of this.players.values()) {
      if (!player.sleeping || !Number.isFinite(player.lastSeenAt)) continue;
      const expiresAt = player.lastSeenAt + SLEEP_RETENTION_MS;
      if (nextExpiry === null || expiresAt < nextExpiry) nextExpiry = expiresAt;
    }
    if (this.pitRetryAt === null) return nextExpiry;
    if (nextExpiry === null) return this.pitRetryAt;
    return Math.min(nextExpiry, this.pitRetryAt);
  }

  private async scheduleNextFieldAlarm(now: number, replace = false) {
    const nextAlarm = this.nextFieldAlarmAt();
    if (nextAlarm === null) {
      if (replace) await this.ctx.storage.deleteAlarm();
      return;
    }

    const alarmAt = Math.max(now + 1, nextAlarm);
    if (replace) {
      await this.ctx.storage.setAlarm(alarmAt);
      return;
    }
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > alarmAt) await this.ctx.storage.setAlarm(alarmAt);
  }

  private reportRoom() {
    if (!this.roomId || !this.directoryId) return;
    const lobby = this.env.LOBBY.get(this.env.LOBBY.idFromName(this.directoryId));
    this.ctx.waitUntil(
      lobby
        .fetch("https://lobby/report", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roomId: this.roomId,
            active: this.activeCount(),
            reserved: this.reservationsNotAlreadyActive(),
            sleepers: this.sleepingCount(),
          }),
        })
        .then(() => undefined)
        .catch(() => undefined),
    );
  }

  private async ensurePitSubscription() {
    if (this.pitSubscribed) {
      return this.pit;
    }
    if (this.pitSubscribePromise) return this.pitSubscribePromise;
    this.pitSubscribePromise = this.subscribePit();
    try {
      const state = await this.pitSubscribePromise;
      this.pitSubscribed = true;
      await this.clearPitRetry();
      return state;
    } finally {
      this.pitSubscribePromise = null;
    }
  }

  private async subscribePit() {
    const pit = this.env.PIT.get(this.env.PIT.idFromName("global-pit"));
    const response = await pit.fetch("https://pit/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId: this.roomId }),
    });
    if (!response.ok) throw new Error("pit-subscribe-failed");
    const state = (await response.json()) as PitState;
    await this.applyPitState(state);
    return this.pit;
  }

  private async applyPitState(update: { count: number; capacity?: number; pit?: PitState }) {
    const incoming = isPitState(update) ? update : isPitState(update.pit) ? update.pit : migrateLegacyPitState(update.count, this.pit.startedAt);
    if (incoming.totalStones < this.pit.totalStones) return;
    const moved = incoming.round !== this.pit.round;
    this.pit = incoming;
    const records: Record<string, unknown> = { "pit-state": this.pit, "pit-count": this.pit.count };
    if (moved) {
      // Keep every visitor outside the new excavation, including someone who
      // happened to be standing where it appeared.
      for (const player of this.players.values()) {
        const safe = clampPositionOutsidePit(player.x, player.z, this.pit);
        if (safe.x !== player.x || safe.z !== player.z) {
          Object.assign(player, safe, { vx: 0, vz: 0 });
          records[`player:${player.id}`] = player;
          this.dirtyPlayers.add(player.id);
        }
      }
      for (const stone of this.stones.values()) {
        if (stone.holderId) continue;
        const index = parseStoneIndex(stone.id);
        if (index === null) continue;
        const descriptor = getStoneDescriptor(index, stone.generation + 1, this.pit);
        Object.assign(stone, { x: descriptor.x, z: descriptor.z, generation: descriptor.generation });
        records[`stone:${stone.id}`] = stone;
        this.broadcast({ t: "stone", op: "upsert", stone });
      }
      this.scheduleFrame();
      this.broadcast({ t: "pit", count: this.pit.count, capacity: this.pit.capacity, pit: this.pit });
    }
    await putStorageRecords(this.ctx.storage, records);
  }

  private async unsubscribePit() {
    const pit = this.env.PIT.get(this.env.PIT.idFromName("global-pit"));
    this.pitSubscribed = false;
    try {
      await pit.fetch("https://pit/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ roomId: this.roomId }),
      });
    } catch {
      // A future connection will re-subscribe idempotently. Fan-out also prunes
      // rooms that report no active sockets on the next global update.
    }
    // A connection can race the awaited unsubscribe. Re-register afterward so
    // the final state reflects current presence, regardless of request order.
    if (this.activeCount() > 0) {
      this.pitSubscribed = false;
      try {
        await this.ensurePitSubscription();
      } catch {
        await this.schedulePitRetry();
      }
    }
  }

  private async schedulePitRetry() {
    if (this.activeCount() === 0) return;
    const now = Date.now();
    if (this.pitRetryAt !== null && this.pitRetryAt > now) {
      await this.scheduleNextFieldAlarm(now);
      return;
    }
    this.pitRetryAt = now + this.pitRetryMs;
    this.pitRetryMs = Math.min(30_000, this.pitRetryMs * 2);
    await this.ctx.storage.put({
      "pit-retry-at": this.pitRetryAt,
      "pit-retry-ms": this.pitRetryMs,
    });
    await this.scheduleNextFieldAlarm(now);
  }

  private async clearPitRetry() {
    const hadRetry = this.pitRetryAt !== null || this.pitRetryMs !== 1_000;
    this.pitRetryAt = null;
    this.pitRetryMs = 1_000;
    if (!hadRetry) return;
    await this.ctx.storage.delete(["pit-retry-at", "pit-retry-ms"]);
    await this.scheduleNextFieldAlarm(Date.now(), true);
  }

  private broadcast(value: unknown) {
    const encoded = JSON.stringify(value);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(encoded);
      } catch {
        // The close callback owns player cleanup.
      }
    }
  }

  private send(socket: WebSocket, value: unknown) {
    try {
      socket.send(JSON.stringify(value));
    } catch {
      // A raced close is harmless.
    }
  }
}

function pitFanoutShard(roomId: string) {
  return stableShard(roomId, PIT_FANOUT_SHARDS);
}
