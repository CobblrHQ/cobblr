// The handlers behind the two nav actions. All the work is matching what a
// person SAID ("Spices") to what the nav holds, then calling the platform.

import { platform, ActionRefusal } from "@cobblr/platform-contract";
import { Router } from "express";
import type { ActionUndoStep } from "@cobblr/platform-contract/action-undo";
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
        throw new ActionRefusal(
          `"${name}" could be ${hit.ambiguous.map((e) => e.label).join(" or ")} — which one?`,
        );
      } else targets.push(hit);
    }
    if (missing.length) {
      throw new ActionRefusal(
        `I could not find ${missing.map((m) => `"${m}"`).join(", ")} in your navigation. ` +
          `It has: ${entries.map((e) => e.label).join(", ")}.`,
      );
    }

    // Reuse a heading of that name rather than making a second one with the
    // same label, which is indistinguishable in the nav and confusing to undo.
    const headings = await nav.listHeadings(ctx.orgId);
    const existing = headings.find((h) => h.name.toLowerCase() === heading.toLowerCase());
    // Where each one sat before, so the way back puts it there and not merely
    // at the top level.
    const was = (kind: string, id: string): string | null =>
      headings.find((h) => h.members.some((m) => m.target_kind === kind && m.target_id === id))?.name ?? null;
    const moved = targets.map((t) => ({ label: t.label, was: was(t.kind, t.id) }));
    const headingId = existing?.id ?? (await nav.createHeading(ctx.orgId, heading)).id;
    for (const t of targets) await nav.addMember(ctx.orgId, headingId, t.kind, t.id);

    return {
      ok: true,
      message: `${targets.map((t) => t.label).join(" and ")} ${targets.length === 1 ? "is" : "are"} now under ${heading}.`,
      heading: { id: headingId, name: heading, created: !existing },
      moved,
    };
  });

  platform().actions.registerHandler("core-presentation.ungroup-nav", async (ctx) => {
    const args = (ctx.args ?? {}) as { sections?: string };
    const said = splitNames(args.sections ?? "");
    if (said.length === 0) throw new Error("I need the sections to take out.");
    const nav = platform().nav;
    const entries = await nav.listEntries(ctx.orgId);
    const headings = await nav.listHeadings(ctx.orgId);
    const moved: string[] = [];
    const from: Array<{ label: string; was: string }> = [];
    for (const name of said) {
      const hit = matchEntry(name, entries);
      if (!hit || "ambiguous" in hit) continue;
      const under = headings.find((h) => h.members.some((m) => m.target_kind === hit.kind && m.target_id === hit.id))?.name;
      await nav.removeMember(ctx.orgId, hit.kind, hit.id);
      moved.push(hit.label);
      if (under) from.push({ label: hit.label, was: under });
    }
    if (moved.length === 0) throw new Error("None of those are in a heading.");
    return { ok: true, message: `${moved.join(" and ")} moved back to the top level.`, from };
  });


// Registered at import, the way every other module does it: the loader imports
// this file for its default Router, and the side effect is what puts the
  // Removing a heading nothing sits under: the tail of undoing a grouping
  // that made it. Not offered to anyone; run by Undo on the card.
  platform().actions.registerHandler("core-presentation.remove-heading", async (ctx) => {
    const id = String((ctx.args as { heading_id?: unknown } | null)?.heading_id ?? "").trim();
    if (!id) throw new Error("I need the heading's id.");
    const nav = platform().nav;
    const h = (await nav.listHeadings(ctx.orgId)).find((x) => x.id === id);
    if (!h) return { ok: true, skipped: true, reason: "already gone" };
    if (h.members.length) return { ok: false, error: `${h.name} still has sections under it.` };
    await nav.deleteHeading(ctx.orgId, id);
    return { ok: true, message: `Removed the empty ${h.name} heading.` };
  });

  // The way back for a grouping: each section to the heading it was under,
  // the ones that were under none to the top level, and a heading this run
  // made removed once empty. For an ungrouping: back under the headings.
  const grouped = (by: Map<string, string[]>): ActionUndoStep[] =>
    [...by].map(([heading, labels]) =>
      heading
        ? { action_id: "core-presentation:group-nav", args: { heading, sections: labels.join(", ") } }
        : { action_id: "core-presentation:ungroup-nav", args: { sections: labels.join(", ") } },
    );
  platform().actions.registerUndo("core-presentation.group-nav", (result) => {
    const r = result as { moved?: Array<{ label?: unknown; was?: unknown }>; heading?: { id?: unknown; created?: unknown } } | null;
    if (!Array.isArray(r?.moved) || !r.moved.length) return null;
    const by = new Map<string, string[]>();
    for (const m of r.moved) {
      if (typeof m.label !== "string") continue;
      const key = typeof m.was === "string" ? m.was : "";
      by.set(key, [...(by.get(key) ?? []), m.label]);
    }
    const steps = grouped(by);
    if (r.heading?.created && typeof r.heading.id === "string") {
      steps.push({ action_id: "core-presentation:remove-heading", args: { heading_id: r.heading.id } });
    }
    return steps;
  });
  platform().actions.registerUndo("core-presentation.ungroup-nav", (result) => {
    const r = result as { from?: Array<{ label?: unknown; was?: unknown }> } | null;
    if (!Array.isArray(r?.from) || !r.from.length) return null;
    const by = new Map<string, string[]>();
    for (const f of r.from) if (typeof f.label === "string" && typeof f.was === "string") by.set(f.was, [...(by.get(f.was) ?? []), f.label]);
    return by.size ? grouped(by) : null;
  });
}

// Registered at import, the way every other module does it: the loader imports
// this file for its default Router, and the side effect is what puts the
// handlers behind the actions the manifest declares.
registerHandlers();

// No HTTP surface of its own — the actions are the interface. An empty router
// keeps the loader's contract (it mounts what this exports).
export default Router();
