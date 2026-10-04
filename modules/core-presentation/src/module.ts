// core-presentation — the shape of the navigation, as something that can be
// DONE rather than only described.
//
// Grouping sections under a heading was a screen and nothing else: kernel
// routes, a builder on /configuration/presentation, and no action behind it.
// So the assistant, asked to put Spices and Tea under one parent, answered
// correctly and then printed "[Take user to Presentation configuration
// screen]" — a stage direction, because pointing was the most it could do. A
// capability the user can reach and Cobb cannot is half-built.
//
// This module owns no tables and no screens. It exists to put the nav shape on
// the action rail, where every other change already lives: proposed, confirmed,
// recorded in the change ledger, undoable.

import { defineModule } from "@cobblr/platform-contract";

export default defineModule({
  name: "core-presentation",
  version: "0.1.5",
  displayName: "Presentation",
  description:
    "Arrange your sidebar: group sections under a heading, and let the assistant tidy it for you.",
  icon: "layout-dashboard",
  band: "stock",
  autoEnable: true, // ambient capability — on for every workspace

  api: () => import("./api/index.js"),

  exposes: {
    events: [],
    actions: [
    {
      // NO-PHRASING: the way back for another action, run only from Undo
      group: "more",
      id: "core-presentation:remove-heading",
      internal: true,
      label: "Remove an empty heading",
      description: "Internal, the tail of undoing a grouping: removes a navigation heading nothing sits under. Runs from Undo on the card; not for direct use.",
      icon: "undo",
      scope: "workspace" as const,
      userInvokable: false,
      invokeHandler: "core-presentation.remove-heading",
      argsSchema: {
        heading_id: { label: "The heading's id", type: "text" },
      },
    },
    {
      // UI-SCREEN: /configuration/presentation
      group: "organise",
      id: "core-presentation:group-nav",
      label: "Group nav sections",
      description:
        'Put existing SIDEBAR sections (the workspace\'s lists, as they appear in the navigation) under one navigation heading, creating the heading if it does not exist. Pass `heading` (what the group is called) and `sections` (a comma-separated list of the section names as they appear in the nav, e.g. "Spices, Tea"). A section belongs to one heading at a time, so this moves it out of any other. This is the sidebar only: a heading over a kind\'s FIELDS on its form (grouping or renaming one) is platform:group-fields, not this.',
      examples: [
        "group spices and tea under Kitchen",
        "put those two lists under one heading",
        "make a nav parent to hold them",
      ],
      icon: "folder-tree",
      scope: "workspace" as const,
      // Undoable in the plainest sense: ungroup puts every section back where
      // it was, and an empty heading can be removed.
      undoable: true,
      invokeHandler: "core-presentation.group-nav",
      argsSchema: {
        heading: { label: "What to call the group", type: "text" as const, required: true },
        sections: { label: "Sections to put under it, comma separated", type: "text" as const, required: true },
      },
    },
    {
      // UI-SCREEN: /configuration/presentation
      group: "organise",
      id: "core-presentation:ungroup-nav",
      label: "Ungroup nav sections",
      description:
        'Take sections back out of their heading, so they sit at the top level again. Pass `sections` as a comma-separated list of names.',
      examples: ["ungroup spices", "take tea back out of Kitchen"],
      icon: "folder-minus",
      scope: "workspace" as const,
      undoable: true,
      invokeHandler: "core-presentation.ungroup-nav",
      argsSchema: {
        sections: { label: "Sections to take out, comma separated", type: "text" as const, required: true },
      },
    },
    ],
  },

  dependencies: [],
  subscribes: [],
});
