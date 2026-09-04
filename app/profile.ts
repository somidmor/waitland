// Retain this key so returning visitors keep their reason after the redesign.
export const PROFILE_STORAGE_KEY = "waiting-pit-profile-v1";

export const WAIT_REASONS = [
  { id: "order", label: "☕ My coffee", phrase: "my coffee" },
  { id: "ride", label: "A ride", phrase: "a ride" },
  { id: "person", label: "Someone", phrase: "someone" },
  { id: "appointment", label: "An appointment", phrase: "an appointment" },
  { id: "other", label: "A fresh start", phrase: "a fresh start" },
] as const;

export type WaitReasonId = (typeof WAIT_REASONS)[number]["id"];

export type WaitProfile = {
  name: string;
  city: string;
  country: string;
  countryCode: string;
  admin1?: string;
  locationId?: number;
  reasonId: WaitReasonId;
  reasonText: string;
};

export type WaitingPitProps = {
  profile: WaitProfile;
  onEditProfile: (trigger: HTMLButtonElement) => void;
};

function cleanText(value: unknown, length: number) {
  return typeof value === "string" ? Array.from(value.replace(/[\u0000-\u001f\u007f<>]/g, "").trim()).slice(0, length).join("") : "";
}

export function createWaitProfile(reason: string, previous?: WaitProfile | null): WaitProfile {
  const reasonText = cleanText(reason, 50);
  const matchingReason = WAIT_REASONS.find((shortcut) => shortcut.phrase.toLowerCase() === reasonText.toLowerCase());
  return {
    name: cleanText(previous?.name, 24),
    city: cleanText(previous?.city, 60),
    country: cleanText(previous?.country, 60),
    countryCode: /^[A-Z]{2}$/.test(previous?.countryCode ?? "") ? previous!.countryCode : "",
    reasonId: matchingReason?.id ?? "other",
    reasonText,
  };
}

export function countryCodeToFlag(countryCode: string) {
  const normalized = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌍";
  return String.fromCodePoint(...Array.from(normalized).map((letter) => 127397 + letter.charCodeAt(0)));
}

export function parseStoredProfile(rawProfile: string | null): WaitProfile | null {
  if (!rawProfile) return null;
  try {
    const value: unknown = JSON.parse(rawProfile);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const profile = value as Partial<WaitProfile>;
    const reasonText = cleanText(profile.reasonText, 50);
    if (!reasonText) return null;
    const countryCode = cleanText(profile.countryCode, 2).toUpperCase();
    const reasonId = WAIT_REASONS.some((reason) => reason.id === profile.reasonId) ? profile.reasonId as WaitReasonId : "other";
    return {
      name: cleanText(profile.name, 24),
      city: cleanText(profile.city, 60),
      country: cleanText(profile.country, 60),
      countryCode: /^[A-Z]{2}$/.test(countryCode) ? countryCode : "",
      reasonId,
      reasonText,
    };
  } catch {
    return null;
  }
}
