// Colour-swatch helpers, shared so the scan-confirm form (ScanPage) and the
// generic entity thumbnail (EntityThumb) use ONE definition of "is this a
// colour field?" and "what colour does this value render as?". Forking that
// logic is how a yarn's colourway ends up a picker in one place and a photo in
// another — keep it here.
//
// The platform has no dedicated colour field TYPE. Bundles ship colours as
// text fields whose name is `color`/`colour`, or whose help mentions
// "hex/swatch" (yarn's colourway). The matchmaker is prompted to fill them
// with CSS hex codes.

/** The minimal field-def shape the swatch check needs — satisfied by platform
 *  field defs, the scan menu's trimmed fields, and anything with a name/type. */
export interface SwatchFieldDef {
  name: string;
  type: string;
  help?: string | null;
}

/** Does this field def want a colour swatch? A text field named
 *  `color`/`colour`, or whose help mentions hex/swatch. */
export function wantsSwatch(def: SwatchFieldDef): boolean {
  return (
    def.type === "text" &&
    (/hex|swatch/i.test(def.help ?? "") || def.name === "color" || def.name === "colour")
  );
}

/** A colour VALUE → a CSS colour usable as a swatch background, or null if it
 *  isn't a colour we can render. A `#rrggbb` (or `rrggbb`) is used as-is; a NAME
 *  ("Royal Blue") is normalised to a CSS named colour ("royalblue") — vendors
 *  like Polar give us only the name, no hex (pfil.us returns `color:"Royal
 *  Blue"`), so this is the only way to show a swatch. Maker-specific names that
 *  aren't CSS colours ("Galaxy Black") return null → the caller shows text. */
export function colorSwatch(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v) return null;
  if (/^#?[0-9a-fA-F]{6}$/.test(v)) return v[0] === "#" ? v : `#${v}`;
  const named = v.toLowerCase().replace(/\s+/g, "");
  return typeof CSS !== "undefined" && CSS.supports?.("color", named) ? named : null;
}

/** Normalise a strict 6-digit hex value → `#rrggbb` (lower-case), else null.
 *  Deliberately stricter than colorSwatch: a thumbnail swatch stands in for a
 *  photo, so it must be a real colour the item CARRIES — a hex — not a fuzzy
 *  named-colour guess. */
export function swatchHex(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!/^#?[0-9a-f]{6}$/i.test(v)) return null;
  return (v[0] === "#" ? v : `#${v}`).toLowerCase();
}

/** Given an item's stored field VALUES (its metadata bag) and — optionally —
 *  its field DEFS, find the first swatch-eligible colour field carrying a hex
 *  value, and return that normalised hex (or null).
 *
 *  With defs: only fields whose def passes `wantsSwatch` are considered, so a
 *  stray `color` key that isn't actually a declared colour field is ignored,
 *  and help-based colour fields (name != color) are honoured.
 *  Without defs: falls back to the conventional `color`/`colour` keys by name
 *  — enough for the common case (yarn) when a caller can't cheaply supply defs.
 *
 *  Returns null when `values` is empty, so a caller that passes nothing keeps
 *  its prior photo-only behaviour. */
export function resolveSwatchHex(
  values: Record<string, unknown> | null | undefined,
  defs?: readonly SwatchFieldDef[] | null,
): string | null {
  if (!values) return null;
  if (defs && defs.length) {
    for (const def of defs) {
      if (!wantsSwatch(def)) continue;
      const hex = swatchHex(values[def.name]);
      if (hex) return hex;
    }
    return null;
  }
  return swatchHex(values.color) ?? swatchHex(values.colour) ?? null;
}

/** What a thumbnail should render, decided BEFORE any image is fetched:
 *  - `swatch`: a swatch-eligible colour field carries a hex, so the colourway
 *    IS the identity — it WINS over a photo (a generic catalog "skein" shot
 *    would otherwise bury it). Opt in by passing `values` (+ optional `defs`);
 *    omit them and a photo always wins, preserving prior behaviour.
 *  - `image`: no preferred swatch, but there is a photo.
 *  - `fallback`: neither — show the legacy `color` swatch (no-photo case) or an
 *    initial-letter chip. `hex` is the legacy fallback colour, or null. */
export type ThumbChoice =
  | { kind: "swatch"; hex: string }
  | { kind: "image" }
  | { kind: "fallback"; hex: string | null };

export function pickThumb(opts: {
  hasImage: boolean;
  values?: Record<string, unknown> | null;
  defs?: readonly SwatchFieldDef[] | null;
  /** Legacy fallback-only hex (EntityThumb's `color` prop). */
  color?: string | null;
}): ThumbChoice {
  const preferred = resolveSwatchHex(opts.values, opts.defs);
  if (preferred) return { kind: "swatch", hex: preferred };
  if (opts.hasImage) return { kind: "image" };
  return { kind: "fallback", hex: swatchHex(opts.color) };
}
