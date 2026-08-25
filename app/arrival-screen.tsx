"use client";

import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent } from "react";
import {
  WAIT_REASONS,
  countryCodeToFlag,
  type WaitProfile,
  type WaitReasonId,
} from "./profile";

type CityOption = {
  id: number;
  name: string;
  country: string;
  countryCode: string;
  admin1?: string;
};

type ArrivalScreenProps = {
  initialProfile: WaitProfile | null;
  mode: "arrival" | "edit";
  onComplete: (profile: WaitProfile) => void;
  onCancel?: () => void;
};

type OpenMeteoResult = {
  id?: number;
  name?: string;
  country?: string;
  country_code?: string;
  admin1?: string;
};

const FALLBACK_CITIES: CityOption[] = [
  { id: -1, name: "Vancouver", admin1: "British Columbia", country: "Canada", countryCode: "CA" },
  { id: -2, name: "Toronto", admin1: "Ontario", country: "Canada", countryCode: "CA" },
  { id: -3, name: "Montreal", admin1: "Quebec", country: "Canada", countryCode: "CA" },
  { id: -4, name: "New York", admin1: "New York", country: "United States", countryCode: "US" },
  { id: -5, name: "Los Angeles", admin1: "California", country: "United States", countryCode: "US" },
  { id: -6, name: "London", country: "United Kingdom", countryCode: "GB" },
  { id: -7, name: "Paris", country: "France", countryCode: "FR" },
  { id: -8, name: "Berlin", country: "Germany", countryCode: "DE" },
  { id: -9, name: "Dubai", country: "United Arab Emirates", countryCode: "AE" },
  { id: -10, name: "Tehran", country: "Iran", countryCode: "IR" },
  { id: -11, name: "Istanbul", country: "Türkiye", countryCode: "TR" },
  { id: -12, name: "Tokyo", country: "Japan", countryCode: "JP" },
  { id: -13, name: "Seoul", country: "South Korea", countryCode: "KR" },
  { id: -14, name: "Sydney", admin1: "New South Wales", country: "Australia", countryCode: "AU" },
  { id: -15, name: "Singapore", country: "Singapore", countryCode: "SG" },
];

function toCityOption(result: OpenMeteoResult): CityOption | null {
  if (
    typeof result.id !== "number" ||
    typeof result.name !== "string" ||
    typeof result.country !== "string" ||
    typeof result.country_code !== "string"
  ) {
    return null;
  }

  return {
    id: result.id,
    name: result.name,
    country: result.country,
    countryCode: result.country_code.toUpperCase(),
    admin1: typeof result.admin1 === "string" ? result.admin1 : undefined,
  };
}

function cityFromProfile(profile: WaitProfile | null): CityOption | null {
  if (!profile) return null;
  return {
    id: profile.locationId ?? 0,
    name: profile.city,
    country: profile.country,
    countryCode: profile.countryCode,
    admin1: profile.admin1,
  };
}

function getFallbackCities(query: string) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (normalizedQuery.length < 3) return [];

  return FALLBACK_CITIES.filter((city) =>
    `${city.name}, ${city.country}`.toLocaleLowerCase().startsWith(normalizedQuery),
  ).slice(0, 6);
}

