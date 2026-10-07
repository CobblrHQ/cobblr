// The validators for record-action groups and layouts, apart from the groups
// themselves (action-groups.ts) so the browser, which only groups actions,
// does not load zod with them (#4945).
import { z } from "zod";
import { ACTION_GROUPS, type RecordActionLayout as StoredLayout } from "@cobblr/platform-contract/action-groups";

export const ActionGroupReference = z.string().refine((s) => ACTION_GROUPS.some((g) => g.id === s) || /^bundle:[a-z0-9-]+\/[a-z0-9-]+$/.test(s), "Use a registered group or a bundle:<bundle>/<group> id");
export const ActionGroup = z.object({ id: z.string().min(1).max(160), label: z.string().min(1).max(80), icon: z.string().max(80).optional(), order: z.number().int(), meaning: z.string().max(300).optional() });
export const RecordActionLayout = z.object({
  groups: z.array(ActionGroup).max(40).default([]),
  actions: z.record(z.object({ group: z.string().max(160).optional(), hidden: z.boolean().optional(), primary: z.boolean().optional() })).default({}),
});
export type RecordActionLayout = z.infer<typeof RecordActionLayout>;

// The validator and the stored shape are one shape, in both directions.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const agree: Same<RecordActionLayout, StoredLayout> = true;
void agree;
