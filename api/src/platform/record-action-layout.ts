import { sql } from "kysely";
import { z } from "zod";
import { ACTION_GROUPS, RecordActionLayout, type RecordActionPins } from "@cobblr/platform-contract/action-groups";
import { meta } from "../db/meta.js";

export async function readRecordActionLayout(orgId: string, kind: string, userId?: string) {
  const [result, personal, installed] = await Promise.all([
    sql<{ state: unknown; revision: number }>`select state, revision from record_action_layouts where org_id = ${orgId}::uuid and entity_kind = ${kind}`.execute(meta),
    sql<{ state: unknown }>`select state from record_action_pins where org_id = ${orgId}::uuid and entity_kind = ${kind} and user_id = ${userId ?? null}::uuid`.execute(meta),
    meta.selectFrom("bundles").select(sql<unknown>`manifest -> 'record_actions' -> ${kind}`.as("layout")).where("org_id", "=", orgId).orderBy("installed_at").execute(),
  ]);
  const shared = result.rows[0];
  const own = personal.rows[0];
  const defaults: RecordActionLayout = { groups: [], actions: {} };
  for (const bundle of installed) {
    const parsed = RecordActionLayout.safeParse(bundle.layout);
    if (!parsed.success) continue;
    for (const group of parsed.data.groups) if (!defaults.groups.some((g) => g.id === group.id)) defaults.groups.push(group);
    for (const [id, action] of Object.entries(parsed.data.actions)) defaults.actions[id] = { ...defaults.actions[id], ...action };
  }
  const chosen = RecordActionLayout.parse(shared?.state ?? {});
  const groups = new Map(defaults.groups.map((g) => [g.id, g]));
  for (const group of chosen.groups) groups.set(group.id, group);
  for (const [id, action] of Object.entries(chosen.actions)) defaults.actions[id] = { ...defaults.actions[id], ...action };
  return { layout: { groups: [...groups.values()], actions: defaults.actions }, revision: shared?.revision ?? 0, pins: z.record(z.boolean()).parse(own?.state ?? {}) as RecordActionPins };
}

export async function setRecordActionPin(orgId: string, kind: string, userId: string, actionId: string, pinned: boolean) {
  await meta.transaction().execute(async (trx) => {
    await sql`insert into record_action_pins(org_id, entity_kind, user_id) values (${orgId}::uuid, ${kind}, ${userId}::uuid) on conflict do nothing`.execute(trx);
    const { rows } = await sql<{ state: RecordActionPins }>`select state from record_action_pins where org_id = ${orgId}::uuid and entity_kind = ${kind} and user_id = ${userId}::uuid for update`.execute(trx);
    const state = rows[0]!.state;
    if (pinned && state[actionId] !== true && Object.values(state).filter(Boolean).length >= 4) throw new Error("Four actions are already pinned. Unpin one before pinning another.");
    await sql`update record_action_pins set state = state || ${JSON.stringify({ [actionId]: pinned })}::jsonb where org_id = ${orgId}::uuid and entity_kind = ${kind} and user_id = ${userId}::uuid`.execute(trx);
  });
}

export const EditRecordActionLayout = z.object({
  kind: z.string().min(1).max(160),
  group: z.string().max(160).optional(),
  label: z.string().min(1).max(80).optional(),
  order: z.number().int().optional(),
  actions: z.array(z.string().min(1).max(160)).max(200).optional(),
  hidden: z.boolean().optional(),
  primary: z.boolean().optional(),
  layout: RecordActionLayout.optional(),
  expected_revision: z.number().int().nonnegative().optional(),
});

export async function editRecordActionLayout(orgId: string, input: z.infer<typeof EditRecordActionLayout>) {
  return meta.transaction().execute(async (trx) => {
    await sql`insert into record_action_layouts(org_id, entity_kind) values (${orgId}::uuid, ${input.kind}) on conflict do nothing`.execute(trx);
    const { rows } = await sql<{ state: unknown; revision: number }>`select state, revision from record_action_layouts where org_id = ${orgId}::uuid and entity_kind = ${input.kind} for update`.execute(trx);
    const row = rows[0]!;
    if (input.expected_revision !== undefined && input.expected_revision !== row.revision) throw new Error("The record actions changed since you opened them. Refresh before saving.");
    const before = RecordActionLayout.parse(row.state);
    const next = input.layout ?? structuredClone(before);
    if (!input.layout) {
      const group = input.group;
      if (group && (input.label || input.order !== undefined)) {
        const registered = ACTION_GROUPS.find((g) => g.id === group);
        const current = next.groups.find((g) => g.id === group);
        const g = { id: group, label: input.label ?? current?.label ?? registered?.label ?? group, order: input.order ?? current?.order ?? registered?.order ?? 100 };
        next.groups = [...next.groups.filter((g) => g.id !== group), g];
      }
      if (group && !ACTION_GROUPS.some((g) => g.id === group) && !next.groups.some((g) => g.id === group)) throw new Error("Name your new group before moving actions into it.");
      for (const id of input.actions ?? []) next.actions[id] = { ...next.actions[id], ...(group ? { group } : {}), ...(input.hidden === undefined ? {} : { hidden: input.hidden }), ...(input.primary === undefined ? {} : { primary: input.primary }) };
    }
    RecordActionLayout.parse(next);
    const revision = row.revision + 1;
    await sql`update record_action_layouts set state = ${JSON.stringify(next)}::jsonb, revision = ${revision} where org_id = ${orgId}::uuid and entity_kind = ${input.kind}`.execute(trx);
    return { before, revision };
  });
}
