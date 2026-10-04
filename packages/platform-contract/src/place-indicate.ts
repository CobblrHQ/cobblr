import { z } from "zod";
import type { ServiceCapabilityDecl } from "./services.js";

export const PLACE_INDICATE = "place.indicate";
const pixel = z.object({ segment: z.number().int().min(0).max(255), led: z.number().int().min(0).max(65534), count: z.number().int().min(1).max(1024).default(1) }).strict().refine(p => p.led + p.count <= 65535, "The LED range is too large.");
export const PlaceLight = z.discriminatedUnion("driver", [
  z.object({ connection_id: z.string().uuid(), driver: z.literal("wled"), pixels: z.array(pixel).min(1).max(2) }).strict(),
  z.object({ connection_id: z.string().uuid(), driver: z.literal("home-assistant"), entity: z.string().regex(/^light\.[a-z0-9_]+$/) }).strict(),
  z.object({ connection_id: z.string().uuid(), driver: z.literal("esphome"), entity: z.string().regex(/^light-[a-z0-9_]+$/), pixels: z.array(pixel).min(1).max(2).optional() }).strict(),
]);
export type PlaceLightMapping = z.infer<typeof PlaceLight>;
export type WledLightMapping = Extract<PlaceLightMapping, { driver: "wled" }>;
export const LightGrid = z.object({
  connection_id: z.string().uuid(), mode: z.enum(["strip", "xy"]),
  driver: z.enum(["wled", "esphome"]).default("wled"), entity: z.string().regex(/^light-[a-z0-9_]+$/).optional(),
  segment: z.number().int().min(0).max(255), start: z.number().int().min(0).max(65534),
  per_bin: z.number().int().min(1).max(1024).default(1), order: z.enum(["row-major", "serpentine"]).default("row-major"),
  column_segment: z.number().int().min(0).max(255).optional(), column_start: z.number().int().min(0).max(65534).optional(),
}).strict();
export type LightGridInput = z.input<typeof LightGrid>;
export const IndicateInput = z.object({ place: z.string().uuid(), color: z.string().regex(/^#?[0-9a-fA-F]{6}$/).optional(), duration: z.number().int().min(1).max(300).optional() }).strict();
export type PlaceIndicateInput = z.infer<typeof IndicateInput>;
export const PLACE_INDICATE_DECL: Omit<ServiceCapabilityDecl, "options_endpoint"> = {
  id: PLACE_INDICATE, version: 1, title: "Light up a place", summary: "Light the mapped bin, or its nearest lit ancestor, then turn it off. Nothing is moved.",
  effect: "signal", mode: "sync",
  input_schema: { type: "object", properties: { place: { type: "string", format: "uuid" }, color: { type: "string", pattern: "^#?[0-9a-fA-F]{6}$" }, duration: { type: "integer", minimum: 1, maximum: 300 } }, required: ["place"], additionalProperties: false },
  output_schema: { type: "object", properties: { indicated: { type: "boolean" }, place: { type: "string" }, color: { type: "string" }, duration: { type: "integer" } }, required: ["indicated", "place", "color", "duration"], additionalProperties: false },
};
