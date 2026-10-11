// What's still here? on a saved view of stock (a Groceries "What's on hand"):
// a stocktake of exactly the records the view is showing. Contributed by
// inventory onto its views through the view-toolbar seam, so the view page
// never names inventory.
import { useMemo } from "react";
import { countOf } from "@cobblr/platform-contract/plural";
import { InventoryApi, WhatsStillHereButton } from "@cobblr/inventory/ui";
import type { ViewToolbarCtx } from "@cobblr/platform-web";
import { getToken } from "../../lib/api";

export function StocktakeViewControl({ ctx }: { ctx: ViewToolbarCtx }) {
  const inventory = useMemo(() => new InventoryApi(ctx.slug, { getToken }), [ctx.slug]);
  return (
    <WhatsStillHereButton api={inventory} slug={ctx.slug} scope={{ ids: ctx.ids }} label={`the ${countOf(ctx.ids.length, "thing")} in ${ctx.viewName}`} fixedLabel className="text-xs text-accent hover:underline">
      What's still here?
    </WhatsStillHereButton>
  );
}
