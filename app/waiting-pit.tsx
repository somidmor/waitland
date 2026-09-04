"use client";

import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from "react";
import { createInitialPitState, type PitState } from "../shared/world";
import { createGameEngine, type GameAction, type GameEngine } from "./game-engine";
import type { WaitingPitProps } from "./profile";
import type { RealtimeStatus } from "./realtime-client";
import type { RemoteAvatarAnchor } from "./remote-avatar-renderer";

function dateLabel(timestamp: number) {
  return new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(timestamp);
}

export default function WaitingPit({ profile, onEditProfile }: WaitingPitProps) {
  const mount = useRef<HTMLDivElement>(null);
  const engine = useRef<GameEngine | null>(null);
  const initialProfile = useRef(profile);
  const dialog = useRef<HTMLDialogElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const joystick = useRef<HTMLDivElement>(null);
  const joystickThumb = useRef<HTMLSpanElement>(null);
  const joystickPointer = useRef<number | null>(null);
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [left, setLeft] = useState(false);
  const [error, setError] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!mount.current) return;
    function announce(text: string) {
      setToast(text);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      toastTimer.current = setTimeout(() => setToast(""), 3800);
    }
    engine.current = createGameEngine(mount.current, initialProfile.current, {
      onPit: setPit,
      onStatus: setStatus,
      onAction(mode, hasRock) { setAction(mode); setCarrying(hasRock); },
      onPeople: setPeople,
      onToast: announce,
      onDeposit() { setContribution((count) => count + 1); },
      onSpeech: setSpeeches,
      onLeave() { setLeft(true); },
      onError() { setError(true); },
    });
    return () => { engine.current?.dispose(); engine.current = null; if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);
  useEffect(() => { engine.current?.setProfile(profile); }, [profile]);
  useEffect(() => {
    if (!ownSpeech) return;
    const timeout = setTimeout(() => setOwnSpeech(""), 7000);
    return () => clearTimeout(timeout);
  }, [ownSpeech]);
  useEffect(() => {
    if (menuOpen) dialog.current?.showModal();
    else if (dialog.current?.open) dialog.current.close();
  }, [menuOpen]);
  useEffect(() => {
    if (left) { engine.current?.dispose(); engine.current = null; }
  }, [left]);

  const online = status.state === "online";
  const blocked = status.state === "replaced" || status.state === "incompatible";
  const actionText = action === "busy" ? (carrying ? "A little throw…" : "One moment…") : action === "walk" ? (carrying ? "Off to the pit…" : "On my way…") : carrying ? "Throw rock" : "Pick up a rock";
  const connectionText = online ? `${people} ${people === 1 ? "person" : "people"} here` : status.state === "connecting" ? "Joining the world…" : blocked ? "Refresh to rejoin" : "Your quiet corner · offline";

  function moveJoystick(event: PointerEvent<HTMLDivElement>) {
    if (joystickPointer.current !== event.pointerId || !joystick.current) return;
    const rect = joystick.current.getBoundingClientRect();
    const dx = event.clientX - rect.left - rect.width / 2;
    const dy = event.clientY - rect.top - rect.height / 2;
    const length = Math.max(30, Math.hypot(dx, dy));
    engine.current?.setJoystick(dx / length, dy / length);
    if (joystickThumb.current) joystickThumb.current.style.transform = `translate(${dx / length * 25}px, ${dy / length * 25}px)`;
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
    const data = { title: "Waitland", text: "Waiting for something? Come make a little something with me.", url: "https://waitland.app" };
    try {
      if (navigator.share) await navigator.share(data);
      else { await navigator.clipboard.writeText(data.url); setToast("Link copied. A little company goes a long way."); }
    } catch { /* Dismissing the native share sheet is intentional. */ }
  }
  function closeMenu() { setMenuOpen(false); requestAnimationFrame(() => menuButton.current?.focus()); }

  if (left) return (
    <main className="game-leave-screen">
      <span className="leave-wings" aria-hidden="true">✦</span>
      <p className="arrival-eyebrow">A little time, well spent</p>
      <h1>Go on.<br />Life is waiting.</h1>
      <p>{contribution ? `You added ${contribution} ${contribution === 1 ? "rock" : "rocks"}. A little piece of your wait stays here.` : "Thanks for spending a little of your wait with us."}</p>
      <button className="enter-field-button" onClick={() => window.location.reload()}>Still waiting? Come back <span aria-hidden="true">↗</span></button>
      <button className="game-text-button" onClick={() => void share()}>Invite someone who’s waiting</button>
    </main>
  );

  return (
    <main className="game-shell" aria-label="Waitland">
      <div className="game-canvas" ref={mount} />
      <header className="game-topbar">
        <div>
          <span className="game-brand"><span className="brand-mark" aria-hidden="true" />waitland<span className="brand-period">.</span></span>
          <span className="game-status"><i className={online ? "is-online" : ""} />{connectionText}</span>
        </div>
        <button ref={menuButton} type="button" className="game-menu-button" aria-label="Open field menu" onClick={() => setMenuOpen(true)}>•••</button>
      </header>
      <button className="game-pit-card" onClick={() => engine.current?.goToPit()} aria-label={`Pit ${pit.round}, ${pit.count} of ${pit.capacity} rocks. Walk to the pit.`}>
        <span className="game-pit-label">OUR NEXT STATUE <span>№ {String(pit.round).padStart(2, "0")}</span></span>
        <span className="game-pit-count"><strong>{pit.count.toLocaleString()}</strong><span> / {pit.capacity.toLocaleString()} rocks</span></span>
        <span className="game-progress" role="progressbar" aria-label="Shared pit progress" aria-valuemin={0} aria-valuemax={pit.capacity} aria-valuenow={pit.count}><span style={{ width: `${Math.min(100, pit.count / pit.capacity * 100)}%` }} /></span>
        <span className="game-pit-footnote">A full pit becomes something lasting.</span>
      </button>
      <div className="game-speech-layer" aria-live="off">
        {speeches.filter((anchor) => !anchor.departing && anchor.distance < 24).slice(0, 5).map((anchor) => (
          <div key={anchor.id} className={`game-speech-bubble ${anchor.speech ? "is-speaking" : ""}`} style={{ left: anchor.screenX, top: anchor.screenY }}>
            {anchor.speech || (anchor.profile?.waitingFor ? `Waiting for ${anchor.profile.waitingFor}` : "Waiting, too.")}
          </div>
        ))}
      </div>
      <div className="game-toast" role="status" aria-live="polite">{toast}</div>
      {ownSpeech ? <div className="game-own-speech">{ownSpeech}</div> : null}
      <div className="game-bottom">
        <div className="game-hint"><span>{carrying ? "A little rock. A shared monument." : "Tap a rock. Make your wait count."}</span><small>{contribution > 0 ? `${contribution} ${contribution === 1 ? "rock" : "rocks"} from your little wait` : `Waiting for ${profile.reasonText}`}</small></div>
        <div className="game-controls-row">
          <div className="game-joystick" ref={joystick} aria-label="Drag to walk" onPointerDown={(event) => { joystickPointer.current = event.pointerId; event.currentTarget.setPointerCapture(event.pointerId); moveJoystick(event); }} onPointerMove={moveJoystick} onPointerUp={releaseJoystick} onPointerCancel={releaseJoystick} onLostPointerCapture={releaseJoystick}>
            <span className="game-joystick-thumb" ref={joystickThumb} /><span className="game-joystick-label">walk</span>
          </div>
          <button type="button" className={`game-action ${carrying ? "is-carrying" : ""}`} disabled={action === "busy" || blocked || error} onClick={() => engine.current?.action()}>
            <span className="action-rock" aria-hidden="true" /><span>{actionText}</span><span aria-hidden="true">{carrying ? "↗" : "+"}</span>
          </button>
        </div>
        <div className="game-secondary-actions">
          <button type="button" className="game-text-button" onClick={() => setChatOpen((value) => !value)} aria-expanded={chatOpen}>Say something</button>
          <span className="game-keyboard-hint">WASD to wander · Space to pick & throw</span>
          <button type="button" className="game-text-button" onClick={() => engine.current?.leave()}>My wait is over ↗</button>
        </div>
        {chatOpen ? <form className="game-chat-form" onSubmit={sendChat}><input aria-label="Say something nearby" placeholder="A few words for people nearby…" value={chat} maxLength={80} autoFocus onChange={(event) => setChat(event.target.value)} onKeyDown={(event) => { if (event.key === "Escape") setChatOpen(false); }} /><button type="submit" disabled={!chat.trim()} aria-label="Send nearby message">↑</button><button type="button" onClick={() => setChatOpen(false)} aria-label="Close message">×</button></form> : null}
      </div>
      <dialog ref={dialog} className="game-dialog" onCancel={() => setMenuOpen(false)} onClose={() => setMenuOpen(false)}>
        <div className="game-dialog-heading"><p className="arrival-eyebrow">A place between things</p><button className="game-icon-button" aria-label="Close menu" onClick={closeMenu}>×</button></div>
        <h2>Nothing to win.<br />Something to make.</h2>
        <p>Pick up a rock. Throw it in. When we fill a pit together, it becomes a dated stone statue—and a bigger pit opens beside it.</p>
        <div className="game-menu-actions">
          <button className="game-menu-row" onClick={() => { closeMenu(); if (menuButton.current) onEditProfile(menuButton.current); }}><span>Waiting for {profile.reasonText}</span><span>edit ↗</span></button>
          <button className="game-menu-row" aria-pressed={sound} onClick={() => { setSound(!sound); engine.current?.setSound(!sound); }}><span>Little stone sounds</span><span>{sound ? "On" : "Off"}</span></button>
          <button className="game-menu-row" onClick={() => void share()}><span>Invite someone who’s waiting</span><span>↗</span></button>
        </div>
        <section className="game-monuments" aria-label="Our statues">
          <h3>What our waiting made <span>{pit.round - 1}</span></h3>
          {pit.monuments.length ? pit.monuments.slice().reverse().map((monument) => <article key={monument.round}><span className="monument-mini" aria-hidden="true" /><div><strong>{monument.name}</strong><p>{monument.stoneCount.toLocaleString()} rocks · {dateLabel(monument.completedAt)} UTC</p><small>Made by people waiting, together.</small></div></article>) : <p>The first statue is still inside this pit.<br />Every little rock gets us closer.</p>}
        </section>
        <p className="game-privacy-note">No accounts. Your reason is visible to people nearby. {online ? "Every online throw joins the shared world." : "Offline rocks stay in your quiet corner on this device."}</p>
      </dialog>
      {error ? <div className="game-dialog-backdrop"><section className="game-dialog game-error" role="alert"><h2>The meadow needs a moment.</h2><p>Your browser couldn’t draw the 3D world. Try reloading, or open Waitland in Safari, Chrome, or Firefox with graphics acceleration enabled.</p><button className="enter-field-button" onClick={() => window.location.reload()}>Try again ↗</button></section></div> : null}
    </main>
  );
}
