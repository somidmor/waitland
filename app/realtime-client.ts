"use client";

/**
 * Browser transport for the Waitland realtime service.
 *
 * The game deliberately talks to this small adapter instead of using WebSocket
 * directly.  That keeps rendering independent from reconnects, protocol
 * details, and the anonymous resume token stored on this device.
 */

export const REALTIME_PROTOCOL_VERSION = 1 as const;
export const MAX_MOVEMENT_RATE_HZ = 8 as const;

const CONFIG_PATH = "/api/multiplayer/config";
const RESUME_STORAGE_KEY = "waiting-pit-realtime-resume-v1";
const MOVE_INTERVAL_MS = 1_000 / MAX_MOVEMENT_RATE_HZ;
const HEARTBEAT_INTERVAL_MS = 15_000;
const CONNECTION_STALE_MS = 45_000;
const WELCOME_TIMEOUT_MS = 12_000;
const HTTP_REQUEST_TIMEOUT_MS = 15_000;
const MAX_INBOUND_BYTES = 512 * 1_024;
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 15_000;
const DEFAULT_RATE_LIMIT_RETRY_MS = 10_000;
const MAX_SERVER_RETRY_MS = 60_000;

export type RealtimeConnectionState =
  | "idle"
  | "connecting"
  | "online"
  | "offline"
  | "replaced"
  | "incompatible"
  | "unsupported"
  | "closed";

export interface RealtimeStatus {
  state: RealtimeConnectionState;
  attempt: number;
  reason?: string;
  retryInMs?: number;
}

export interface RealtimeProfileInput {
  name: string;
  city: string;
  countryCode: string;
  countryFlag?: string;
  waitReason?: string;
  reasonId?: string;
  reasonText?: string;
}

export interface RealtimeProfile {
  name: string;
  city: string;
  countryCode: string;
  countryFlag: string;
  waitReason: string;
}

export interface MultiplayerConfig {
  enabled: boolean;
  protocolVersion: number;
  realtimeOrigin?: string;
  reason?: "not-configured" | "invalid-configuration";
}

export interface RealtimeSession {
  actorId: string;
  resumeToken: string;
  roomId: string;
  wsUrl: string;
  capacity: number;
  count: number;
}

export interface RealtimeMovement {
  x: number;
  z: number;
  heading: number;
  vx?: number;
  vz?: number;
}

export interface RealtimePlayer extends RealtimeMovement {
  id: string;
  carrying?: string | boolean | null;
  sleeping?: boolean;
  profile: RealtimeProfile;
}

export interface RealtimePlayerDelta extends RealtimeMovement {
  id: string;
  carrying?: string | boolean | null;
  sleeping?: boolean;
  profile?: RealtimeProfile;
}

export interface RealtimeStone {
  id: string;
  x: number;
  z: number;
  generation?: number;
  holderId: string | null;
}

export interface WelcomeMessage {
  t: "welcome";
  protocol: number;
  selfId: string;
  roomId: string;
  count: number;
  capacity: number;
  players: RealtimePlayer[];
  stones: RealtimeStone[];
  serverTime: number;
}

export interface FrameMessage {
  t: "frame";
  serverTime: number;
  players: RealtimePlayerDelta[];
}

export interface ChatMessage {
  t: "chat";
  playerId: string;
  id: string;
  text: string;
  expiresAt: number;
}

export interface StoneMessage {
  t: "stone";
  op: "upsert" | "remove";
  stone?: RealtimeStone;
  stoneId?: string;
}

export interface PitMessage {
  t: "pit";
  count: number;
  capacity: number;
}

export interface ActionResultMessage {
  t: "action";
  id: string;
  ok: boolean;
  kind: "pickup" | "throw";
  reason?: string;
  deposited?: boolean;
  count?: number;
}

export interface PongMessage {
  t: "pong";
  at?: number;
  serverTime?: number;
}

export interface ServerErrorMessage {
  t: "error";
  code: string;
  message?: string;
}

export interface PlayerEventMessage {
  t: "player_join" | "player_leave" | "player_sleep";
  playerId: string;
  player?: RealtimePlayer;
}

export interface UnknownServerMessage {
  t: string;
  [key: string]: unknown;
}

export type ServerMessage =
  | WelcomeMessage
  | FrameMessage
  | ChatMessage
  | StoneMessage
  | PitMessage
  | ActionResultMessage
  | PongMessage
  | ServerErrorMessage
  | PlayerEventMessage
  | UnknownServerMessage;

