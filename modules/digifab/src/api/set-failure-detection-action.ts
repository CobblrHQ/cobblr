// Set print failure detection (digifab:set-failure-detection): the handler its manifest entry names. Wired in ./index.ts.
// The same write as the failure-detection settings (PUT /failure/config), less
// the backend and detector: those decide where camera frames are sent.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { DigifabDB } from "../db.js";
import { readFailureConfig } from "../failure-detect.js";
import { ConfigBody, writeFailureConfig } from "./failure.js";

const bool = (v: unknown): boolean | undefined => (v === true || v === "true" ? true : v === false || v === "false" ? false : undefined);
const num = (v: unknown): number | undefined => (v === undefined || v === null || v === "" ? undefined : Number(v));

export function registerSetFailureDetectionAction(): void {
  platform().actions.registerHandler("digifab.set-failure-detection", async (ctx) => {
    const a = (ctx.args ?? {}) as Record<string, unknown>;
    // A sureness said as a percent (70) means 0.7.
    const t = num(a.threshold);
    const change = ConfigBody.pick({ enabled: true, threshold: true, sample_interval_sec: true, auto_pause: true }).safeParse({
      ...(bool(a.enabled) !== undefined ? { enabled: bool(a.enabled) } : {}),
      ...(t !== undefined ? { threshold: t > 1 ? t / 100 : t } : {}),
      ...(num(a.sample_interval_sec) !== undefined ? { sample_interval_sec: num(a.sample_interval_sec) } : {}),
      ...(bool(a.auto_pause) !== undefined ? { auto_pause: bool(a.auto_pause) } : {}),
    });
    if (!change.success) return { ok: false, error: "Sureness is 10 to 99 percent, and how often it looks is every 5 to 600 seconds." };
    if (!Object.keys(change.data).length) return { ok: false, error: "Say what to change: on or off, how sure, how often, or whether it pauses the printer." };
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<DigifabDB>;
    const was = await readFailureConfig(db);
    const now = await writeFailureConfig(db as never, change.data);
    const before = { enabled: was.enabled, threshold: was.threshold, sample_interval_sec: was.sample_interval_sec, auto_pause: was.auto_pause };
    return {
      ok: true,
      summary: now.enabled
        ? `Failure detection is on: it calls a failure at ${Math.round(now.threshold * 100)}% sure, looks every ${now.sample_interval_sec} seconds, and ${now.auto_pause ? "pauses the printer itself" : "tells you without pausing"}.`
        : "Failure detection is off.",
      data: { before },
    };
  });
  platform().actions.registerUndo("digifab.set-failure-detection", (result) => {
    const d = (result as { ok?: unknown; data?: { before?: Record<string, unknown> } } | null);
    if (d?.ok !== true || !d.data?.before) return null;
    return { action_id: "digifab:set-failure-detection", args: d.data.before };
  });
}
