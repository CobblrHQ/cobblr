// Test a failure detector (digifab:test-detector): the handler its manifest entry names. Wired in ./index.ts.
// The same reachability check as Test on a detector (POST /failure/detectors/:id/test).
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../../db.js";
import { testDetectorManifest } from "../detectors/engine.js";
import { detectorConn } from "./failure.js";

export function registerTestDetectorAction(): void {
  platform().actions.registerHandler("digifab.test-detector", async (ctx) => {
    const want = typeof ctx.args?.detector === "string" ? ctx.args.detector.trim() : "";
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const rows = await db.selectFrom("digifab_detectors").select(["id", "label"]).execute();
    if (!rows.length) return { ok: false, error: "This workspace has no failure detectors set up." };
    const named = want ? rows.filter((r) => r.id === want || r.label.toLowerCase() === want.toLowerCase()) : rows.length === 1 ? rows : [];
    if (named.length !== 1) return { ok: false, error: `Say which detector: ${rows.map((r) => r.label).join(", ")}.` };
    const row = named[0]!;
    const d = await detectorConn(db as never, ctx.orgId, row.id);
    if (!d) return { ok: false, error: `${row.label} has no address to test.` };
    const out = (await testDetectorManifest(d.manifest, d.conn.baseUrl, d.conn.apiKey)) as { ok: boolean; detail?: string; error?: string };
    const why = out.detail ?? out.error;
    // The detector's answer is the result: one that is down is a finding, not a failed action.
    return {
      ok: true,
      summary: out.ok ? `${row.label} answered.` : `${row.label} did not answer${why ? `: ${why}` : ""}.`,
      data: { detector: row.id, works: out.ok, ...(why ? { said: why } : {}) },
    };
  });
}
