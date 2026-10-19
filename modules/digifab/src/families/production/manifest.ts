// What the electronics production family declares in Digital Fabrication's manifest: its
// module part, its actions and its panels. Data only: src/module.ts spreads it
// in through families/manifests.ts. The part is on everywhere, as electronics production was
// before it had a folder of its own.
import type { FamilyManifest } from "../../core/families.js";

export const productionManifest: FamilyManifest = {
  part: {
    id: "production",
    label: "Electronics production",
    description: "Electronics production: paste reflow profiles and the oven's bridge driver, and testing boards on their jigs.",
    default: "on",
    routes: ["/production", "/reflow"],
  },
  panels: [
  ],
  actions: [
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      { part: "production", runBy: "member", id: "digifab:reflow-profiles", changes: "records", group: "make", label: "Read paste profiles", description: "List saved immutable reflow profiles for this paste jar.", scope: "workspace", invokeHandler: "digifab.reflow-profiles", userInvokable: true, argsSchema: {paste_kind: {label: "Paste collection kind", type: "text", required: true}, paste_id: {label: "Paste jar id", type: "text", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      { part: "production", runBy: "member", id: "digifab:reflow-profile", changes: "records", group: "make", label: "Read a paste profile", description: "Read one saved paste profile and its manufacturer limits.", scope: "workspace", invokeHandler: "digifab.reflow-profile", userInvokable: true, argsSchema: {profile_id: {label: "Paste profile id", type: "text", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      // ADMIN-ONLY: a paste's reflow profile is the recipe every later batch is baked with; saving one is process setup, and a member has no say over configuration
      { part: "production", runBy: "admin", id: "digifab:save-reflow-profile", changes: "records", group: "make", label: "Save a paste reflow profile", description: "Save the four phases and manufacturer limits as a new immutable version for a liquid paste jar.", scope: "workspace", invokeHandler: "digifab.save-reflow-profile", userInvokable: true, argsSchema: {paste_kind: {label: "Paste collection kind", type: "text", required: true}, paste_id: {label: "Paste jar id", type: "text", required: true}, profile: {label: "Four phases and manufacturer limits", type: "json", required: true}}},
      // UI-SCREEN: /builds/<revision> saves paste profiles and downloads the oven bridge package.
      { part: "production", runBy: "member", id: "digifab:reflow-bridge-package", changes: "records", group: "make", label: "Download the reflow bridge driver", description: "Read the installable bridge driver package for T-962 open firmware and YARC controllers.", scope: "workspace", invokeHandler: "digifab.reflow-bridge-package", userInvokable: true, argsSchema: {}},
      {
        part: "production",
        // UI-SCREEN: /digifab/production
        id: "digifab:production-test", changes: "records", label: "Manage production tests", scope: "workspace", group: "more", userInvokable: false, effect: "writes", undoable: false,
        runBy: "member",
        description: "Save a new immutable test-plan version; register a native jig asset with its fixture pins (pins: name, gpio, direction input or output, pull) and maintenance interval; mint a quantity-one inventory unit without changing its model quantity; prepare an exact unit/plan_version/jig_id/station/bridge_connection_id attempt; sync offline evidence; record reworked or scrapped dispositions; export unit or filtered product/customer/lot PDF or JSON certificates through Files. Admin required for save_plan, save_jig and mint_unit. Other operations require a member. fields is the operation's JSON object.",
        invokeHandler: "digifab.production-test", argsSchema: { operation: { label: "Operation", type: "text", required: true, choices: ["save_plan", "save_jig", "mint_unit", "prepare", "sync", "disposition", "export"].map(value => ({ value, label: value })) }, fields: { label: "Production fields", type: "json", required: true } },
      },
      {
        part: "production",
        // UI-SCREEN: /station/production/:connectionId
        id: "digifab:production-control", changes: "records", label: "Run a production test", scope: "workspace", group: "more", userInvokable: false, effect: "physical", undoable: false,
        // ADMIN-ONLY: starting an attempt powers the board on its jig and answering a prompt moves it on, so it runs the station: the admin tier, or an operator (#6785); aborting stays every member's (digifab:production-abort)
        runBy: "admin",
        grantedAs: "digifab:operate",
        description: "Start a prepared production attempt with fields id, confirmed:true and the scanned jig_id, or answer its current operator prompt with id, step_id, value and optional photo. Requires an admin or an operator. Uses the exact saved plan and approved bridge. All controlled supplies must be owner-enabled. Abort is the separate production-abort stop action, which any member may use.",
        invokeHandler: "digifab.production-control", argsSchema: { operation: { label: "Operation", type: "text", required: true, choices: ["start", "answer"].map(value => ({ value, label: value })) }, fields: { label: "Run or answer fields", type: "json", required: true } },
      },
      {
        part: "production",
        // UI-SCREEN: /station/production/:connectionId
        id: "digifab:production-abort", changes: "records", label: "Abort a production test", scope: "workspace", group: "more", userInvokable: false, effect: "stops", undoable: false,
        runBy: "member",
        description: "Stop the prepared or active attempt immediately and turn every declared supply off. Requires a member; no confirmation is needed.", invokeHandler: "digifab.production-abort", argsSchema: { id: { label: "Attempt id", type: "text", required: true } },
      },
      {
        part: "production",
        // UI-SCREEN: /digifab/production
        id: "digifab:production-read", changes: "records", label: "Read production test evidence", scope: "workspace", group: "more", userInvokable: false, effect: "none", undoable: false,
        runBy: "member",
        description: "Read a serialized unit's full history (fields kind/id), product/customer/lot statistics (fields product_id/customer_id/lot), or a production bridge's cached attempts (fields connection_id). Reports first-pass yield, step failures, measured spreads and drift, and operator/jig failure rates. Requires a workspace member.", invokeHandler: "digifab.production-read", argsSchema: { operation: { label: "Read", type: "text", required: true, choices: ["history", "report", "artifact", "bridge"].map(value => ({ value, label: value })) }, fields: { label: "Scope", type: "json", required: true } },
      },
  ],
};
