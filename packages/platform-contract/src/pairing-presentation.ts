// Presentation for a pairing target that is not a Cobblr record. The writer
// vouches for this address; models never get to invent it. Kept in the
// pairing's metadata so every reader of the platform primitive sees the same
// title and open action.

export interface PairingResultPresentation {
  label: string;
  href: string;
  open_label?: string;
}

/** Only absolute web addresses can leave the app. In particular, a value in
 * pairing metadata must never become a javascript: link in a chat answer. */
export function pairingResultPresentation(value: unknown): PairingResultPresentation | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const label = typeof row.label === "string" ? row.label.trim() : "";
  const href = typeof row.href === "string" ? row.href.trim() : "";
  if (!label || !href) return null;
  try {
    const url = new URL(href);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  } catch {
    return null;
  }
  const open = typeof row.open_label === "string" ? row.open_label.trim() : "";
  return { label, href, ...(open ? { open_label: open } : {}) };
}

export function pairingResultMetadata(presentation: PairingResultPresentation): { result: PairingResultPresentation } {
  const safe = pairingResultPresentation(presentation);
  if (!safe) throw new Error("Pairing result presentation needs a title and an absolute HTTP address");
  return { result: safe };
}
