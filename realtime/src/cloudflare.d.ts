/**
 * Lightweight platform declarations for the Node-based unit-test build.
 * Production Worker code is checked separately against the generated Wrangler
 * environment and the current @cloudflare/workers-types package.
 */

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub<T = unknown> {
  /** Type-only marker matching the RPC target carried by the platform stub. */
  readonly __rpcTarget?: T;
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
}

interface DurableObjectNamespace<T = unknown> {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub<T>;
}

interface DurableObjectTransaction {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

interface DurableObjectStorage {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  delete(keys: string[]): Promise<number>;
  list<T = unknown>(options?: { prefix?: string; limit?: number }): Promise<Map<string, T>>;
  transaction<T>(closure: (txn: DurableObjectTransaction) => Promise<T>): Promise<T>;
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
}

interface WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown | null;
}

interface DurableObjectState {
  readonly id: DurableObjectId;
  readonly storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T>;
  acceptWebSocket(socket: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
  setWebSocketAutoResponse(pair?: WebSocketRequestResponsePair): void;
  waitUntil(promise: Promise<unknown>): void;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

interface ExportedHandler<Env = unknown> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Response | Promise<Response>;
}

declare module "cloudflare:workers" {
  export abstract class DurableObject<Env = Cloudflare.Env> {
    protected ctx: DurableObjectState;
    protected env: Env;
    constructor(ctx: DurableObjectState, env: Env);
  }
}

declare class WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

declare class WebSocketRequestResponsePair {
  constructor(request: string, response: string);
}
