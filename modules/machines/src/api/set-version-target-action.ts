// Set the version a cohort should run (machines:set-version-target): the handler its manifest entry names. Wired in ./index.ts.
import { platform } from "@cobblr/platform-contract";
import type { Kysely } from "kysely";
import type { MachinesDB } from "../db.js";
import { cohortsIn, readFleet } from "./versions-store.js";

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 120) : null);

export type TargetArgs = { cohort?: unknown; firmware_target?: unknown; software_target?: unknown };
export type TargetOutcome = { ok: true; cohort: string; label: string; firmware_target: string | null; software_target: string | null; summary: string } | { ok: false; error: string };

/** Set (or clear) one cohort's target in one collection. An empty target
 *  clears it; both empty removes the cohort's target. */
export async function setVersionTarget(db: Kysely<MachinesDB>, orgId: string, userId: string | null, instance: string, args: TargetArgs): Promise<TargetOutcome> {
  const asked = text(args.cohort);
  if (!asked) return { ok: false, error: "Say which cohort, as the versions page names it (for example Prusa MK4 · PrusaLink)." };
  const cohorts = await cohortsIn(db, orgId, instance);
  const key = asked.toLowerCase().replace(/\s+/g, " ");
  const label = cohorts.get(key);
  if (!label) {
    const names = [...cohorts.values()].sort();
    return { ok: false, error: names.length ? `No machines here are in "${asked}". The cohorts are: ${names.join("; ")}.` : "There are no machines here to set a target for." };
  }
  const firmware = "firmware_target" in args ? text(args.firmware_target) : undefined;
  const software = "software_target" in args ? text(args.software_target) : undefined;
  if (firmware === undefined && software === undefined) return { ok: false, error: "Say the firmware or the software version this cohort should run." };
  const had = await db.selectFrom("machines_version_targets").selectAll().where("instance", "=", instance).where("cohort", "=", key).executeTakeFirst();
  const next = { firmware_target: firmware === undefined ? had?.firmware_target ?? null : firmware, software_target: software === undefined ? had?.software_target ?? null : software };
  if (!next.firmware_target && !next.software_target) {
    await db.deleteFrom("machines_version_targets").where("instance", "=", instance).where("cohort", "=", key).execute();
  } else {
    await db.insertInto("machines_version_targets")
      .values({ instance, cohort: key, ...next, set_by: userId, updated_at: new Date() })
      .onConflict((oc) => oc.columns(["instance", "cohort"]).doUpdateSet({ ...next, set_by: userId, updated_at: new Date() }))
      .execute();
  }
  await platform().activity.log({ orgId, userId, action: "version_target_set", ref: { module: "machines", entityType: "version_target", entityId: `${instance}:${key}` }, diff: { cohort: label, ...next }, before: { firmware_target: had?.firmware_target ?? null, software_target: had?.software_target ?? null } });
  const fleet = await readFleet(db, orgId, instance);
  const counted = fleet.cohorts.find((c) => c.cohort === key);
  const wants = [next.firmware_target && `firmware ${next.firmware_target}`, next.software_target && `software ${next.software_target}`].filter(Boolean).join(" and ");
  const summary = wants ? `${label} should run ${wants}: ${counted?.summary ?? "no machines"}` : `${label} has no target now`;
  return { ok: true, cohort: key, label, ...next, summary };
}

export function registerSetVersionTargetAction(): void {
  platform().actions.registerHandler("machines.set-version-target", async (ctx) => {
    const db = (await platform().tenants.getDb(ctx.orgId)) as Kysely<MachinesDB>;
    const args = (ctx.args ?? {}) as TargetArgs;
    // The cohort is named the same in every collection; set it where it has machines.
    const instances = (await platform().instances.list(ctx.orgId)).filter((i) => i.module_name === "machines").map((i) => i.instance_name);
    const key = text(args.cohort)?.toLowerCase().replace(/\s+/g, " ");
    const holding: string[] = [];
    if (key) for (const instance of instances) if ((await cohortsIn(db, ctx.orgId, instance)).has(key)) holding.push(instance);
    if (!holding.length) return setVersionTarget(db, ctx.orgId, ctx.userId ?? null, instances[0] ?? "machines", args);
    const outcomes = [];
    for (const instance of holding) outcomes.push(await setVersionTarget(db, ctx.orgId, ctx.userId ?? null, instance, args));
    const failed = outcomes.find((o) => !o.ok);
    if (failed) return failed;
    return { ...outcomes[0]!, summary: outcomes.map((o) => (o as { summary: string }).summary).join("; ") };
  });
}
