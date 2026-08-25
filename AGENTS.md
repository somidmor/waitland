# Waitland agent guide

This file is the operational source of truth for coding agents working on
Waitland. Read it before changing the application, Cloudflare configuration,
multiplayer protocol, 3D assets, or deployment workflow.

## Product in one paragraph

Waitland is a portrait-first, account-free web game for people who are waiting.
A visitor enters a name, city, country, and a simple reason for waiting, then
spawns as a small stylized person in a shared 3D field. They can walk, carry one
stone, throw it into a global pit, and speak to nearby people through short
speech bubbles. A visit may last one minute or one hour. There is no onboarding
maze, inventory system, score grind, or required sign-in. Leaving should feel
gentle: the visible character grows white wings and flies away. The server may
retain a dormant player record for reconnect continuity, but the UI must never
show sleeping bodies.

## Production topology

Waitland is a GitHub-to-Cloudflare monorepo with two independent Workers:

| Service | Cloudflare Worker | Production domain | Responsibility |
| --- | --- | --- | --- |
| Web | `waitland-web` | `https://waitland.app` | Vinext UI, Three.js renderer, static assets, `/api/multiplayer/config` |
| Realtime | `waitland-realtime` | `https://realtime.waitland.app` | Anonymous sessions, WebSockets, room authority, chat, stones, global pit |

`https://www.waitland.app` is accepted by Cloudflare and redirected to the
canonical apex domain by `worker/index.ts`.

The repository is intended to live at `somidmor/waitland`, with `main` as the
production branch. One GitHub Actions workflow deploys the monorepo's two
Workers from different working directories:

- Web Worker root: `/`
- Realtime Worker root: `/realtime`

Do not reintroduce OpenAI Sites hosting files. The previous
`.openai/hosting.json` and Sites-only build helpers were deliberately removed
when the application moved to native Cloudflare Workers.

## Repository map

- `app/`
  - `page.tsx` and `game-loader.tsx`: application entry and client loading.
  - `arrival-screen.tsx`: no-account arrival/profile flow.
  - `waiting-pit.tsx`: main game orchestration, input, HUD, and realtime event
    integration.
  - `pit-geometry.ts`: the shared irregular excavation contours used by the
    meadow opening, dirt lip, wall, and floor.
  - `world-art.ts`: Three.js terrain, pit, stones, environment dressing,
    shadows, and departure visuals.
  - `avatar/`: versioned rigged-avatar manifest/runtime plus the procedural
    local-avatar implementation and fallback.
  - `avatar-design.ts`: deterministic avatar parts and palette. Keep this as the
    stable customization boundary for a future character editor.
  - `remote-avatar-renderer.ts`: remote player visualization and interpolation.
  - `realtime-client.ts`: browser transport, reconnects, resume token, protocol
    validation, and local-only fallback.
- `profile.ts`: validated local visitor profile and country/city metadata.
    It intentionally retains the legacy `waiting-pit-profile-v1` local-storage
    key so existing visitors keep their saved profiles.
  - `globals.css`: portrait HUD, safe-area behavior, responsive rules, and the
    warm miniature-world visual language.
- `worker/index.ts`: web Worker entry point, image optimization, canonical host
  redirect, health response, multiplayer config endpoint, and Vinext handler.
- `shared/world.ts`: world constants and deterministic stone descriptors shared
  by the browser and realtime server. Changes affect both deployments.
- `realtime/src/`: authoritative multiplayer Worker and Durable Objects.
  - `index.ts`: HTTP/session routes, WebSockets, Lobby, FieldRoom,
    PitCoordinator, and PitFanout.
  - `domain.ts`: validation and authoritative gameplay rules.
  - `ids.ts`, `sharding.ts`, `tokens.ts`, `types.ts`: deterministic identity,
    allocation, signed-token, and protocol support.
- `realtime/test/`: protocol, client, domain, token, and scaling tests.
- `realtime/scripts/realtime-harness.mjs`: production smoke/load harness.
- `tests/`: web build and responsive-layout contracts.
- `public/`: favicon, social card, and static browser assets.
- `wrangler.jsonc`: `waitland-web` deployment source of truth.
- `realtime/wrangler.jsonc`: `waitland-realtime` deployment source of truth.
- `worker-configuration.d.ts` and
  `realtime/worker-configuration.d.ts`: generated Cloudflare binding types.
- `MULTIPLAYER.md` and `realtime/PROTOCOL.md`: detailed architecture and wire
  protocol documentation.
- `.github/workflows/ci.yml`: pull-request and `main` verification.
- `.github/workflows/deploy.yml`: gated production deployment and post-release
  HTTP/WebSocket verification.

The `db/`, `drizzle/`, and `examples/d1/` directories are inactive starter
scaffolding. Live gameplay does not use D1. Do not put movement, presence,
stones, or chat into D1 polling. Remove the scaffolding in a dedicated cleanup
change if it is no longer useful; never silently connect it to production.

