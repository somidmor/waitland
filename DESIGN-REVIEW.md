# Waitland visual redesign — September 2026

## Independent review

The user rejected the first rebuild's appearance. A separate visual critic
inspected production, live mobile, small-phone, multiplayer, entry, and statue
screenshots. The review found:

- No dependable visual distinction between the local visitor and other people.
- A large floating progress card competing with small characters and scenery.
- An inconsistent mixture of marketing typography, pill controls, orbit art,
  and repeated slogans.
- Statue dates and names too small, with records buried in the general menu.
- Speech bubbles collapsing to one character per line near screen edges.
- Random scenery scatter and camera composition that changed with spawn position.

## Art direction

A shared sculpture park: sturdy sans-serif typography, bone signs, forest-green
controls, muted moss ground, tactile stone forms, and terracotta reserved for the
local player and active targets. Entry asks a direct question and shows the
actual world. Game text describes the current action.

## Acceptance criteria

1. A persistent 14 px YOU flag, contrasting ground ring, and deliberate outfit.
   The character should read at least 52 px tall on 390×844 and 44 px on 320×568.
2. A compact top rail and a clear playable region. Online random spawn and
   reconnect must preserve visible ownership. Wandering must not lose the hero.
3. Primary interface text at least 14 px; statue name 24 px and date/count 16 px
   in its detail plaque. World labels remain screen-sized rather than shrinking
   with camera distance.
4. Both world sculptures and labels open a readable plaque and frame the statue.
   A Statues control makes earlier work discoverable without opening settings.
5. Deliberate groves, moss beds, an entrance path, and a connecting promenade.
   No uniform tiny confetti or decorative labels competing with the action.
6. One clear action, 44 px minimum interaction targets, and reachable touch
   controls across narrow portrait and landscape layouts.
7. One reason field, understated shortcuts, and Enter the field. Preserve
   hydration gating, validation, edit focus, and account-free entry.
8. Bounded speech bubble widths and clamped positions. Actual speech is visible;
   waiting reasons appear when a nearby person is selected.

An independent follow-up visual review is required after implementation. Code
checks alone are not evidence of visual acceptance. Screenshot evidence is kept
in ignored output/playwright; physical phone performance remains a separate
hardware check.

## Final review result

The independent critic accepted the redesign for release after inspecting fresh
phone, small-phone, desktop, entry, nearby-chat, and wing-departure screenshots;
playing pickup/throw; completing a pit; and opening the statue inspector by
clicking the actual 3D sculpture. All requested visual gates passed. The final
chat case showed three visitors, including another orange-clothed visitor:
the local YOU flag and body remained unmistakable.

The review caused additional iterations on cooler lighting, tree composition,
rounded path ends, desktop rail width, label/player collision avoidance, camera
frustum coverage during rollover, and volumetric white departure wings.

Final local release checks passed: TypeScript, ESLint, 55 web tests, 51 realtime
tests, the two-client workerd lifecycle/restart integration, and dry-run packages
for both Workers. Browser checks included simultaneous pickup contention (one
winner), shared counters, 180 px speech bubbles with zero YOU overlap, reconnect,
statue inspection, and departure cleanup. The final two-client browser run
reported no page errors or failed resource responses.

No new Meshy generation was performed: the current environment and project
.env files did not contain a Meshy key. The implemented park and sculptures use
local geometry, and the entry/share images are captures of the actual game.
