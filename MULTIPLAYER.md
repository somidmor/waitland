# Multiplayer architecture and deployment

Waitland uses one Cloudflare Worker for the browser UI and a separate
Cloudflare Worker in [`realtime/`](./realtime/) for authoritative multiplayer
state. The web Worker never connects to D1 and never owns live game state. It
exposes `/api/multiplayer/config`, which gives the browser the configured
realtime origin at runtime.

This is a two-deployment system. Deploying `waitland-web` publishes only the
browser application and its config endpoint; it never deploys
`waitland-realtime` or creates its signing secret.

## Implemented architecture

```text
Browser on waitland.app
  -> GET /api/multiplayer/config
  -> POST <realtime-origin>/v1/session
       -> Lobby("directory-0") global packing allocator
       -> reserve FieldRoom("field-<uuid>")
  -> WSS <realtime-origin>/v1/connect?ticket=...
       -> assigned FieldRoom

Successful pit throw
  -> PitCoordinator("global-pit")
  -> one of 32 PitFanout shards
  -> subscribed FieldRooms
  -> connected browsers
```

### Web client and realtime Worker boundary

- `waitland-web` serves the game, renderer, and `app/realtime-client.ts`.
- The separate Worker validates origins, creates anonymous sessions, signs
  resume tokens and one-minute connection tickets, and routes WebSocket
  upgrades to Durable Objects.
- `SESSION_SECRET` signs tickets and seven-day resume tokens. Profiles,
  positions, actions, and client sequence numbers are all treated as
  untrusted input.

### Lobby

One active `Lobby` Durable Object at `directory-0` keeps lightweight room-load
hints and reserves a room before a ticket is issued. All fresh arrivals pass
through the same allocator, so low-volume visitors are packed together instead
of being scattered across invisible cohorts. Directory IDs `directory-0`
through `directory-15` remain valid for resume compatibility and future
expansion, but inactive directories do not receive fresh joins. Each normal
room has a limit of 64 active players. Four reconnect-only overflow slots
prevent a brief disconnect from immediately displacing an existing player.
Reservations expire after 75 seconds.

Each newly signed resume token records its owning directory. Tokens issued
before directory pinning fall back to the original 16-way actor hash. This
keeps existing actors attached to their FieldRoom if more fresh-join allocator
directories are activated later.

Allocation publishes an in-memory optimistic claim before awaiting the room
object. Concurrent cold joins therefore pack up to 64 reservations into the
same cohort instead of creating one room each. Room responses reconcile the
hint, failures roll it back, and the directory retains at most 2,048 useful
allocation hints; a resume token can still address a pruned room directly.

New joins prefer rooms below both the 64-player active limit and the 1,024
sleeping-player soft limit. If no suitable room is available, the Lobby creates
the next available `field-<uuid>` visibility cohort.

### FieldRoom shards

Each `FieldRoom` is an independent authority for its players, stones, nearby
chat, pickup/throw validation, and idempotent action results. High-frequency
movement is never sent through a global object.

- The client sends at most 8 movement updates per second. The server admits a
  sustained maximum of 10 per second per actor: 64 active players produce at
  most 512 expected movement messages per second in a well-behaved full room.
- The room validates sequence numbers, speed, elapsed server time, precisely
  representable finite coordinates, and pit collision. The visual terrain is
  streamed without an outer boundary; client-reported velocity and clocks are
  not authoritative.
- Dirty player updates are coalesced into one delta frame every 80 ms, or at
  most 12.5 room frames per second, then broadcast to that room's sockets for
  client interpolation.
- Moving poses are persisted at most once per player every two seconds. The
  final zero-velocity edge, pickup, throw, disconnect, stone, and sleep
  transitions are persisted immediately.
- Chat is rate-limited and delivered only within 26 world units. Pickup and
  throw actions use a four-action burst/one-per-second token bucket, a bounded
  room queue, serialized execution, and action-ID deduplication.

### Global pit and hierarchical fanout

`PitCoordinator("global-pit")` is the only serializer for the shared 1,000-stone
objective. A deposit key includes room, stone, and stone generation, so a room
retry after a cross-object failure cannot increment the pit twice.

