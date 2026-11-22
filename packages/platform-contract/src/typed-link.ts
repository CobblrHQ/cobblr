// A link a person types, read the way they mean it (#4115).
//
// On a phone nobody types "https://": a part's Supplier URL typed as
// "supplier.example/hinges" was refused as "Not saved". Something that looks
// like a web address is taken as https://; a web link with its scheme is kept;
// any other scheme (javascript:, data:, file:, mailto:) is refused plainly,
// never given an https:// in front; and words that are not a link are said to
// be one, so nothing is guessed at in silence.

export type TypedLink =
  | { ok: true; url: string | null }
  | { ok: false; reason: string };

export const NOT_A_WEB_LINK = "Only a web link can be saved here (one that starts https:// or http://).";
export const NOT_A_LINK = "This is not a link. A link looks like supplier.example/page.";

// A scheme is letters before a colon that is not a port: "javascript:", "data:", never "localhost:8080".
const SCHEME = /^([a-z][a-z0-9+.-]*):(?!\d)/i;
const HOST = /^(?:localhost|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*[a-z0-9]|\d{1,3}(?:\.\d{1,3}){3})(?::\d{1,5})?(?:[/?#]\S*)?$/i;

function web(text: string): string | null {
  try {
    const u = new URL(text);
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

/** What a typed link saves as: the web address, null for nothing, or why it cannot be saved. */
export function readTypedLink(typed: string): TypedLink {
  const t = typed.trim();
  if (!t) return { ok: true, url: null };
  const scheme = SCHEME.exec(t)?.[1]?.toLowerCase();
  if (scheme && !scheme.includes(".")) {
    if (scheme !== "http" && scheme !== "https") return { ok: false, reason: NOT_A_WEB_LINK };
    const url = web(t);
    return url ? { ok: true, url } : { ok: false, reason: NOT_A_LINK };
  }
  if (/\s/.test(t) || !HOST.test(t)) return { ok: false, reason: NOT_A_LINK };
  const url = web(`https://${t}`);
  return url ? { ok: true, url } : { ok: false, reason: NOT_A_LINK };
}
