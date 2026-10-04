import { LightGrid, PlaceLight, type LightGridInput, type PlaceLightMapping, type WledLightMapping } from "@cobblr/platform-contract/place-indicate";

type PixelMapping = WledLightMapping | (Extract<PlaceLightMapping, { driver: "esphome" }> & { pixels: WledLightMapping["pixels"] });

export function mapLightGrid(places: Array<{ id: string; metadata: Record<string, unknown> }>, raw: Omit<LightGridInput, "driver"> & { driver?: LightGridInput["driver"] }): Map<string, PixelMapping> {
  const config = LightGrid.parse(raw);
  const bins = places.map(p => {
    const rect = p.metadata.floorplan as { x_mm?: number; y_mm?: number } | undefined;
    if (!Number.isFinite(rect?.x_mm) || !Number.isFinite(rect?.y_mm)) throw new Error("Arrange every bin with + grid before mapping its light.");
    return { id: p.id, x: rect!.x_mm!, y: rect!.y_mm! };
  });
  if (!bins.length) throw new Error("Add bins with + grid first.");
  const xs = [...new Set(bins.map(p => p.x))].sort((a, b) => a - b);
  const ys = [...new Set(bins.map(p => p.y))].sort((a, b) => a - b);
  if (xs.length * ys.length !== bins.length || new Set(bins.map(p => `${p.x}:${p.y}`)).size !== bins.length) throw new Error("These bins do not form a complete grid. Arrange them with + grid first.");
  if (config.mode === "xy" && (config.column_segment === undefined || config.column_start === undefined)) throw new Error("Choose the column strip's segment and starting LED.");
  if (config.driver === "esphome" && !config.entity) throw new Error("Choose the ESPHome light entity for this strip.");
  const out = new Map<string, PixelMapping>();
  for (const bin of bins) {
    const row = ys.indexOf(bin.y), col = xs.indexOf(bin.x);
    const index = row * xs.length + (config.order === "serpentine" && row % 2 ? xs.length - 1 - col : col);
    const pixels = config.mode === "strip"
      ? [{ segment: config.segment, led: config.start + index * config.per_bin, count: config.per_bin }]
      : [{ segment: config.segment, led: config.start + row, count: 1 }, { segment: config.column_segment!, led: config.column_start! + col, count: 1 }];
    if (config.mode === "xy" && config.segment === config.column_segment && config.start < config.column_start! + xs.length && config.column_start! < config.start + ys.length) throw new Error("The row and column LED ranges overlap. Choose separate strips or ranges.");
    out.set(bin.id, PlaceLight.parse({ connection_id: config.connection_id, driver: config.driver, ...(config.driver === "esphome" ? { entity: config.entity } : {}), pixels }) as PixelMapping);
  }
  return out;
}