The coordinator coalesces changed counts behind a 250 ms alarm. It publishes
to 32 `PitFanout` Durable Objects; each fanout shard forwards the update to only
its subscribed active rooms in batches of six. This keeps global movement out
of the coordinator and avoids one coordinator subrequest per room.

Subscriptions are stored as individual keys rather than one growing array.
Empty rooms unsubscribe, failed fanout shards are persisted with their newest
target count and retried with bounded backoff, and the final 1,000th update
clears the room subscription tree. Once complete, later rooms receive the final
state without being registered for updates that can never occur.

### Hibernation, reconnects, and private dormant state

Field rooms use `ctx.acceptWebSocket()` and per-socket serialized attachments,
so Cloudflare can hibernate an idle room without dropping healthy sockets. On
wake, the constructor reloads persisted players and stones and reconstructs
awake presence from `ctx.getWebSockets()` plus the attachments.

The browser sends the exact constant heartbeat `{"t":"ping"}` every 15
seconds. Cloudflare answers it through the Hibernation API without waking an
idle room object. The browser treats 45 seconds without an inbound response as
stale and reconnects with randomized exponential backoff from 500 ms up to 15
seconds. A welcome message must arrive within 12 seconds. The stored resume
token returns the same actor to the preferred room when capacity allows.

Closing the socket, including `pagehide`, is the authoritative dormant-state
signal. An in-flight join is aborted when the page hides or the browser goes
offline, so it cannot reopen a background socket after leaving. The room
releases a carried stone, stores the disconnected record at its last position
for resume continuity, and immediately broadcasts `player_leave`. Remaining
clients animate the white-wing departure. Dormant players are never included
in welcome snapshots and are retained privately for up to seven days; a room
prunes beyond 2,048 dormant records.

Hibernation reduces idle cost, but it is not a no-disconnect guarantee.
Cloudflare deployments and runtime restarts can close sockets, which is why
resume tokens and reconnect logic remain required.

## Why D1 polling was rejected

D1 is useful for relational account data, directories, or future leaderboards,
but not for the live movement path implemented here.

- At 1,000 players, 8 Hz movement alone would require 8,000 writes per second,
  before polling reads, chat, or actions.
- A D1 database executes queries serially. Global read replicas improve
  read-heavy latency, but all writes still reach the primary and replicas may
  lag.
- Polling adds repeated HTTP and query work, does not push presence changes,
  does not retain WebSockets, and does not provide one in-memory authority for
  collision, pickup, or throw ordering.
- Client interpolation can hide sparse-update latency but cannot repair stale
  reads, conflicting ownership, or an overloaded write primary.

The Durable Object design instead partitions the hot path by room, gives each
room a single authority, broadcasts only deltas, and hibernates when quiet. D1
can be added later for non-realtime, cross-room reporting without putting it in
the gameplay loop.

## Deploy the realtime Worker

The commands below are run from the repository root unless a step says
otherwise.

### 1. Review `realtime/wrangler.jsonc`

The checked-in file is the deployment source of truth. It declares the Worker,
all four Durable Object bindings, the SQLite-backed `v1` migration,
observability, and smart placement:

- `LOBBY` -> `Lobby`
- `ROOMS` -> `FieldRoom`
- `PIT` -> `PitCoordinator`
- `PIT_FANOUT` -> `PitFanout`

Do not rewrite an already-deployed migration tag. Add a new migration tag for
future Durable Object class/storage changes.

Set `ALLOWED_ORIGINS` under `vars` to exact, comma-separated production
browser origins. Do not use paths or a wildcard. The checked-in production
configuration contains the canonical Waitland web origins:

```jsonc
"vars": {
  "ALLOWED_ORIGINS": "https://waitland.app,https://www.waitland.app"
}
```

Add any future production web origin to this list before directing its users to
multiplayer. Origin matching is exact and case-sensitive after browser URL
normalization. Pass a localhost origin to `wrangler dev` with `--var`; do not
add it to the production value.

### 2. Install, verify, and authenticate

```sh
cd realtime
npm ci
npm run build
npm test
npx wrangler login
```

### 3. Bootstrap or intentionally rotate the signing secret

Skip this step for every ordinary deployment: the existing production secret
must be preserved. Only for a brand-new environment or an intentional forced
session reset, run the following from the repository root and paste a
cryptographically random value of at least 32 characters when prompted:

