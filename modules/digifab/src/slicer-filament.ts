function positive(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function range(value: unknown): [number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 2) return;
  const lo = positive(value[0]);
  const hi = positive(value[1]);
  return lo && hi && hi >= lo ? [lo, hi] : undefined;
}

export function filamentValues(metadata: Record<string, unknown>, manufacturer?: unknown): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  const diameter = positive(metadata.diameter_mm ?? metadata.diameter);
  if (diameter) values.diameter_mm = diameter;
  for (const key of ["nozzle_temp_c", "bed_temp_c"] as const) {
    const stem = key === "nozzle_temp_c" ? "nozzle_temp" : "bed_temp";
    const r = range(metadata[key]) ?? range([metadata[`${stem}_min`], metadata[`${stem}_max`]]) ?? range([metadata[stem], metadata[stem]]);
    if (r) values[key] = r;
  }
  for (const key of ["density_g_cm3", "max_volumetric_mm3_s"] as const) {
    const n = positive(metadata[key] ?? (key === "density_g_cm3" ? metadata.density : undefined));
    if (n) values[key] = n;
    else if (metadata[key] === null) values[key] = null;
  }
  const color = metadata.color_hex ?? metadata.color;
  if (typeof color === "string" && /^#?[a-f0-9]{6}$/i.test(color)) values.color_hex = `#${color.replace(/^#/, "")}`;
  const brand = metadata.brand ?? manufacturer;
  if (typeof brand === "string" && brand.trim()) values.brand = brand.trim();
  return values;
}
