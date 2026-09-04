# Realtime protocol v1

All HTTP and WebSocket payloads are JSON. Coordinates are ground-plane `x/z`
values. Times are Unix milliseconds unless a token field explicitly says
seconds. Unknown fields must be ignored for forward compatibility.

## Join or resume

`POST /v1/session`

```json
{
  "profile": {
    "waitReason": "Waiting for coffee"
  },
  "resumeToken": "optional previously issued token"
}
```

Only `waitReason` is needed (60 characters maximum); an empty reason becomes
"Just waiting". Legacy name/city/country fields remain optional. Omitted fields
are empty strings, and no location is invented. The server normalizes text and
derives any flag from the optional two-letter country code. A valid resume token preserves the anonymous actor
ID, prior room, and owning allocator directory, then attempts to wake the same
avatar. The token is opaque to the browser; clients must store and return it
unchanged.

```json
{
  "protocol": 1,
  "actorId": "uuid",
  "resumeToken": "signed seven-day token",
  "roomId": "field-11111111-2222-4333-8444-555555555555",
  "wsUrl": "wss://…/v1/connect?ticket=…",
  "capacity": 100,
  "count": 0
}
```

Open `wsUrl` directly. Its signed ticket expires after 60 seconds. To reconnect,
call `/v1/session` again with `resumeToken`; do not reuse or persist `wsUrl`.
The session `count` is a compatibility field and is currently `0` so session
creation does not hit the global coordinator. The session capacity is also a compatibility hint for round one. The complete
authoritative pit state arrives in the WebSocket `welcome` snapshot.

## Client to server

Movement should be sent at no more than 8 Hz. `vx`, `vz`, and `carrying` are optional
prediction hints and are not authoritative.

```json
{"t":"move","seq":18,"x":4.2,"z":12.8,"vx":1.1,"vz":0,"heading":1.57}
{"t":"profile","profile":{"name":"Mina","city":"Vancouver","countryCode":"CA","countryFlag":"🇨🇦","waitReason":"Waiting for coffee"}}
{"t":"chat","id":"uuid-or-opaque-id","text":"hello"}
{"t":"pickup","id":"uuid-or-opaque-id","stoneId":"stone-12"}
{"t":"throw","id":"uuid-or-opaque-id","stoneId":"stone-12"}
{"t":"ping"}
```

- `seq` must increase for the lifetime of a socket.
- Movement coordinates must be finite and precisely representable. Rooms
  enforce server-time speed credit and pit collision, but there is no
  artificial outer map edge.
- Action/chat IDs use 1–48 characters from `A-Z a-z 0-9 _ -`.
- Chat is capped at 80 Unicode characters and a burst of three messages; it
  then refills at three messages per ten seconds.
- Pickup and throw IDs are idempotency keys. Retrying the same ID returns the
  cached `action` result.
- A throw deposits only when the authoritative player is within the shared pit
  throw radius. Otherwise the stone travels 7.5 world units from the
  action-time pose (shortened only by pit collision) and is dropped in front of
  the avatar. Later movement while a pit request is pending cannot move that
  landing point.

Closing the WebSocket makes the actor dormant. The room zeroes velocity,
releases any held stone at the last position, stores the record privately for
resume continuity, and immediately broadcasts `player_leave`. Other clients
use that event for the white-wing departure animation. Dormant actors are not
included in welcome snapshots. A resumed session wakes the same actor.
Anonymous dormant records are retained for seven days; rooms stop accepting
new actors at a soft dormant-record limit, with a hard memory safety ceiling
for exceptional churn.

## Server to client

The first message is a complete room snapshot:

```json
{
  "t": "welcome",
  "protocol": 1,
  "selfId": "uuid",
  "roomId": "field-11111111-2222-4333-8444-555555555555",
  "count": 42,
  "capacity": 100,
  "pit": {
    "round": 1, "count": 42, "capacity": 100, "totalStones": 42,
    "center": {"x": 0, "z": 0}, "radius": 3.6,
    "wallRadius": 4.85, "throwRadius": 12.5,
    "startedAt": 1770000000000, "monuments": []
  },
  "players": [
    {
      "id": "uuid",
      "x": 4.2,
      "z": 12.8,
      "vx": 0,
      "vz": 0,
      "heading": 1.57,
      "carrying": null,
      "sleeping": false,
      "profile": {
        "name": "Mina",
        "city": "Vancouver",
        "countryCode": "CA",
        "countryFlag": "🇨🇦",
        "waitReason": "Waiting for coffee"
      }
    }
  ],
  "stones": [{"id":"stone-12","x":9.1,"z":17.2,"generation":0,"holderId":null}],
  "serverTime": 1770000000000
}
```

