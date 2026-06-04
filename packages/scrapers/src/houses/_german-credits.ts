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

/** Map a printed label + name to a creative credit (mapped function) or a sung role. */
export function normalizeGermanCredit(rawLabel: string, name: string): RawCredit {
  const label = rawLabel.trim().replace(/:\s*$/, "");
  const fn = GERMAN_CREDIT_LABELS[label.toLowerCase()];
  return fn ? { function: fn, name } : { role: label, name };
}
