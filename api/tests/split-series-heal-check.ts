import { expect } from "vitest";
import { http, org, type TestSession } from "./helpers.js";

type Item = { id: string; suggested_name: string | null; suggested_metadata: Record<string, unknown> };

export async function checkOldSplitRows(s: TestSession): Promise<void> {
  const item = (id: string) => http<Item>(s, org(s, `/modules/core-scan/inbox/${id}`));
  const meta = (r: Item) => r.suggested_metadata ?? {};
  const importRow = async (row: Record<string, unknown>): Promise<Item> => {
    const r = await http<{ created_ids: string[] }>(s, org(s, "/modules/core-scan/import"), { method: "POST", body: [row] });
    expect(r.created_ids).toHaveLength(1);
    return item(r.created_ids[0]!);
  };
  // A parent and two children shaped like a split from before the rule:
  // the parent's series on both, no record of why.
  const parent = await importRow({
    suggested_name: "Two boxed building sets",
    x_cobblr: { metadata: { source: "vision", series: "Wicked", photo_individuals: [] } },
  });
  const oldChild = (name: string, extra: Record<string, unknown> = {}) =>
    importRow({
      suggested_name: name,
      x_cobblr: {
        metadata: {
          source: "vision-split",
          split_from: parent.id,
          series: "Wicked",
          split_inherited: { from: parent.id, name, brand: "Brickwright", fields: {}, observation: null },
          ...extra,
        },
      },
    });
  const frame = await oldChild("Brickwright Holiday Picture Frame 40702");
  const set = await oldChild("Brickwright Wicked 75684");
  // A child whose own crop was identified since: its series is its own.
  const own = await oldChild("Brickwright Holiday Picture Frame 40702 (re-identified)", { source: "vision" });
  const audit = await http<{ scanned: number; count: number; items: Array<{ id: string; series: string }> }>(s, org(s, "/modules/core-scan/inbox/split-series-audit"));
  expect(audit.count).toBe(audit.items.length);
  expect(audit.items.map((i) => i.id)).not.toContain(set.id);
  expect(audit.items.map((i) => i.id)).not.toContain(own.id);
  // A scheduled pass may already have healed the row before either request.
  const healed = await http<{ visited: number; healed: number; items: string[] }>(s, org(s, "/modules/core-scan/inbox/split-series-heal"), { method: "POST", body: {} });
  expect(healed.healed).toBe(healed.items.length);
  const after = await item(frame.id);
  expect(meta(after).series).toBeUndefined();
  expect((meta(after).split_dropped as Record<string, unknown>)?.series, "moved, not deleted").toBe("Wicked");
  expect(meta(after).split_series_judged).toBeTruthy();
  expect(meta(await item(set.id)).series, "the piece that names it keeps it").toBe("Wicked");
  expect(meta(await item(own.id)).series, "a child's own identify is its own answer").toBe("Wicked");
  // Judged rows are not visited again: the second count is empty.
  const again = await http<{ count: number; items: Array<{ id: string }> }>(s, org(s, "/modules/core-scan/inbox/split-series-audit"));
  expect(again.items.map((i) => i.id)).not.toContain(frame.id);
}
