"use client";

import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { createInitialPitState, type PitMonument, type PitState } from "../shared/world";
import { createGameEngine, type GameAction, type GameEngine, type WorldAnchors } from "./game-engine";
import type { WaitingPitProps } from "./profile";
import type { RealtimeStatus } from "./realtime-client";
import type { RemoteAvatarAnchor } from "./remote-avatar-renderer";

type Panel = "menu" | "archive" | null;
const MONUMENT_LABEL_WIDTH = 184;
const MONUMENT_LABEL_HEIGHT = 64;

type OverlayRect = { left: number; top: number; width: number; height: number };

function overlapArea(first: OverlayRect, second: OverlayRect) {
  const width = Math.max(0, Math.min(first.left + first.width, second.left + second.width) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.top + first.height, second.top + second.height) - Math.max(first.top, second.top));
  return width * height;
}

function monumentLabelPosition(x: number, y: number, hero: WorldAnchors["hero"], width: number, height: number) {
  // Labels stay above the thumb controls, with 44px of clear field between them.
  const minTop = 100;
  const maxTop = Math.max(minTop, height - 184 - MONUMENT_LABEL_HEIGHT);
  function candidate(left: number, top: number): OverlayRect {
    return {
      left: Math.max(12, Math.min(width - MONUMENT_LABEL_WIDTH - 12, left)),
      top: Math.max(minTop, Math.min(maxTop, top)),
      width: MONUMENT_LABEL_WIDTH,
      height: MONUMENT_LABEL_HEIGHT,
    };
  }
  const original = candidate(x - MONUMENT_LABEL_WIDTH / 2, y + 5);
  if (!hero.visible) return original;
  const heroX = Math.max(36, Math.min(width - 36, hero.screenX));
  const heroY = Math.max(78, Math.min(height - 148, hero.screenY));
  const flag = { left: heroX - 36, top: heroY - 37, width: 72, height: 48 };
  const player = { left: heroX - 40, top: heroY - 37, width: 80, height: 123 };
  if (!overlapArea(original, player)) return original;
  const options = [
    candidate(original.left, player.top + player.height + 12),
    candidate(original.left, player.top - MONUMENT_LABEL_HEIGHT - 12),
    candidate(player.left - MONUMENT_LABEL_WIDTH - 12, original.top),
    candidate(player.left + player.width + 12, original.top),
  ];
  const clearPlacement = options.find((option) => overlapArea(option, player) === 0);
  if (clearPlacement) return clearPlacement;
  // If a very short viewport cannot fit a label completely outside the player,
  // protecting the YOU flag takes priority over the remaining body overlap.
  const score = (option: OverlayRect) => overlapArea(option, flag) * 1_000_000 + overlapArea(option, player) * 1_000 + Math.hypot(option.left - original.left, option.top - original.top);
  return options.reduce((best, option) => score(option) < score(best) ? option : best);
}

function speechBubblePosition(x: number, y: number, bubbleHeight: number, hero: WorldAnchors["hero"], width: number, height: number) {
  function candidate(left: number, top: number): OverlayRect {
    return { left: Math.max(12, Math.min(width - 192, left)), top: Math.max(90, Math.min(height - 150 - bubbleHeight, top)), width: 180, height: bubbleHeight };
  }
  const original = candidate(x - 90, y - bubbleHeight);
  if (!hero.visible) return original;
  const heroX = Math.max(36, Math.min(width - 36, hero.screenX));
  const heroY = Math.max(78, Math.min(height - 148, hero.screenY));
  const flag = { left: heroX - 36, top: heroY - 37, width: 72, height: 48 };
  const player = { ...flag, height: 116 };
  if (!overlapArea(original, player)) return original;
  const options = [
    candidate(original.left, player.top - bubbleHeight - 12),
    candidate(player.left - 192, original.top),
    candidate(player.left + player.width + 12, original.top),
    candidate(original.left, player.top + player.height + 12),
  ];
  const clearPlacement = options.find((option) => overlapArea(option, player) === 0);
  if (clearPlacement) return clearPlacement;
  const score = (option: OverlayRect) => overlapArea(option, flag) * 1_000_000 + overlapArea(option, player) * 1_000;
  return options.reduce((best, option) => score(option) < score(best) ? option : best);
}

