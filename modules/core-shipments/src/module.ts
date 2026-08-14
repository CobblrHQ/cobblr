// core-shipments — "where is it right now" for anything with a tracking number.
//
// A CAPABILITY, not a noun. There is no Shipments page and no shipment entity:
// an unarrived thing is a record with an open order (arrivals.md's non-goal,
// kept), and this module only answers a question about a number that already
// lives on that record. Turn it on for a workspace with no tracking numbers and
// nothing changes, which is the capability test.
//
// It is also the upgrade path for the arrivals sweep. arrivals.md asks the user
// "did it turn up?" on the ETA day, because the receipt's estimate was all we
// had. With a tracking number we can know instead of asking, and the question
// stays as the fallback for orders that carry no number. That reverses this
// doc's "carrier tracking" non-goal deliberately — see arrivals.md.
//
// Cost shape: carrier tracking APIs are FREE (only label/shipping APIs are
// gated), and detection is by number format, so nothing here is metered. BYO
// carrier keys self-host; managed keys are a hosted convenience, never a
// per-use charge. business-models/docs/12 §1.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-shipments",
  version: "0.6.0",
  displayName: "Shipments",
  description:
    "Tells you where a parcel is. Paste a tracking number and Cobblr works out the carrier from the number itself, links you straight to their page, and (once a carrier is connected) follows the parcel so an order marks itself arrived instead of asking you.",
  icon: "truck",
  band: "stock",
  // Ambient: inert until something carries a tracking number, so there is no
  // decision to put in front of the user.
  autoEnable: true,

  // No table yet. Poll state arrives with the first carrier driver; detection
  // is a pure function over the number and stores nothing.

  api: () => import("./api/index.js"),

  intents: [],
  dependencies: [],

  // Purchases owns the order that carries the number today. The panel below is
  // gated on this, and stays inert in a workspace without purchases.
  operatesOn: ["purchases"],

  provides: {
    entityKinds: [],
  },

  contributes: {
    fieldDefs: [],
    panels: [
      {
        id: "core-shipments:shipment",
        surface: "entity-detail-panel" as const,
        target: "purchases:order",
        title: "Shipment",
      },
    ],
    wires: [],
  },

  exposes: {
    events: [],
    api: [],
    actions: [
      {
        // The whole cross-module surface. A module owning records that carry
        // tracking numbers passes what it has stored and gets back what to
        // store next: the carrier's answer, the better of its date and the
        // caller's own estimate, and when to ask again. All the judgement
        // lives here so a caller cannot drift from it.
        //
        // Workspace-scoped: it acts on a NUMBER, not on a record, and
        // core-shipments has no business naming whose record it came from.
        id: "core-shipments:track",
        label: "Check a tracking number",
        description:
          "Ask the configured carrier or tracking service where a parcel is. Returns its state and scan history, the better of the carrier's arrival estimate and the one you passed in, and when to check again. Never marks anything arrived: a carrier says a parcel was delivered, only a person can say they took it in. Args: { number, currentEta?, currentEtaSource?, lastState?, lastCheckedAt?, force? }.",
        scope: "workspace" as const,
        invokeHandler: "core-shipments.track",
        userInvokable: false,
      },
    ],
  },
});