export interface RealtimeError {
  source: "transport" | "server";
  code: string;
  message: string;
  recoverable: boolean;
}

export interface RealtimeEventMap {
  status: RealtimeStatus;
  session: RealtimeSession;
  welcome: WelcomeMessage;
  frame: FrameMessage;
  chat: ChatMessage;
  stone: StoneMessage;
  pit: PitMessage;
  action: ActionResultMessage;
  player: PlayerEventMessage;
  pong: PongMessage;
  error: RealtimeError;
  message: ServerMessage;
}

export interface RealtimeClientCallbacks {
  onStatus?: (status: RealtimeStatus) => void;
  onSession?: (session: RealtimeSession) => void;
  onWelcome?: (message: WelcomeMessage) => void;
  onFrame?: (message: FrameMessage) => void;
  onChat?: (message: ChatMessage) => void;
  onStone?: (message: StoneMessage) => void;
  onPit?: (message: PitMessage) => void;
  onAction?: (message: ActionResultMessage) => void;
  onPlayer?: (message: PlayerEventMessage) => void;
  onError?: (error: RealtimeError) => void;
  onMessage?: (message: ServerMessage) => void;
}

export interface RealtimeClientOptions extends RealtimeClientCallbacks {
  profile: RealtimeProfileInput;
  configPath?: string;
  fetchImpl?: typeof fetch;
  webSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
}

type ClientMovementMessage = RealtimeMovement & { t: "move"; seq: number };
type ClientChatMessage = { t: "chat"; id: string; text: string };
type ClientActionMessage = {
  t: "pickup" | "throw";
  id: string;
  stoneId: string;
};
type ClientProfileMessage = { t: "profile"; profile: RealtimeProfile };
type ClientPingMessage = { t: "ping" };
type ClientMessage =
  | ClientMovementMessage
  | ClientChatMessage
  | ClientActionMessage
  | ClientProfileMessage
  | ClientPingMessage;

type Listener<K extends keyof RealtimeEventMap> = (event: RealtimeEventMap[K]) => void;
type StoredResume = Pick<RealtimeSession, "actorId" | "resumeToken" | "roomId">;

class RealtimeRequestTimeoutError extends Error {
  readonly code = "request_timeout";

  constructor() {
    super("The connection is slow. Trying again…");
  }
}

class RealtimeHttpError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactText(value: string, maxLength: number) {
  return value.trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function flagFromCountryCode(countryCode: string) {
  const normalized = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌍";
  return String.fromCodePoint(
    ...Array.from(normalized).map((letter) => 127397 + letter.charCodeAt(0)),
  );
}

function normalizeProfile(profile: RealtimeProfileInput): RealtimeProfile {
  const countryCode = compactText(profile.countryCode, 2).toUpperCase();
  return {
    name: compactText(profile.name, 24) || "Someone",
    city: compactText(profile.city, 60) || "Somewhere",
    countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "XX",
    countryFlag: compactText(profile.countryFlag ?? "", 8) || flagFromCountryCode(countryCode),
    waitReason:
      compactText(profile.waitReason ?? profile.reasonText ?? profile.reasonId ?? "waiting", 50) ||
      "waiting",
  };
}

function finiteNumber(value: number, fallback = 0) {
  return Number.isFinite(value) ? value : fallback;
}

function normalizeHeading(value: number) {
  const heading = finiteNumber(value);
  return Math.atan2(Math.sin(heading), Math.cos(heading));
}

function makeMessageId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readResume(): StoredResume | undefined {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RESUME_STORAGE_KEY) ?? "null") as unknown;
    if (
      isObject(parsed) &&
      typeof parsed.actorId === "string" &&
      typeof parsed.resumeToken === "string" &&
      typeof parsed.roomId === "string"
    ) {
      return {
        actorId: parsed.actorId,
        resumeToken: parsed.resumeToken,
        roomId: parsed.roomId,
      };
    }
  } catch {
    // Anonymous play still works when storage is blocked.
  }
  return undefined;
}

function writeResume(session: RealtimeSession) {
  try {
    window.localStorage.setItem(
      RESUME_STORAGE_KEY,
      JSON.stringify({
        actorId: session.actorId,
        resumeToken: session.resumeToken,
        roomId: session.roomId,
      } satisfies StoredResume),
    );
  } catch {
    // The current connection remains usable without persistence.
  }
}

function clearResume() {
  try {
    window.localStorage.removeItem(RESUME_STORAGE_KEY);
  } catch {
    // Nothing else to do when storage is blocked.
  }
}