Subsequent movement frames are **delta upserts**, not complete snapshots. The
browser should retain players omitted from a frame and interpolate between
authoritative samples. `profile` is included only when a player joins or edits
it; motion-only deltas must be merged with the last known profile.

```json
{"t":"frame","serverTime":1770000000080,"players":[{"id":"uuid","x":4.3,"z":12.8,"vx":1.1,"vz":0,"heading":1.57,"carrying":null,"sleeping":false,"profile":{"name":"Mina","city":"Vancouver","countryCode":"CA","countryFlag":"🇨🇦","waitReason":"Waiting for coffee"}}]}
{"t":"chat","playerId":"uuid","id":"message-id","text":"hello","expiresAt":1770000007000}
{"t":"stone","op":"upsert","stone":{"id":"stone-12","x":9.1,"z":17.2,"generation":1,"holderId":null}}
{"t":"pit","count":43,"capacity":100,"pit":{"round":1,"count":43,"capacity":100,"totalStones":43,"center":{"x":0,"z":0},"radius":3.6,"wallRadius":4.85,"throwRadius":12.5,"startedAt":1770000000000,"monuments":[]}}
{"t":"action","id":"action-id","ok":true,"kind":"throw","deposited":true,"count":43}
{"t":"pong"}
{"t":"error","code":"chat-rate-limited"}
```

Stone `upsert` events replace mutable state for that stone ID. A generation
change means the deterministic descriptor from `getStoneDescriptor(index,
generation, pit)` should be rebuilt using the active pit layout. `pit` updates are coalesced and eventually
delivered across every active room; the deposit result is immediate for the
throwing actor. For a throw, the authoritative stone `upsert` is sent before
its `action` acknowledgement on the same socket so the browser can finish the
visible arc without snapping to stale predicted state. The room retains a
fixed pool of 84 stone IDs and keeps at least 10 unheld stones within the
near-pit ring (22 units in the first round, scaling with the pit); recycling increments a generation rather than growing
room state.

The constant `{"t":"ping"}` heartbeat is intentional: Cloudflare can answer
it with a WebSocket auto-response while the room isolate remains hibernated.
Timestamped pings remain accepted for protocol compatibility but wake the room.


## Excavation and monument lifecycle

`welcome.pit`, `pit.pit`, and successful throw `action.pit` contain the full
`PitState` from `shared/world.ts`. `GET /v1/pit` returns that state directly.
Top-level count/capacity remain for earlier clients; new clients use `pit`.
Protocol version stays 1 because these fields are additive. Cached throw
acknowledgements attach the current snapshot even if their original count was
from an earlier round.

A pit holds `round * 100` stones. Its final accepted deposit immediately creates
a `PitMonument` with `round`, `name`, `stoneCount`, `center`, `radius`, `startedAt`
and `completedAt` (Unix milliseconds), and begins the next round at count zero.
The current round's `totalStones` is the lifetime deposit total and orders
updates safely across rollovers. At most eight completed monuments are sent,
oldest to newest; all monument records remain durable at the coordinator.

`getPitLayout(round)` places centres at `{x: (round - 1) * 26, z: 0}` and makes
each new pit larger, approaching an eight-unit visual radius. Shared helpers
accept the current pit for collision, heading, throw distance and stone
placement. A throw already in flight when a neighbouring room finishes a pit
is accepted into the current round rather than discarded. The room captures
the target pit when queueing an action, so a preceding queued throw completing
a round cannot invalidate a legitimate throw already received. Temporary
coordinator failures leave the rock held and may be retried; the same stone
generation can never increase the global count twice. Unheld stones move
to the new excavation, while stone IDs and the fixed pool size remain stable.

Clients must compare `totalStones` before applying delayed snapshots and reject
malformed state with `parsePitState`/`isPitState`. Local-only play uses
`createInitialPitState` and `advancePitState` for the identical lifecycle; local
progress does not silently enter the global total when connectivity returns.
