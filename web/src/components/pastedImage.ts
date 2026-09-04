// What a paste MEANS when you are choosing a picture.
//
// Two reports, one gesture (2026-09-03). Pasting the address of an image into
// the image-search box ran it as a search phrase, so the one thing a person
// does when they have already found the exact picture they want was the one
// thing the box could not do. And copying an image itself, the ordinary
// screenshot-then-paste, had no door at all.
//
// So paste is read, not assumed: a picture on the clipboard is a picture, an
// address is an address, and anything else is still a search phrase. The rule
// lives here, apart from any component, because three surfaces need to agree on
// it (the search box on the card, the search box inside the viewer, and the
// viewer itself) and a rule copied three times is a rule that will differ.

export type PastedImage =
  /** An actual image on the clipboard: a screenshot, or a copied file. */
  | { kind: "file"; file: File }
  /** Text that is the address of an image, to be fetched and kept. */
  | { kind: "url"; url: string };

/** The clipboard, reduced to what this rule needs. Shaped so the rule can be
 *  asserted without a browser or a real DataTransfer. */
export interface PastedPayload {
  files?: readonly File[];
  text?: string | null;
}

/**
 * An http(s) address, or null. Deliberately strict about the SCHEME and nothing
 * else.
 *
 * Requiring a scheme is what keeps a search phrase a search phrase: somebody
 * typing `lego star wars` or even `amazon.com` means "search for that", and
 * only a pasted `https://…` is unambiguously "this exact thing".
 *
 * It does NOT require the address to end in .jpg. Plenty of image addresses
 * carry no extension at all, and the download is SSRF-guarded and validated
 * server-side, so a wrong address fails loudly with a message rather than
 * needing to be guessed at here.
 */
export function imageUrlFrom(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  // Cheap reject first: a phrase with a space is never an address, and
  // URL() would otherwise accept some surprising things.
  if (!t || /\s/.test(t)) return null;
  let u: URL;
  try {
    u = new URL(t);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  return u.toString();
}

/**
 * What was pasted, in the order that matters: a picture beats its address.
 *
 * Copying an image in a browser puts BOTH the bitmap and the source address on
 * the clipboard. The bitmap is the thing the person is looking at, it needs no
 * network and cannot be hotlink-blocked, so it wins.
 */
export function readPastedImage(payload: PastedPayload): PastedImage | null {
  const file = (payload.files ?? []).find((f) => f.type.startsWith("image/"));
  if (file) return { kind: "file", file };
  const url = imageUrlFrom(payload.text);
  return url ? { kind: "url", url } : null;
}

/**
 * THE reader for images on a clipboard. Every paste surface in the app uses
 * this one, because there were four hand-rolled copies and three different
 * answers: two read only `items`, one read only `files`, and a browser that
 * populates the other one dropped the paste on the floor with no error.
 *
 * Both are read, and the result deduped, so the same screenshot never arrives
 * twice on a browser that fills in both.
 */
export function clipboardImageFiles(data: DataTransfer | null | undefined): File[] {
  if (!data) return [];
  const out: File[] = [];
  const seen = new Set<string>();
  const take = (f: File | null) => {
    if (!f || !f.type.startsWith("image/")) return;
    const id = `${f.name}:${f.size}:${f.lastModified}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push(f);
  };
  for (const it of Array.from(data.items ?? [])) if (it.kind === "file") take(it.getAsFile());
  for (const f of Array.from(data.files ?? [])) take(f);
  return out;
}

/** A ClipboardEvent, reduced to the payload above. */
export function payloadFromClipboard(data: DataTransfer | null): PastedPayload {
  if (!data) return {};
  return { files: clipboardImageFiles(data), text: data.getData("text/plain") };
}
