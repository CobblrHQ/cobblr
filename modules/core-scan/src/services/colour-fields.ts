// A colour a scan files is stored the platform's one way
// (@cobblr/platform-contract/colour): a hex in any spelling a tag, a catalog
// or a model gave it ("FF8800FF", "#0af", "rgb(0, 163, 108)") becomes
// "#rrggbb", and a name ("Royal Blue", "Sunset") is kept as written, since
// a colour field can be the key a type is found by. Which fields are colours
// is the table's to say: a field it draws as a swatch.

import { canonicalColour } from "@cobblr/platform-contract/colour";

export interface ColourFieldDef {
  name: string;
  renderer?: string | null;
}

export function canonicalColourFields(meta: Record<string, unknown>, defs: readonly ColourFieldDef[]): Record<string, unknown> {
  const out = { ...meta };
  for (const d of defs) {
    if (d.renderer !== "color-hex") continue;
    const v = out[d.name];
    if (typeof v === "string") out[d.name] = canonicalColour(v);
  }
  return out;
}
