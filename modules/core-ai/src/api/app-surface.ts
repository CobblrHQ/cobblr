// What this app can actually do, for the assistant that lives in it.
//
// Cobb was told he knows how the app works "because you are part of it". He
// does not: no feature documentation reaches the model, so he improvised. Asked
// for a nav parent to hold some sections he answered "that is handled by
// creating a new app", inventing a mechanism while a purpose-built one sat
// unmentioned.
//
// The first fix was a hand-written list, which fixed that day and guaranteed
// the next one: a feature shipped on Tuesday is invisible until somebody
// remembers to describe it, and nobody remembers. So the list is now DERIVED
// from the app's own registry of configuration destinations
// (web/src/lib/configuration-nav.ts) - the one the configuration hub, the
// section pages, the settings sidebar and the command palette all render from,
// which therefore cannot fall behind without four visible surfaces breaking
// first. Shipping a screen is what tells Cobb the screen exists.
//
// The generated half is packages/platform-contract/src/app-surface.generated.ts
// (pnpm gen:app-surface;
// lint:app-surface fails when it is stale). EXTRAS below is for the few
// capabilities that are not destinations of their own - something you do INSIDE
// a screen - and each is checked to point at a real route.

import { GENERATED_SURFACE } from "@cobblr/platform-contract/app-surface";
import type { Capability } from "@cobblr/platform-contract/app-surface-types";

export type { Capability };

/** Capabilities that are not destinations: a thing you do inside a screen, so
 *  the registry has no row for it. Keep this SHORT - every line is one someone
 *  has to remember, which is the failure mode the generated half exists to
 *  avoid. Add one only when a real question could not be answered without it. */
export const EXTRAS: Capability[] = [
  {
    feature: "a navbar heading",
    does: "Group several nav entries under one parent. A heading is a label with no page of its own; modules and instances from anywhere can sit under it, and an entry belongs to at most one heading.",
    where: "/configuration/presentation",
    also: ["nav parent", "group sections", "folder in the sidebar"],
  },
  {
    feature: "an instance",
    does: "A second, separate list of the same kind of thing (Spices as well as Parts). Each is its own top-level nav entry by default, and can be set to nest under its module on the presentation screen.",
    where: "/configuration/new-thing",
    also: ["another list", "separate table", "specialisation"],
  },
];

export const APP_SURFACE: Capability[] = [...GENERATED_SURFACE, ...EXTRAS];

/** The block that goes in the system prompt. Kept as a function so the prompt
 *  cannot drift from the list. */
export function appSurfacePrompt(enabledModules?: ReadonlySet<string>): string {
  // A screen whose module is off is not a place this workspace can go, so
  // naming it would be the original bug wearing a badge. It also keeps the
  // block honest in size: the full list is ~1,700 tokens on every single turn,
  // and most workspaces run a fraction of the modules.
  const visible = APP_SURFACE.filter((c) => !c.module || !enabledModules || enabledModules.has(c.module));
  const lines = visible.map((c) => {
    // Two synonyms, not five: they exist so a person's word finds the feature,
    // and the rest is prompt weight for nothing.
    const also = c.also?.length ? ` (also: ${c.also.slice(0, 2).join(", ")})` : "";
    return `- ${c.feature} - ${c.does} [${c.where}]${also}`;
  });
  return `WHAT THIS APP CAN DO, and where each lives. This is the whole of what you know about the product's own features:
${lines.join("\n")}

If someone asks how to do something in the app and it is NOT in that list, say you are not sure and point them at Configuration. Never describe a mechanism you have not been told about here: inventing one sends a person looking for a screen that does not exist, which is worse than "I don't know".`;
}
