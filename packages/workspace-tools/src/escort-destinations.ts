export interface EscortDestination {
  id: string;
  path: string;
  label: string;
  /** Prefill keys the destination's page reads (via usePrefill) — the contract
   *  between this registry and the page. Empty = navigation only. */
  prefill: Record<string, string>;
  /** Why this surface is escort-only — surfaced to the model so it can say so. */
  why: string;
  /** Actions that ALREADY do part of what this screen is for, listed so the
   *  model is told to run them instead of escorting.
   *
   *  This exists because the `fields` entry went stale the day field editing
   *  got actions: its `why` still read "editing or deleting a field touches the
   *  data under it", and a local model duly answered "I've taken you to the
   *  Fields & forms screen" to four separate requests it could have just done
   *  (measured, 2026-08-25). An escort is the least useful answer there is when
   *  a door exists, so the doors are named here and lint:escort-claims fails
   *  when a surface gains an action and this list does not. */
  covered_by?: string[];
}

export const ESCORT_DESTINATIONS: EscortDestination[] = [
  {
    id: "members",
    path: "/configuration/members",
    label: "Members & invites",
    prefill: {
      email: "email address to prefill on the invite form",
      role: "role to preselect: member, editor, admin or guest",
    },
    why: "membership is a human decision",
  },
  {
    id: "api-tokens",
    path: "/configuration/tokens",
    label: "API tokens",
    prefill: {},
    why: "the assistant never mints or revokes credentials",
  },
  {
    id: "backup",
    path: "/configuration/backup",
    label: "Backup & restore",
    prefill: {},
    why: "a restore replaces data wholesale",
  },
  {
    id: "ai-config",
    path: "/configuration/ai",
    label: "AI providers",
    prefill: {},
    why: "the assistant does not configure its own keys",
  },
  {
    id: "wires",
    path: "/wires",
    label: "Automations (wires)",
    // The composer opens already narrowed (#6070): "message Sam when the
    // coffee runs out" is the stock event, "ran-out" and the coffee's id.
    prefill: {
      kind: "the record kind the automation is about (e.g. inventory:part or pantry:item)",
      event: "the event that runs it; a count changing is inventory.stock.changed",
      change: "for a count: used, ran-out, below (with below=N) or reorder-point",
      below: "the number for change=below",
      record: "one record's id, to narrow the automation to that record",
      record_name: "that record's name, shown in place of the id",
      category: "a category name, to narrow it to records filed under it",
      tag: "a tag name, to narrow it to records carrying it",
      view: "a shared saved view's id, to narrow it to the records the view shows",
    },
    why: "building one by hand",
    covered_by: ["platform:set-wire-enabled", "platform:add-wire", "platform:edit-wire", "platform:remove-wire"],
  },
  {
    id: "fields",
    path: "/fields",
    label: "Fields & forms",
    prefill: {},
    // The covered_by list below names what an action does instead, so the
    // why says only what the screen is still FOR (#3378 added two sweeps to
    // the list and the description hit its cap).
    why: "changing a field's type",
    covered_by: [
      "platform:add-field",
      "platform:edit-field",
      "platform:set-field-on-records",
      "platform:update-fields",
      "platform:restore-batch-field",
      "platform:remove-field",
      "platform:group-fields",
      "platform:ungroup-fields",
      "platform:set-field-preset",
      // The seller upgrade's no (#4518); its yes and the settle of two
      // same-meaning fields are found by their own examples.
      "platform:decline-seller-field",
      // Kind-wide sweeps over a field, workspace-scoped since #3378: the
      // screen shows the field, these retire it into the real Location.
      "inventory:field-to-location",
      "assets:field-to-location",
    ],
  },
];
