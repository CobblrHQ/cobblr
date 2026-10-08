// A Shopify store's partial-shipment notice, as a person forwards it from
// their own mailbox (#5351): order #36772, one of its three filament bundles,
// shipped by Amazon Logistics. The store's own address is in the forwarded
// header only; the email arrives from the person who forwarded it.

export const KINGROON_SHIPPING_NOTICE = {
  from_email: "maker@example.org",
  subject: "Fwd: One item in your order is on the way",
  text: [
    "---------- Forwarded message ---------",
    "From: KINGROON 3D <store+68291010889@t.shopifyemail.com>",
    "Date: Wed, Oct 8, 2026 at 11:02 AM",
    "Subject: One item in your order is on the way",
    "To: <maker@example.org>",
    "",
    "",
    "KINGROON 3D",
    "",
    "Order #36772",
    "",
    "One item in your order is on the way",
    "",
    "One item in your order is on the way. Track your shipment to see the delivery status.",
    "",
    "Track your shipment",
    "",
    "or Visit our store",
    "",
    "Amazon Logistics US tracking number: TBA335321582286",
    "",
    "Items in this shipment",
    "",
    "KINGROON PETG Filament 1.75mm × 1",
    "US / 10KG / Multicolor",
    "",
    "If you have any questions, reply to this email or contact us at support@example.com",
    "",
  ].join("\n"),
};

/** The three lines the order was imported with, as its receipt named them. */
export const KINGROON_ORDER_LINES = [
  { description: "KINGROON PETG Filament 1.75mm US / 10KG / Multicolor", qty: 1, unit_price: 129.99 },
  { description: "KINGROON PETG Filament 1.75mm US / 10KG / Black", qty: 1, unit_price: 119.99 },
  { description: "KINGROON PLA Filament 1.75mm US / 10KG / White", qty: 1, unit_price: 109.99 },
];
