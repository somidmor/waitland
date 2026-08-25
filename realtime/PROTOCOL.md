# Realtime protocol v1

All HTTP and WebSocket payloads are JSON. Coordinates are ground-plane `x/z`
values. Times are Unix milliseconds unless a token field explicitly says
seconds. Unknown fields must be ignored for forward compatibility.

## Join or resume

`POST /v1/session`

```json
{
  "profile": {
    "name": "Mina",
    "city": "Vancouver",
    "countryCode": "CA",
    "countryFlag": "🇨🇦",
    "waitReason": "Waiting for coffee"
  },
  "resumeToken": "optional previously issued token"
}
```

The server normalizes and bounds every profile field and derives the flag from
the two-letter country code. A valid resume token preserves the anonymous actor
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
  "capacity": 1000,
  "count": 0
}
```

Open `wsUrl` directly. Its signed ticket expires after 60 seconds. To reconnect,
call `/v1/session` again with `resumeToken`; do not reuse or persist `wsUrl`.
The session `count` is a compatibility field and is currently `0` so session
creation does not hit the global coordinator. The authoritative pit count is
in the WebSocket `welcome` snapshot.

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
- Action/chat IDs use 1–48 characters from `A-Z a-z 0-9 _ -`.
- Chat is capped at 80 Unicode characters and a burst of three messages; it
  then refills at three messages per ten seconds.
- Pickup and throw IDs are idempotency keys. Retrying the same ID returns the
  cached `action` result.
- A throw deposits only when the authoritative player is within the shared pit
  throw radius. Otherwise the stone is dropped safely in front of the avatar.

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
  "capacity": 1000,
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
{"t":"pit","count":43,"capacity":1000}
{"t":"action","id":"action-id","ok":true,"kind":"throw","deposited":true,"count":43}
{"t":"pong"}
{"t":"error","code":"chat-rate-limited"}
```

Stone `upsert` events replace mutable state for that stone ID. A generation
change means the deterministic descriptor from `getStoneDescriptor(index,
generation)` should be rebuilt. `pit` updates are coalesced and eventually
delivered across every active room; the deposit result is immediate for the
throwing actor.

The constant `{"t":"ping"}` heartbeat is intentional: Cloudflare can answer
it with a WebSocket auto-response while the room isolate remains hibernated.
Timestamped pings remain accepted for protocol compatibility but wake the room.
