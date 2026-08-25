import type { ResumeClaims, TicketClaims } from "./types.ts";
import { isActorId, isRoomId } from "./ids.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmacKey(secret: string) {
  if (secret.length < 32) throw new Error("SESSION_SECRET must contain at least 32 characters");
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function signToken(payload: ResumeClaims | TicketClaims, secret: string) {
  const body = base64UrlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(signature))}`;
}

export async function verifyToken<T extends ResumeClaims | TicketClaims>(
  token: string,
  kind: T["kind"],
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<T | null> {
  try {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra) return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      base64UrlDecode(signature),
      encoder.encode(body),
    );
    if (!valid) return null;
    const payload = JSON.parse(decoder.decode(base64UrlDecode(body))) as Partial<T>;
    if (payload.v !== 1 || payload.kind !== kind) return null;
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) return null;
    if (typeof payload.iat !== "number" || payload.iat > nowSeconds + 30) return null;
    if (!isActorId(payload.actorId)) return null;
    if (!isRoomId(payload.roomId)) return null;
    return payload as T;
  } catch {
    return null;
  }
}

export function encodeInternalJson(value: unknown) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

export function decodeInternalJson<T>(value: string) {
  return JSON.parse(decoder.decode(base64UrlDecode(value))) as T;
}
