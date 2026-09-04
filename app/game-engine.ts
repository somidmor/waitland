import * as THREE from "three";
import { CARRY_SPEED, WALK_SPEED, PICKUP_RADIUS, FIELD_STONE_COUNT, getStoneDescriptor, parseStoneIndex, clampPositionOutsidePit, createInitialPitState, advancePitState, parsePitState, type PitState } from "../shared/world";
import { createProceduralAvatar, type RiggedAvatarRuntime } from "./avatar";
import { createAvatarAppearance } from "./avatar-design";
import { WAITLANDER_RUNTIME_MANIFEST } from "./avatar/waitlander-manifest";
import { RemoteAvatarRenderer, type RemoteAvatarAnchor } from "./remote-avatar-renderer";
import { RealtimeClient, type RealtimeStatus, type RealtimePlayer, type RealtimeStone, type ActionResultMessage } from "./realtime-client";
import { createWaitingWorld } from "./world-art";
import { nextWalkingPosition, pitApproach, type GroundPoint } from "./game-navigation";
import { StoneAudio } from "./game-audio";
import type { WaitProfile } from "./profile";

const LOCAL_PIT_KEY = "waitland-local-pit-v2";
export type GameAction = "pick" | "walk" | "throw" | "busy";
export type GameCallbacks = {
  onPit: (pit: PitState) => void;
  onStatus: (status: RealtimeStatus) => void;
  onAction: (action: GameAction, carrying: boolean) => void;
  onPeople: (count: number) => void;
  onToast: (message: string) => void;
  onDeposit: () => void;
  onSpeech: (anchors: readonly RemoteAvatarAnchor[]) => void;
  onLeave: () => void;
  onError: () => void;
};
type Destination = GroundPoint & { stoneId?: string; throw?: boolean };
type PendingAction = { id: string; kind: "pickup" | "throw"; stoneId: string; at: number; pit: PitState };
type Flight = { mesh: THREE.Mesh; stoneId: string; start: THREE.Vector3; end: THREE.Vector3; elapsed: number; deposited: boolean };
type RemoteFlight = Flight & { waitingForRelease: boolean; releaseDeadline: number };

