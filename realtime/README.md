# Waitland realtime service

This directory is the standalone `waitland-realtime` Cloudflare Worker. The
root `waitland-web` Worker serves `waitland.app`; this service owns
authoritative multiplayer state at `realtime.waitland.app` through Durable
Objects.

## Architecture

- **One active Lobby allocator** at `directory-0` packs anonymous arrivals into
  the same available field room, so even two early visitors can meet. Sixteen
  directory IDs remain valid for resume compatibility and measured future
  expansion, but inactive directories never receive fresh joins. A field room admits 64
  new active players, with four emergency reconnect slots so a sleeping actor
  is not displaced by a brief network interruption. The Lobby is only on the
  cold join/resume path; all high-frequency gameplay stays in FieldRoom shards.
- **FieldRoom DOs** own movement, nearby chat, stones, pickup/throw validation,
  action idempotency, and private reconnect state. Each uses hibernatable
  WebSockets. Movement is validated against the server clock, persisted at a
  low frequency, and sent as 80 ms delta frames for client interpolation.
- **PitCoordinator DO** is the single serializer for the 1,000-stone global
  objective. It stores every successful action id, so a retry cannot increment
  twice.
- **PitFanout DOs** form 32 subscriber shards. The coordinator publishes one
  coalesced update per shard instead of making one subrequest per field room.
  Individual subscription keys avoid a growing single storage value; failed
  targets persist and retry with backoff, while the completed objective clears
  the room subscription tree.
- Anonymous resume and one-minute WebSocket tickets are HMAC-signed. Every new
  resume token pins its owning allocator directory, so activating more join
  allocators later cannot move an existing actor away from its room. Tokens
  from before directory pinning use the original 16-way actor hash. No account
  or browser credential is required, and raw profile/session data is never
  trusted by a room.

High-frequency movement never touches a global database or global object. A
room broadcasts only to its roughly 64 active sockets; chat is sent only within
26 world units. Stone geometry is deterministic and shared with the browser in
`../shared/world.ts`, so snapshots carry only the mutable stone fields.
The exact constant heartbeat `{"t":"ping"}` is served by Cloudflare's
WebSocket auto-response path, so idle health checks do not wake a hibernating
room isolate.

## Deploy

```sh
cd realtime
npm ci
npx wrangler login
npm run deploy
```

Routine deploys preserve the existing encrypted `SESSION_SECRET`. Run
`npm run secret:set` only for a first-time environment or an intentional
emergency rotation; rotation invalidates active resume tokens and unused
connection tickets. The secret must be cryptographically random and at least
32 characters. The repository contains no placeholder or fallback secret;
session creation fails closed when the binding is missing or too short.

The checked-in `ALLOWED_ORIGINS` contains the canonical production Waitland web
origins. Supply localhost explicitly to `wrangler dev`;
do not add development origins to the production variable. The production
multiplayer endpoint is `https://realtime.waitland.app`.

For an internet-scale launch, also put a Cloudflare rate-limiting rule in front
of `POST /v1/session`. Gameplay messages already have per-actor movement, chat,
profile, and action token buckets, bounded input sizes, authoritative
speed/collision checks, and a bounded serialized room-action queue.

## Local verification

```sh
cp .dev.vars.example .dev.vars
npm run build
npm test
npm run dev -- --var ALLOWED_ORIGINS:http://localhost:5173
```

In another terminal, copy the root `.dev.vars.example` to `.dev.vars` and run
`npm run dev` from the repository root. The web app then uses the realtime
Worker at `http://localhost:8787`.

The tests cover token tampering/expiration, text normalization, Unicode chat
limits, movement anti-teleport and explicit-stop rules, pit collision, token
buckets, deterministic non-stacking spawn placement, disconnect cleanup, and
dormant-record retention. See [PROTOCOL.md](./PROTOCOL.md) for the browser
contract.

After deployment, run the one-client smoke test from the repository root:

```sh
REALTIME_ORIGIN=https://realtime.waitland.app \
WEB_ORIGIN=https://waitland.app \
npm run realtime:smoke
```

Load mode requires the explicit `ALLOW_LOAD_TEST=yes` guard. Configuration and
safety notes are in [`../MULTIPLAYER.md`](../MULTIPLAYER.md).
