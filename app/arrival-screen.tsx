"use client";

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import Link from "next/link";
import Image from "next/image";
import { WAIT_REASONS, createWaitProfile, type WaitProfile } from "./profile";

type ArrivalScreenProps = {
  initialProfile: WaitProfile | null;
  mode: "arrival" | "edit";
  onComplete: (profile: WaitProfile) => void;
  onCancel?: () => void;
};
const subscribeToHydration = () => () => undefined;

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
      <label className="sr-only" htmlFor="wait-reason">What are you waiting for?</label>
      <input
        ref={inputRef}
        id="wait-reason"
        name="reason"
        type="text"
        readOnly={!hydrated}
        placeholder="My coffee, a friend, the train…"
        value={reason}
        onChange={(event) => { setReason(event.target.value); setError(false); }}
        maxLength={50}
        autoComplete="off"
        enterKeyHint="go"
        aria-invalid={error || undefined}
        aria-describedby={error ? "arrival-error" : "arrival-privacy"}
      />
      <div className="arrival-reasons" aria-label="Choose a waiting reason">
        {WAIT_REASONS.slice(0, 4).map((shortcut) => (
          <button
            key={shortcut.id}
            type="button"
            disabled={!hydrated}
            className={reason.toLowerCase() === shortcut.phrase.toLowerCase() ? "is-selected" : undefined}
            aria-pressed={reason.toLowerCase() === shortcut.phrase.toLowerCase()}
            onClick={() => { setReason(shortcut.phrase); setError(false); }}
          >
            {shortcut.label.replace("☕ ", "")}
          </button>
        ))}
      </div>
      {error ? <p id="arrival-error" className="arrival-error" role="alert">Enter a reason, or choose one above.</p> : null}
      <button className="arrival-submit" type="submit" disabled={!hydrated}>
        <span>{editing ? "Save and return" : "Enter the field"}</span>
        <span aria-hidden="true">→</span>
      </button>
      <p className="arrival-privacy" id="arrival-privacy">{editing ? "Your reason is visible to people nearby." : "No account needed. Your reason appears nearby."}</p>
    </form>
  );

  if (editing) {
    return (
      <div className="arrival-editor" onClick={(event) => { if (event.target === event.currentTarget) onCancel?.(); }}>
        <div ref={dialogRef} className="arrival-edit-card" role="dialog" aria-modal="true" aria-labelledby="arrival-edit-title">
          <button className="arrival-close" type="button" onClick={onCancel} aria-label="Close">×</button>
          <h1 id="arrival-edit-title">What are you waiting for?</h1>
          {form}
        </div>
      </div>
    );
  }

  return (
    <main className="arrival-shell">
      <header className="arrival-header">
        <Link className="arrival-brand" href="/" aria-label="Waitland home"><span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>waitland</Link>
        <span className="arrival-header-note">A shared field.</span>
      </header>
      <div className="arrival-content">
        <section className="arrival-intro" aria-labelledby="arrival-title">
          <h1 id="arrival-title">What are you<br />waiting for?</h1>
          <p className="arrival-description">Pick up rocks. Fill a shared pit.<br />Build a statue together.</p>
          {form}
        </section>
        <figure className="arrival-scene"><Image src="/field-preview.webp" width={1200} height={750} unoptimized alt="A stone statue beside a shared pit in Waitland" /></figure>
      </div>
      <footer className="arrival-footer">Every full pit becomes a dated statue. Then a bigger pit opens.</footer>
    </main>
  );
}
