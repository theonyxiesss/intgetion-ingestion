import { isValidTimeZone } from "@intgetion/kit";

/**
 * Abbreviations that name one zone unambiguously (13.2). Ambiguous ones
 * (IST, CST, BST, ...) are left out on purpose: they resolve to null.
 */
export const TIME_ZONE_ALIASES: Readonly<Record<string, string>> = {
  CET: "Europe/Paris",
  CEST: "Europe/Paris",
  MSK: "Europe/Moscow",
  JST: "Asia/Tokyo",
  KST: "Asia/Seoul",
  HKT: "Asia/Hong_Kong",
  SGT: "Asia/Singapore",
  NZST: "Pacific/Auckland",
  NZDT: "Pacific/Auckland",
};

/**
 * An explicit IANA zone or an unambiguous alias, else null. Fixed offsets
 * such as "GMT+3" are rejected (D6) and also give null.
 */
export function resolveTimeZone(
  value: string | null | undefined,
): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  const alias = TIME_ZONE_ALIASES[raw.toUpperCase()];
  if (alias) return alias;
  // Intl also accepts legacy keys such as "IST" or "EST"; a bare
  // abbreviation outside the table above is ambiguous, so only Area/City
  // names and plain UTC pass.
  if (!raw.includes("/") && raw.toUpperCase() !== "UTC") return null;
  return isValidTimeZone(raw) ? raw : null;
}
