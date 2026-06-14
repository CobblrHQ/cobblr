// maker-scan — vendor scan-URL resolvers.
//
// Some makers print a QR on their product that encodes a URL to a SPECIFIC
// product page (a Polar Filament spool → `3dqr.co/?i=<serial>`). Scanned
// into the inbox, that URL would otherwise be treated as a barcode and sent
// to the generic web-search path, which finds the maker's *marketing* page
// (a LinkedIn post, the homepage) — not the product. The real fix is to
// recognise the maker's URL shape and fetch + parse the product page itself.
//
// This module is the home for that vendor list. The platform owns the seam
// (`platform().scan.registerUrlResolver` / `resolveUrl`); this connector
// registers one matcher+resolver per vendor through it — never a cross-module
// import (the module-isolation rule). The kernel stays vendor-agnostic; adding
// a maker is one more entry in `vendors/`, registered here — no kernel change.
//
// Today: Polar Filament (3dqr.co). The `filament` bundle is the data model
// (types + spools); this connector only turns a scanned spool URL into a
// product the scan pipeline can route — the two never reference each other.
//
// Not foundational — the platform works without it. `marketplace` band per
// docs/architecture/module-layers.md (it's a connector, like
// bricklink-connector).

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "maker-scan",
  version: "0.1.0",
  displayName: "Maker scan",
  description:
    "Resolve scanned maker QR codes (product URLs) to the actual product — fetches the maker's product page instead of letting a scan fall back to a generic web search. Today: Polar Filament spools.",
  icon: "scan-line",
  band: "marketplace",

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  provides: {
    entityKinds: [],
  },

  exposes: {
    events: [],
    api: [],
    actions: [],
  },

  subscribes: [],
});
