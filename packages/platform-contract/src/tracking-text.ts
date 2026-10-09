// A tracking number from whatever a person pasted (#5351).
//
// People copy what the store's email gives them: the number, a number with
// spaces in it ("1Z 999 AA1 01 2345 6784"), or the "Track your package" link
// itself (track.amazon.com/tracking/TBA…, fedex.com/fedextrack/?trknbr=…,
// ups.com/track?tracknum=…, tools.usps.com/…?tLabels=…). Every door that takes
// a tracking number reads it through this, so a pasted link is the number
// it points at everywhere: the order's Add tracking, the scan inbox's
// tracking control, and the assistant's add-a-parcel.
//
// Pure. Which carrier a number is stays core-shipments' question.

/** The query parameters carriers and tracking sites put the number in. */
const PARAM = /^(?:trk|trknbr|track|tracking|tracknum|tracknums|trackingnumber|tracking[-_]?number|tracking[-_]?id|tlabels|inquirynumber\d*|number|nums|awb|label|id|q)$/i;

/** A token that could be a tracking number: letters and digits, long enough,
 *  and with a digit in it (a word in a path is never one). */
function plausible(token: string): boolean {
  return /^[A-Za-z0-9]{8,40}$/.test(token) && /\d/.test(token);
}

/** The tracking number in what was pasted, or null when there is none.
 *  A link gives the number it carries; anything else loses its spaces. */
export function trackingNumberFromText(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw) && !/^[a-z0-9.-]+\.[a-z]{2,}\//i.test(raw)) {
    const n = raw.replace(/\s+/g, "");
    return n.length > 0 && n.length <= 64 ? n : null;
  }
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  for (const [key, value] of url.searchParams) {
    if (!PARAM.test(key)) continue;
    // Some sites take several numbers at once ("nums=A,B"); the first is it.
    const first = value.split(/[,\s]+/).find(plausible);
    if (first) return first;
  }
  const segments = url.pathname.split("/").map((s) => decodeURIComponent(s)).filter(plausible);
  return segments.length ? segments[segments.length - 1]! : null;
}