export function createGameEngine(mount: HTMLDivElement, profile: WaitProfile, callbacks: GameCallbacks) {
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch { callbacks.onError(); return null; }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.6));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.domElement.setAttribute("aria-label", "Waitland meadow. Tap a rock to collect it, then tap the pit to throw.");
  renderer.domElement.setAttribute("role", "img");
  mount.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const world = createWaitingWorld(scene);
  const camera = new THREE.OrthographicCamera(-16, 16, 25, -25, 0.1, 220);
  const player = new THREE.Group();
  player.position.set(0, 0, 18);
  scene.add(player);
  const avatar = createProceduralAvatar({ seed: "local", groundShadow: true, castShadow: true });
  player.add(avatar.root);
  let rigged: RiggedAvatarRuntime | null = null;
  const abort = new AbortController();
  let disposed = false;
  // The tiny colored person is the production art direction. Keep the authored
  // rig available for explicit asset evaluation without charging every visitor
  // its model/texture download or overriding the readable clothing palette.
  const useRiggedAvatar = new URLSearchParams(window.location.search).get("avatar") === "rigged";
  if (useRiggedAvatar) void import("./avatar/rigged-avatar-runtime").then(async ({ loadRiggedAvatar }) => {
    const result = await loadRiggedAvatar(WAITLANDER_RUNTIME_MANIFEST, { signal: abort.signal, castShadow: true });
    if (!result.ok) return;
    if (disposed) { result.avatar.dispose(); return; }
    rigged = result.avatar;
    player.add(rigged.root);
    avatar.root.visible = false;
  }).catch(() => undefined);
  const remote = new RemoteAvatarRenderer(scene, { maxRiggedPlayers: useRiggedAvatar ? 12 : 0, mobileRiggedPlayers: useRiggedAvatar ? 8 : 0, riggedDistance: 28 });
  const players = new Map<string, RealtimePlayer>();
  const stones = new Map<string, RealtimeStone>();
  const audio = new StoneAudio();
  let pit = createInitialPitState(Date.now());
  try { pit = parsePitState(JSON.parse(localStorage.getItem(LOCAL_PIT_KEY) ?? "null")) ?? pit; } catch { /* Invalid or unavailable storage starts a fresh local meadow. */ }
  player.position.set(pit.center.x, 0, pit.center.z + pit.wallRadius + 6);
  let selfId = "local";
  let destination: Destination | null = null;
  let held: string | null = null;
  let pending: PendingAction | null = null;
  let flight: Flight | null = null;
  let interaction: { kind: "pickup" | "throw"; startedAt: number } | null = null;
  const remoteFlights = new Map<string, RemoteFlight>();
  let leavingAt: number | null = null;
  let blocked = false;
  let hasJoined = false;
  let lastAction = "";
  let lastTime = performance.now();
  let frame = 0;
  let uiClock = 0;
  let width = 1;
  let height = 1;
  const keys = new Set<string>();
  const joystick = { x: 0, z: 0 };
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const lookAt = new THREE.Vector3(0, 0, 8);
  const desiredLook = new THREE.Vector3();
  const celebrationFocus = new THREE.Vector3();
  let celebrationUntil = 0;
  const cameraOffset = new THREE.Vector3(13, 28, 29);
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const hitPoint = new THREE.Vector3();
  const heldPoint = new THREE.Vector3();
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.28, 0.38, 32), new THREE.MeshBasicMaterial({ color: 0xfaf6e9, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
  marker.rotation.x = -Math.PI / 2;
  marker.position.y = 0.09;
  marker.visible = false;
  scene.add(marker);
  const wingGeometry = new THREE.SphereGeometry(1, 12, 8);
  const wingMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1 });
  const wings = [-1, 1].map((sign) => {
    const wing = new THREE.Mesh(wingGeometry, wingMaterial);
    wing.scale.set(1.3, 0.2, 0.55);
    wing.position.set(sign * 1.1, 2.1, 0.3);
    wing.rotation.z = sign * 0.3;
    wing.visible = false;
    player.add(wing);
    return wing;
  });

  function applyPit(next: PitState, celebrate = true) {
    if (hasJoined && (next.round < pit.round || (next.round === pit.round && next.count < pit.count))) return;
    const previous = pit;
    pit = next;
    if (previous.round !== next.round) {
      const safe = clampPositionOutsidePit(player.position.x, player.position.z, next);
      player.position.x = safe.x;
      player.position.z = safe.z;
    }
    world.setPit(pit);
    callbacks.onPit(pit);
    if (celebrate && next.round > previous.round) {
      callbacks.onToast("We made a statue. A bigger pit is waiting →");
      world.burst(previous.center.x, previous.center.z, "monument");
      audio.play("monument");
      celebrationFocus.set((previous.center.x + next.center.x) / 2, 0, (previous.center.z + next.center.z) / 2 + 3);
      celebrationUntil = performance.now() + 4200;
      destination = null;
    }
  }
  function placeStone(stone: RealtimeStone) {
    stones.set(stone.id, stone);
    if (held === stone.id || flight?.stoneId === stone.id || remoteFlights.has(stone.id)) return;
    const index = parseStoneIndex(stone.id);
    if (index === null) return;
    const descriptor = { ...getStoneDescriptor(index, stone.generation ?? 0, pit), x: stone.x, z: stone.z };
    world.setStone(descriptor, !stone.holderId);
  }
  function reconcileHeld(id: string, forceClear = false) {
    const state = stones.get(id);
    held = !forceClear && state?.holderId === selfId ? id : null;
    if (state && !held) placeStone(state);
  }
  function beginRemoteFlight(previous: RealtimeStone, next: RealtimeStone) {
    const actor = previous.holderId ? players.get(previous.holderId) : undefined;
    const mesh = world.stones.get(next.id);
    if (!actor || !mesh || next.holderId || next.id === held || flight?.stoneId === next.id) return false;
    const deposited = (next.generation ?? 0) > (previous.generation ?? 0);
    // A rollover arrives before the room's recycled stone. Choose the old
    // monument when the thrower is still standing beside that excavation.
    const target = [pit, ...pit.monuments].reduce((closest, candidate) =>
      Math.hypot(actor.x - candidate.center.x, actor.z - candidate.center.z) <
      Math.hypot(actor.x - closest.center.x, actor.z - closest.center.z) ? candidate : closest);
    const arc: RemoteFlight = {
      mesh, stoneId: next.id, start: new THREE.Vector3(actor.x, 1.65, actor.z),
      end: deposited ? new THREE.Vector3(target.center.x, -0.2, target.center.z) : new THREE.Vector3(next.x, 0.25, next.z),
      elapsed: 0, deposited, waitingForRelease: false, releaseDeadline: performance.now() + 900,
    };
    remoteFlights.set(next.id, arc);
    mesh.visible = false;
    arc.waitingForRelease = remote.deferStoneRelease(actor.id, (release) => {
      if (disposed || remoteFlights.get(next.id) !== arc) return;
      if (release) arc.start.copy(release.position);
      arc.waitingForRelease = false;
    });
    return true;
  }
  function resetLocalStones() {
    for (let index = 0; index < FIELD_STONE_COUNT; index++) {
      const descriptor = getStoneDescriptor(index, 0, pit);
      placeStone({ id: descriptor.id, x: descriptor.x, z: descriptor.z, generation: 0, holderId: null });
    }
  }
  function snapshot(player: RealtimePlayer) {
    return { id: player.id, x: player.x, z: player.z, yaw: player.heading, vx: player.vx, vz: player.vz,
      moving: Math.hypot(player.vx ?? 0, player.vz ?? 0) > 0.1, carryingStone: Boolean(player.carrying),
      profile: { name: player.profile.name, waitingFor: player.profile.waitReason } };
  }
  function countPeople() { callbacks.onPeople(1 + players.size); }
  function pose(vx = 0, vz = 0) { return { x: player.position.x, z: player.position.z, heading: player.rotation.y, vx, vz }; }
  function pickupComplete(id: string) {
    remoteFlights.delete(id);
    held = id;
    destination = null;
    const mesh = world.stones.get(id);
    if (mesh) mesh.visible = true;
    rigged?.playInteraction({ kind: "pickup", restart: true });
    interaction = { kind: "pickup", startedAt: performance.now() };
    audio.play("pickup");
    callbacks.onToast("One little rock. Tap the pit.");
  }
  function beginFlight(id: string, targetPit: PitState, deposited: boolean) {
    const mesh = world.stones.get(id);
    held = null;
    destination = null;
    if (!mesh) return;
    (rigged?.anchors.heldItem ?? avatar.anchors.heldItem).getWorldPosition(heldPoint);
    const angle = Math.random() * Math.PI * 2;
    const radius = Math.random() * targetPit.radius * 0.5;
    const end = deposited
      ? new THREE.Vector3(targetPit.center.x + Math.cos(angle) * radius, -0.2, targetPit.center.z + Math.sin(angle) * radius)
      : new THREE.Vector3(stones.get(id)?.x ?? player.position.x, 0.4, stones.get(id)?.z ?? player.position.z);
    flight = { mesh, stoneId: id, start: heldPoint.clone(), end, elapsed: -0.16, deposited };
    rigged?.playInteraction({ kind: "throw", restart: true });
    interaction = { kind: "throw", startedAt: performance.now() };
  }
  function onAction(result: ActionResultMessage) {
    if (!pending || pending.id !== result.id) return;
    const action = pending;
    pending = null;
    if (!result.ok) {
      // A failed global deposit releases the server's rock onto the ground.
      // Keeping the local hand full here would strand a phantom owned stone.
      reconcileHeld(action.stoneId, action.kind === "pickup" || result.reason === "not-carrying");
      callbacks.onToast(result.reason === "too-far" ? "A little closer. Try again." : result.reason === "pit-unavailable" ? "The pit needs a moment. Your rock is on the grass." : "That rock moved. Try another.");
      destination = null;
      return;
    }
    if (action.kind === "pickup") pickupComplete(action.stoneId);
    else {
      beginFlight(action.stoneId, action.pit, Boolean(result.deposited));
      if (result.deposited) callbacks.onDeposit();
      if (result.pit) applyPit(result.pit);
    }
  }
  const realtime = new RealtimeClient({ profile,
    onStatus(status) {
      if (disposed) return;
      callbacks.onStatus(status);
      blocked = status.state === "replaced" || status.state === "incompatible";
      if (status.state !== "online" && status.state !== "connecting" && hasJoined) {
        pending = null;
        const interruptedRocks = [...remoteFlights.keys()];
        remoteFlights.clear();
        for (const id of interruptedRocks) {
          const state = stones.get(id);
          if (state) placeStone(state);
        }
        for (const id of players.keys()) remote.depart(id);
        players.clear();
        for (const stone of stones.values()) if (stone.holderId && stone.id !== held) placeStone({ ...stone, holderId: null });
        countPeople();
      }
    },
    onWelcome(message) {
      if (disposed || leavingAt !== null) return;
      held = null;
      pending = null;
      flight = null;
      remoteFlights.clear();
      destination = null;
      hasJoined = false;
      applyPit(message.pit, false);
      hasJoined = true;
      selfId = message.selfId;
      avatar.setAppearance(createAvatarAppearance(selfId));
      const self = message.players.find((entry) => entry.id === selfId);
      if (self) { player.position.set(self.x, 0, self.z); player.rotation.y = self.heading; }
      lookAt.set(player.position.x * 0.4 + pit.center.x * 0.6, 0, player.position.z * 0.4 + pit.center.z * 0.6);
      stones.clear();
      for (const mesh of world.stones.values()) mesh.visible = false;
      message.stones.forEach(placeStone);
      if (typeof self?.carrying === "string") pickupComplete(self.carrying);
      players.clear();
      for (const entry of message.players) if (entry.id !== selfId && !entry.sleeping) players.set(entry.id, entry);
      remote.replaceSnapshot([...players.values()].map(snapshot), message.serverTime);
      countPeople();
    },
    onFrame(message) {
      for (const delta of message.players) {
        if (delta.id === selfId) {
          if (!pending && !flight && Object.prototype.hasOwnProperty.call(delta, "carrying")) {
            const authoritativeHeld = typeof delta.carrying === "string" ? delta.carrying : null;
            if (held !== authoritativeHeld) {
              const previousHeld = held;
              held = authoritativeHeld;
              if (previousHeld) {
                const released = stones.get(previousHeld);
                if (released) placeStone(released);
              }
              if (held) remoteFlights.delete(held);
            }
          }
          if (!pending && !flight && Math.hypot(delta.x - player.position.x, delta.z - player.position.z) > 2.5) {
            player.position.set(delta.x, 0, delta.z);
          }
          continue;
        }
        const previous = players.get(delta.id);
        const profile = delta.profile ?? previous?.profile;
        if (!profile) continue;
        const next = { ...previous, ...delta, profile };
        if (next.sleeping) { players.delete(next.id); remote.depart(next.id); }
        else { players.set(next.id, next); remote.upsert(snapshot(next), message.serverTime); }
      }
      countPeople();
    },
    onStone(message) {
      if (message.stone) {
        const previous = stones.get(message.stone.id);
        if (message.stone.holderId) remoteFlights.delete(message.stone.id);
        if (previous?.holderId && previous.holderId !== selfId && !message.stone.holderId) {
          beginRemoteFlight(previous, message.stone);
        }
        placeStone(message.stone);
      } else if (message.stoneId) {
        remoteFlights.delete(message.stoneId);
        stones.delete(message.stoneId);
        const mesh = world.stones.get(message.stoneId);
        if (mesh) mesh.visible = false;
      }
    },
    onPit(message) { applyPit(message.pit); },
    onAction,
    onChat(message) {
      if (message.playerId !== selfId) remote.setSpeech(message.playerId, message.text, message.expiresAt);
    },
    onPlayer(message) {
      if (message.playerId === selfId) return;
      if (message.t === "player_leave" || message.t === "player_sleep") { players.delete(message.playerId); remote.depart(message.playerId); }
      else if (message.player) { players.set(message.playerId, message.player); remote.upsert(snapshot(message.player)); }
      countPeople();
    },
    onError(error) { if (error.code === "chat-rate-limited") callbacks.onToast("Give your words a moment to land."); },
  });

  function takeRock(id: string) {
    if (held || pending || flight || blocked || leavingAt !== null) return;
    const stone = stones.get(id);
    if (!stone || stone.holderId) { destination = null; return; }
    if (Math.hypot(stone.x - player.position.x, stone.z - player.position.z) > PICKUP_RADIUS - 0.15) {
      destination = { x: stone.x, z: stone.z, stoneId: id };
      return;
    }
    if (realtime.isOnline) {
      realtime.sendMovementImmediately(pose());
      const actionId = realtime.pickup(id);
      if (actionId) pending = { id: actionId, kind: "pickup", stoneId: id, at: performance.now(), pit };
    } else { stones.set(id, { ...stone, holderId: selfId }); pickupComplete(id); }
  }
  function throwRock() {
    if (!held || pending || flight || blocked || leavingAt !== null) return;
    const distance = Math.hypot(player.position.x - pit.center.x, player.position.z - pit.center.z);
    if (distance > pit.throwRadius - 0.75) { destination = { ...pitApproach(player.position, pit), throw: true }; return; }
    player.rotation.y = Math.atan2(player.position.x - pit.center.x, player.position.z - pit.center.z);
    const id = held;
    if (realtime.isOnline) {
      realtime.sendMovementImmediately(pose());
      const actionId = realtime.throwStone(id);
      if (actionId) pending = { id: actionId, kind: "throw", stoneId: id, at: performance.now(), pit };
    } else {
      const oldPit = pit;
      beginFlight(id, oldPit, true);
      const next = advancePitState(pit, Date.now());
      applyPit(next);
      const stone = stones.get(id);
      const index = parseStoneIndex(id);
      if (index !== null) {
        const descriptor = getStoneDescriptor(index, (stone?.generation ?? 0) + 1, pit);
        stones.set(id, { id, x: descriptor.x, z: descriptor.z, generation: descriptor.generation, holderId: null });
      }
      if (next.round !== oldPit.round) resetLocalStones();
      try { localStorage.setItem(LOCAL_PIT_KEY, JSON.stringify(pit)); } catch { /* Private browsing remains playable. */ }
      callbacks.onDeposit();
    }
  }
  function closestStone() {
    let closest: RealtimeStone | null = null;
    let distance = Infinity;
    for (const stone of stones.values()) {
      if (stone.holderId) continue;
      const value = Math.hypot(stone.x - player.position.x, stone.z - player.position.z);
      if (value < distance) { distance = value; closest = stone; }
    }
    return closest;
  }
  function action() {
    if (held) throwRock();
    else { const closest = closestStone(); if (closest) takeRock(closest.id); }
  }
  let down: { x: number; y: number } | null = null;
  function pointerDown(event: PointerEvent) { down = { x: event.clientX, y: event.clientY }; }
  function pointerUp(event: PointerEvent) {
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 14 || blocked || leavingAt !== null) { down = null; return; }
    down = null;
    const rect = renderer.domElement.getBoundingClientRect();
    pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const targets = [...world.stones.values()].filter((mesh) => mesh.visible && !stones.get(String(mesh.userData.stoneId))?.holderId);
    const hits = raycaster.intersectObjects([world.pitTarget, ...targets], false);
    const object = hits[0]?.object;
    if (object === world.pitTarget) {
      if (held) throwRock();
      else callbacks.onToast("Pick up a rock first. Tap one on the grass.");
      return;
    }
    if (object?.userData.stoneId && !held) { takeRock(String(object.userData.stoneId)); return; }
    if (raycaster.ray.intersectPlane(plane, hitPoint)) {
      if (!held) {
        // Enlarged ground-plane hit areas make the little rocks forgiving on touch.
        const nearby = [...stones.values()].filter((stone) => !stone.holderId).sort((a, b) => Math.hypot(a.x - hitPoint.x, a.z - hitPoint.z) - Math.hypot(b.x - hitPoint.x, b.z - hitPoint.z))[0];
        if (nearby && Math.hypot(nearby.x - hitPoint.x, nearby.z - hitPoint.z) < 1.7) { takeRock(nearby.id); return; }
      }
      destination = clampPositionOutsidePit(hitPoint.x, hitPoint.z, pit);
    }
  }
  function keyDown(event: KeyboardEvent) {
    if (event.target instanceof HTMLElement) {
      if (event.target.isContentEditable || /INPUT|TEXTAREA|SELECT/.test(event.target.tagName) || event.target.closest('dialog[open], [role="dialog"]')) return;
      if (event.target.tagName === "BUTTON" && (event.code === "Space" || event.key === "Enter")) return;
    }
    if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " "].includes(event.key)) event.preventDefault();
    if (event.code === "Space" && !event.repeat) action();
    keys.add(event.key.toLowerCase());
  }
  function keyUp(event: KeyboardEvent) { keys.delete(event.key.toLowerCase()); }
  function blur() { keys.clear(); joystick.x = 0; joystick.z = 0; destination = null; }
  function resize() {
    width = Math.max(mount.clientWidth, 1);
    height = Math.max(mount.clientHeight, 1);
    const aspect = width / height;
    const halfHeight = aspect < 0.8 ? 23 : 20;
    camera.left = -halfHeight * aspect;
    camera.right = halfHeight * aspect;
    camera.top = halfHeight;
    camera.bottom = -halfHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height);
  }
  const observer = new ResizeObserver(resize);
  observer.observe(mount);
  resize();
  renderer.domElement.addEventListener("pointerdown", pointerDown);
  renderer.domElement.addEventListener("pointerup", pointerUp);
  window.addEventListener("keydown", keyDown);
  window.addEventListener("keyup", keyUp);
  window.addEventListener("blur", blur);
  function contextLost(event: Event) { event.preventDefault(); callbacks.onError(); }
  renderer.domElement.addEventListener("webglcontextlost", contextLost);
  applyPit(pit, false);
  resetLocalStones();
  void realtime.start();

  function animate(now: number) {
    if (disposed) return;
    // High-refresh displays should not double the game's GPU and battery cost.
    if (now - lastTime < 1000 / 60 - 0.5) {
      frame = requestAnimationFrame(animate);
      return;
    }
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    const previousX = player.position.x;
    const previousZ = player.position.z;
    if (leavingAt === null && !blocked) {
      let sx = joystick.x + Number(keys.has("d") || keys.has("arrowright")) - Number(keys.has("a") || keys.has("arrowleft"));
      let sz = joystick.z + Number(keys.has("s") || keys.has("arrowdown")) - Number(keys.has("w") || keys.has("arrowup"));
      const strength = Math.hypot(sx, sz);
      if (strength > 0.08) {
        destination = null;
        sx /= Math.max(strength, 1); sz /= Math.max(strength, 1);
        const angle = Math.atan2(cameraOffset.x, cameraOffset.z);
        const dx = sx * Math.cos(angle) + sz * Math.sin(angle);
        const dz = -sx * Math.sin(angle) + sz * Math.cos(angle);
        const speed = held ? CARRY_SPEED : WALK_SPEED;
        const next = clampPositionOutsidePit(player.position.x + dx * speed * dt, player.position.z + dz * speed * dt, pit);
        player.position.x = next.x; player.position.z = next.z;
      } else if (destination && !pending && !flight) {
        const distance = Math.hypot(destination.x - player.position.x, destination.z - player.position.z);
        const threshold = destination.stoneId ? PICKUP_RADIUS - 0.3 : 0.15;
        if (distance <= threshold) {
          const reached = destination;
          destination = null;
          if (reached.stoneId) takeRock(reached.stoneId);
          else if (reached.throw) throwRock();
        } else {
          const next = nextWalkingPosition(player.position, destination, (held ? CARRY_SPEED : WALK_SPEED) * dt, pit);
          player.position.x = next.x; player.position.z = next.z;
          if (destination.throw && Math.hypot(next.x - pit.center.x, next.z - pit.center.z) <= pit.throwRadius - 1) throwRock();
        }
      }
    }
    const vx = dt ? (player.position.x - previousX) / dt : 0;
    const vz = dt ? (player.position.z - previousZ) / dt : 0;
    const moving = Math.hypot(vx, vz) > 0.1;
    if (moving) {
      const heading = Math.atan2(-vx, -vz);
      player.rotation.y += Math.atan2(Math.sin(heading - player.rotation.y), Math.cos(heading - player.rotation.y)) * Math.min(1, dt * 14);
    }
    if (leavingAt === null) realtime.sendMovement(pose(vx, vz));
    const interactionProgress = interaction ? Math.min(1, (now - interaction.startedAt) / (interaction.kind === "pickup" ? 560 : 700)) : 1;
    const gesture = Math.sin(Math.max(0, interactionProgress) * Math.PI) * (reducedMotion ? 0.3 : 1);
    const picking = interaction?.kind === "pickup";
    avatar.updatePose({
      elapsedSeconds: now / 1000, moving, speed: moving ? 1 : 0,
      carryingStone: Boolean(held) || (interaction?.kind === "throw" && interactionProgress < 0.25),
      ...(interaction ? { bob: gesture * (picking ? -0.24 : 0.12), lean: gesture * (picking ? 0.12 : -0.14), lookPitch: gesture * (picking ? 0.2 : -0.12) } : {}),
    });
    avatar.root.rotation.x = gesture * (picking ? 0.17 : -0.1);
    if (interactionProgress === 1) interaction = null;
    rigged?.update(dt, { moving, speed: moving ? 1 : 0, carryingStone: Boolean(held) });
    if (held) {
      const mesh = world.stones.get(held);
      if (mesh) {
        (rigged?.anchors.heldItem ?? avatar.anchors.heldItem).getWorldPosition(mesh.position);
        mesh.visible = true;
        mesh.scale.setScalar(0.7);
      }
    }
    if (flight) {
      flight.elapsed += dt;
      const t = Math.max(0, Math.min(1, flight.elapsed / (reducedMotion ? 0.3 : 0.65)));
      flight.mesh.position.lerpVectors(flight.start, flight.end, t);
      flight.mesh.position.y += Math.sin(t * Math.PI) * 4;
      flight.mesh.rotation.x += dt * 6;
      flight.mesh.visible = true;
      if (t === 1) {
        const completed = flight;
        flight = null;
        if (completed.deposited) {
          world.burst(completed.end.x, completed.end.z, "deposit");
          audio.play("deposit");
          navigator.vibrate?.(18);
        }
        const state = stones.get(completed.stoneId);
        if (state) placeStone(state);
      }
    }
    for (const [id, arc] of remoteFlights) {
      if (arc.waitingForRelease && now < arc.releaseDeadline) continue;
      arc.waitingForRelease = false;
      arc.elapsed += dt;
      const t = Math.min(1, arc.elapsed / (reducedMotion ? 0.3 : 0.65));
      arc.mesh.visible = true;
      arc.mesh.position.lerpVectors(arc.start, arc.end, t);
      arc.mesh.position.y += Math.sin(t * Math.PI) * 3.6;
      arc.mesh.rotation.x += dt * 5;
      if (t === 1) {
        remoteFlights.delete(id);
        if (arc.deposited) world.burst(arc.end.x, arc.end.z, "deposit");
        const state = stones.get(id);
        if (state) placeStone(state);
        else arc.mesh.visible = false;
      }
    }
    if (pending && now - pending.at > 7000) {
      pending = null;
      held = null;
      destination = null;
      callbacks.onToast("The connection is catching up. Rejoining the meadow…");
      // Never guess whether a timed-out action committed. A fresh welcome
      // restores the authority's position, carrying state and recycled stones.
      realtime.sleep("action-timeout");
      realtime.wake();
    }
    if (leavingAt !== null) {
      const elapsed = (now - leavingAt) / 1000;
      player.position.y = elapsed * elapsed * 2;
      wings.forEach((wing, index) => { wing.visible = true; wing.rotation.z = (index ? 1 : -1) * (0.35 + Math.sin(now / 95) * 0.5); });
      if (elapsed > 2.2) { callbacks.onLeave(); return; }
    }
    const pitDistance = Math.hypot(player.position.x - pit.center.x, player.position.z - pit.center.z);
    const focusWeight = Math.min(0.6, 12 / Math.max(1, pitDistance));
    desiredLook.set(player.position.x * (1 - focusWeight) + pit.center.x * focusWeight, 0, player.position.z * (1 - focusWeight) + pit.center.z * focusWeight);
    const celebrating = now < celebrationUntil && !destination && leavingAt === null;
    if (celebrating) desiredLook.copy(celebrationFocus);
    const desiredZoom = celebrating && width < height ? 0.72 : 1;
    camera.zoom += (desiredZoom - camera.zoom) * (reducedMotion ? 1 : Math.min(1, dt * 3));
    camera.updateProjectionMatrix();
    lookAt.lerp(desiredLook, reducedMotion ? 1 : 1 - Math.exp(-dt * 3));
    camera.position.copy(lookAt).add(cameraOffset);
    camera.lookAt(lookAt);
    marker.visible = Boolean(destination);
    if (destination) marker.position.set(destination.x, 0.08, destination.z);
    world.update(now / 1000, player.position.x, player.position.z);
    remote.update(now, dt, camera, player.position, { width, height }, (anchors) => {
      if (uiClock > 0.1) callbacks.onSpeech(anchors.slice(0, 8).map((anchor) => ({
        ...anchor,
        speech: anchor.speechExpiresAt && anchor.speechExpiresAt <= Date.now() ? undefined : anchor.speech,
      })));
    });
    uiClock += dt;
    if (uiClock > 0.12) {
      uiClock = 0;
      const closest = closestStone();
      world.highlightStone(!held && closest && Math.hypot(closest.x - player.position.x, closest.z - player.position.z) < 4 ? closest.id : null);
      const mode: GameAction = pending || flight ? "busy" : destination ? "walk" : held ? "throw" : "pick";
      const key = `${mode}:${Boolean(held)}`;
      if (key !== lastAction) { lastAction = key; callbacks.onAction(mode, Boolean(held)); }
    }
    renderer.render(scene, camera);
    frame = requestAnimationFrame(animate);
  }
  frame = requestAnimationFrame(animate);
  return {
    action,
    setJoystick(x: number, z: number) { joystick.x = x; joystick.z = z; },
    setSound(enabled: boolean) { audio.enabled = enabled; if (enabled) audio.play("pickup"); },
    setProfile(next: WaitProfile) { realtime.setProfile(next); },
    speak(text: string) { if (!realtime.sendChat(text)) callbacks.onToast("Your words are just for you while offline."); },
    leave() { if (leavingAt !== null) return; leavingAt = performance.now(); destination = null; realtime.stop(); },
    goToPit() { destination = pitApproach(player.position, pit); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      abort.abort();
      realtime.destroy();
      observer.disconnect();
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
      renderer.domElement.removeEventListener("pointerdown", pointerDown);
      renderer.domElement.removeEventListener("pointerup", pointerUp);
      renderer.domElement.removeEventListener("webglcontextlost", contextLost);
      audio.dispose();
      remoteFlights.clear();
      remote.dispose();
      rigged?.dispose();
      avatar.dispose();
      marker.geometry.dispose();
      marker.material.dispose();
      wingGeometry.dispose();
      wingMaterial.dispose();
      world.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
export type GameEngine = NonNullable<ReturnType<typeof createGameEngine>>;
