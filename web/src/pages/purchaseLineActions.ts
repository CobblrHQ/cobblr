// The one place a purchase line's arrival actions are worked out on the page
// (platform-contract purchase-line-actions): the context is built here and
// nowhere else, so the row and its controls cannot disagree (#6219).
import { useQuery } from "@tanstack/react-query";
import { purchaseLineActions } from "@cobblr/platform-contract/purchase-line-actions";
import { api, type Order, type OrderItem } from "../lib/api";

export function usePurchaseLineActions(slug: string, order: Pick<Order, "status" | "add_to_stock">, item: Pick<OrderItem, "id" | "qty" | "received_at" | "part_id">) {
  const qty = Number(item.qty);
  // Only a line that could scan in asks whether it has a receipt line to
  // count against; the answer is the scan module's (slots null = none). A
  // line that is a pack of different things has a row too, but each of its
  // things is matched on a line of its own: nothing to scan in here, the
  // same refusal the scan session gives it. "None" is a 200 answer, so no
  // order page ever makes a request that fails (#6268).
  const asks = qty > 1 && !item.received_at && !item.part_id && order.add_to_stock !== false && order.status !== "cancelled";
  const line = useQuery({
    queryKey: ["order-line-slots", slug, "order-item", item.id],
    queryFn: async () => (await api.orderLineSlotsIfAny(slug, { order_item_id: item.id })).slots?.mode === "same",
    enabled: asks,
    retry: false,
    staleTime: 30_000,
  });
  // Asking failed is not "there is none": the button stays, and pressing it
  // says what went wrong.
  const scanLine = line.isError ? true : (line.data ?? null);
  return purchaseLineActions({
    order: { status: order.status, add_to_stock: order.add_to_stock ?? null },
    item: { qty, received_at: item.received_at ?? null, part_id: item.part_id ?? null },
    scanLine,
  });
}
