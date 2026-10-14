// Ran out (core-scan:ran-out, #6526): the scan row's Ran out, for the
// assistant and the MCP server too. "I just ran out of oat milk, I don't have
// it in Cobblr yet." A row matched to one thing you keep takes that thing to
// none (attach, mode count); any other row is filed at none (confirm). Both
// through the routes a person's tap uses, with the person's own session, so
// the same take, the same list line and the same Undo. Wired in ./index.ts.
import type { Kysely } from "kysely";
import { platform } from "@cobblr/platform-contract";
import { apiFetch, selfOrigin } from "@cobblr/platform-contract/self-api";
import type { CoreScanDB } from "../db.js";
import { ranOutPlan } from "@cobblr/platform-contract/scan-triage";
import { destinationTables, filingDestination } from "../services/destination.js";
import { assembleMergedMenu } from "../services/matchmaker.js";

type Answer = { ran_out?: { took: boolean; on_list: boolean; needs_list: boolean; note: string | null }; entity_title?: string };

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function registerRanOutAction(): void {
  platform().actions.registerHandler("core-scan.ran-out", async (ctx) => {
    const args = (ctx.args ?? {}) as Record<string, unknown>;
    const id = str(args.item_id);
    if (!id) return { ok: false, error: "Say which scan ran out: item_id." };
    if (!ctx.userId) return { ok: false, error: "Ran out is said by a person." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as unknown as Kysely<CoreScanDB>;
    const row = await db.selectFrom("core_scan_inbox_items").selectAll().where("id", "=", id).executeTakeFirst();
    if (!row) return { ok: false, error: "That scan is not in the inbox." };
    if (row.status !== "pending") return { ok: false, error: `"${row.suggested_name ?? "That scan"}" is already filed.` };
    const slug = (await platform().orgs.get(ctx.orgId).catch(() => null))?.slug ?? "";
    const token = slug ? await platform().auth.mintSession({ userId: ctx.userId }).catch(() => null) : null;
    if (!token) return { ok: false, error: "Could not act for you on this workspace." };
    const call = async (path: string, body: Record<string, unknown>) => {
      const r = await apiFetch(`${selfOrigin()}/api/v1/orgs/${slug}/modules/core-scan/inbox/${id}/${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await r.json().catch(() => ({}))) as Answer & { error?: { message?: string } };
      return r.ok ? { ok: true as const, json } : { ok: false as const, error: json.error?.message ?? `Ran out was refused (${r.status}).` };
    };

    const name = row.suggested_name ?? "It";
    const listWords = (a: Answer) =>
      a.ran_out?.on_list ? " and it is on the shopping list" : a.ran_out?.needs_list ? "; say which list it goes on" : a.ran_out?.note ? ` (${a.ran_out.note})` : "";
    // The one rule every surface reads. The confirm route refuses a table
    // with no count itself, so a named kind counts as counted here.
    const plan = ranOutPlan(row as never, { counted: true });
    if (plan.kind === "none") return { ok: false, error: `"${name}" cannot be marked Ran out: ${plan.why}.` };
    if (plan.kind === "take" && !str(args.kind)) {
      const m = plan.match;
      const r = await call("attach", { kind: m.kind, entity_id: m.id, ...(m.instance ? { instance: m.instance } : {}), mode: "count", ran_out: true });
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, summary: `${r.json.entity_title ?? name} is at none now${listWords(r.json)}.`, data: { item_id: id, ...r.json.ran_out } };
    }

    // Anything else is filed at none: where the caller says, else where the
    // row was going.
    const said = str(args.kind);
    // Where the row was going: the one destination the card shows.
    const top = said ? null : filingDestination(row as never, destinationTables(await assembleMergedMenu(selfOrigin(), slug, token, ctx.orgId).catch(() => [])));
    const kind = said || (top?.kind && top.kind.includes(":") ? top.kind : top?.module && top.kind ? `${top.module}:${top.kind}` : "");
    if (!kind) return { ok: false, error: `Say where "${name}" is kept (kind), so it can be added at none.` };
    const [module, base] = kind.split(":");
    const instance = said ? str(args.instance) : (top?.instance ?? "");
    const r = await call("confirm", { target_module: module, target_kind: base, ...(instance ? { instance } : {}), ran_out: true });
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, summary: `Added ${name} with none on hand${listWords(r.json)}.`, data: { item_id: id, ...r.json.ran_out } };
  });
}
