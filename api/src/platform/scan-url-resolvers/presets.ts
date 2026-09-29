// Shared mappings for published filament data formats. A maker that publishes
// one gets it by naming the preset in its manifest (`output.preset`), so a
// second maker publishing OpenTag3D resolves exactly like the first, and an
// operator-added resolver row can use it with no code.

import type { FieldMap, ScanUrlResolverManifest } from "./types.js";

type Output = ScanUrlResolverManifest["output"];

/** OpenTag3D (https://opentag3d.info/spec), as a maker's web API serves it:
 *  `{ opentag_version, tag_data: {...}, product_photos: [...] }`. The tag
 *  stores its numbers in small integer units; each map below reads them back
 *  in the units a person uses:
 *  - temperatures are stored divided by 5 (43 is 215 °C), 0 meaning not given;
 *  - diameter is µm, tolerance hundredths of a mm, nozzle tenths of a mm;
 *  - density is µg/cm³ (1240 is 1.24 g/cm³);
 *  - weights are grams, the filament's own weight excluding the spool;
 *  - measured length is metres;
 *  - colours are [r, g, b, a] bytes in up to four slots, a 0 alpha marking
 *    an unused one; two or more set read as one several-colour value;
 *  - the manufacture date is [year, month, day].
 *  The melt-flow value is left out: its unit reads as g/min in the spec while
 *  the label a maker prints beside it reads g/10 min, and a number in the
 *  wrong unit is worse than none. */
const T = (path: string) => `tag_data.${path}`;
const tempC = (path: string): FieldMap => ({ path: T(path), scale: 5, zero_is_empty: true });

export const OPENTAG3D_OUTPUT: Omit<Output, "source" | "preset"> = {
  name: { concat: [T("color_name"), T("material")], sep: " ", fallback: "Filament" },
  brand: T("manufacturer"),
  category: "filament",
  entityType: "part",
  imageUrl: "product_photos.0",
  fields: {
    material: T("material"),
    material_mod: T("material_mod"),
    // ONE colour field. Its name where the tag gives one, since a filament
    // type is matched by it; the tag's code only when nothing named it; and
    // several colours always as the several-colour value, which a name
    // cannot say (the colour rule, @cobblr/platform-contract/colour).
    color: {
      colours: [T("color_1"), T("color_2"), T("color_3"), T("color_4")],
      gradient_if: [T("material_mod"), T("color_name")],
      named_by: T("color_name"),
    },
    diameter: { path: T("diameter"), scale: 0.001, suffix: " mm" },
    tolerance: { path: T("tolerance"), scale: 0.01, prefix: "±", suffix: " mm", zero_is_empty: true },
    nozzle_size: { path: T("nozzle_diameter"), scale: 0.1, suffix: " mm", zero_is_empty: true },
    nozzle_temp: tempC("print_temp"),
    nozzle_temp_min: tempC("min_print_temp"),
    nozzle_temp_max: tempC("max_print_temp"),
    bed_temp: tempC("bed_temp"),
    bed_temp_min: tempC("min_bed_temp"),
    bed_temp_max: tempC("max_bed_temp"),
    chamber_temp: tempC("chamber_temp"),
    dry_temp: tempC("max_dry_temp"),
    dry_hours: { path: T("dry_time"), zero_is_empty: true },
    density: { path: T("density"), scale: 0.001, zero_is_empty: true },
    size: { path: T("weight"), scale: 0.001, suffix: " kg", zero_is_empty: true },
    empty_spool_g: { path: T("empty_spool_weight"), zero_is_empty: true },
    spool_core_mm: { path: T("spool_core_diameter"), zero_is_empty: true },
    length_m: { path: T("measured_length"), zero_is_empty: true },
    upc: { path: T("barcode"), stringify: true, zero_is_empty: true },
    sku: T("sku"),
    batch_code: T("serial"),
    mfg_date: { path: T("mfg_date"), ymd: true },
    qa_status: "qa_status",
  },
};

const PRESETS: Record<NonNullable<Output["preset"]>, Omit<Output, "source" | "preset">> = {
  opentag3d: OPENTAG3D_OUTPUT,
};

/** The manifest's output with its preset filled in underneath: whatever the
 *  manifest says itself wins, key by key. */
export function withPreset(output: Output): Output {
  if (!output.preset) return output;
  const p = PRESETS[output.preset];
  return {
    ...output,
    name: output.name ?? p.name,
    brand: output.brand ?? p.brand,
    category: output.category !== undefined ? output.category : p.category,
    entityType: output.entityType !== undefined ? output.entityType : p.entityType,
    imageUrl: output.imageUrl ?? p.imageUrl,
    fields: { ...p.fields, ...output.fields },
  };
}