export default function ArrivalScreen({
  initialProfile,
  mode,
  onComplete,
  onCancel,
}: ArrivalScreenProps) {
  const initialCity = useMemo(() => cityFromProfile(initialProfile), [initialProfile]);
  const [name, setName] = useState(initialProfile?.name ?? "");
  const [cityQuery, setCityQuery] = useState(initialProfile?.city ?? "");
  const [selectedCity, setSelectedCity] = useState<CityOption | null>(initialCity);
  const [suggestions, setSuggestions] = useState<CityOption[]>([]);
  const [searchState, setSearchState] = useState<"idle" | "loading" | "empty" | "error">("idle");
  const [activeSuggestion, setActiveSuggestion] = useState(-1);
  const [searchDismissed, setSearchDismissed] = useState(false);
  const [reasonId, setReasonId] = useState<WaitReasonId | "">(
    mode === "edit" ? initialProfile?.reasonId ?? "" : "",
  );
  const [customReason, setCustomReason] = useState(
    mode === "edit" && initialProfile?.reasonId === "other" ? initialProfile.reasonText : "",
  );

  useEffect(() => {
    const query = cityQuery.trim();
    if ((selectedCity && query === selectedCity.name) || query.length < 3) return;

    const localMatches = getFallbackCities(query);

    const controller = new AbortController();
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const parameters = new URLSearchParams({
          name: query,
          count: "6",
          language: "en",
          format: "json",
        });
        const response = await fetch(
          `https://geocoding-api.open-meteo.com/v1/search?${parameters.toString()}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("City search failed");

        const payload = (await response.json()) as { results?: OpenMeteoResult[] };
        const remoteMatches = (payload.results ?? [])
          .map(toCityOption)
          .filter((city): city is CityOption => city !== null);
        const merged = [...remoteMatches, ...localMatches].filter(
          (city, index, cities) =>
            cities.findIndex(
              (candidate) => {
                if (candidate.id > 0 && city.id > 0) return candidate.id === city.id;
                return (
                  candidate.name === city.name &&
                  candidate.countryCode === city.countryCode &&
                  candidate.admin1 === city.admin1
                );
              },
            ) === index,
        );
        if (!active) return;
        setActiveSuggestion(-1);
        setSuggestions(merged.slice(0, 6));
        setSearchState(merged.length > 0 ? "idle" : "empty");
      } catch (error) {
        if (!active || (error instanceof DOMException && error.name === "AbortError")) return;
        setSearchState(localMatches.length > 0 ? "idle" : "error");
      }
    }, 280);

    return () => {
      active = false;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [cityQuery, selectedCity]);

  const selectedReason = WAIT_REASONS.find((reason) => reason.id === reasonId);
  const reasonText = reasonId === "other" ? customReason.trim() : selectedReason?.phrase ?? "";
  const canSubmit =
    name.trim().length > 0 && selectedCity !== null && reasonId !== "" && reasonText.length > 0;
  const showSuggestions =
    cityQuery.trim().length >= 3 &&
    !selectedCity &&
    !searchDismissed &&
    (suggestions.length > 0 || searchState !== "idle");

  function chooseCity(city: CityOption) {
    setSelectedCity(city);
    setCityQuery(city.name);
    setSuggestions([]);
    setSearchState("idle");
    setActiveSuggestion(-1);
    setSearchDismissed(true);
  }

  function handleCityKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (!showSuggestions) return;

    if (event.key === "Escape") {
      event.preventDefault();
      setActiveSuggestion(-1);
      setSearchDismissed(true);
      return;
    }

    if (suggestions.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveSuggestion((current) => (current + 1) % suggestions.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveSuggestion((current) =>
        current <= 0 ? suggestions.length - 1 : current - 1,
      );
    } else if (event.key === "Enter" && activeSuggestion >= 0) {
      event.preventDefault();
      chooseCity(suggestions[activeSuggestion]);
    }
  }

  function submitArrival(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit || !selectedCity || !reasonId) return;

    onComplete({
      name: name.trim().replace(/\s+/g, " ").slice(0, 24),
      city: selectedCity.name,
      country: selectedCity.country,
      countryCode: selectedCity.countryCode,
      admin1: selectedCity.admin1,
      locationId: selectedCity.id > 0 ? selectedCity.id : undefined,
      reasonId,
      reasonText: reasonText.replace(/\s+/g, " ").slice(0, 50),
    });
  }

  return (
    <main className="arrival-shell">
      <div className="arrival-brand" aria-label="Waitland">
        <span className="brand-mark" aria-hidden="true" />
        <span>Waitland</span>
      </div>

      <section
        className="arrival-card"
        role={mode === "edit" ? "dialog" : undefined}
        aria-modal={mode === "edit" ? true : undefined}
        aria-labelledby="arrival-title"
      >
        {mode === "edit" && onCancel ? (
          <button
            type="button"
            className="arrival-close"
            autoFocus
            onClick={onCancel}
            aria-label="Cancel editing"
          >
            ×
          </button>
        ) : null}

        <p className="arrival-eyebrow">{mode === "edit" ? "Your arrival card" : "Before you enter"}</p>
        <h1 id="arrival-title">{mode === "edit" ? "Change your details" : "Who’s waiting?"}</h1>
        <p className="arrival-intro">
          {mode === "edit"
            ? "Keep it simple—this is what people nearby will see."
            : "Three quick things. Then the field is yours."}
        </p>

        <form className="arrival-form" onSubmit={submitArrival}>
          <div className="arrival-field">
            <label htmlFor="arrival-name"><span>1</span>Your name</label>
            <input
              id="arrival-name"
              type="text"
              value={name}
              maxLength={24}
              autoComplete="given-name"
              enterKeyHint="next"
              placeholder="Alex"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="arrival-field city-field">
            <label htmlFor="arrival-city"><span>2</span>Your city</label>
            <div className={`city-input ${selectedCity ? "has-city" : ""}`}>
              <span className="city-leading" aria-hidden="true">
                {selectedCity ? countryCodeToFlag(selectedCity.countryCode) : "⌖"}
              </span>
              <input
                id="arrival-city"
                type="text"
                role="combobox"
                value={cityQuery}
                maxLength={60}
                autoComplete="off"
                enterKeyHint="next"
                aria-autocomplete="list"
                aria-expanded={showSuggestions}
                aria-controls={showSuggestions ? "city-suggestions" : undefined}
                aria-activedescendant={
                  showSuggestions && activeSuggestion >= 0
                    ? `city-option-${activeSuggestion}`
                    : undefined
                }
                placeholder="Start typing a city"
                onKeyDown={handleCityKeyDown}
                onFocus={() => setSearchDismissed(false)}
                onBlur={() => setSearchDismissed(true)}
                onChange={(event) => {
                  const nextQuery = event.target.value;
                  setCityQuery(nextQuery);
                  setSelectedCity(null);
                  setActiveSuggestion(-1);
                  setSearchDismissed(false);
                  if (nextQuery.trim().length >= 3) {
                    setSuggestions(getFallbackCities(nextQuery));
                    setSearchState("loading");
                  } else {
                    setSuggestions([]);
                    setSearchState("idle");
                  }
                }}
              />
              {searchState === "loading" ? <span className="city-spinner" aria-hidden="true" /> : null}
              {searchState === "loading" ? <span className="sr-only" role="status">Searching cities…</span> : null}
            </div>

            {showSuggestions ? (
              <div className="city-results">
                <div id="city-suggestions" role="listbox">
                  {suggestions.map((city, index) => (
                    <button
                      id={`city-option-${index}`}
                      key={`${city.id}-${city.countryCode}-${city.admin1 ?? ""}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={activeSuggestion === index}
                      className={activeSuggestion === index ? "is-active" : ""}
                      onPointerEnter={() => setActiveSuggestion(index)}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => chooseCity(city)}
                    >
                      <span className="city-result-flag" aria-hidden="true">
                        {countryCodeToFlag(city.countryCode)}
                      </span>
                      <span>
                        <strong>{city.name}</strong>
                        <small>{[city.admin1, city.country].filter(Boolean).join(", ")}</small>
                      </span>
                    </button>
                  ))}
                </div>
                {searchState === "empty" ? <p role="status">No matching city. Try “city, country”.</p> : null}
                {searchState === "error" ? <p role="status">City search is unavailable. Try again.</p> : null}
              </div>
            ) : null}

            {selectedCity ? (
              <p className="city-confirmation">
                {countryCodeToFlag(selectedCity.countryCode)} {selectedCity.country}
              </p>
            ) : (
              <p className="field-help">Choose a result so we can show the right flag.</p>
            )}
          </div>

          <fieldset className="arrival-reasons">
            <legend><span>3</span>What are you waiting for?</legend>
            <div className="reason-grid">
              {WAIT_REASONS.map((reason) => (
                <button
                  key={reason.id}
                  type="button"
                  className={reasonId === reason.id ? "is-selected" : ""}
                  aria-pressed={reasonId === reason.id}
                  onClick={() => setReasonId(reason.id)}
                >
                  <span>{reason.label}</span>
                  <span aria-hidden="true">{reasonId === reason.id ? "✓" : ""}</span>
                </button>
              ))}
            </div>
          </fieldset>

          {reasonId === "other" ? (
            <div className="arrival-field custom-reason">
              <label htmlFor="custom-reason">In a few words</label>
              <input
                id="custom-reason"
                type="text"
                value={customReason}
                maxLength={50}
                autoFocus
                enterKeyHint="go"
                placeholder="My coffee, boarding, laundry…"
                onChange={(event) => setCustomReason(event.target.value)}
              />
            </div>
          ) : null}

          <button type="submit" className="enter-field-button" disabled={!canSubmit}>
            <span>{mode === "edit" ? "Save and return" : "Enter the field"}</span>
            <span aria-hidden="true">→</span>
          </button>
        </form>

        <p className="arrival-note">
          No account needed. Your name and city are remembered on this device. City search by{" "}
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">Open-Meteo</a>.
        </p>
      </section>
    </main>
  );
}