function dateLabel(timestamp: number) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(timestamp);
}

export default function WaitingPit({ profile, onEditProfile }: WaitingPitProps) {
  const mount = useRef<HTMLDivElement>(null);
  const engine = useRef<GameEngine | null>(null);
  const initialProfile = useRef(profile);
  const dialog = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const archiveButton = useRef<HTMLButtonElement>(null);
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  const inspectClose = useRef<HTMLButtonElement>(null);
  const joystick = useRef<HTMLDivElement>(null);
  const joystickThumb = useRef<HTMLSpanElement>(null);
  const joystickPointer = useRef<number | null>(null);
  const heroLabel = useRef<HTMLDivElement>(null);
  const ownSpeechLabel = useRef<HTMLDivElement>(null);
  const monumentLabels = useRef(new Map<number, HTMLButtonElement>());
  const remoteSpeechLabels = useRef(new Map<string, HTMLDivElement>());
  const speechMeasurements = useRef(new Map<string, { text: string; height: number }>());
  const latestSpeechAnchors = useRef<readonly RemoteAvatarAnchor[]>([]);
  const [pit, setPit] = useState<PitState>(() => createInitialPitState(0));
  const [status, setStatus] = useState<RealtimeStatus>({ state: "connecting", attempt: 0 });
  const [action, setAction] = useState<GameAction>("pick");
  const [carrying, setCarrying] = useState(false);
  const [people, setPeople] = useState(1);
  const [contribution, setContribution] = useState(0);
  const [toast, setToast] = useState("");
  const [speeches, setSpeeches] = useState<readonly RemoteAvatarAnchor[]>([]);
  const [sound, setSound] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chat, setChat] = useState("");
  const [ownSpeech, setOwnSpeech] = useState("");
  const [panel, setPanel] = useState<Panel>(null);
  const [selectedMonument, setSelectedMonument] = useState<PitMonument | null>(null);
  const [left, setLeft] = useState(false);
  const [error, setError] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function showToast(text: string) {
    setToast(text);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(""), 3800);
  }

  useEffect(() => {
    if (!mount.current) return;
    function updateAnchors(anchors: WorldAnchors) {
      const width = window.innerWidth;
      const height = window.innerHeight;
      function position(node: HTMLElement | null, x: number, y: number, visible: boolean, halfWidth: number) {
        if (!node) return;
        node.style.display = visible ? "" : "none";
        if (!visible) return;
        node.style.left = `${Math.max(halfWidth + 12, Math.min(width - halfWidth - 12, x))}px`;
        node.style.top = `${Math.max(78, Math.min(height - 148, y))}px`;
      }
      position(heroLabel.current, anchors.hero.screenX, anchors.hero.screenY, anchors.hero.visible, 24);
      position(ownSpeechLabel.current, anchors.hero.screenX, anchors.hero.screenY - 40, anchors.hero.visible, 90);
      const visible = new Set<number>();
      for (const anchor of anchors.monuments) {
        visible.add(anchor.round);
        const node = monumentLabels.current.get(anchor.round);
        if (!node) continue;
        node.style.display = anchor.visible ? "" : "none";
        if (!anchor.visible) continue;
        const placement = monumentLabelPosition(anchor.screenX, anchor.screenY, anchors.hero, width, height);
        node.style.left = `${placement.left + MONUMENT_LABEL_WIDTH / 2}px`;
        node.style.top = `${placement.top - 5}px`;
      }
      for (const [round, node] of monumentLabels.current) if (!visible.has(round)) node.style.display = "none";
      for (const anchor of latestSpeechAnchors.current) {
        const node = remoteSpeechLabels.current.get(anchor.id);
        if (!node || !anchor.speech || node.textContent !== anchor.speech) continue;
        node.style.display = "";
        let measurement = speechMeasurements.current.get(anchor.id);
        if (!measurement || measurement.text !== anchor.speech) {
          // Measure only when the message changes, never on every animation frame.
          measurement = { text: anchor.speech, height: node.offsetHeight };
          speechMeasurements.current.set(anchor.id, measurement);
        }
        const placement = speechBubblePosition(anchor.screenX, anchor.screenY, measurement.height, anchors.hero, width, height);
        node.style.left = `${placement.left + 90}px`;
        node.style.top = `${placement.top + measurement.height}px`;
      }
    }
    engine.current = createGameEngine(mount.current, initialProfile.current, {
      onPit: setPit,
      onStatus: setStatus,
      onAction(mode, hasRock) { setAction(mode); setCarrying(hasRock); },
      onPeople: setPeople,
      onToast: showToast,
      onDeposit() { setContribution((count) => count + 1); },
      onSpeech(anchors) {
        latestSpeechAnchors.current = anchors;
        setSpeeches(anchors);
        for (const id of speechMeasurements.current.keys()) if (!anchors.some((anchor) => anchor.id === id && anchor.speech)) speechMeasurements.current.delete(id);
      },
      onWorldAnchors: updateAnchors,
      onInspectMonument: setSelectedMonument,
      onLeave() { setLeft(true); },
      onError() { setError(true); },
    });
    return () => {
      engine.current?.dispose();
      engine.current = null;
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => { engine.current?.setProfile(profile); }, [profile]);
  useEffect(() => {
    if (!ownSpeech) return;
    const timeout = setTimeout(() => setOwnSpeech(""), 7000);
    return () => clearTimeout(timeout);
  }, [ownSpeech]);
  useEffect(() => {
    if (panel) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [panel]);
  useEffect(() => {
    if (selectedMonument) inspectClose.current?.focus({ preventScroll: true });
  }, [selectedMonument]);
  useEffect(() => {
    if (left) { engine.current?.dispose(); engine.current = null; }
  }, [left]);

  const online = status.state === "online";
  const blocked = status.state === "replaced" || status.state === "incompatible";
  const actionText = action === "busy" ? "One moment…" : action === "walk" ? "Walking…" : carrying ? "Throw rock" : "Pick up rock";
  const connectionText = online ? `${people} here` : status.state === "connecting" ? "Connecting" : blocked ? "Rejoin" : "Offline";

  function moveJoystick(event: PointerEvent<HTMLDivElement>) {
    if (joystickPointer.current !== event.pointerId || !joystick.current) return;
    const rect = joystick.current.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const length = Math.max(30, Math.hypot(dx, dy));
    engine.current?.setJoystick(dx / length, dy / length);
    if (joystickThumb.current) joystickThumb.current.style.transform = `translate(${dx / length * 23}px, ${dy / length * 23}px)`;
  }
  function releaseJoystick() {
    joystickPointer.current = null;
    engine.current?.setJoystick(0, 0);
    if (joystickThumb.current) joystickThumb.current.style.transform = "translate(0, 0)";
  }
  function sendChat(event: FormEvent) {
    event.preventDefault();
    const text = chat.trim();
    if (!text) return;
    engine.current?.speak(text);
    setOwnSpeech(text);
    setChat("");
    setChatOpen(false);
  }
  async function share() {
    try {
      if (navigator.share) await navigator.share({ title: "Waitland", text: "Pick up rocks and build a statue with me.", url: "https://waitland.app" });
      else { await navigator.clipboard.writeText("https://waitland.app"); showToast("Link copied"); }
    } catch { /* Closing the share sheet needs no further action. */ }
  }
  function openPanel(nextPanel: Exclude<Panel, null>, trigger: HTMLButtonElement) {
    panelTrigger.current = trigger;
    engine.current?.inspectMonument(null);
    setPanel(nextPanel);
    setChatOpen(false);
  }
  function closePanel() {
    setPanel(null);
    requestAnimationFrame(() => panelTrigger.current?.focus());
  }
  function inspectMonument(monument: PitMonument) {
    setPanel(null);
    setChatOpen(false);
    engine.current?.inspectMonument(monument.round);
  }
  function closeInspection() {
    engine.current?.inspectMonument(null);
    archiveButton.current?.focus({ preventScroll: true });
  }

  if (left) return (
    <main className="game-leave-screen">
      <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
      <h1>Thanks for stopping by.</h1>
      <p>{contribution ? `You added ${contribution} ${contribution === 1 ? "rock" : "rocks"} to the field.` : "Your place in the field will be here."}</p>
      <button className="enter-field-button" onClick={() => window.location.reload()}>Return to the field</button>
      <button className="game-text-button" onClick={() => void share()}>Invite a friend</button>
    </main>
  );

  return (
    <main className="game-shell" aria-label="Waitland">
      <div className="game-canvas" ref={mount} />
      <header className="game-topbar">
        <div className="game-identity"><span className="game-brand">waitland</span><span className="game-status" data-status={online ? "online" : "offline"}>{connectionText}</span></div>
        <button className="game-pit-card" onClick={() => engine.current?.goToPit()} aria-label={`Pit ${pit.round}, ${pit.count} of ${pit.capacity} rocks. Walk to the pit.`}>
          <span className="game-pit-label">Pit {pit.round}</span>
          <span className="game-pit-count"><strong>{pit.count.toLocaleString()}</strong><span> / {pit.capacity.toLocaleString()}</span></span>
          <span className="game-progress" role="progressbar" aria-label="Shared pit progress" aria-valuemin={0} aria-valuemax={pit.capacity} aria-valuenow={pit.count}><span style={{ width: `${Math.min(100, pit.count / pit.capacity * 100)}%` }} /></span>
        </button>
        <div className="game-top-actions">
          <button ref={archiveButton} className="game-archive-button" type="button" onClick={(event) => openPanel("archive", event.currentTarget)}><span className="statue-symbol" aria-hidden="true" />Statues</button>
          <button ref={menuButton} type="button" className="game-menu-button" aria-label="Open field menu" onClick={(event) => openPanel("menu", event.currentTarget)}>•••</button>
        </div>
      </header>

      <div className="game-owner-layer"><div ref={heroLabel} className="game-you-label" style={{ display: "none" }}>YOU</div></div>
      <div className="game-world-labels" aria-live="off">
        {pit.monuments.map((monument) => (
          <button
            key={monument.round}
            ref={(node) => { if (node) monumentLabels.current.set(monument.round, node); else monumentLabels.current.delete(monument.round); }}
            className="game-monument-label"
            style={{ display: "none" }}
            onClick={() => inspectMonument(monument)}
            aria-label={`View ${monument.name}, completed ${dateLabel(monument.completedAt)}`}
          >
            <strong>{monument.name}</strong><span>{dateLabel(monument.completedAt)}</span>
          </button>
        ))}
      </div>
      <div className="game-speech-layer" aria-live="off">
        {speeches.filter((anchor) => anchor.speech && !anchor.departing && anchor.distance < 24).slice(0, 5).map((anchor) => (
          <div key={anchor.id} ref={(node) => { if (node) remoteSpeechLabels.current.set(anchor.id, node); else remoteSpeechLabels.current.delete(anchor.id); }} className="game-speech-bubble" style={{ display: "none" }}>{anchor.speech}</div>
        ))}
        {ownSpeech ? <div ref={ownSpeechLabel} className="game-speech-bubble game-own-speech" style={{ display: "none" }}>{ownSpeech}</div> : null}
      </div>
      <div className="game-toast" role="status" aria-live="polite">{toast}</div>

      {!selectedMonument ? <div className="game-bottom">
        <div className="game-controls-row">
          <div className="game-joystick" ref={joystick} aria-label="Drag to walk" onPointerDown={(event) => { joystickPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); moveJoystick(event); }} onPointerMove={moveJoystick} onPointerUp={releaseJoystick} onPointerCancel={releaseJoystick} onLostPointerCapture={releaseJoystick}>
            <span className="game-joystick-thumb" ref={joystickThumb} />
          </div>
          <div className="game-primary-control">
            <p className="game-hint">{carrying ? "Tap the pit to throw" : "Tap a rock to pick it up"}</p>
            <button type="button" className="game-action" disabled={action === "busy" || blocked || error} onClick={() => engine.current?.action()}><span className="action-rock" aria-hidden="true" /><span>{actionText}</span><span aria-hidden="true">{carrying ? "↗" : "+"}</span></button>
          </div>
        </div>
        <div className="game-secondary-actions">
          <button type="button" className="game-text-button" onClick={() => setChatOpen((value) => !value)} aria-expanded={chatOpen}>Chat</button>
          <span className="game-keyboard-hint">WASD · Space to pick up & throw</span>
          <button type="button" className="game-text-button" onClick={() => engine.current?.leave()}>Leave ↗</button>
        </div>
        {chatOpen ? <form className="game-chat-form" onSubmit={sendChat}><input aria-label="Say something nearby" placeholder="Say something nearby…" value={chat} maxLength={80} autoFocus onChange={(event) => setChat(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setChatOpen(false); }} /><button type="submit" disabled={!chat.trim()} aria-label="Send nearby message">↑</button><button type="button" onClick={() => setChatOpen(false)} aria-label="Close message">×</button></form> : null}
      </div> : (
        <section className="monument-inspector" role="dialog" aria-modal="false" aria-labelledby="monument-name" onKeyDown={(event) => { if (event.key === "Escape") closeInspection(); }}>
          <div className="monument-inspector-top"><span>Statue {selectedMonument.round}</span><button ref={inspectClose} className="game-icon-button" type="button" aria-label="Close statue details" onClick={closeInspection}>×</button></div>
          <h2 id="monument-name">{selectedMonument.name}</h2>
          <p className="monument-date">{dateLabel(selectedMonument.completedAt)} <span>UTC</span></p>
          <p className="monument-count">Built from <strong>{selectedMonument.stoneCount.toLocaleString()} rocks</strong></p>
          <button className="monument-return" type="button" onClick={closeInspection}>Return to the field <span aria-hidden="true">→</span></button>
        </section>
      )}

      <dialog ref={dialog} className="game-dialog" onCancel={closePanel} onClose={() => setPanel(null)} aria-labelledby="game-panel-title">
        <div className="game-dialog-heading"><h2 id="game-panel-title">{panel === "archive" ? "Our statues" : "The field"}</h2><button className="game-icon-button" aria-label="Close menu" onClick={closePanel}>×</button></div>
        {panel === "archive" ? <>
          <p>Every statue was made by people waiting here.</p>
          <section className="game-monuments" aria-label="Our statues">
            {pit.monuments.length ? pit.monuments.slice().reverse().map((monument) => (
              <button className="monument-archive-item" key={monument.round} onClick={() => inspectMonument(monument)}><span className="statue-symbol" aria-hidden="true" /><span><strong>{monument.name}</strong><span>{dateLabel(monument.completedAt)}</span><span>{monument.stoneCount.toLocaleString()} rocks</span></span><span aria-hidden="true">→</span></button>
            )) : <p className="game-empty-archive">No statues yet. Fill the first pit with {pit.capacity.toLocaleString()} rocks to build one.</p>}
          </section>
          <button className="dialog-return" onClick={closePanel}>Return to the field</button>
        </> : <>
          <p>Pick up one rock, then throw it in the pit. A full pit becomes a dated statue and a bigger pit opens beside it. Tap a person to see what they’re waiting for.</p>
          <div className="game-menu-actions">
            <button className="game-menu-row" onClick={() => { closePanel(); if (menuButton.current) onEditProfile(menuButton.current); }}><span>Waiting for {profile.reasonText}</span><span>Edit</span></button>
            <button className="game-menu-row" aria-pressed={sound} onClick={() => { setSound(!sound); engine.current?.setSound(!sound); }}><span>Sound</span><span>{sound ? "On" : "Off"}</span></button>
            <button className="game-menu-row" onClick={() => void share()}><span>Invite a friend</span><span>↗</span></button>
          </div>
          <p className="game-privacy-note">No account needed. Your waiting reason and messages are visible to people nearby. {!online ? "Offline rocks are saved on this device." : ""}</p>
          <button className="dialog-return" onClick={closePanel}>Return to the field</button>
        </>}
      </dialog>
      {error ? <div className="game-dialog-backdrop"><section className="game-dialog game-error" role="alert"><h2>The field couldn’t open.</h2><p>This browser couldn’t draw the 3D world. Reload, or try Safari, Chrome, or Firefox with graphics acceleration enabled.</p><button className="enter-field-button" onClick={() => window.location.reload()}>Try again</button></section></div> : null}
    </main>
  );
}
