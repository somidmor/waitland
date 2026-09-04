# Waitland rebuild — September 2026

## Product decisions

The old entry flow asked for name, a geocoded city, country, and a reason before
showing play. Its rich environment and textured characters competed with the
small rocks and pit on portrait screens. A fixed objective also ended the loop.

The rebuild keeps the invitation simple: **A little wait. Something lasting.**

- Ask only what someone is waiting for. Shortcuts and an empty-input default
  keep entry quick; no account, geolocation, or third-party search request.
- Tap a rock to walk to it and pick it up. Tap the pit or the single action
  button to walk within throwing distance and throw. Joystick, arrows/WASD,
  and Space remain available without a tutorial screen.
- Make the first shared statue attainable: 100 rocks, then 200, 300, and so on.
  Every completion records its name, rock count, start/completion time, and
  position, and opens a physically larger pit beside it.
- Give the game a quiet, legible visual identity: sage grass, cream stone,
  charcoal text, orange actions, colored miniature people, gentle shadows.
- Keep optional conversation and sound in secondary controls. No scoreboards,
  currency, inventory screen, account funnel, or persistent chat history.
- Let people leave when their real-life wait ends, with white wings and a short
  acknowledgement of the rocks they contributed.

## Implementation

The visible experience was rebuilt across arrival, HUD, input, navigation,
world rendering, monuments, sound, mobile layout, and social imagery. The
existing anonymous WebSocket/Durable Object foundation remains because it
already handles room authority, collision, hibernation, and reconnects.

`game-engine.ts` owns the renderer and simulation; `waiting-pit.tsx` owns the
React interface. `game-navigation.ts` routes taps around the excavation.
`world-art.ts` draws and reuses procedural scenery, stones, pit geometry,
monument sculptures, and particles. Default play downloads no environment
models, textures, audio, or character GLBs. The versioned rigged-character
runtime remains available with `?avatar=rigged` for future art work.

`shared/world.ts` defines deterministic pit layouts, increasing capacities,
monument metadata, and safe snapshot validation. PitCoordinator serializes
rollovers and stores completed monuments. The latest eight are sent to clients
and rendered; earlier monument records remain in durable storage. Wire fields
are additive and retain the legacy count/capacity fields. Offline progression
is validated and stored on the device, never replayed into shared counts.

The unused D1/Drizzle starter scaffolding was removed. Package patches eliminate
all dependency advisories reported by the current npm audit. No production
Worker, Durable Object class/binding, migration, or session secret was renamed.

## Verification

Passed release gates: TypeScript, ESLint, 55 web tests, 51 realtime tests,
and both Worker dry-run packages. Dependency audit reports zero known advisories. The real-runtime lifecycle integration exercises two
WebSockets, final deposit rollover, a second-round throw, runtime restart, and
anonymous reconnect against isolated local state.

Browser QA covers 320×568, 390×844, 852×393, and 1440×980; entry, editing,
focus restoration, shared throw counts, nearby chat, remote movement,
disconnect/reconnect, local statue creation/persistence, and departure.
Screenshots and browser scenario scripts live in ignored `output/playwright/`.

Physical iOS/Android hardware performance is not measured by these desktop
browser checks. Before a broad public launch, sample frame time and memory on
an actual mid-range phone and perform a multi-region load test; the current
verification exercises functional correctness and modest concurrency.

The last browser review also fixed premature form submission before hydration,
keyboard movement after button focus, and collision when a new pit opens under
a visitor. An independent navigation sweep passed 480 start/destination pairs.