## Non-negotiable product constraints

1. No account is required to enter or play.
2. The primary experience is portrait mobile; desktop/tablet are supported but
   must not drive the HUD design.
3. The player can understand the game without instructions: move, pick up one
   stone, carry it to the pit, and throw.
4. One visitor may carry at most one stone.
5. Short speech bubbles are proximity chat, not a persistent chat product.
6. The pit is a shared global objective with a capacity of 1,000 stones in the
   current prototype.
7. The player cannot enter the pit.
8. Leaving displays a white-wing flight animation. Do not restore visible
   sleeping avatars.
9. Preserve graceful local-only play when realtime is unavailable.
10. Keep controls reachable around iOS/Android safe areas and usable with touch,
    keyboard, and pointer input where already supported.

## Durable Object state preservation

The production multiplayer state belongs to the existing Worker
`waitland-realtime`. These identifiers are immutable unless a deliberate,
reviewed data migration is being performed:

- Worker name: `waitland-realtime`
- Binding `LOBBY` -> class `Lobby`
- Binding `ROOMS` -> class `FieldRoom`
- Binding `PIT` -> class `PitCoordinator`
- Binding `PIT_FANOUT` -> class `PitFanout`
- Existing migration tag: `v1`

Never rename the Worker, create a replacement production realtime Worker,
delete or rewrite `v1`, or rename those bindings/classes as routine cleanup.
Doing so can split or orphan the production Durable Object namespaces. Add a
new migration tag for an intentional future storage/class migration.

`SESSION_SECRET` must remain unchanged across normal deploys. Rotating it
invalidates all resume tokens and unused tickets and should be treated as a
forced session reset.

## Multiplayer design summary

The browser fetches `/api/multiplayer/config`, requests an anonymous session
from `/v1/session`, then upgrades to the ticketed WebSocket URL returned by the
realtime Worker.

- `Lobby("directory-0")` packs new visitors into visible cohorts.
- Each `FieldRoom` authoritatively owns its players, stones, nearby chat,
  pickup/throw ordering, and WebSockets.
- Normal rooms allow 64 active players plus four reconnect-only overflow slots.
- Clients send at most eight movement updates per second.
- Room movement deltas are coalesced to an 80 ms frame cadence.
- Chat is limited to 26 world units and server-rate-limited.
- `PitCoordinator("global-pit")` serializes deposits idempotently.
- Thirty-two `PitFanout` shards propagate global count updates to active rooms.
- WebSocket hibernation attachments preserve sockets through Durable Object
  hibernation.
- The client pings every 15 seconds, considers 45 seconds without inbound data
  stale, and reconnects with randomized exponential backoff.
- Dormant records are retained for reconnect continuity, limited and pruned by
  the server. They are backend state, not visible sleeping characters.

Read `MULTIPLAYER.md` and `realtime/PROTOCOL.md` before changing any network
message, limit, timer, storage key, sharding rule, or reconnect behavior.

## Local development

Requirements:

- Node.js 22.13.0 or newer (`.node-version` is committed).
- npm.

Install both projects:

```sh
npm ci
npm --prefix realtime ci
```

Create ignored local settings:

```sh
cp .dev.vars.example .dev.vars
cp realtime/.dev.vars.example realtime/.dev.vars
```

Run the realtime Worker and web app in separate terminals:

```sh
npm --prefix realtime run dev -- --var ALLOWED_ORIGINS:http://localhost:5173
npm run dev
```

To exercise local-only mode, set `REALTIME_ORIGIN=disabled` in the ignored root
`.dev.vars`; the web Worker's config endpoint must then report `enabled: false`.

## Required verification

Run before every production change:

```sh
npm run typecheck
npm run lint
npm test
npm run cloudflare:check
```

`npm test` builds/tests the web app and runs the complete realtime TypeScript
and Node test suite. `cloudflare:check` performs dry-run packaging for both
Workers. Do not report success when a command was skipped or failed.

After changing a Wrangler binding, regenerate and commit its types:

```sh
npm run types:cloudflare
npm run types:cloudflare:realtime
```

## Secrets and configuration

Committed non-secret production configuration:

- Web `REALTIME_ORIGIN=https://realtime.waitland.app` in root `wrangler.jsonc`.
- Realtime `ALLOWED_ORIGINS` in `realtime/wrangler.jsonc`.

Production secret:

- `SESSION_SECRET` on `waitland-realtime` only.

Rules:

- Never commit `.env`, `.dev.vars`, Cloudflare tokens, R2 keys, GitHub tokens,
  Meshy keys, passwords, or copied dashboard responses.
- Never copy the uploaded `Cloudflare.txt` credential file into this repository.
- Use Cloudflare encrypted runtime secrets for production and ignored
  `.dev.vars` files locally.
