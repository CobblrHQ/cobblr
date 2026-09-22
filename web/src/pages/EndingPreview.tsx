// A door to LOOK at the sandbox's ending without waiting an hour: the copy is
// the product there (#3254, the owner: "make the UI explain it correctly and
// then I'll criticize it live"). Renders only where /healthz says test_doors,
// the same gate as the scanner's image door; on a real deployment it goes
// home. The keep door on the preview talks to the real api, so on a box that
// hands out no sandboxes it says it could not keep; the words are what this
// route is for.
//
//   /try/ended                          the sandbox's hour, held 24 h
//   /try/ended?kind=trial               a kept trial whose time is up
//   /try/ended?hold=0                   the hold at zero (the old ending)
//   /try/ended?carry=1                  with the third door lit
//   /try/ended?built=1                  with a sample of what was built here
import { Navigate, useSearchParams } from "react-router-dom";
import { useDeployEnv } from "../lib/deploy-env";
import { SandboxEnded } from "./SandboxEnded";
import type { SandboxLedger } from "../lib/api";

/** A ledger to look at on the preview route, so the words can be criticised
 *  without waiting an hour and building something first. */
const SAMPLE_LEDGER: SandboxLedger = {
  since: new Date().toISOString(),
  bundles: [{ external_id: "cobblr.pantry", version: "1.4.0", name: "Pantry", words: "Installed Pantry" }],
  modules: [{ module_name: "projects", name: "Projects", words: "Turned on Projects" }],
  instances: [{ module_name: "inventory", instance_name: "spices", display_name: "Spices", words: "Made Spices in Inventory" }],
  fields: [
    { id: "f1", entity_kind: "inventory:part", name: "colour", display_label: "Colour", type: "text", words: "Added a field Colour to parts" },
    { id: "f2", entity_kind: "inventory:part", name: "size", display_label: "Size", type: "text", words: "Added a field Size to parts" },
  ],
  automations: [{ id: "a1", source_kind: "inventory:part", action_id: "labels:print", words: "Set up an automation on parts" }],
  scans: [],
  records: [
    { entity_kind: "inventory:part", label: "parts", ids: ["1", "2", "3", "4", "5", "6"], scanned: 6, words: "6 parts (6 scanned)" },
    { entity_kind: "core-locations:location", label: "locations", ids: ["l1", "l2"], scanned: 0, words: "2 locations" },
  ],
  left_behind: [
    "the records the sandbox came stocked with",
    "the activity feed and notifications",
    "conversations with the assistant",
    "scan sessions and their history",
    "the guest account itself",
  ],
};

export function EndingPreview() {
  const { testDoors, ready } = useDeployEnv();
  const [params] = useSearchParams();
  // No verdict until the box has answered: the flag reads false while the
  // answer is on its way, and a redirect on that lands on the login screen.
  if (!ready) return null;
  if (!testDoors) return <Navigate to="/" replace />;
  const kind = params.get("kind") === "trial" ? "trial" : "sandbox";
  const hold = Number(params.get("hold") ?? "24");
  return (
    <SandboxEnded
      kind={kind}
      slug="preview"
      preview={{
        cloud_url: params.get("cloud") ?? "https://app.cobblr.xyz/signup",
        selfhost_url: "https://github.com/CobblrHQ/cobblr",
        decision_hours: Number.isFinite(hold) ? hold : 24,
        carry_available: params.get("carry") === "1",
      }}
      ledgerPreview={params.get("built") === "1" ? SAMPLE_LEDGER : null}
    />
  );
}
