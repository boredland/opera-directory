import type { RawCredit } from "../types";

/**
 * German credit-function labels → canonical function keys, shared by the
 * German-house adapters (Oper Frankfurt, Staatsoper Berlin, …). They all print
 * the creative team as "Regie: …", "Musikalische Leitung: …"; a label that maps
 * here is a creative function, anything else is a sung role.
 */
export const GERMAN_CREDIT_LABELS: Record<string, string> = {
  "musikalische leitung": "conductor",
  dirigent: "conductor",
  dirigat: "conductor",
  regie: "director",
  inszenierung: "director",
  bühne: "set-designer",
  bühnenbild: "set-designer",
  "bühne und kostüme": "set-designer",
  "bühne & kostüme": "set-designer",
  "bühne & video": "set-designer",
  "bühne und video": "set-designer",
  kostüme: "costume-designer",
  kostüm: "costume-designer",
  licht: "lighting",
  lichtdesign: "lighting",
  choreografie: "choreographer",
  choreographie: "choreographer",
  dramaturgie: "dramaturgy",
  chor: "chorus-master",
  "chor, extrachor": "chorus-master",
  choreinstudierung: "chorus-master",
  chorleitung: "chorus-master",
  kinderchor: "childrens-chorus-master",
  video: "video-designer",
  sound: "sound-designer",
};

/**
 * Pull a composer name out of a free-text credit line like "Oper von Georges Bizet",
 * "Dramma lirico in vier Akten von Verdi", "Familienoper von X nach Y" or
 * "… mit Musik von Richard Wagner und Kindern". Prefers an explicit "Musik von",
 * then a bare "von", and trims the trailing nach/und/mit/für/Libretto/life-dates noise.
 */
export function composerFromText(text: string): string | null {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/Musik von\s+([A-ZÄÖÜ].*)/) ?? t.match(/\bvon\s+([A-ZÄÖÜ].*)/);
  if (!m?.[1]) return null;
  const name = m[1]
    // cut at the next credit/clause — these can be space-separated ("Verdi nach …")
    // or concatenated with no space ("TschaikowskyLibretto …") in stripped markup.
    .split(/\s+(?:nach|und|mit|für|frei nach|u\.\s?a\.)\b/i)[0]
    ?.split(/Libretto|Text von|Choreograf|Inszenierung|Regie\b|Musikalische/)[0]
    // a German article/verb after the name marks the start of prose (the name
    // particles von/van/de/di are NOT in this list, so "Carl Maria von Weber" survives).
    ?.split(/\s+(?:die|der|das|dem|ein|eine|einem|inszeniert|erzählt|wird|in der|auf der)\b/)[0]
    ?.split(/[,(;:/]/)[0]
    ?.replace(/\s+\d.*$/, "") // drop "1893" / "ab 14 Jahren"
    .trim();
  return name && name.length >= 3 && name.length <= 50 ? name : null;
}

/** Map a printed label + name to a creative credit (mapped function) or a sung role. */
export function normalizeGermanCredit(rawLabel: string, name: string): RawCredit {
  const label = rawLabel.trim().replace(/:\s*$/, "");
  const fn = GERMAN_CREDIT_LABELS[label.toLowerCase()];
  return fn ? { function: fn, name } : { role: label, name };
}
