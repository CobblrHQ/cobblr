// What the kilns family declares in Digital Fabrication's manifest: its
// module part, its actions and its panels. Data only: src/module.ts spreads it
// in through families/manifests.ts. The part is on everywhere, as kilns were
// before it had a folder of its own.
import type { FamilyManifest } from "../../core/families.js";

export const kilnsManifest: FamilyManifest = {
  part: {
    id: "kilns",
    label: "Kilns",
    description: "Kilns as machines: their profiles and components, firing logs with every piece, and Start and Stop at their station.",
    default: "on",
    routes: ["/kilns"],
  },
  panels: [
      // On a kiln, and on any other machine only where it already has firing
      // logs (the presence the family registers, #6337).
      { part: "kilns", id: "digifab:kiln", surface: "entity-detail-panel" as const, target: "machines:machine", title: "Firing logs", collections: ["kilns"], presence: true },
  ],
  actions: [
      {
        part: "kilns",
        // UI-SCREEN: /machines
        id: "digifab:kiln-log", changes: "records", label: "Record kiln firings", scope: "workspace", group: "more", userInvokable: false, effect: "writes", undoable: false,
        // ADMIN-ONLY: the page's kiln routes POST /kilns/:machineId/profile, /firings and /firings/:id/finish gate on this action, owner or admin (kilns.ts)
        runBy: "admin",
        description: "Save a kiln profile, create a firing log with schedule and every piece, or finish a log with measured hours and peak temperature. Requires an admin. Never starts or stops a kiln. Profile id is machine id, fields: connection_id, device_id, components (name, interval_hours, replaced_at_hours). Create id is a new UUID, fields: machine_id, firing (name, cone, schedule of ramp_c_per_hour/target_c/hold_minutes, pieces of kind/id, glazes of part_id/ml and optional kind for an Inventory collection (must be liquid workshop stock), notes). Finish id is firing id, fields: duration_hours, peak_c, outcome completed/failed/stopped.",
        examples: ["log this glaze firing and all its pieces", "replace the kiln elements after 200 firing hours"], invokeHandler: "digifab.kiln-log",
        argsSchema: {
          operation: { label: "Operation", type: "text", required: true, choices: ["profile", "create", "finish"].map(value => ({ value, label: value })) },
          id: { label: "Machine or firing id", type: "text", required: true },
          fields: { label: "Profile or log fields", type: "json", required: true },
        },
      },
  ],
};
