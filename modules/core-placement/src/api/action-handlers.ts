// Action handlers — the invokable side of placement, so wires, Tier-B apps,
// and the AI surfaces (Ask Cobb / MCP, via invoke_action) can move records
// between containers without speaking the /place HTTP shape. Same semantics
// (and the same eligibility guards — platform().placement.place throws
// "placement:" errors on self/cycle/ineligible-kind):
//   - core-placement.place  — put the targeted record inside a container.
//   - core-placement.remove — take the targeted record out of its container.

import { platform } from "@cobblr/platform-contract";

let registered = false;

export function registerPlacementActionHandlers(): void {
  if (registered) return;
  registered = true;

  platform().actions.registerHandler("core-placement.place", async (ctx) => {
    const args = (ctx.args as { container_kind?: unknown; container_id?: unknown; slot?: unknown } | null) ?? {};
    const containerKind = String(args.container_kind ?? "").trim();
    const containerId = String(args.container_id ?? "").trim();
    if (!containerKind || !containerId) {
      return { ok: false, error: "container_kind and container_id are required" };
    }
    try {
      await platform().placement.place({
        orgId: ctx.orgId,
        containee: { kind: ctx.entity.kind, id: ctx.entity.id },
        container: { kind: containerKind, id: containerId },
        slot: typeof args.slot === "string" && args.slot.trim() ? args.slot.trim() : null,
        placedBy: ctx.userId ?? null,
      });
    } catch (err) {
      // Surface the eligibility guard's message (self, cycle, ineligible kind)
      // as a clean failure the invoker can relay, not a thrown 500.
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, placed_in: { kind: containerKind, id: containerId } };
  });

  platform().actions.registerHandler("core-placement.remove", async (ctx) => {
    await platform().placement.remove({
      orgId: ctx.orgId,
      containee: { kind: ctx.entity.kind, id: ctx.entity.id },
    });
    return { ok: true, removed: true };
  });
}
