"use client";

import type { ComponentType } from "react";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import ArrivalScreen from "./arrival-screen";
import {
  PROFILE_STORAGE_KEY,
  parseStoredProfile,
  type WaitingPitProps,
  type WaitProfile,
} from "./profile";

const subscribeToClient = () => () => undefined;

export default function GameLoader() {
  const [Game, setGame] = useState<ComponentType<WaitingPitProps> | null>(null);
  const [savedProfile, setSavedProfile] = useState<WaitProfile | null>(null);
  const [activeProfile, setActiveProfile] = useState<WaitProfile | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const isClient = useSyncExternalStore(subscribeToClient, () => true, () => false);
  const storedProfile = useMemo(
    () => {
      if (!isClient) return null;
      try {
        return parseStoredProfile(window.localStorage.getItem(PROFILE_STORAGE_KEY));
      } catch {
        return null;
      }
    },
    [isClient],
  );
  const rememberedProfile = savedProfile ?? storedProfile;
  const editTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!activeProfile || Game) return;

    let active = true;
    import("./waiting-pit")
      .then((module) => {
        if (active) setGame(() => module.default);
      })
      .catch(() => {
        if (active) setLoadError(true);
      });
    return () => {
      active = false;
    };
  }, [activeProfile, Game, loadAttempt]);

  function completeArrival(profile: WaitProfile) {
    try {
      window.localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
    } catch {
      // The session still works when storage is unavailable.
    }
    setSavedProfile(profile);
    setActiveProfile(profile);
    setEditingProfile(false);
    if (editingProfile) {
      window.requestAnimationFrame(() => editTriggerRef.current?.focus());
    }
  }

  function closeEditor() {
    setEditingProfile(false);
    window.requestAnimationFrame(() => editTriggerRef.current?.focus());
  }

  if (!activeProfile) {
    return (
      <ArrivalScreen
        key={rememberedProfile ? "arrival-returning" : "arrival-new"}
        initialProfile={rememberedProfile}
        mode="arrival"
        onComplete={completeArrival}
      />
    );
  }

  if (Game) {
    return (
      <>
        <div
          className="game-stage"
          aria-hidden={editingProfile || undefined}
          inert={editingProfile || undefined}
        >
          <Game
            profile={activeProfile}
            onEditProfile={(trigger) => {
              editTriggerRef.current = trigger;
              trigger.blur();
              setEditingProfile(true);
            }}
          />
        </div>
        {editingProfile ? (
          <ArrivalScreen
            key="edit"
            initialProfile={activeProfile}
            mode="edit"
            onComplete={completeArrival}
            onCancel={closeEditor}
          />
        ) : null}
      </>
    );
  }

  if (loadError) {
    return (
      <main className="loading-shell" aria-label="The field could not open">
        <span className="loading-pit" aria-hidden="true" />
        <h1>The field couldn’t load.</h1>
        <p>Check your connection and try again.</p>
        <button
          type="button"
          className="loading-retry"
          onClick={() => {
            setLoadError(false);
            setLoadAttempt((attempt) => attempt + 1);
          }}
        >
          Try again
        </button>
        <button className="loading-back" type="button" onClick={() => setActiveProfile(null)}>Go back</button>
      </main>
    );
  }

  return (
    <main className="loading-shell" aria-label="Opening Waitland">
      <span className="loading-pit" aria-hidden="true" />
      <p>Opening the field…</p>
    </main>
  );
}
