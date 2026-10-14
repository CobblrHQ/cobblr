// Add several things from one photo (core-scan:add-things-from-photo, #6342):
// the assistant's and the MCP server's door onto POST /scan/assistant/photo,
// run as the person through the module's own route, so every door adds the
// pieces the same way. Its undo is Undo split on the group. Wired in ./index.ts.
import { countOf, platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";

type Answer = { error?: { message?: string }; group?: { item_id?: string; check?: string | null }; items?: Array<{ name?: string }> } & Record<string, unknown>;

/** POST one of this module's scan routes as the person who ran the action. */
export async function asThePerson(ctx: Pick<ActionInvokeContext, "orgId" | "userId">, path: string, body: unknown): Promise<{ status: number; json: Answer }> {
  const slug = (await platform().orgs.get(ctx.orgId).catch(() => null))?.slug;
  const token = ctx.userId ? await platform().auth.mintSession({ userId: ctx.userId }).catch(() => null) : null;
  if (!slug || !token) return { status: 401, json: { error: { message: "This needs a person's session; run it as someone in the workspace." } } };
  const r = await apiFetch(`${selfOrigin()}/api/v1/orgs/${slug}/modules/core-scan${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: ((await r.json().catch(() => ({}))) ?? {}) as Answer };
}

export function registerAddThingsFromPhotoAction(): void {
  platform().actions.registerHandler("core-scan.add-things-from-photo", async (ctx) => {
    const a = (ctx.args ?? {}) as { image_file_id?: unknown; item_id?: unknown; items?: unknown };
    const items = typeof a.items === "string" ? JSON.parse(a.items) : a.items;
    const r = await asThePerson(ctx, "/scan/assistant/photo", {
      ...(typeof a.image_file_id === "string" && a.image_file_id ? { image_file_id: a.image_file_id } : {}),
      ...(typeof a.item_id === "string" && a.item_id ? { item_id: a.item_id } : {}),
      items,
    });
    if (r.status >= 400) return { ok: false, error: r.json.error?.message ?? `That did not go through (${r.status}).`, ...(r.json.seen ? { data: { seen: r.json.seen, listed: r.json.listed } } : {}) };
    const n = r.json.items?.length ?? 0;
    return { ok: true, summary: `${countOf(n, "thing")} from one photo are in the inbox as one group${r.json.group?.check ? ` (${r.json.group.check})` : ""}.`, data: r.json };
  });
  // Undo split on the group puts the photo back as one.
  platform().actions.registerUndo("core-scan.add-things-from-photo", (result) => {
    const id = (result as { data?: { group?: { item_id?: unknown } } } | null)?.data?.group?.item_id;
    return typeof id === "string" ? { action_id: "core-scan:undo-split", args: { item_id: id } } : null;
  });
}
