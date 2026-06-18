import type { IsoDate } from "@opera-directory/schema";

/**
 * Zero-pad year/month/day parts and assemble an ISO date string.
 * Accepts year as a number or string (2- or 4-digit); a 2-digit year is
 * assumed to be in the 2000s (e.g. "26" → 2026).
 * Returns null when any part is missing or non-numeric.
 */
export function isoFromParts(
  year: string | number,
  month: string | number,
  day: string | number,
): IsoDate | null {
  const y = typeof year === "number" ? year : Number.parseInt(year, 10);
  const m = typeof month === "number" ? month : Number.parseInt(month, 10);
  const d = typeof day === "number" ? day : Number.parseInt(day, 10);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  const fullYear = y < 100 ? 2000 + y : y;
  return `${fullYear}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` as IsoDate;
}

/**
 * Parse a German-style "dd.mm.yy" or "dd.mm.yyyy" date string to ISO.
 * Returns null when the string does not match.
 */
export function parseGermanDotDate(text: string): IsoDate | null {
  const m = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{2,4})\b/);
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return isoFromParts(m[3], m[2], m[1]);
}
