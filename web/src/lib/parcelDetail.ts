// Pulling the carrier's sentence apart from our own words.
//
// Its own module rather than living beside the component: the api project's
// tests import it, and that project cannot resolve a .tsx.

/** The carrier's sentence with our own state word stripped off the front.
 *  "Delivered, Left at garage." next to a "Delivered" chip says it twice; what
 *  the reader wants is the half we do not already have. Returns null when
 *  nothing is left, so the row simply drops it. */
export function trimEcho(detail: string | null, label: string): string | null {
  const d = (detail ?? "").trim();
  if (!d || !label) return d || null;
  const rest = d.toLowerCase().startsWith(label.toLowerCase())
    ? d.slice(label.length).replace(/^[\s,.:;-]+/, "")
    : d;
  const out = rest.trim().replace(/\.$/, "");
  if (!out) return null;
  return out.charAt(0).toUpperCase() + out.slice(1);
}
