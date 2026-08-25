export const PROFILE_STORAGE_KEY = "waiting-pit-profile-v1";

export const WAIT_REASONS = [
  { id: "appointment", label: "Appointment", phrase: "an appointment" },
  { id: "ride", label: "A ride", phrase: "a ride" },
  { id: "order", label: "Food or order", phrase: "food or an order" },
  { id: "person", label: "Someone", phrase: "someone" },
  { id: "other", label: "Something else", phrase: "something else" },
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

export function countryCodeToFlag(countryCode: string) {
  const normalized = countryCode.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(normalized)) return "🌍";

  return String.fromCodePoint(
    ...Array.from(normalized).map((letter) => 127397 + letter.charCodeAt(0)),
  );
}

export function parseStoredProfile(rawProfile: string | null): WaitProfile | null {
  if (!rawProfile) return null;

  try {
    const value = JSON.parse(rawProfile) as Partial<WaitProfile>;
    const validReason = WAIT_REASONS.some((reason) => reason.id === value.reasonId);
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const city = typeof value.city === "string" ? value.city.trim() : "";
    const country = typeof value.country === "string" ? value.country.trim() : "";
    const countryCode =
      typeof value.countryCode === "string" ? value.countryCode.trim().toUpperCase() : "";
    const reasonText = typeof value.reasonText === "string" ? value.reasonText.trim() : "";
    if (
      !name ||
      !city ||
      !country ||
      !/^[A-Z]{2}$/.test(countryCode) ||
      !reasonText ||
      !validReason
    ) {
      return null;
    }

    return {
      name: name.slice(0, 24),
      city: city.slice(0, 60),
      country: country.slice(0, 60),
      countryCode,
      admin1: typeof value.admin1 === "string" ? value.admin1.slice(0, 60) : undefined,
      locationId: typeof value.locationId === "number" ? value.locationId : undefined,
      reasonId: value.reasonId as WaitReasonId,
      reasonText: reasonText.slice(0, 50),
    };
  } catch {
    return null;
  }
}
