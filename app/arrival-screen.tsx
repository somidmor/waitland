"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import { WAIT_REASONS, createWaitProfile, type WaitProfile } from "./profile";

type ArrivalScreenProps = {
  initialProfile: WaitProfile | null;
  mode: "arrival" | "edit";
  onComplete: (profile: WaitProfile) => void;
  onCancel?: () => void;
};
const subscribeToHydration = () => () => undefined;

function StoneGarden() {
  return (
    <div className="arrival-preview" aria-hidden="true">
      <div className="preview-orbit" />
      <div className="preview-sun" />
      <div className="preview-ground" />
      <div className="preview-pit" />
      <div className="preview-cairn">
        <i className="preview-rock preview-rock--base" />
        <i className="preview-rock preview-rock--middle" />
        <i className="preview-rock preview-rock--top" />
      </div>
      <i className="preview-pebble preview-pebble--one" />
      <i className="preview-pebble preview-pebble--two" />
      <i className="preview-pebble preview-pebble--three" />
      <div className="preview-person"><i /><b /><span /></div>
      <span className="preview-grass preview-grass--one" />
      <span className="preview-grass preview-grass--two" />
      <span className="preview-caption">Small moments. Solid things.</span>
      <span className="preview-annotation"><span /> MADE TOGETHER</span>
    </div>
  );
}

export default function ArrivalScreen({ initialProfile, mode, onComplete, onCancel }: ArrivalScreenProps) {
  const hydrated = useSyncExternalStore(subscribeToHydration, () => true, () => false);
  const [reason, setReason] = useState(initialProfile?.reasonText ?? "");
  const [error, setError] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const editing = mode === "edit";

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel?.();
      if (event.key !== "Tab" || !dialogRef.current) return;
      const controls = dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input");
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [editing, onCancel]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const profile = createWaitProfile(reason, initialProfile);
    if (!profile.reasonText) {
      setError(true);
      inputRef.current?.focus();
      return;
    }
    onComplete(profile);
  }

  const form = (
    <form className="arrival-form" onSubmit={submit} aria-busy={!hydrated}>
      <label htmlFor="wait-reason">What are you waiting for?</label>
      <div className={`arrival-input-wrap${error ? " has-error" : ""}`}>
        <input
          ref={inputRef}
          id="wait-reason"
          name="reason"
          type="text"
          readOnly={!hydrated}
          placeholder="My coffee, a friend, a fresh start…"
          value={reason}
          onChange={(event) => { setReason(event.target.value); setError(false); }}
          maxLength={50}
          autoComplete="off"
          enterKeyHint="go"
          aria-invalid={error || undefined}
          aria-describedby={error ? "arrival-error" : "arrival-privacy"}
        />
        <span className="arrival-input-dot" aria-hidden="true" />
      </div>
      <div className="arrival-reasons" aria-label="A few ideas">
        {WAIT_REASONS.map((shortcut) => (
          <button
            key={shortcut.id}
            type="button"
            disabled={!hydrated}
            className={reason.toLowerCase() === shortcut.phrase.toLowerCase() ? "is-selected" : undefined}
            aria-pressed={reason.toLowerCase() === shortcut.phrase.toLowerCase()}
            onClick={() => { setReason(shortcut.phrase); setError(false); }}
          >
            {shortcut.label}
          </button>
        ))}
      </div>
      {error ? <p id="arrival-error" className="arrival-error" role="alert">A word or two is enough. Or pick an idea above.</p> : null}
      <button className="arrival-submit" type="submit" disabled={!hydrated}>
        <span>{editing ? "Back to the field" : "Let’s make something"}</span>
        <span className="arrow-icon" aria-hidden="true">↗</span>
      </button>
      <p className="arrival-privacy" id="arrival-privacy">{editing ? "Your reason is visible to people nearby." : "No accounts. Just a little of your time."}</p>
    </form>
  );

  if (editing) {
    return (
      <div className="arrival-editor" onClick={(event) => { if (event.target === event.currentTarget) onCancel?.(); }}>
        <div ref={dialogRef} className="arrival-edit-card" role="dialog" aria-modal="true" aria-labelledby="arrival-edit-title">
          <button className="arrival-close" type="button" onClick={onCancel} aria-label="Close">×</button>
          <p className="arrival-eyebrow">STILL A LITTLE TIME?</p>
          <h1 id="arrival-edit-title">Life can wait.<br />For a moment.</h1>
          {form}
        </div>
      </div>
    );
  }

  return (
    <main className="arrival-shell">
      <header className="arrival-header">
        <Link className="arrival-brand" href="/" aria-label="Waitland home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>waitland<span className="brand-period">.</span></Link>
        <span className="arrival-header-note"><i /> A GOOD PLACE TO WAIT</span>
      </header>
      <div className="arrival-content">
        <section className="arrival-intro" aria-labelledby="arrival-title">
          <p className="arrival-eyebrow">TURN A LITTLE TIME INTO SOMETHING.</p>
          <h1 id="arrival-title">A little wait.<br /><em>Something<br className="desktop-break" /> lasting.</em></h1>
          <p className="arrival-description">Pick up a rock. Toss it in the pit.<br />Together, we’ll turn the waiting into a monument.</p>
        </section>
        <StoneGarden />
        {form}
      </div>
      <footer className="arrival-footer"><span>ONE ROCK AT A TIME.</span><span>Come for a minute. Leave a little mark.</span></footer>
    </main>
  );
}
