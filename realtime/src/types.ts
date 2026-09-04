import type { PitState, StoneDescriptor } from "../../shared/world.ts";

export type Env = Cloudflare.Env;

export type PublicProfile = {
  name: string;
  city: string;
  countryCode: string;
  countryFlag: string;
  waitReason: string;
};

export type PublicPlayer = {
  id: string;
  x: number;
  z: number;
  vx: number;
  vz: number;
  heading: number;
  carrying: string | null;
  sleeping: boolean;
  profile: PublicProfile;
};

export type StoneState = Pick<StoneDescriptor, "id" | "x" | "z" | "generation"> & {
  holderId: string | null;
};

export type ActionResult = {
  t: "action";
  id: string;
  ok: boolean;
  kind: "pickup" | "throw";
  reason?: string;
  deposited?: boolean;
  count?: number;
  pit?: PitState;
};

export type StoredPlayer = PublicPlayer & {
  lastMoveAt: number;
  lastSeenAt: number;
  lastSeq: number;
  movementCredit?: number;
  movementCreditAt?: number;
  actionHistory: ActionResult[];
};

export type MoveMessage = {
  t: "move";
  seq: number;
  x: number;
  z: number;
  vx?: number;
  vz?: number;
  heading?: number;
  carrying?: unknown;
};

export type ClientMessage =
  | MoveMessage
  | { t: "profile"; profile: unknown }
  | { t: "chat"; id: string; text: string }
  | { t: "pickup"; id: string; stoneId: string }
  | { t: "throw"; id: string; stoneId: string }
  | { t: "ping"; at?: number };

export type ResumeClaims = {
  v: 1;
  kind: "resume";
  actorId: string;
  roomId: string;
  /** Optional only for compatibility with tokens issued before directory pinning. */
  directoryId?: string;
  iat: number;
  exp: number;
};

export type TicketClaims = {
  v: 1;
  kind: "ticket";
  actorId: string;
  roomId: string;
  profile: PublicProfile;
  nonce: string;
  iat: number;
  exp: number;
};
