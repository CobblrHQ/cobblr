// Kind-aware printer fields — pure helpers.
//
// A printer's "kind" (how it talks: bambu / klipper / prusa / reprap / marlin)
// decides which spec fields are relevant. A CLOSED ecosystem (Bambu, Prusa) is a
// finished product — the vendor owns the hotend, mainboard, firmware, bed, and
// (for a cloud connection) there's no LAN IP to know — so those build-detail
// fields are noise. An OPEN/DIY printer (Klipper/Voron, RepRapFirmware/Duet,
// Marlin) is one you configured, so they matter and stay visible.
//
// The kind is persisted in the machine's `metadata.printer_kind` (set by the New
// 3D printer flow). For printers created before that, we fall back to the
// manufacturer so existing Bambu/Prusa printers clean up with no backfill.

/** Closed ecosystems where the vendor manages the build — hide the DIY fields. */
export const CLOSED_KINDS = new Set(["bambu", "prusa"]);

/** Custom field-def names that only matter for an open/DIY printer. */
export const BUILD_DETAIL_FIELDS = ["hotend", "extruder", "board", "firmware", "bed_size", "local_ip"] as const;

/** Resolve a printer's kind from its metadata, falling back to the manufacturer
 *  (so printers made before `printer_kind` was persisted still resolve). Returns
 *  null when genuinely unknown — callers then hide nothing. */
export function resolvePrinterKind(
  metadata: Record<string, unknown> | null | undefined,
  manufacturer: string | null | undefined,
): string | null {
  const stored = metadata?.printer_kind;
  if (typeof stored === "string" && stored) return stored;
  const m = (manufacturer ?? "").trim().toLowerCase();
  if (m === "bambu lab" || m === "bambu") return "bambu";
  if (m === "prusa" || m === "prusa research") return "prusa";
  return null;
}

/** Field-def names to hide for a given resolved kind. Closed → hide the
 *  build-detail block; open or unknown → hide nothing (never hide on
 *  uncertainty). */
export function hiddenPrinterFields(kind: string | null): Set<string> {
  return kind && CLOSED_KINDS.has(kind) ? new Set(BUILD_DETAIL_FIELDS) : new Set();
}
