// The record-action groups and how a record's actions are laid out in them.
// No schema library here: the browser groups actions on every record page,
// and the zod schemas the api validates a layout with live in
// action-groups-schema.ts so a page does not load them (#4945).

export const ACTION_GROUPS = [
  { id: "share", label: "Share", icon: "share-2", order: 10, meaning: "Who can see or receive this record", synonyms: ["sharing"] },
  { id: "stock", label: "Stock", icon: "boxes", order: 20, meaning: "Amounts, holdings and where things belong", synonyms: ["inventory"] },
  { id: "service", label: "Service", icon: "wrench", order: 30, meaning: "Care, repairs, schedules and matching equipment", synonyms: ["maintenance", "vehicle care"] },
  { id: "label", label: "Label", icon: "tag", order: 40, meaning: "Printed labels and identifying codes", synonyms: ["labels", "label printing", "printing labels"] },
  { id: "plan", label: "Plan", icon: "calendar", order: 50, meaning: "Projects, tasks and reservations", synonyms: ["planning"] },
  { id: "make", label: "Make", icon: "hammer", order: 60, meaning: "Making, assembling and production", synonyms: ["making", "production"] },
  { id: "buy", label: "Buy", icon: "shopping-cart", order: 70, meaning: "Purchases, orders and shopping lists", synonyms: ["purchase", "purchases", "shopping"] },
  { id: "organise", label: "Organise", icon: "folders", order: 80, meaning: "Collections, views and record organisation", synonyms: ["organize", "organisation", "organization"] },
  { id: "lifecycle", label: "Ownership", icon: "hand-coins", order: 90, meaning: "Leaving and returning to your things", synonyms: ["life cycle", "disposition"] },
  { id: "more", label: "More", icon: "ellipsis", order: 1000, meaning: "Other record actions", synonyms: ["other"] },
] as const;
export type ActionGroupId = (typeof ACTION_GROUPS)[number]["id"];
const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/s$/, "");
export function similarActionGroup(idOrLabel: string) {
  const name = normal(idOrLabel);
  return ACTION_GROUPS.find((g) => [g.id, g.label, ...g.synonyms].some((s) => normal(s) === name));
}
export function actionGroupCollision(groups: readonly { id: string; label: string; synonyms?: readonly string[] }[]) {
  for (const group of groups) for (const word of [group.id, group.label]) {
    const existing = groups.find((g) => g !== group && [g.id, g.label, ...(g.synonyms ?? [])].some((s) => normal(s) === normal(word)));
    if (existing) return { group, existing };
  }
  return undefined;
}
export interface ActionGroupDef { id: string; label: string; icon?: string; order: number; meaning?: string }
/** A kind's action layout, as stored. Its validator is RecordActionLayout in
 *  action-groups-schema.ts, which is checked to produce exactly this. */
export interface RecordActionLayout {
  groups: ActionGroupDef[];
  actions: Record<string, { group?: string; hidden?: boolean; primary?: boolean }>;
}
export type RecordActionPins = Record<string, boolean>;
export interface GroupableAction { id: string; group?: string | null; primary?: boolean }
export function groupRecordActions<T extends GroupableAction>(items: T[], layout: RecordActionLayout = { groups: [], actions: {} }, pins: RecordActionPins = {}) {
  const groups = new Map<string, ActionGroupDef>(ACTION_GROUPS.map((g) => [g.id, { ...g }]));
  for (const g of layout.groups) groups.set(g.id, g);
  const visible = items.filter((a) => !layout.actions[a.id]?.hidden);
  const primaries = visible.filter((a) => pins[a.id] ?? layout.actions[a.id]?.primary ?? a.primary ?? false).sort((a, b) => Number(pins[b.id] === true) - Number(pins[a.id] === true)).slice(0, 4);
  const primaryIds = new Set(primaries.map((a) => a.id));
  const menus = [...groups.values()].sort((a, b) => a.order - b.order).map((g) => ({ ...g, items: visible.filter((a) => {
    const requested = layout.actions[a.id]?.group ?? a.group ?? "more";
    return !primaryIds.has(a.id) && (groups.has(requested) ? requested : "more") === g.id;
  }) })).filter((g) => g.items.length);
  return { primaries, menus };
}
