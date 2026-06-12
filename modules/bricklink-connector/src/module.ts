// bricklink — BrickLink-format import/export for a Lego workspace.
//
// BrickLink is the canonical marketplace + part-catalog format for the
// LEGO community. Power users live there for:
//   - Maintaining "wanted lists" (XML of parts they need for a MOC).
//   - Tracking orders (XML/CSV downloaded from BL after a purchase).
//   - Sharing inventories (XML export of what they own).
//
// v0.1 shipped the wanted-list import path.
// v0.2 (this version) adds:
//   - POST /parse-order  — accept a BL order CSV, return structured
//     lines + summary. Doesn't write; a future /commit-order
//     endpoint takes these and bumps inventory + creates a purchase.
//   - POST /diff-wanted-list — diff a parsed wanted-list against
//     the workspace's Lego inventory. Returns each wanted line +
//     a bucket (have / partial / need / unmatched). Color-aware.
//
// Future:
//   - POST /commit-order  — write the parsed order into purchases
//     + bump inventory_parts.qty.
//   - POST /export-inventory  — emit BL-compatible XML from
//     workspace inventory.
//   - Resolve sets / minifigs via a rebrickable-sets catalog match
//     so the diff can bucket non-part wanted items too.
//
// Not foundational — the platform works without a Lego workspace.
// `marketplace` band per docs/architecture/module-layers.md.
//
// VENDORED COPY — canonical source is
// https://github.com/CobblrHQ/bricklink-connector.
//
// Until marketplace v2's image-build CI ships (which fetches signed
// tarballs from cobblrhq/registry at docker build), this in-tree
// copy is the runtime source. Once v2 CI ships, the Dockerfile step
// that builds @cobblr/bricklink-connector gets replaced by a "fetch
// + verify + extract from registry" step, and this directory
// disappears from cobblr-core entirely.
//
// Sync rule: any change to this code MUST also be PR'd to
// cobblrhq/bricklink-connector. The two diverge if not kept
// aligned. See docs/history/bricklink-rename.md.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "bricklink-connector",
  version: "0.2.0",
  displayName: "BrickLink",
  description:
    "Import BrickLink wanted-list XML + order CSVs; diff a wanted list against your Lego inventory. Built for the Lego workspace use case.",
  icon: "package",
  band: "marketplace",

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [
      "bricklink.wanted-list.parsed",
      "bricklink.order.parsed",
    ],
    api: [],
    actions: [
      {
        id: "bricklink:disassemble-kit",
        label: "Disassemble into parts",
        description:
          "Expand a Lego kit (an inventory:part matched to a Rebrickable set) into its constituent parts. Reads the lego.bom / lego.part catalogs (semantic types), creates one part per BOM row via inventory:create-items, writes a `matches` pairing to each Rebrickable part entry + a `derived-from` pairing back to the kit, and flips the kit's metadata.lifecycle to 'parted-out' via inventory:update-item. Requires the BOM catalog loaded (node scripts/seed-rebrickable.mjs --include-bom). Lives in the Lego domain module, not generic inventory.",
        appliesTo: { kinds: ["inventory:part"] },
        invokeHandler: "bricklink.disassemble-kit",
        userInvokable: true,
      },
    ],
  },

  subscribes: [],
});
