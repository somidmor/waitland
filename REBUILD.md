# Waitland rebuild — September 2026

## Product decisions

The old entry flow asked for name, a geocoded city, country, and a reason before
showing play. Its rich environment and textured characters competed with the
small rocks and pit on portrait screens. A fixed objective also ended the loop.

The invitation is direct: **What are you waiting for?**

The first visual pass was rejected by the user. The second pass was guided by
a dedicated independent visual critic; see `DESIGN-REVIEW.md` for the findings
and acceptance criteria.

- Ask only what someone is waiting for. Shortcuts and a single required reason
  keep entry quick; no account, geolocation, or third-party search request.
- Tap a rock to walk to it and pick it up. Tap the pit or the single action
  button to walk within throwing distance and throw. Joystick, arrows/WASD,
  and Space remain available without a tutorial screen.
- Make the first shared statue attainable: 100 rocks, then 200, 300, and so on.
  Every completion records its name, rock count, start/completion time, and
  position, and opens a physically larger pit beside it.
- Give the game a quiet, legible visual identity: a composed moss-green sculpture park,
  bone signs, forest-green controls, and terracotta reserved for the local
  visitor. A persistent YOU flag and contrasting ground ring make ownership
  unmistakable. Camera framing adapts to the visitor’s actual arrival position.
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
models, textures, audio, or character GLBs. Entry uses a 26 KB WebP captured from
the actual game. Monument names and dates are screen-space buttons, with
readable detail plaques and a discoverable statue index. The versioned rigged-character
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
The visual revision also verifies simultaneous pickup contention, persistent
player ownership while walking and reconnecting, bounded edge speech bubbles,
readable statue inspection, and a complete portrait rollover view.

Physical iOS/Android hardware performance is not measured by these desktop
browser checks. Before a broad public launch, sample frame time and memory on
an actual mid-range phone and perform a multi-region load test; the current
verification exercises functional correctness and modest concurrency.

The last browser review also fixed premature form submission before hydration,
keyboard movement after button focus, and collision when a new pit opens under
a visitor. An independent navigation sweep passed 480 start/destination pairs.
