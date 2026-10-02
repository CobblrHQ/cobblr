/** The SHAPE of the thing, read out of what the photo pass already wrote.
 *
 *  Every barcode-with-photo item carries `photo_observations`: two or three
 *  factual sentences about what is in frame, produced by a vision call that has
 *  already been paid for. Nothing downstream reads it when searching for a
 *  catalog picture, so the search asks the web for a name and nothing else, and
 *  the web answers with the category's most photographed member.
 *
 *  Reported 2026-08-14: an item whose own observation said it was a BOX came
 *  back illustrated with a bottle. The system had written down the right answer
 *  and then not consulted it.
 *
 *  Deterministic on purpose. The observation is already prose in hand, so
 *  recognising "box" in it is a word match, not a question worth paying a model
 *  to answer (heuristic-first). It also means this runs on the image-search
 *  path, which deliberately sends no picture anywhere. */

/** Retail form factors worth adding to a search, longest first so "spray
 *  bottle" wins over "bottle" and the more specific term reaches the query. */
const FORM_FACTORS = [
  "spray bottle",
  "squeeze bottle",
  "blister pack",
  "stand-up pouch",
  "shaker",
  "canister",
  "cannister",
  "bottle",
  "carton",
  "packet",
  "sachet",
  "pouch",
  "tube",
  "jar",
  "tin",
  "can",
  "tub",
  "bag",
  "box",
  "spool",
  "reel",
  "roll",
  "bucket",
  "pail",
  "case",
] as const;

/** Where an observation stops describing the thing and starts describing
 *  what is in it or around it. */
const BEYOND_THE_THING = /\b(?:contain(?:s|ing|ed)?|inside|filled with|full of|holding|holds|with .{0,40}\bin (?:it|them)|behind|in the background|next to|beside)\b/;

/** The part of an observation that describes the thing itself: its first
 *  sentence, up to where it turns to the contents or the surroundings. The
 *  photo pass describes everything in frame, and the shape of something else
 *  is the wrong word to search with: stacked storage bins holding "a roll of
 *  tape" were searched as "Storage Bin roll" and came back as paper-towel
 *  racks. */
export function subjectOf(observation: string | null | undefined): string {
  const t = (observation ?? "").toLowerCase().trim();
  if (!t) return "";
  const first = t.split(/[.!?](?:\s|$)/)[0] ?? "";
  const cut = BEYOND_THE_THING.exec(first);
  return (cut ? first.slice(0, cut.index) : first).trim();
}

/** The form factor named in an observation, or null.
 *
 *  Returns ONE term: the search is a name plus a couple of sharpening words,
 *  and a pile of near-synonyms makes it worse rather than better. */
export function formFactorFromObservation(observation: string | null | undefined): string | null {
  const t = subjectOf(observation);
  if (!t) return null;
  for (const f of FORM_FACTORS) {
    // Word-boundary: "can" must not match "candle", and "tin" must not match
    // "tinted". This is the whole reason it is a regex rather than includes().
    if (new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}s?\\b`).test(t)) {
      return f === "cannister" ? "canister" : f;
    }
  }
  return null;
}
