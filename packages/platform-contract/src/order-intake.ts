import type { ServiceCapabilityDecl } from "./services.js";

export const ORDER_INTAKE = "orders.list";
export interface IncomingOrder {
  currency?: string;
  review?: { subject: string; text: string; ref: string; from_email?: string };
  source: string;
  ref: string;
  url?: string;
  number?: string;
  date?: string;
  shipping_address?: string;
  notes?: string;
  customer?: { name?: string; email?: string; phone?: string; address?: string };
  items: Array<{ sku?: string; description: string; qty: number; unit_price?: number }>;
}
export interface IncomingOrderPage { orders: IncomingOrder[]; cursor: string | null }
const string = { type: "string", minLength: 1, maxLength: 2000 };
export const INCOMING_ORDER_SCHEMA = {
  type: "object", required: ["source", "ref", "items"], additionalProperties: false,
  properties: {
    review: { type: "object", additionalProperties: false, required: ["subject", "text", "ref"], properties: { subject: { type: "string", maxLength: 400 }, text: { type: "string", maxLength: 20000 }, ref: { type: "string", minLength: 1, maxLength: 400 }, from_email: { type: "string", maxLength: 255 } } },
    currency: { type: "string", pattern: "^[A-Z]{3}$" },
    source: string, ref: string, number: string, date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    url: { type: "string", pattern: "^https?://", maxLength: 4000 }, shipping_address: { type: "string", maxLength: 4000 }, notes: { type: "string", maxLength: 10000 },
    customer: { type: "object", additionalProperties: false, properties: { name: string, email: string, phone: string, address: { type: "string", maxLength: 4000 } } },
    items: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", additionalProperties: false, required: ["description", "qty"], properties: {
      sku: string, description: string, qty: { type: "number", exclusiveMinimum: 0 }, unit_price: { type: "number", minimum: 0 },
    } } },
  },
};
export const ORDER_INTAKE_CAPABILITY: Omit<ServiceCapabilityDecl, "options_endpoint"> = {
  id: ORDER_INTAKE, version: 1, title: "Read incoming orders",
  summary: "Read a page of orders from your email or store. Stable source references prevent duplicates; the cursor advances only after every order is saved.",
  effect: "none", mode: "sync",
  input_schema: { type: "object", additionalProperties: false, required: ["cursor"], properties: { cursor: { type: ["string", "null"], maxLength: 4000 }, limit: { type: "integer", minimum: 1, maximum: 20 } } },
  output_schema: { type: "object", additionalProperties: false, required: ["orders", "cursor"], properties: { orders: { type: "array", maxItems: 20, items: INCOMING_ORDER_SCHEMA }, cursor: { type: ["string", "null"], maxLength: 4000 } } },
};
