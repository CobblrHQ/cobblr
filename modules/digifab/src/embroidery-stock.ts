import { z } from "zod";
import { platform, type ActionInvokeContext } from "@cobblr/platform-contract";
import { normaliseActionResult } from "@cobblr/platform-contract/action-result";
import { ReviewRequired } from "./drivers/job-review.js";
import { threadChart } from "./embroidery-chart.js";
export const ThreadSpool = z.object({
  id: z.string().uuid(),
  kind: z.string(),
  name: z.string(),
  revision: z.number().int().nonnegative(),
  remaining: z.number().finite().nonnegative(),
  unit: z.enum(["m", "g"]),
  config: z.object({
    shape: z.literal("spool"),
    unit: z.enum(["m", "g"]),
    grams_per_m: z.number().finite().positive().optional(),
  }),
  color: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .nullable(),
  brand: z.string(),
  code: z.string(),
});
export type ThreadSpool = z.infer<typeof ThreadSpool>;
export function stockContext(
  orgId: string,
  userId: string | null,
  fields: Record<string, unknown>,
  entity?: {
    kind: string;
    id: string;
  },
): ActionInvokeContext {
  return {
    orgId,
    userId,
    entity,
    args: { fields },
    event: {
      name: null,
      payload: {},
      actor: { user_id: userId, display_name: null, auth_method: "session" },
      timestamp: new Date().toISOString(),
      trigger_type: "user-invoked",
    },
  };
}
export async function threadSpool(
  orgId: string,
  id: string,
): Promise<ThreadSpool> {
  const entity = await platform().entities.lookup(orgId, "inventory:part", id);
  if (!entity || entity.retired)
    throw new ReviewRequired("Choose an available thread spool in Inventory.");
  const fields = entity.fields,
    stock = z
      .object({
        shape: z.literal("spool"),
        revision: z.number().int().nonnegative(),
        remaining: z.number().finite().nonnegative(),
        unit: z.enum(["m", "g"]),
        config: ThreadSpool.shape.config,
      })
      .safeParse(fields.stock);
  if (!stock.success)
    throw new ReviewRequired(
      "Configure this thread as spool stock in Inventory.",
    );
  const metadata = (
      fields.metadata && typeof fields.metadata === "object"
        ? fields.metadata
        : {}
    ) as Record<string, unknown>,
    f = { ...metadata, ...fields };
  const brand = String(f.thread_brand ?? f.brand ?? ""),
    code = String(f.thread_code ?? f.colour_code ?? ""),
    chart = threadChart.find(
      (c) => c.brand.toLowerCase() === brand.toLowerCase() && c.code === code,
    );
  const color = z
    .string()
    .regex(/^#[0-9a-f]{6}$/i)
    .safeParse(f.thread_color ?? f.color ?? f.colour ?? chart?.color);
  return ThreadSpool.parse({
    id,
    kind: entity.kind,
    name: entity.title,
    ...stock.data,
    color: color.success ? color.data : null,
    brand,
    code,
  });
}
export function spoolMetres(spool: ThreadSpool): number {
  if (spool.unit === "m") return spool.remaining;
  if (!spool.config.grams_per_m)
    throw new ReviewRequired(
      "Set grams per metre for thread measured in grams before preparing this run.",
    );
  return spool.remaining / spool.config.grams_per_m;
}
export function groupedThreadUse(
  mapping: Record<string, ThreadSpool>,
  usage: {
    index: number;
    metres: number;
  }[],
): {
  spool: ThreadSpool;
  metres: number;
}[] {
  const grouped = new Map<
    string,
    {
      spool: ThreadSpool;
      metres: number;
    }
  >();
  for (const use of usage) {
    const spool = mapping[String(use.index)];
    if (!spool)
      throw new ReviewRequired(
        "Every colour stop needs its original thread spool.",
      );
    const row = grouped.get(spool.id) ?? { spool, metres: 0 };
    row.metres = Math.round((row.metres + use.metres) * 1e9) / 1e9;
    grouped.set(spool.id, row);
  }
  return [...grouped.values()];
}
export async function threadStock(
  orgId: string,
  asked: {
    limit: number;
    offset: number;
    q?: string;
  },
) {
  const answer = await platform().actions.invoke(
    "inventory:list-stock",
    stockContext(orgId, null, { ...asked, shape: "spool" }),
  );
  const out = normaliseActionResult(answer, "inventory:list-stock");
  if (!out.ok)
    throw new ReviewRequired(
      "Enable Inventory and configure your thread spools first.",
    );
  const page = z
    .object({
      items: z.array(z.object({ id: z.string().uuid() })),
      total: z.number(),
      complete: z.boolean(),
    })
    .parse(out.data);
  return {
    ...page,
    items: await Promise.all(
      page.items.map((item) => threadSpool(orgId, item.id)),
    ),
  };
}
const rgb = (color: string) =>
  [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16));
export function nearestThreads(
  color: string | null,
  owned: ThreadSpool[],
  brand = "",
  code = "",
) {
  const target = color ? rgb(color) : null;
  return owned
    .filter((s) => s.remaining > 0 && s.color)
    .map((spool) => ({
      spool,
      exact:
        !!code &&
        spool.code === code &&
        spool.brand.toLowerCase() === brand.toLowerCase(),
      distance: target
        ? Math.sqrt(
            rgb(spool.color!).reduce((n, v, i) => n + (v - target[i]!) ** 2, 0),
          )
        : null,
    }))
    .sort(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        (a.distance ?? Infinity) - (b.distance ?? Infinity) ||
        a.spool.name.localeCompare(b.spool.name),
    )
    .slice(0, 3);
}
