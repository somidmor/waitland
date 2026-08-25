import assert from "node:assert/strict";
import test from "node:test";
import { signToken, verifyToken } from "../src/tokens.ts";
import type { ResumeClaims } from "../src/types.ts";

const secret = "test-only-secret-that-is-at-least-thirty-two-characters";
const claims: ResumeClaims = {
  v: 1,
  kind: "resume",
  actorId: "00000000-0000-4000-8000-000000000000",
  roomId: "field-11111111-2222-4333-8444-555555555555",
  iat: 1_000,
  exp: 2_000,
};

test("signed resume tokens round trip", async () => {
  const token = await signToken(claims, secret);
  assert.deepEqual(await verifyToken<ResumeClaims>(token, "resume", secret, 1_500), claims);
});

test("tampering and expiration are rejected", async () => {
  const token = await signToken(claims, secret);
  const tampered = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
  assert.equal(await verifyToken<ResumeClaims>(tampered, "resume", secret, 1_500), null);
  assert.equal(await verifyToken<ResumeClaims>(token, "resume", secret, 2_000), null);
});

test("short secrets are rejected", async () => {
  await assert.rejects(() => signToken(claims, "too-short"), /at least 32/);
});
