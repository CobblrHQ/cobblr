// What a store's mixed pack holds, learned once (#5764, #3769's first
// entries). A "10KG / Multicolor" order line names ten spools without saying
// which; the store's page shows only a photo. Once a person has confirmed a
// pack's ten (here, the owner's boxes, read off their labels), the next read
// of that same variant splits into the known ten with no model at all.
//
// Keyed by the store, the product's title and the variant's options other
// than the warehouse (the same pack ships from any). Each unit is the store's
// own colour option (so it is named and pictured as that colour is sold
// alone), the colour its box prints, and its SKU when the box showed one.

import type { BoxChoice } from "@cobblr/platform-contract/box-label";
import { storeVariantOf } from "@cobblr/platform-contract/same-product";

export interface KnownPack {
  host: string;
  title: string;
  /** The variant's options that say which pack ("10KG", "Multicolor"),
   *  lower case, the warehouse left out. */
  options: readonly string[];
  /** Where the contents came from. */
  source: string;
  units: readonly BoxChoice[];
}

const KINGROON_PETG = { host: "kingroon.com", title: "KINGROON PETG Filament 1.75mm" } as const;
const OWNER_PACKS = "from one owner's pack, 2026-10-11 (#5764)";

export const KNOWN_PACKS: readonly KnownPack[] = [
  {
    ...KINGROON_PETG,
    options: ["10kg", "multicolor"],
    source: OWNER_PACKS,
    units: [
      { colour: "black", label_colour: "Black", sku: "NPETG087" },
      { colour: "transparent", label_colour: "Transparent", sku: "KR-PETG023Y-1CH" },
      { colour: "gray", label_colour: "Gray", sku: "KR-PETG017Y-1CH" },
      { colour: "blue", label_colour: "Dark Blue", sku: "KR-PETG019Y-1CH" },
      // The label was faded where the SKU's digits are: known by its colour.
      { colour: "green", label_colour: "Green", sku: null },
      { colour: "white", label_colour: "White", sku: "KR-PETG016Y-1CH" },
      { colour: "red", label_colour: "Red", sku: "NPETG001" },
      { colour: "silver", label_colour: "Metallic Silver", sku: "NPETG008" },
      { colour: "orange", label_colour: "Orange", sku: "KR-PETG021Y-1CH" },
      { colour: "yellow", label_colour: "Yellow", sku: "KR-PETG026Y-1CH" },
    ],
  },
  {
    ...KINGROON_PETG,
    options: ["10kg", "multicolor-1"],
    source: OWNER_PACKS,
    units: [
      { colour: "white", label_colour: "White", sku: "KR-PETG016Y-1CH" },
      { colour: "light Pink", label_colour: "Light Pink", sku: "KR-PETG003Y-1CH" },
      { colour: "orange", label_colour: "Orange", sku: "KR-PETG021Y-1CH" },
      { colour: "black", label_colour: "Black", sku: "KR-PETG027Y-1CH" },
      { colour: "Purple", label_colour: "Purple", sku: "KR-PETG024Y-1CH" },
      { colour: "red", label_colour: "Red", sku: "NPETG001" },
      { colour: "blue", label_colour: "Dark Blue", sku: "KR-PETG019Y-1CH" },
      { colour: "gray", label_colour: "Gray", sku: "KR-PETG017Y-1CH" },
      { colour: "grass green", label_colour: "Grass Green", sku: "KR-PETG002Y-1CH" },
      { colour: "light apricot", label_colour: "Light Apricot", sku: "KR-PETG006Y-1CH" },
    ],
  },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** An option that says where a variant ships from, never which pack it is. */
const SHIPS_FROM = /warehouse|ships?\s*from|ship\s*to|location|country|region|origin|depot/i;

/** The options that say which pack a variant is: its option values, lower
 *  case and sorted, without the one that says where it ships from (the same
 *  pack ships from any warehouse). One rule for the seed and the network. */
export function packOptionsOf(product: { options: ReadonlyArray<{ name: string }> }, variant: { option1?: string | null; option2?: string | null; option3?: string | null }): string[] {
  const values = [variant.option1, variant.option2, variant.option3];
  return [...new Set(values.map((v, i) => (v && !SHIPS_FROM.test(product.options[i]?.name ?? "") ? norm(v) : "")).filter(Boolean))].sort();
}

/** The known contents of a store's variant, if a person has confirmed them:
 *  the same store and product, the same identifying options (packOptionsOf). */
export function knownPackFor(host: string, title: string, packOptions: readonly string[], packs: readonly KnownPack[] = KNOWN_PACKS): KnownPack | null {
  const want = [...new Set(packOptions.map(norm))].sort().join("/");
  const h = host.toLowerCase().replace(/^www\./, "");
  return packs.find((p) => p.host === h && norm(p.title) === norm(title) && [...p.options].sort().join("/") === want) ?? null;
}

/** A ships-from value as an order line prints it ("US", "EU"): where the store
 *  sends it from, never part of which pack it is. */
const SHIPS_FROM_VALUE = /^(us|usa|eu|uk|gb|ca|au|de|fr|es|it|cn|jp|mx)$/i;

/** The pack an order line names, read from the line itself ("KINGROON PETG
 *  Filament 1.75mm - US / 10KG / Multicolor"), for when the store's page
 *  cannot be read: its title and its options, a ships-from value aside. A
 *  known pack is known without the network (#6004). */
export function knownPackForLine(host: string, line: string, packs: readonly KnownPack[] = KNOWN_PACKS): KnownPack | null {
  const v = storeVariantOf(line);
  if (!v) return null;
  const h = host.toLowerCase().replace(/^www\./, "");
  const have = new Set(v.options.map(norm));
  return packs.find((p) => p.host === h && norm(p.title) === norm(v.base) && p.options.every((o) => have.has(norm(o))) && [...have].every((o) => p.options.map(norm).includes(o) || SHIPS_FROM_VALUE.test(o))) ?? null;
}
