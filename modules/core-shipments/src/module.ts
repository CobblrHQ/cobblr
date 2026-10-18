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
  version: "0.7.0",
  maturity: "beta",
  displayName: "Shipments",
  description:
    "Paste a tracking number to see where a parcel is, and have an order mark itself arrived.",
  icon: "truck",
  band: "stock",
  // Ambient: inert until something carries a tracking number, so there is no
  // decision to put in front of the user.
  autoEnable: true,

  // No table. Detection is a pure function over the number, and a parcel's
  // poll state is stored by the record that carries it (a purchase order, a
  // scanned receipt), which calls core-shipments:track and keeps the answer.

  api: () => import("./api/index.js"),

  dependencies: [],

  // The records that carry a number: a purchase coming in, a sale going out.
  // Each panel below is gated on its module and stays inert without it.
  operatesOn: ["purchases", "sales"],

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
      {
        id: "core-shipments:shipment",
        surface: "entity-detail-panel" as const,
        target: "sales:order",
        title: "Shipment",
      },
    ],
    wires: [],
  },

  exposes: {
    events: ["core-shipments.tracker.pushed"],
    actions: [
      {
        // NO-PHRASING: a record asks it for the words of a shipping notice; nobody asks for it by name
        // UI-REACH: a sales order's Ship dialog names the carrier and the tracking link from it (sales ship preview and notice)
        group: "more",
        id: "core-shipments:identify",
        changes: "records",
        runBy: "member",
        label: "Name a tracking number's carrier",
        description:
          "Which carrier a tracking number belongs to, and the page where anyone can follow it (the carrier's own, or a universal tracker when the carrier is not recognised). Never calls a carrier. Args: { number }.",
        scope: "workspace" as const,
        invokeHandler: "core-shipments.identify",
        argsSchema: {
          number: { label: "The tracking number", type: "text", required: true },
        },
        userInvokable: false,
      },
      {
        // The whole cross-module surface. A module owning records that carry
        // tracking numbers passes what it has stored and gets back what to
        // store next: the carrier's answer, the better of its date and the
        // caller's own estimate, and when to ask again. All the judgement
        // lives here so a caller cannot drift from it.
        //
        // Workspace-scoped: it acts on a NUMBER, not on a record, and
        // core-shipments has no business naming whose record it came from.
        group: "more",
        // UI-REACH: internal carrier query used by parcel refresh; people check the stored parcel on Purchases or Sales instead of supplying polling state.
        id: "core-shipments:track",
        changes: "records",
        runBy: "member",
        examples: ["where is my parcel", "track this number"],
        label: "Check a tracking number",
        description:
          "Ask the configured carrier or tracking service where a parcel is. Returns its state and scan history, the better of the carrier's arrival estimate and the one you passed in, and when to check again. Never marks anything arrived: a carrier says a parcel was delivered, only a person can say they took it in. Args: { number, currentEta?, currentEtaSource?, lastState?, lastCheckedAt?, force? }.",
        scope: "workspace" as const,
        invokeHandler: "core-shipments.track",
        argsSchema: {
          confirmed: { label: "Whether a person has confirmed they received it", type: "boolean" },
          deliveredAt: { label: "When the carrier said it was delivered, ISO timestamp", type: "text" },
          watchDaysAfterDelivery: { label: "Days to keep watching after the delivered scan (default 14; a parcel you sent: 2)", type: "number" },
          number: { label: "The tracking number", type: "text" },
          currentEta: { label: "The arrival date you already hold, if any", type: "text" },
          currentEtaSource: { label: "Where that date came from", type: "text" },
          lastState: { label: "The last state you recorded", type: "text" },
          lastCheckedAt: { label: "When you last checked, ISO timestamp", type: "text" },
          force: { label: "Check now even if it is not due yet", type: "boolean" },
        },
        userInvokable: false,
      },
    ],
  },
});
