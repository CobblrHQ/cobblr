// An address: where an appointment or a visit happens (#5317).
//
// Called an ADDRESS everywhere a person reads it, never a "location" or a
// "place": in Cobblr a Location is where a thing is kept (core-locations).
//
// Stored as one JSON value. The parts are what a person types into the
// structured form; `line` is the street address joined from them, kept so a
// reader that only wants text (a calendar's LOCATION, a spreadsheet cell, a
// search) never re-derives it. `lat`/`lon` arrive only from a map lookup, and
// none ships yet (the lookup seam is in the api; off, it offers nothing).
//
// Text that came from anywhere else (an import, an assistant, a field retyped
// from text) reads as an address whose line is that text, so a typed address
// is never refused for not being structured.

export const ADDRESS_SOURCES = ["typed", "used", "lookup"] as const;
/** Where the value came from: typed by a person, picked from the addresses
 *  this workspace already used, or returned by a map lookup. */
export type AddressSource = (typeof ADDRESS_SOURCES)[number];

export const ADDRESS_PARTS = ["street", "city", "region", "postal", "country"] as const;
export type AddressPart = (typeof ADDRESS_PARTS)[number];

export interface AddressValue {
  /** What the place is called: "MVC Lodi Agency". Optional; a home has none. */
  name?: string;
  street?: string;
  city?: string;
  /** State, province or county. */
  region?: string;
  postal?: string;
  country?: string;
  /** The street address on one line, joined from the parts (or as typed). */
  line: string;
  lat?: number;
  lon?: number;
  source: AddressSource;
}

const clean = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.replace(/\s+/g, " ").trim();
  return t === "" ? undefined : t;
};
const coord = (v: unknown, limit: number): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && Math.abs(n) <= limit ? n : undefined;
};

/** The street address on one line: "8 Mill St, Lodi, NJ 07644". */
export function joinAddressLine(parts: Partial<Record<AddressPart, string | undefined>>): string {
  const regionPostal = [clean(parts.region), clean(parts.postal)].filter(Boolean).join(" ");
  return [clean(parts.street), clean(parts.city), regionPostal, clean(parts.country)].filter(Boolean).join(", ");
}

/** Any stored or typed value as an address, or null when it holds none.
 *  An object keeps its parts; a string is an address typed on one line. */
export function asAddress(raw: unknown): AddressValue | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    const line = clean(raw);
    return line ? { line, source: "typed" } : null;
  }
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out: AddressValue = { line: "", source: (ADDRESS_SOURCES as readonly unknown[]).includes(o.source) ? (o.source as AddressSource) : "typed" };
  const name = clean(o.name);
  if (name) out.name = name;
  for (const p of ADDRESS_PARTS) {
    const v = clean(o[p]);
    if (v) out[p] = v;
  }
  out.line = joinAddressLine(out) || clean(o.line) || "";
  const lat = coord(o.lat, 90);
  const lon = coord(o.lon, 180);
  if (lat !== undefined && lon !== undefined) {
    out.lat = lat;
    out.lon = lon;
  }
  if (!out.line && !out.name) return null;
  return out;
}

/** The address as one piece of text: "MVC Lodi Agency, 8 Mill St, Lodi, NJ".
 *  What a calendar's LOCATION, a spreadsheet and a search read. */
export function addressText(raw: unknown): string {
  const a = asAddress(raw);
  if (!a) return "";
  if (!a.name) return a.line;
  if (!a.line || a.line.toLowerCase().startsWith(a.name.toLowerCase())) return a.line || a.name;
  return `${a.name}, ${a.line}`;
}

/** What a calendar event carries of an address: its one line and, when it has
 *  them, its coordinates. Empty when there is no address. */
export function addressWhere(raw: unknown): { location?: string; geo?: { lat: number; lon: number } } {
  const a = asAddress(raw);
  if (!a) return {};
  return {
    location: addressText(a),
    ...(a.lat !== undefined && a.lon !== undefined ? { geo: { lat: a.lat, lon: a.lon } } : {}),
  };
}

/** Two addresses are the same place when their name and line read the same,
 *  whatever the case or spacing. What "used before" de-duplicates on. */
export function addressKey(raw: unknown): string {
  const a = asAddress(raw);
  if (!a) return "";
  return `${(a.name ?? "").toLowerCase()}|${a.line.toLowerCase()}`;
}

/** Does this address answer what is being typed? Every word typed must start
 *  a word of the name or the line, so "mvc" finds MVC Lodi Agency and
 *  "mill lodi" finds 8 Mill St, Lodi. */
export function addressMatches(raw: unknown, query: string): boolean {
  const a = asAddress(raw);
  if (!a) return false;
  const words = query.toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = `${a.name ?? ""} ${a.line}`.toLowerCase().split(/[\s,.#-]+/).filter(Boolean);
  return words.every((w) => hay.some((h) => h.startsWith(w)));
}

/** A link that opens the address in a map. Apple Maps on an Apple device,
 *  where it opens the Maps app; a universal maps link anywhere else, which
 *  opens the maps app on Android and a map page on a computer. Coordinates
 *  are used when there are some, the text otherwise. */
export function directionsUrl(raw: unknown, opts: { apple?: boolean } = {}): string | null {
  const a = asAddress(raw);
  if (!a) return null;
  const text = addressText(a);
  const q = a.lat !== undefined && a.lon !== undefined ? `${a.lat},${a.lon}` : text;
  if (opts.apple) {
    const label = a.lat !== undefined ? `&q=${encodeURIComponent(a.name ?? text)}` : "";
    return a.lat !== undefined
      ? `https://maps.apple.com/?ll=${a.lat},${a.lon}${label}`
      : `https://maps.apple.com/?q=${encodeURIComponent(q)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`;
}

/** Whether a browser is on an Apple device, for directionsUrl's `apple`. */
export function isAppleDevice(userAgent: string, maxTouchPoints = 0): boolean {
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1);
}