- A Meshy API key is a development-time asset-generation credential. It does
  not belong in either Worker.
- Keep production asset files below Cloudflare's per-file static-asset limit.
  Optimize GLB geometry, textures, animation clips, and compression before
  shipping. Store large/raw source models outside the runtime bundle, such as
  Git LFS or R2.

## Avatar and 3D asset boundary

The local hero and every visible remote player now prefer one versioned,
rigged Meshy GLB with idle, walk, and pick/throw clips. It is
lazy-loaded behind `avatar/waitlander-manifest.ts`; decoded geometry and
textures are shared while each visible player owns the skeleton and animation
state required by Three.js. The deterministic procedural avatar remains the
loading/error fallback; remote distance and instance options are explicit
operational escape hatches rather than production defaults. Preserve these boundaries so
customization does not require rewriting gameplay or transport:

- Profile/avatar selection produces a stable avatar descriptor.
- `avatar-design.ts` maps that descriptor to visual parts/material choices.
- Procedural local/fallback and remote LOD renderers consume the same
  descriptor.
- Rigged local and nearby-remote renderers consume a versioned asset manifest
  whose anchors and clip aliases isolate gameplay from mesh-specific names.
- Today, procedural appearances are derived deterministically from the actor ID;
  the protocol carries no appearance field. Future customization should add a
  compact descriptor or identifier, never raw models or textures.
- Movement, collision, pickup, throw, chat, and departure state stay independent
  of mesh topology.

For mobile delivery, prefer one shared skeleton, instanced/reused materials,
small texture atlases, KTX2 textures, compressed geometry, bounded draw calls,
and lazy loading. Test memory and frame time on an actual phone before accepting
a visual upgrade.

## Deployment and rollback

Manual release order:

```sh
npm run deploy:realtime
npm run deploy:web
```

Deploy realtime first so the browser never expects a protocol the server does
not yet understand. Ordinary frontend-only changes may deploy only the web
Worker. Shared protocol/world changes require both deployments in that order.

GitHub deployment workflow:

- `.github/workflows/deploy.yml` runs only for `main` and manual dispatches.
- Its deploy jobs depend on a full type-check, lint, test, and two-Worker
  packaging gate; a failed verification cannot publish either Worker.
- It deploys the existing `waitland-realtime` Worker first, then
  `waitland-web`.
- Before touching realtime state, it confirms that the configured Cloudflare
  account already contains deployments for the exact `waitland-realtime`
  Worker. A wrong account fails closed instead of creating a fresh service.
- Repository Actions secrets `CLOUDFLARE_API_TOKEN` and
  `CLOUDFLARE_ACCOUNT_ID` are required. Use an account/zone-scoped deployment
  token rather than a permanent full-access token, and never print either
  value in workflow logs.
- Do not also enable Cloudflare Builds for these Workers unless this workflow
  is disabled; two deployment systems would race on every push.
- After both deploys, it verifies public health/config endpoints, a full
  one-client protocol exchange, and two simultaneous WebSocket clients.
- Durable Object Workers do not receive normal preview URLs. Use local tests or
  a separately named staging Worker/namespace for realtime branch testing.

Rollback with Cloudflare Worker versions or by reverting the responsible Git
commit and redeploying. Do not roll back by renaming a Worker or deleting a
Durable Object migration. If frontend multiplayer must be disabled, remove or
invalidate the web Worker's `REALTIME_ORIGIN` and deploy the web Worker; the
client will fall back to local-only play.

## Production verification

After deployment, verify in this order:

```sh
curl -fsS https://realtime.waitland.app/health
curl -fsS https://realtime.waitland.app/ready
curl -fsS https://waitland.app/health
curl -fsS https://waitland.app/api/multiplayer/config

REALTIME_ORIGIN=https://realtime.waitland.app \
WEB_ORIGIN=https://waitland.app \
npm run realtime:smoke
```

Then use at least two independent browser contexts or physical devices and
verify:

1. Both visitors enter without an account.
2. Each sees the other's movement with smooth interpolation.
3. Nearby speech bubbles reach the other client.
4. Stone ownership cannot duplicate.
5. A successful throw updates the global pit count for both clients.
6. A forced disconnect reconnects without an endless `reconnecting` state.
7. Closing one client shows the white-wing departure to the other and does not
   leave a visible sleeping body.

## Definition of done

A change is complete only when:

- It preserves the simple one-minute entry and portrait-first experience.
- Type-check, lint, web tests, realtime tests, and both Worker dry runs pass.
- Realtime identifiers/migrations and `SESSION_SECRET` continuity are safe.
- No secret or raw credential is staged for Git.
- Relevant architecture/protocol docs are updated.
- Production health/config/smoke checks pass when the task includes deployment.
- Multiplayer-facing changes are verified with at least two independent clients.
