// Check a printer (core-print:test-printer): the handler its manifest entry names. Wired in ./index.ts.
// The same reachability check as Test on the printer settings (POST /printers/:id/test):
// it asks the printer, it never prints.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { CorePrintDB } from "../db.js";
import { configuredDriver } from "../dispatch.js";

export function registerTestPrinterAction(): void {
  platform().actions.registerHandler("core-print.test-printer", async (ctx) => {
    const want = typeof ctx.args?.printer === "string" ? ctx.args.printer.trim() : "";
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<CorePrintDB>;
    const rows = await db.selectFrom("core_print_printers").selectAll().orderBy("created_at", "asc").execute();
    if (!rows.length) return { ok: false, error: "This workspace has no printers set up." };
    // No name: the default printer, or the only one.
    const named = want
      ? rows.filter((r) => r.id === want || r.name.toLowerCase() === want.toLowerCase())
      : rows.filter((r) => r.is_default).length === 1
        ? rows.filter((r) => r.is_default)
        : rows.length === 1
          ? rows
          : [];
    if (named.length !== 1) {
      const list = rows.map((r) => r.name).join(", ");
      return { ok: false, error: want ? `No single printer called "${want}". There is ${list}.` : `Say which printer: ${list}.` };
    }
    const row = named[0]!;
    const out = await (await configuredDriver(ctx.orgId, row)).test();
    // The printer's answer is the result: one that is off is a finding, not a failed action.
    return {
      ok: true,
      summary: out.ok ? `${row.name} answered and is ready.` : `${row.name} did not answer: ${out.error ?? "no reason given"}.`,
      data: { printer: row.id, name: row.name, ready: out.ok, ...(out.error ? { said: out.error } : {}) },
    };
  });
}