function parseRealtimeOrigin(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
      return undefined;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function parseWebSocketUrl(value: unknown) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash) return undefined;
    if (url.protocol !== "wss:" && url.protocol !== "ws:") return undefined;
    if (url.protocol === "ws:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function parseSession(value: unknown): RealtimeSession | undefined {
  if (!isObject(value)) return undefined;
  const wsUrl = parseWebSocketUrl(value.wsUrl);
  if (
    typeof value.actorId !== "string" ||
    typeof value.resumeToken !== "string" ||
    typeof value.roomId !== "string" ||
    !wsUrl ||
    typeof value.capacity !== "number" ||
    typeof value.count !== "number"
  ) {
    return undefined;
  }
  return {
    actorId: value.actorId,
    resumeToken: value.resumeToken,
    roomId: value.roomId,
    wsUrl,
    capacity: Math.max(0, Math.floor(value.capacity)),
    count: Math.max(0, Math.floor(value.count)),
  };
}

function retryAfterMilliseconds(response: Response) {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    return Math.min(MAX_SERVER_RETRY_MS, Math.max(0, seconds * 1_000));
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(MAX_SERVER_RETRY_MS, Math.max(0, date - Date.now()));
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
) {
  const parentSignal = init.signal;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromParent = () => controller.abort();

  if (parentSignal?.aborted) controller.abort();
  else parentSignal?.addEventListener("abort", abortFromParent, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new RealtimeRequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abortFromParent);
  }
}

function sessionHttpError(response: Response) {
  const retryAfterMs =
    retryAfterMilliseconds(response) ??
    (response.status === 429 ? DEFAULT_RATE_LIMIT_RETRY_MS : undefined);
  if (response.status === 429) {
    return new RealtimeHttpError(
      "session_rate_limited",
      "The field is busy. Trying again shortly…",
      retryAfterMs,
    );
  }
  if (response.status >= 500) {
    return new RealtimeHttpError(
      `session_${response.status}`,
      "The field is waking up. Trying again…",
      retryAfterMs,
    );
  }
  return new RealtimeHttpError(
    `session_${response.status}`,
    `Session request failed (${response.status})`,
    retryAfterMs,
  );
}

function canonicalMessage(value: unknown): ServerMessage | undefined {
  if (!isObject(value)) return undefined;
  const rawType = typeof value.t === "string" ? value.t : typeof value.type === "string" ? value.type : "";
  if (!rawType) return undefined;

  const aliases: Record<string, string> = {
    "player:join": "player_join",
    "player:joined": "player_join",
    player_joined: "player_join",
    join: "player_join",
    "player:leave": "player_leave",
    "player:left": "player_leave",
    player_left: "player_leave",
    leave: "player_leave",
    "player:sleep": "player_sleep",
    player_sleeping: "player_sleep",
    "world:frame": "frame",
    player_frame: "frame",
    speech: "chat",
    "stone:update": "stone",
    stone_update: "stone",
    "pit:update": "pit",
    pit_update: "pit",
    heartbeat_ack: "pong",
  };
  const t = aliases[rawType] ?? rawType;
  const nested = isObject(value.data) ? value.data : undefined;
  return { ...(nested ?? {}), ...value, t } as ServerMessage;
}

