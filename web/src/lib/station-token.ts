// A Station tablet's own token (#4640), kept on the tablet and used in place
// of a person's session while the station page is open.
//
// The tablet never signs in: an owner approves it, and it keeps a token that
// reaches only its own station (api/src/auth/scopes.ts, `station:<address>`).
// While the station page is mounted that token is the tab's token, so every
// call the page makes, including the scan inbox's own card for a new thing,
// goes out as the station; a person signed in on the same browser stays
// signed in, and their session comes back when the page closes.

let override: string | null = null;

/** The token the api client sends while a station page is open. */
export function getStationTokenOverride(): string | null {
  return override;
}

export function setStationTokenOverride(token: string | null): void {
  override = token;
}

const key = (slug: string, address: string) => `cobblr.station.${slug}.${address}`;
const LAST = "cobblr.station.last";

export function readStationToken(slug: string, address: string): string | null {
  try {
    return localStorage.getItem(key(slug, address));
  } catch {
    return null;
  }
}

export function saveStationToken(slug: string, address: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(key(slug, address), token);
    else localStorage.removeItem(key(slug, address));
  } catch {
    // A browser that keeps nothing asks for approval again next time.
  }
}

/** The station this device opened last: an installed station app opens at
 *  `/station` and goes straight back to it. */
export function lastStation(): { slug: string; address: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(LAST) ?? "null") as { slug?: unknown; address?: unknown } | null;
    return v && typeof v.slug === "string" && typeof v.address === "string" ? { slug: v.slug, address: v.address } : null;
  } catch {
    return null;
  }
}

export function rememberStation(slug: string, address: string): void {
  try {
    localStorage.setItem(LAST, JSON.stringify({ slug, address }));
  } catch {
    // Nothing kept: /station asks which station next time.
  }
}

// A phone's kitchen QR token (#5353): kept apart from a tablet's, so a phone
// that opened the label is never mistaken for an approved station screen.
const qrKey = (slug: string, address: string) => `cobblr.station-qr.${slug}.${address}`;

export function readStationQrToken(slug: string, address: string): string | null {
  try {
    return localStorage.getItem(qrKey(slug, address));
  } catch {
    return null;
  }
}

export function saveStationQrToken(slug: string, address: string, token: string | null): void {
  try {
    if (token) localStorage.setItem(qrKey(slug, address), token);
    else localStorage.removeItem(qrKey(slug, address));
  } catch {
    // A browser that keeps nothing opens the label again next time.
  }
}