```sh
npx wrangler secret put SESSION_SECRET --config realtime/wrangler.jsonc
```

Keep the same secret across ordinary deploys and never commit it. Rotating it
invalidates existing resume tokens and unused connection tickets, so rotation
should be treated as a forced-session reset.

### 4. Deploy

```sh
npm run deploy:realtime
```

Wrangler applies the bindings and migration from the config, creates the
custom-domain DNS record, and publishes the service at:

```text
https://realtime.waitland.app
```

Changing `ALLOWED_ORIGINS` requires another Worker deploy.

For local development, copy both ignored example files and run the two
services in separate terminals:

```sh
# Terminal 1
cp realtime/.dev.vars.example realtime/.dev.vars
cd realtime
npm run dev -- --var ALLOWED_ORIGINS:http://localhost:5173

# Terminal 2, from the repository root
cp .dev.vars.example .dev.vars
npm run dev
```

### 5. Verify the backend before deploying the web Worker

Replace `<realtime-origin>` below with the deployed HTTPS origin:

```sh
curl -fsS <realtime-origin>/ready

curl -i -X OPTIONS <realtime-origin>/v1/session \
  -H 'Origin: https://waitland.app' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type'
```

The readiness response must report `{"ok":true,"protocol":1}` and a pit
snapshot; it verifies the signing-secret shape and reaches the global pit
binding. The preflight must return `204` and
`Access-Control-Allow-Origin: https://waitland.app`.

Next run the executable smoke harness. It creates or resumes one anonymous
session, opens the ticketed WebSocket, waits for `welcome`, sends movement,
chat, and ping messages, and requires frame, chat, and pong responses:

```sh
# From the repository root
REALTIME_ORIGIN=<realtime-origin> \
WEB_ORIGIN=https://waitland.app \
npm run realtime:smoke
```

Do not deploy a protocol-dependent web change if the smoke command exits
non-zero. The harness keeps its
anonymous resume token in a mode-`0600` file under the operating system's temp
directory so repeated verification wakes the same test actor instead of
creating an unlimited trail of sleepers.

### 6. Point the web Worker at realtime

The root `wrangler.jsonc` contains this non-secret production value:

```text
REALTIME_ORIGIN=https://realtime.waitland.app
```

Use an origin only: HTTPS scheme and hostname, with no credentials, path,
query, or fragment. Keep it in Worker configuration rather than hardcoding it
into the browser bundle. After changing it, rebuild and deploy `waitland-web`,
then verify:

```sh
curl -fsS https://waitland.app/api/multiplayer/config
```

The response must have `enabled: true`, `protocolVersion: 1`, and the exact
`realtimeOrigin`. If it reports `not-configured` or `invalid-configuration`, do
not troubleshoot the WebSocket first; correct `REALTIME_ORIGIN` and redeploy
the web Worker.

## Load-test and monitoring targets

Test the WebSocket service independently of the renderer. At minimum, exercise:

```sh
REALTIME_ORIGIN=<realtime-origin> \
WEB_ORIGIN=https://waitland.app \
ALLOW_LOAD_TEST=yes \
CLIENTS=64 \
DURATION_SECONDS=1800 \
MOVES_PER_SECOND=8 \
npm run realtime:load
```

Load mode never runs without the exact `ALLOW_LOAD_TEST=yes` guard. It admits
clients with bounded concurrency, sends at most 12 movement messages per
second per socket, reports welcome and frame-age p95 values, and exits non-zero
for join failures, server errors, or unexpected closes. Confirm the target and
Cloudflare account limits before setting the guard. Run from multiple regions
for geographic latency data; one local process is not an internet-scale proof.

| Scenario | Target |
| --- | --- |
| Full room | 64 active sockets for 30 minutes, each sending 8 movement messages/s |
| Room hot path | 512 sustained movement messages/s, 80 ms delta frames, no overloaded responses |
| Reconnect | 64 simultaneous reconnects, including four resume-overflow cases; at least 99% welcomed within 15 s |
| Horizontal scale | Expected peak room count plus 50% headroom; no increase in per-room frame latency |
| Global objective | Concurrent idempotent deposits across at least 32 rooms; no duplicate increments and fanout visible within 1 s |
| Sleep/wake | Repeated page hide/show and forced socket close; position restored and carried stone released exactly once |

