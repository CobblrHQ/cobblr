// Check a print for failure (digifab:check-for-failure): the handler its manifest entry names. Wired in ./index.ts.
// The same single look as "check now" on the fleet card (POST /failure/:connectionId/:deviceId/check):
// one sample, nothing paused, the watch unchanged.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../../../db.js";
import { checkForFailureOnce } from "./failure.js";

export function registerCheckForFailureAction(): void {
  platform().actions.registerHandler("digifab.check-for-failure", async (ctx) => {
    const connectionId = typeof ctx.args?.connection_id === "string" ? ctx.args.connection_id.trim() : "";
    const deviceId = typeof ctx.args?.device_id === "string" ? ctx.args.device_id.trim() : "";
    if (!connectionId || !deviceId) return { ok: false, error: "Say which printer: its connection and device, as read_fabrication_floor lists them." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const r = await checkForFailureOnce(db as never, ctx.orgId, connectionId, deviceId);
    if (!r.available) return { ok: true, summary: "There was nothing to look at: no camera frame, or no model to judge it.", data: r };
    const pct = Math.round(r.probability * 100);
    return {
      ok: true,
      summary: r.would_trip ? `It looks like it is failing: ${pct} percent sure.` : `It looks fine: the chance of a failure is ${pct} percent.`,
      data: r,
    };
  });
}
