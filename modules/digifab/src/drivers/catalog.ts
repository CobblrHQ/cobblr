// The built-in driver CATALOG — the "app store" shelf of ready-to-install
// firmware drivers that ship with digifab. These are declarative manifests
// (data); a user browses them (GET …/drivers/catalog) and installs one
// (POST …/drivers) into their workspace with no platform deploy. Custom
// manifests can still be installed directly.
//
// This is the first non-module population of the eventual UNIFIED registry /
// app store (modules + bundles + drivers, one browse surface). For now it's
// a digifab-local shelf; the catalog SHAPE (id/name/summary/manifest) is
// deliberately registry-ready. See docs/design-decisions/digifab-drivers.md.

import { DriverManifest } from "./manifest.js";
import octoprint from "../../drivers-catalog/octoprint.json" with { type: "json" };
import klipper from "../../drivers-catalog/klipper-moonraker.json" with { type: "json" };
import duet from "../../drivers-catalog/duet-rrf.json" with { type: "json" };
import prusalink from "../../drivers-catalog/prusalink.json" with { type: "json" };
import fluidnc from "../../drivers-catalog/fluidnc.json" with { type: "json" };

export interface CatalogEntry {
  id: string;
  name: string;
  /** One line for the store shelf. */
  summary: string;
  /** What credential the connection needs (UI hint). */
  credentialHint: string;
  kind: "declarative" | "edge-adapter";
  /** The installable manifest (declarative entries). */
  manifest: DriverManifest;
}

// Each raw JSON is validated at module load so a malformed catalog entry
// fails loudly here, not at install time.
function entry(raw: unknown, summary: string, credentialHint: string): CatalogEntry {
  const m = DriverManifest.parse(raw);
  return { id: m.id, name: m.name, summary, credentialHint, kind: "declarative", manifest: m };
}

export const DRIVER_CATALOG: CatalogEntry[] = [
  entry(octoprint, "Single-printer host. Upload + select-and-print over the OctoPrint REST API.", "API key (Settings → Application Keys)"),
  entry(klipper, "Klipper via the Moonraker API. Upload to the gcodes store + start a print.", "API key (optional; Moonraker [authorization])"),
  entry(duet, "RepRapFirmware (Duet Web Control). Raw gcode upload + M32 print start.", "none (or DWC password)"),
  entry(prusalink, "Prusa printers via PrusaLink. Raw PUT upload + print.", "API key (PrusaLink Settings)"),
  entry(fluidnc, "GRBL lasers/CNC on FluidNC. Upload to SD + $SD/Run; plain-text GRBL status.", "none (or device password)"),
];

// Bambu is intentionally NOT here: it speaks MQTT + FTPS, not REST, so it
// can't be a declarative manifest. It ships as an EDGE-ADAPTER bridge the
// user runs (LAN or cloud mode = the bridge's config, not Cobblr's). See
// the design doc's "Bambu" section.
export const EDGE_ADAPTER_CATALOG: Array<Pick<CatalogEntry, "id" | "name" | "summary" | "credentialHint" | "kind">> = [
  {
    id: "bambu",
    name: "Bambu Lab (bridge)",
    summary: "MQTT/FTPS — not REST. Run the Bambu edge-adapter bridge; point a connection at it. LAN or cloud mode is the bridge's config.",
    credentialHint: "configured in the bridge (LAN access code, or Bambu Cloud account)",
    kind: "edge-adapter",
  },
];
