// Which groups a put-away walk lists, and which it leaves out and why.
//
// The walk used to read one plan's applied groups. A person accepted towels
// on one plan, the page re-planned around the bin that accept had just made,
// they accepted scissors on the new plan, and the walk over the new plan
// listed scissors alone and reported "All put away" with the towels still on
// the counter (#2897). The rule lives here, pure, so it is pinned by a test:
// every accepted group, from every plan still in play, whose items are filed
// and not yet placed; anything accepted that cannot be walked is named with
// its reason rather than dropped.

export interface QueuePlan {
  plan_id: string;
  subject: "inbox" | "entities";
  applied_group_ids: readonly string[];
  groups: ReadonlyArray<{
    id: string;
    label: string;
    item_ids: readonly string[];
    destination: { kind: string; location_id?: string; location_name?: string; location_path?: string };
  }>;
}

export interface QueueGroup {
  plan_id: string;
  group_id: string;
  label: string;
  /** Only the members still to place; a group whose members were all placed is not listed. */
  item_ids: string[];
  location_id: string;
  location_name: string;
  location_path: string;
}

export interface LeftOut {
  plan_id: string;
  group_id: string;
  label: string;
  reason: string;
}

export interface QueueInput {
  /** The plan being walked first, then the others still in play, newest first. */
  plans: readonly QueuePlan[];
  /** Items a person has confirmed placed (inbox: placed_at set; entities: the session's marks). */
  placed: ReadonlySet<string>;
  /** Inbox items that are NOT filed yet (still pending), with why the walk cannot take them. */
  unfiled: ReadonlyMap<string, string>;
  /** Inbox items that no longer exist (discarded, deleted). */
  missing?: ReadonlySet<string>;
}

export function walkQueue(input: QueueInput): { groups: QueueGroup[]; left_out: LeftOut[]; remaining: number } {
  const groups: QueueGroup[] = [];
  const left_out: LeftOut[] = [];
  const taken = new Set<string>();
  for (const plan of input.plans) {
    const applied = new Set(plan.applied_group_ids);
    for (const g of plan.groups) {
      if (!applied.has(g.id)) continue;
      const d = g.destination;
      if (d.kind !== "existing" || !d.location_id) {
        left_out.push({ plan_id: plan.plan_id, group_id: g.id, label: g.label, reason: "no destination was set" });
        continue;
      }
      // An item accepted on two plans is walked once, under the first plan
      // that lists it (the pinned one comes first).
      const members = g.item_ids.filter((id) => !taken.has(id) && !input.missing?.has(id));
      const unplaced = members.filter((id) => !input.placed.has(id));
      if (unplaced.length === 0) continue; // done, or nothing left that is this walk's
      const ready = plan.subject === "entities" ? unplaced : unplaced.filter((id) => !input.unfiled.has(id));
      const held = unplaced.filter((id) => !ready.includes(id));
      if (ready.length > 0) {
        for (const id of ready) taken.add(id);
        groups.push({
          plan_id: plan.plan_id,
          group_id: g.id,
          label: g.label,
          item_ids: ready,
          location_id: d.location_id,
          location_name: d.location_name ?? "",
          location_path: d.location_path ?? d.location_name ?? "",
        });
      }
      if (held.length > 0) {
        const reasons = [...new Set(held.map((id) => input.unfiled.get(id) ?? "not filed yet"))];
        left_out.push({
          plan_id: plan.plan_id,
          group_id: g.id,
          label: g.label,
          reason: `${held.length} not filed yet (${reasons.join("; ")})`,
        });
      }
    }
  }
  return { groups, left_out, remaining: groups.reduce((n, g) => n + g.item_ids.length, 0) };
}
