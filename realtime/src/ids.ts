const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const ACTOR_ID = new RegExp(`^${UUID}$`, "i");
const ROOM_ID = new RegExp(`^field-${UUID}$`, "i");

export function isActorId(value: unknown): value is string {
  return typeof value === "string" && ACTOR_ID.test(value);
}

export function isRoomId(value: unknown): value is string {
  return typeof value === "string" && ROOM_ID.test(value);
}
