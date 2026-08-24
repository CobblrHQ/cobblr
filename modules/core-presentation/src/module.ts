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
  version: "0.1.0",
  displayName: "Presentation",
  description:
    "The shape of your navigation: group sections under a heading, and take them out again. Lets the assistant rearrange the nav for you instead of telling you where to click.",
  icon: "layout-dashboard",
  band: "foundational",

  api: () => import("./api/index.js"),

  exposes: {
    events: [],
    api: [],
    actions: [
    {
      id: "core-presentation:group-nav",
      label: "Group nav sections",
      description:
        'Put existing nav sections under one heading, creating the heading if it does not exist. Pass `heading` (what the group is called) and `sections` (a comma-separated list of the section names as they appear in the nav, e.g. "Spices, Tea"). A section belongs to one heading at a time, so this moves it out of any other.',
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
        heading: { label: "What to call the group", type: "text" as const },
        sections: { label: "Sections to put under it, comma separated", type: "text" as const },
      },
    },
    {
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
        sections: { label: "Sections to take out, comma separated", type: "text" as const },
      },
    },
    ],
  },

  dependencies: [],
  subscribes: [],
});