export async function loadMultiplayerConfig(
  configPath = CONFIG_PATH,
  fetchImpl: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<MultiplayerConfig> {
  const response = await fetchImpl(configPath, {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`Config request failed (${response.status})`);
  const value = (await response.json()) as unknown;
  if (!isObject(value) || typeof value.enabled !== "boolean") {
    throw new Error("Invalid multiplayer config response");
  }
  const realtimeOrigin = parseRealtimeOrigin(
    value.realtimeOrigin ?? value.origin ?? value.baseUrl,
  );
  const enabled = value.enabled && Boolean(realtimeOrigin);
  return {
    enabled,
    protocolVersion:
      typeof value.protocolVersion === "number" ? value.protocolVersion : REALTIME_PROTOCOL_VERSION,
    realtimeOrigin,
    ...(!enabled
      ? {
          reason:
            value.reason === "invalid-configuration"
              ? ("invalid-configuration" as const)
              : ("not-configured" as const),
        }
      : {}),
  };
}

export class RealtimeClient {
  private profile: RealtimeProfile;
  private readonly configPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly WebSocketImpl?: typeof WebSocket;
  private readonly requestTimeoutMs: number;
  private readonly listeners = new Map<keyof RealtimeEventMap, Set<(value: never) => void>>();
  private socket?: WebSocket;
  private abortController?: AbortController;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private movementTimer?: ReturnType<typeof setTimeout>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private welcomeTimer?: ReturnType<typeof setTimeout>;
  private pendingMovement?: RealtimeMovement;
  private lastMovementSentAt = 0;
  private lastInboundAt = 0;
  private movementSequence = 0;
  private attempt = 0;
  private generation = 0;
  private started = false;
  private suspended = false;
  private blockedByReplacement = false;
  private blockedByProtocol = false;
  private permanentlyClosed = false;
  private timeoutRecoveryUntil = 0;
  private statusValue: RealtimeStatus = { state: "idle", attempt: 0 };
  private sessionValue?: RealtimeSession;
  private realtimeOrigin?: string;

  constructor(options: RealtimeClientOptions) {
    this.profile = normalizeProfile(options.profile);
    this.configPath = options.configPath ?? CONFIG_PATH;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.WebSocketImpl =
      options.webSocketImpl ?? (typeof WebSocket === "undefined" ? undefined : WebSocket);
    this.requestTimeoutMs = Math.max(
      1,
      Math.floor(options.requestTimeoutMs ?? HTTP_REQUEST_TIMEOUT_MS),
    );

    const callbacks: Array<[keyof RealtimeEventMap, ((event: never) => void) | undefined]> = [
      ["status", options.onStatus as ((event: never) => void) | undefined],
      ["session", options.onSession as ((event: never) => void) | undefined],
      ["welcome", options.onWelcome as ((event: never) => void) | undefined],
      ["frame", options.onFrame as ((event: never) => void) | undefined],
      ["chat", options.onChat as ((event: never) => void) | undefined],
      ["stone", options.onStone as ((event: never) => void) | undefined],
      ["pit", options.onPit as ((event: never) => void) | undefined],
      ["action", options.onAction as ((event: never) => void) | undefined],
      ["player", options.onPlayer as ((event: never) => void) | undefined],
      ["error", options.onError as ((event: never) => void) | undefined],
      ["message", options.onMessage as ((event: never) => void) | undefined],
    ];
    for (const [event, callback] of callbacks) {
      if (callback) this.addRawListener(event, callback);
    }
  }

  get status() {
    return this.statusValue;
  }

  get session() {
    return this.sessionValue;
  }

  get isOnline() {
    return this.statusValue.state === "online";
  }

  on<K extends keyof RealtimeEventMap>(event: K, listener: Listener<K>) {
    this.addRawListener(event, listener as (value: never) => void);
    return () => {
      this.listeners.get(event)?.delete(listener as (value: never) => void);
    };
  }

  async start() {
    if (this.started && !this.permanentlyClosed) return;
    this.started = true;
    this.suspended = false;
    this.blockedByReplacement = false;
    this.blockedByProtocol = false;
    this.permanentlyClosed = false;
    this.timeoutRecoveryUntil = 0;

    if (
      typeof window === "undefined" ||
      typeof AbortController === "undefined" ||
      !this.WebSocketImpl
    ) {
      this.setStatus("unsupported", "WebSocket is not available in this browser.");
      return;
    }

    window.addEventListener("online", this.handleBrowserOnline);
    window.addEventListener("offline", this.handleBrowserOffline);
    window.addEventListener("pagehide", this.handlePageHide);
    window.addEventListener("pageshow", this.handlePageShow);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);

    if (document.visibilityState === "hidden") {
      this.sleep("hidden");
      return;
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline", "This device is offline.");
      return;
    }
    await this.connect();
  }

  setProfile(profile: RealtimeProfileInput) {
    this.profile = normalizeProfile(profile);
    if (this.isOnline) this.send({ t: "profile", profile: this.profile });
  }

  sendMovement(movement: RealtimeMovement) {
    this.pendingMovement = {
      x: finiteNumber(movement.x),
      z: finiteNumber(movement.z),
      heading: normalizeHeading(movement.heading),
      ...(movement.vx === undefined ? {} : { vx: finiteNumber(movement.vx) }),
      ...(movement.vz === undefined ? {} : { vz: finiteNumber(movement.vz) }),
    };
    this.flushOrScheduleMovement();
  }

  /** Bypass the ordinary movement throttle for a final pose or stop update. */
  sendMovementImmediately(movement: RealtimeMovement) {
    this.sendMovement(movement);
    this.flushMovementImmediately();
  }

  sendChat(text: string) {
    const cleanText = compactText(text, 80);
    if (!cleanText) return undefined;
    const id = makeMessageId();
    return this.send({ t: "chat", id, text: cleanText }) ? id : undefined;
  }

  sendAction(kind: "pickup" | "throw", stoneId: string) {
    const cleanStoneId = compactText(stoneId, 96);
    if (!cleanStoneId) return undefined;
    // WebSocket ordering guarantees this latest predicted pose reaches the
    // authority before the action. This avoids boundary rejections caused by
    // waiting for the next ordinary 125 ms movement slot.
    this.flushMovementImmediately();
    const id = makeMessageId();
    return this.send({ t: kind, id, stoneId: cleanStoneId }) ? id : undefined;
  }

  pickup(stoneId: string) {
    return this.sendAction("pickup", stoneId);
  }

  throwStone(stoneId: string) {
    return this.sendAction("throw", stoneId);
  }

  /** Tell the server to keep the avatar asleep at its last accepted position. */
  sleep(reason = "sleep") {
    if (
      this.permanentlyClosed ||
      this.suspended ||
      this.blockedByReplacement ||
      this.blockedByProtocol
    ) return;
    this.suspended = true;
    // A page can hide while its session request is still in flight. Invalidate
    // that generation as well as an open socket so it cannot finish joining in
    // the background after the avatar has been put to sleep.
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.clearTimers();
    // Closing the socket is the authoritative sleep signal. Unlike an unload
    // fetch, a WebSocket close is observed reliably by the room Durable Object.
    this.closeSocket(1000, reason.slice(0, 80));
    this.setStatus("offline", "Sleeping until this page returns.");
  }

  wake() {
    if (
      !this.started ||
      this.permanentlyClosed ||
      !this.suspended ||
      this.blockedByReplacement ||
      this.blockedByProtocol
    ) return;
    this.suspended = false;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline", "This device is offline.");
      return;
    }
    void this.connect();
  }

  stop(options: { sleep?: boolean } = { sleep: true }) {
    if (this.permanentlyClosed) return;
    this.permanentlyClosed = true;
    this.started = false;
    this.suspended = false;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.clearTimers();
    this.closeSocket(1000, options.sleep === false ? "closed" : "sleep");
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.handleBrowserOnline);
      window.removeEventListener("offline", this.handleBrowserOffline);
      window.removeEventListener("pagehide", this.handlePageHide);
      window.removeEventListener("pageshow", this.handlePageShow);
      document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    }
    this.setStatus("closed", "Realtime client stopped.");
  }

  destroy() {
    this.stop();
    this.listeners.clear();
  }

  private addRawListener(event: keyof RealtimeEventMap, listener: (value: never) => void) {
    const existing = this.listeners.get(event);
    if (existing) existing.add(listener);
    else this.listeners.set(event, new Set([listener]));
  }

  private emit<K extends keyof RealtimeEventMap>(event: K, value: RealtimeEventMap[K]) {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(value as never);
      } catch {
        // A rendering callback must never take down the network loop.
      }
    }
  }

  private setStatus(state: RealtimeConnectionState, reason?: string, retryInMs?: number) {
    const next = { state, attempt: this.attempt, reason, retryInMs } satisfies RealtimeStatus;
    if (
      this.statusValue.state === next.state &&
      this.statusValue.attempt === next.attempt &&
      this.statusValue.reason === next.reason &&
      this.statusValue.retryInMs === next.retryInMs
    ) {
      return;
    }
    this.statusValue = next;
    this.emit("status", next);
  }

  private emitTransportError(code: string, message: string, recoverable = true) {
    this.emit("error", { source: "transport", code, message, recoverable });
  }

  private async connect() {
    if (
      !this.started ||
      this.permanentlyClosed ||
      this.suspended ||
      this.blockedByReplacement ||
      this.blockedByProtocol ||
      this.socket
    ) return;
    const generation = ++this.generation;
    this.clearReconnectTimer();
    this.abortController?.abort();
    const abortController = new AbortController();
    this.abortController = abortController;
    this.setStatus("connecting", this.attempt ? "Reconnecting…" : "Joining the field…");

    try {
      if (!this.realtimeOrigin) {
        const configFetch = ((input: RequestInfo | URL, init: RequestInit = {}) =>
          fetchWithTimeout(
            this.fetchImpl,
            input,
            init,
            this.requestTimeoutMs,
          )) as typeof fetch;
        const config = await loadMultiplayerConfig(
          this.configPath,
          configFetch,
          abortController.signal,
        );
        if (generation !== this.generation) return;
        if (!config.enabled || !config.realtimeOrigin) {
          this.setStatus(
            "unsupported",
            config.reason === "invalid-configuration"
              ? "Realtime is temporarily unavailable."
              : "Multiplayer is not enabled on this site yet.",
          );
          return;
        }
        if (config.protocolVersion !== REALTIME_PROTOCOL_VERSION) {
          this.blockForProtocol();
          return;
        }
        this.realtimeOrigin = config.realtimeOrigin;
      }

      const session = await this.createOrResumeSession(abortController.signal);
      if (generation !== this.generation) return;
      this.sessionValue = session;
      writeResume(session);
      this.emit("session", session);
      this.openSocket(session, generation);
    } catch (error) {
      if (generation !== this.generation) return;
      if (abortController.signal.aborted) return;
      const reason =
        error instanceof Error ? error.message : "Could not connect to multiplayer.";
      const code =
        error instanceof RealtimeHttpError || error instanceof RealtimeRequestTimeoutError
          ? error.code
          : "connect_failed";
      const retryAfterMs =
        error instanceof RealtimeHttpError ? error.retryAfterMs : undefined;
      this.emitTransportError(code, reason);
      this.scheduleReconnect(reason, retryAfterMs);
    } finally {
      if (this.abortController === abortController) this.abortController = undefined;
    }
  }

  private async createOrResumeSession(
    signal: AbortSignal,
    retryWithoutResume = true,
  ): Promise<RealtimeSession> {
    if (!this.realtimeOrigin) throw new Error("Realtime origin is unavailable");
    const resume = readResume();
    const response = await fetchWithTimeout(
      this.fetchImpl,
      new URL("/v1/session", this.realtimeOrigin),
      {
        method: "POST",
        mode: "cors",
        cache: "no-store",
        credentials: "omit",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          profile: this.profile,
          ...(resume?.resumeToken ? { resumeToken: resume.resumeToken } : {}),
        }),
        signal,
      },
      this.requestTimeoutMs,
    );

    if ((response.status === 401 || response.status === 403) && resume && retryWithoutResume) {
      clearResume();
      return this.createOrResumeSession(signal, false);
    }
    if (!response.ok) {
      throw sessionHttpError(response);
    }
    const session = parseSession((await response.json()) as unknown);
    if (!session) throw new Error("Realtime service returned an invalid session");
    return session;
  }

  private openSocket(session: RealtimeSession, generation: number) {
    if (!this.WebSocketImpl || generation !== this.generation) return;
    let socket: WebSocket;
    try {
      socket = new this.WebSocketImpl(session.wsUrl);
    } catch (error) {
      const message = error instanceof Error ? error.message : "WebSocket could not open.";
      this.emitTransportError("socket_open_failed", message);
      this.scheduleReconnect(message);
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    let openTimedOut = false;

    this.welcomeTimer = setTimeout(() => {
      if (socket !== this.socket || generation !== this.generation) return;
      openTimedOut = true;
      this.welcomeTimer = undefined;
      this.socket = undefined;
      // A browser can leave a CONNECTING WebSocket in limbo even after close().
      // Quarantine that attempt, start a fresh one, and briefly treat a 4001 on
      // the fresh socket as local timeout fallout rather than another browser tab.
      this.timeoutRecoveryUntil = Date.now() + CONNECTION_STALE_MS * 2;
      this.emitTransportError("socket_open_timeout", "The realtime socket did not open.");
      try {
        socket.close(4000, "open timeout");
      } catch {
        // The open handler below still closes the quarantined socket if it
        // eventually completes its handshake.
      }
      this.scheduleReconnect("The realtime socket did not open.");
    }, WELCOME_TIMEOUT_MS);

    socket.addEventListener("open", () => {
      if (openTimedOut) {
        try {
          socket.close(4000, "open timeout");
        } catch {
          // The socket will still reach its close/error path.
        }
        return;
      }
      if (socket !== this.socket || generation !== this.generation) return;
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.lastInboundAt = Date.now();
      this.startHeartbeat();
      this.welcomeTimer = setTimeout(() => {
        if (this.statusValue.state !== "online" && socket === this.socket) {
          this.emitTransportError("welcome_timeout", "The realtime service did not become ready.");
          socket.close(4000, "welcome timeout");
        }
      }, WELCOME_TIMEOUT_MS);
    });

    socket.addEventListener("message", (event) => {
      if (socket !== this.socket || generation !== this.generation) return;
      void this.receive(event.data);
    });

    socket.addEventListener("error", () => {
      if (socket !== this.socket || generation !== this.generation) return;
      this.emitTransportError("socket_error", "The realtime connection was interrupted.");
    });

    socket.addEventListener("close", (event) => {
      if (openTimedOut) {
        // Once the quarantined attempt has definitely closed, only a small
        // event-delivery grace period is needed for a resulting 4001.
        this.timeoutRecoveryUntil = Math.min(
          this.timeoutRecoveryUntil,
          Date.now() + 2_000,
        );
      }
      if (socket !== this.socket || generation !== this.generation) return;
      this.socket = undefined;
      this.stopHeartbeat();
      if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
      this.welcomeTimer = undefined;
      if (this.permanentlyClosed || this.suspended) return;
      if (event.code === 4001) {
        if (Date.now() < this.timeoutRecoveryUntil) {
          this.emitTransportError(
            "socket_replaced_during_timeout_recovery",
            "A previous connection attempt finished late; reconnecting.",
          );
          this.scheduleReconnect("Finishing a previous connection attempt…");
          return;
        }
        // The server uses 4001 only when a newer connection for this anonymous
        // actor wins. Do not let two tabs continuously evict and reconnect over
        // one shared localStorage resume token.
        this.blockedByReplacement = true;
        this.suspended = true;
        this.clearTimers();
        this.setStatus("replaced", "This field is already open in another tab.");
        return;
      }
      const reason = event.reason || (event.code === 4003 ? "The room is full or the session expired." : "Connection closed.");
      this.scheduleReconnect(reason);
    });
  }

  private async receive(data: unknown) {
    let text: string;
    if (typeof data === "string") {
      text = data;
    } else if (data instanceof ArrayBuffer) {
      if (data.byteLength > MAX_INBOUND_BYTES) return;
      text = new TextDecoder().decode(data);
    } else if (typeof Blob !== "undefined" && data instanceof Blob) {
      if (data.size > MAX_INBOUND_BYTES) return;
      text = await data.text();
    } else {
      return;
    }
    if (text.length > MAX_INBOUND_BYTES) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return;
    }
    this.lastInboundAt = Date.now();

    if (isObject(parsed)) {
      const rawType = parsed.t ?? parsed.type;
      if ((rawType === "batch" || rawType === "events") && Array.isArray(parsed.events ?? parsed.messages)) {
        for (const item of (parsed.events ?? parsed.messages) as unknown[]) this.dispatchMessage(item);
        return;
      }
    }
    this.dispatchMessage(parsed);
  }

  private dispatchMessage(value: unknown) {
    const message = canonicalMessage(value);
    if (!message) return;
    this.emit("message", message);

    switch (message.t) {
      case "welcome":
        if ((message as WelcomeMessage).protocol !== REALTIME_PROTOCOL_VERSION) {
          this.blockForProtocol();
          return;
        }
        if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
        this.welcomeTimer = undefined;
        if (this.movementTimer) clearTimeout(this.movementTimer);
        this.movementTimer = undefined;
        this.pendingMovement = undefined;
        this.movementSequence = 0;
        this.attempt = 0;
        this.setStatus("online", "Connected.");
        this.emit("welcome", message as WelcomeMessage);
        break;
      case "frame":
        this.emit("frame", message as FrameMessage);
        break;
      case "chat":
        this.emit("chat", message as ChatMessage);
        break;
      case "stone":
        this.emit("stone", message as StoneMessage);
        break;
      case "pit":
        this.emit("pit", message as PitMessage);
        break;
      case "action":
        this.emit("action", message as ActionResultMessage);
        break;
      case "player_join":
      case "player_leave":
      case "player_sleep":
        this.emit("player", message as PlayerEventMessage);
        break;
      case "pong":
        this.emit("pong", message as PongMessage);
        break;
      case "error": {
        const serverError = message as ServerErrorMessage;
        if (serverError.code === "protocol_mismatch") {
          this.blockForProtocol(serverError.message);
          return;
        }
        this.emit("error", {
          source: "server",
          code: serverError.code,
          message: serverError.message ?? serverError.code,
          recoverable: serverError.code !== "protocol_mismatch",
        });
        break;
      }
      default:
        break;
    }
  }

  private flushOrScheduleMovement() {
    if (!this.pendingMovement || !this.isSocketReady() || !this.isOnline) return;
    const elapsed = performance.now() - this.lastMovementSentAt;
    if (elapsed >= MOVE_INTERVAL_MS) {
      this.flushMovement();
      return;
    }
    if (this.movementTimer) return;
    this.movementTimer = setTimeout(() => {
      this.movementTimer = undefined;
      this.flushMovement();
    }, MOVE_INTERVAL_MS - elapsed);
  }

  private flushMovement() {
    if (!this.pendingMovement || !this.isSocketReady() || !this.isOnline) return;
    const movement = this.pendingMovement;
    this.pendingMovement = undefined;
    this.movementSequence += 1;
    if (this.send({ t: "move", seq: this.movementSequence, ...movement })) {
      this.lastMovementSentAt = performance.now();
    }
  }

  private flushMovementImmediately() {
    if (this.movementTimer) clearTimeout(this.movementTimer);
    this.movementTimer = undefined;
    this.flushMovement();
  }

  private send(message: ClientMessage) {
    if (!this.isSocketReady()) return false;
    try {
      this.socket?.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  private isSocketReady() {
    return this.socket?.readyState === this.WebSocketImpl?.OPEN;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.isSocketReady()) return;
      const now = Date.now();
      if (now - this.lastInboundAt > CONNECTION_STALE_MS) {
        this.emitTransportError("connection_stale", "The realtime connection stopped responding.");
        this.socket?.close(4000, "stale");
        return;
      }
      // Keep this payload byte-for-byte constant so Cloudflare can answer it
      // with a WebSocket auto-response without waking the hibernating room.
      this.send({ t: "ping" });
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private scheduleReconnect(reason: string, minimumDelayMs = 0) {
    if (
      !this.started ||
      this.permanentlyClosed ||
      this.suspended ||
      this.blockedByReplacement ||
      this.blockedByProtocol ||
      this.reconnectTimer
    ) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      this.setStatus("offline", "This device is offline.");
      return;
    }
    this.attempt += 1;
    const ceiling = Math.min(RECONNECT_CAP_MS, RECONNECT_BASE_MS * 2 ** Math.min(this.attempt, 8));
    const jitteredDelay = Math.round(ceiling * (0.5 + Math.random() * 0.5));
    const delay = Math.max(
      jitteredDelay,
      Math.min(MAX_SERVER_RETRY_MS, Math.max(0, minimumDelayMs)),
    );
    this.setStatus("offline", reason, delay);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private clearTimers() {
    this.clearReconnectTimer();
    if (this.movementTimer) clearTimeout(this.movementTimer);
    if (this.welcomeTimer) clearTimeout(this.welcomeTimer);
    this.movementTimer = undefined;
    this.welcomeTimer = undefined;
    this.stopHeartbeat();
  }

  private blockForProtocol(message?: string) {
    if (this.blockedByProtocol) return;
    this.blockedByProtocol = true;
    this.suspended = true;
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.clearTimers();
    this.closeSocket(4002, "protocol mismatch");
    this.setStatus("incompatible", "Refresh this page to join multiplayer.");
    this.emit("error", {
      source: "server",
      code: "protocol_mismatch",
      message: message ?? "The site and realtime service use different protocol versions.",
      recoverable: false,
    });
  }

  private closeSocket(code: number, reason: string) {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    try {
      socket.close(code, reason);
    } catch {
      // It is already closed.
    }
  }

  private readonly handleBrowserOnline = () => {
    if (
      !this.started ||
      this.permanentlyClosed ||
      this.suspended ||
      this.blockedByReplacement ||
      this.blockedByProtocol
    ) return;
    this.clearReconnectTimer();
    void this.connect();
  };

  private readonly handleBrowserOffline = () => {
    // Prevent an in-flight session response from opening a socket after the
    // browser has already told us it is offline.
    this.generation += 1;
    this.abortController?.abort();
    this.abortController = undefined;
    this.clearTimers();
    this.closeSocket(4000, "offline");
    this.setStatus("offline", "This device is offline.");
  };

  private readonly handlePageHide = () => {
    if (!this.permanentlyClosed) this.sleep("pagehide");
  };

  private readonly handlePageShow = () => {
    if (this.started && this.suspended && !this.permanentlyClosed) this.wake();
  };

  private readonly handleVisibilityChange = () => {
    if (document.visibilityState === "hidden") this.sleep("hidden");
    else if (this.started && this.suspended && !this.permanentlyClosed) this.wake();
  };
}
