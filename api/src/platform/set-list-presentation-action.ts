import { z } from "zod";
import type { ActionInvokeContext } from "@cobblr/platform-contract";
import { registerHandler, registerUndo } from "./actions.js";
import { listOverrides, upsertOverride } from "./entity-kind-overrides.js";
import { mergeOverrideConfig } from "./override-config-merge.js";

type ListTarget = { targetKind: "entity_kind" | "instance"; targetId: string; label: string };
type FindList = (orgId: string, said: string) => Promise<ListTarget | { error: string }>;
const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => v === "" ? null : v);
const Settings = z.object({
  target: z.string().trim().min(1).optional(),
  entity_kind: z.string().trim().min(1).optional(),
  icon: text(80),
  hidden: z.boolean().optional(),
  nav_order: z.number().int().min(-2147483648).max(2147483647).nullable().optional(),
  group_label: text(160),
  top_level: z.boolean().nullable().optional(),
  item_noun: text(160),
  item_noun_plural: text(160),
});
const CONFIG_FIELDS = { group_label: "group_label", top_level: "presents_as_top_level", item_noun: "item_noun", item_noun_plural: "item_noun_plural" } as const;

export function registerSetListPresentationAction(findList: FindList): void {
  registerHandler("platform.set-list-presentation", async (ctx: ActionInvokeContext) => {
    const parsed = Settings.safeParse(ctx.args ?? {});
    if (!parsed.success) return { ok: false, error: "Check the presentation settings: use text for names, true or false for switches, and a whole number for navigation order." };
    const args = parsed.data;
    const said = args.target || args.entity_kind;
    if (!said) return { ok: false, error: "Which list would you like to change? Give its name or kind ID." };
    const found = await findList(ctx.orgId, said);
    if ("error" in found) return { ok: false, error: found.error };
    const stored = (await listOverrides(ctx.orgId)).find((o) => o.target_kind === found.targetKind && o.target_id === found.targetId);
    const before: Record<string, unknown> = {};
    const config: Record<string, unknown> = {};
    if (args.icon !== undefined) before.icon = stored?.icon ?? null;
    if (args.hidden !== undefined) before.hidden = stored?.hidden ?? false;
    if (args.nav_order !== undefined) before.nav_order = stored?.nav_order ?? null;
    for (const [arg, key] of Object.entries(CONFIG_FIELDS) as Array<[keyof typeof CONFIG_FIELDS, string]>) {
      if (args[arg] === undefined) continue;
      before[arg] = stored?.config?.[key] ?? null;
      config[key] = args[arg];
    }
    if (!Object.keys(before).length) return { ok: false, error: "Choose at least one presentation setting to change." };
    await upsertOverride({
      orgId: ctx.orgId,
      targetKind: found.targetKind,
      targetId: found.targetId,
      icon: args.icon,
      hidden: args.hidden,
      navOrder: args.nav_order,
      ...(Object.keys(config).length ? { config: mergeOverrideConfig(stored?.config, config) } : {}),
    });
    return { ok: true, summary: `Presentation saved for ${found.label}.`, data: { target: found.targetId, before } };
  });
  registerUndo("platform.set-list-presentation", (result) => {
    const data = (result as { data?: { target?: unknown; before?: unknown } } | null)?.data;
    if (typeof data?.target !== "string" || !data.before || typeof data.before !== "object") return null;
    return { action_id: "platform:set-list-presentation", args: { ...data.before, target: data.target } };
  });
}