Initial service-level targets are p95 session creation below 500 ms, p95
welcome below 1 second after WebSocket open, p95 room-frame age below 250 ms,
and unexpected close or server-error rate below 0.1% over a 30-minute run.
Measure from more than one geographic region because each Durable Object runs
in one location.

Keep Cloudflare observability enabled and alert on:

- Worker and Durable Object 5xx, overloaded, CPU-limit, and memory-limit events;
- `/v1/session` 400/401/403/409/429/503 rates and Lobby assignment latency;
- active socket count, messages per second, frame size, frame age, and bytes
  broadcast per FieldRoom;
- client reconnect attempts, welcome timeouts, stale-heartbeat closes, and time
  to resume;
- PitCoordinator deposit latency, duplicate rate, alarm failures, fanout lag,
  and stale room subscriptions;
- Durable Object duration and storage growth, especially sleeping-player
  retention.

Put a Cloudflare rate-limiting rule in front of `POST /v1/session` before a
public load test. A conservative starting policy is 30 requests per minute per
source IP with a 60-second mitigation period for ordinary public traffic;
measure shared-network and reconnect behavior before launch. A 64-client load
generator will intentionally exceed that threshold, so allowlist its known IP
or test against an isolated staging deployment—do not disable the production
rule globally. Record this account-level rule in release operations, because
it is not created by `wrangler.jsonc`. Gameplay already has bounded message
sizes, movement and chat token buckets, server-authoritative movement checks,
and serialized actions.

## Disable or roll back

Disable multiplayer before rolling back the realtime Worker:

1. Remove or invalidate `REALTIME_ORIGIN` in the web Worker configuration.
2. Rebuild and deploy `waitland-web`.
3. Verify `/api/multiplayer/config` reports `enabled: false`; the game should
   continue in local-only mode.
4. Roll back or disable the realtime Worker only after clients have drained.

Ordinary Worker code rollback must not rewrite or remove an already-applied
Durable Object migration tag. Restoring `REALTIME_ORIGIN` requires another web
Worker deployment, followed by the smoke harness.

## Known practical limits

- A FieldRoom admits 64 normal active players; only four additional reconnects
  are allowed temporarily. This application limit is intentionally far below
  Cloudflare's WebSocket connection ceiling.
- A full room's expected 512 inbound movement messages/s leaves headroom below
  Cloudflare's approximate 1,000 requests/s soft limit per Durable Object, but
  chat, actions, heartbeats, JSON work, fanout, and storage also consume CPU.
  Load-test before raising either the player cap or update rate.
- Cloudflare Workers/Durable Objects have 128 MB isolate memory. The practical
  ceiling is workload-dependent even though the Hibernation API permits up to
  32,768 sockets per object.
- Cloudflare accepts received WebSocket messages up to 32 MiB, but this service
  intentionally rejects messages above 2,048 bytes. Browser inbound messages
  are capped at 512 KiB.
- SQLite-backed Durable Objects allow up to 10 GB per object. The service's
  tighter sleeper retention and hard-count limits should be monitored long
  before that platform ceiling.
- The one active Lobby is intentionally a cold-path packing allocator so early
  visitors reliably meet. FieldRoom movement remains horizontally sharded. A
  Lobby has Cloudflare's approximate per-object request ceiling. If measured
  sustained join traffic approaches that boundary, activate additional
  fresh-join directories gradually; signed directory affinity keeps existing
  resumes stable. A two-level cohort allocator is the next step only if that
  simple expansion is insufficient. The single PitCoordinator can still become a deposit
  bottleneck near the per-object throughput boundary, but it carries only the
  finite 1,000-deposit objective and no movement traffic. Add admission-rate
  limiting first; change the objective topology only if measured traffic
  requires it.
- Field rooms are bounded visibility cohorts, not different objectives: every
  cohort has the same field rules and shares the one global pit count. Players
  interact directly with up to 63 other active people in their cohort. This
  keeps per-user bandwidth and render work bounded as total concurrency grows.
- Hibernation saves idle duration but resets in-memory state. Important state
  must remain persisted, and every client must tolerate reconnects during
  deployments or runtime restarts.

Cloudflare references: [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/),
[WebSocket hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/),
[Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/),
and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).
