// One line on an order saying how its store's own page is being followed
// (#5461): the page a Shopify order email's "View order" button opens, read
// on a schedule for each line's tracking. Never the link.

import type { OrderPage } from "../../lib/api";

/** The sentence for an order's page, or null when there is nothing to say. */
export function orderPageWords(page: OrderPage | null | undefined): string | null {
  if (!page) return null;
  const store = page.store;
  if (!page.reads_on) return `The ${store} order page is saved. This Cobblr does not read store pages, so tracking comes from the shipping emails.`;
  switch (page.state) {
    case "waiting":
      return `Following the ${store} order page: each line gets its tracking number when the store ships it.`;
    case "following":
      return `Following the ${store} order page until everything is delivered.`;
    case "done":
      return `The ${store} order page says everything is delivered.`;
    case "expired":
      return `The ${store} order page link no longer opens the order. Tracking comes from the shipping emails now.`;
    case "redacted": {
      const shipped = page.shipped_lines ? ` It says ${page.shipped_lines} ${page.shipped_lines === 1 ? "line has" : "lines have"} shipped.` : "";
      return `The ${store} order page no longer shows tracking numbers, so they come from the shipping emails now.${shipped}`;
    }
    case "unsupported":
      return `The ${store} order page is not one Cobblr can read. Tracking comes from the shipping emails.`;
    default:
      return null;
  }
}

export function OrderPageStatus({ page }: { page: OrderPage | null | undefined }) {
  const words = orderPageWords(page);
  if (!words) return null;
  return (
    <p className="text-xs text-muted" data-testid="order-page-status">
      {words}
    </p>
  );
}
