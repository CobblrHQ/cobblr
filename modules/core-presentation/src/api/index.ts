// The handlers behind the two nav actions. All the work is matching what a
// person SAID ("Spices") to what the nav holds, then calling the platform.

import { platform } from "@cobblr/platform-contract";
import { matchEntry, splitNames } from "./match.js";

function registerHandlers(): void {
  platform().actions.registerHandler("core-presentation.group-nav", async (ctx) => {
    const args = (ctx.args ?? {}) as { heading?: string; sections?: string };
    const heading = String(args.heading ?? "").trim();
    const said = splitNames(args.sections ?? "");
    if (!heading) throw new Error("I need a name for the group.");
    if (said.length === 0) throw new Error("I need the sections to put under it.");

    const nav = platform().nav;
    const entries = await nav.listEntries(ctx.orgId);
    const targets: Array<{ kind: string; id: string; label: string }> = [];
    const missing: string[] = [];
    for (const name of said) {
      const hit = matchEntry(name, entries);
      if (!hit) missing.push(name);
      else if ("ambiguous" in hit) {
        throw new Error(
          `"${name}" could be ${hit.ambiguous.map((e) => e.label).join(" or ")} — which one?`,
        );
      } else targets.push(hit);
    }
    if (missing.length) {
      throw new Error(
        `I could not find ${missing.map((m) => `"${m}"`).join(", ")} in your navigation. ` +
          `It has: ${entries.map((e) => e.label).join(", ")}.`,
      );
    }

    // Reuse a heading of that name rather than making a second one with the
    // same label, which is indistinguishable in the nav and confusing to undo.
    const existing = (await nav.listHeadings(ctx.orgId)).find(
      (h) => h.name.toLowerCase() === heading.toLowerCase(),
    );
    const headingId = existing?.id ?? (await nav.createHeading(ctx.orgId, heading)).id;
    for (const t of targets) await nav.addMember(ctx.orgId, headingId, t.kind, t.id);

    return {
      ok: true,
      message: `${targets.map((t) => t.label).join(" and ")} ${targets.length === 1 ? "is" : "are"} now under ${heading}.`,
      heading: { id: headingId, name: heading },
    };
  });

  platform().actions.registerHandler("core-presentation.ungroup-nav", async (ctx) => {
    const args = (ctx.args ?? {}) as { sections?: string };
    const said = splitNames(args.sections ?? "");
    if (said.length === 0) throw new Error("I need the sections to take out.");
    const nav = platform().nav;
    const entries = await nav.listEntries(ctx.orgId);
    const moved: string[] = [];
    for (const name of said) {
      const hit = matchEntry(name, entries);
      if (!hit || "ambiguous" in hit) continue;
      await nav.removeMember(ctx.orgId, hit.kind, hit.id);
      moved.push(hit.label);
    }
    if (moved.length === 0) throw new Error("None of those are in a heading.");
    return { ok: true, message: `${moved.join(" and ")} moved back to the top level.` };
  });
}

import { Router } from "express";

// Registered at import, the way every other module does it: the loader imports
// this file for its default Router, and the side effect is what puts the
// handlers behind the actions the manifest declares.
registerHandlers();

// No HTTP surface of its own — the actions are the interface. An empty router
// keeps the loader's contract (it mounts what this exports).
export default Router();
