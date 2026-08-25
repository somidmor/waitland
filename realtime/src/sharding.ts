// Keep every originally valid directory address so old signed resumes can
// preserve the FieldRoom owner recorded before allocator changes. Only the
// first directory receives fresh joins today, which packs a quiet launch into
// the same rooms. High-frequency gameplay remains sharded across FieldRooms.
export const LOBBY_SHARD_COUNT = 16;
export const ACTIVE_NEW_JOIN_LOBBY_SHARDS = 1;

export function stableShard(value: string, shards: number) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % shards;
}

export function lobbyDirectoryForActor(actorId: string) {
  return `directory-${stableShard(actorId, ACTIVE_NEW_JOIN_LOBBY_SHARDS)}`;
}

/** Directory used by tokens issued before the owning directory was signed. */
export function legacyLobbyDirectoryForActor(actorId: string) {
  return `directory-${stableShard(actorId, LOBBY_SHARD_COUNT)}`;
}

export function isLobbyId(value: string) {
  const match = /^directory-(0|[1-9]\d?)$/.exec(value);
  if (!match) return false;
  return Number.parseInt(match[1], 10) < LOBBY_SHARD_COUNT;
}

export function isActiveNewJoinLobbyId(value: string) {
  const match = /^directory-(0|[1-9]\d?)$/.exec(value);
  if (!match) return false;
  return Number.parseInt(match[1], 10) < ACTIVE_NEW_JOIN_LOBBY_SHARDS;
}
