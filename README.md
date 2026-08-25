# Waitland

Waitland is a portrait-first, account-free browser game for the minutes people
spend waiting. Visitors enter anonymously, walk around a shared 3D field, carry
one stone at a time to a global 1,000-stone pit, and talk through short nearby
speech bubbles.

- Web app: <https://waitland.app>
- Realtime service: <https://realtime.waitland.app>
- Architecture and agent handoff: [`AGENTS.md`](./AGENTS.md)
- Multiplayer details: [`MULTIPLAYER.md`](./MULTIPLAYER.md)

## Architecture

This repository deploys two Cloudflare Workers:

- `waitland-web` from the repository root serves the Vinext/Three.js web app,
  static assets, health endpoint, and runtime multiplayer configuration.
- `waitland-realtime` from [`realtime/`](./realtime/) owns anonymous sessions,
  WebSockets, room state, stones, chat, and the global pit through Durable
  Objects.

The authoritative source lives in GitHub. The committed deployment workflow
verifies and deploys both Workers to Cloudflare whenever `main` changes, then
runs public health checks and one- and two-client WebSocket checks.

## Requirements

- Node.js 22.13.0 or newer
- npm
- A Cloudflare account with Workers and Durable Objects access for deployment

## Local development

```sh
npm ci
npm --prefix realtime ci
cp .dev.vars.example .dev.vars
cp realtime/.dev.vars.example realtime/.dev.vars
```

Start the two services in separate terminals:

```sh
npm --prefix realtime run dev -- --var ALLOWED_ORIGINS:http://localhost:5173
npm run dev
```

Set `REALTIME_ORIGIN=disabled` in the ignored root `.dev.vars` file to exercise
the graceful local-only fallback. Confirm `/api/multiplayer/config` reports
`enabled: false`.

## Verification

```sh
npm run typecheck
npm run lint
npm test
npm run cloudflare:check
```

Targeted commands:

```sh
npm run test:site
npm run realtime:verify
npm run realtime:smoke
npm run realtime:load
```

Smoke/load runtime variables and safety guards are documented in
[`MULTIPLAYER.md`](./MULTIPLAYER.md).

## Deployment

```sh
npm run deploy:realtime
npm run deploy:web
```

The realtime Worker is deployed first so browser and server protocol changes
remain compatible. Preserve the exact `waitland-realtime` Worker name, Durable
Object class/binding names, migration tag `v1`, and production
`SESSION_SECRET`; see [`AGENTS.md`](./AGENTS.md) before changing deployment
configuration.

Never commit `.env`, `.dev.vars`, Cloudflare/R2 credentials, GitHub tokens, or
Meshy API keys.
