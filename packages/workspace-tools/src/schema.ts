// zod → JSON-schema, for exactly the subset the tool registry uses (string,
// number, boolean, enum, record, array-of-primitive, optional, described).
// The MCP SDK consumes the zod shapes directly; the chat's provider adapters
// need JSON schema for native tool-calling — this converter keeps ONE source
// of truth without pulling in a schema library for six type kinds.

import { z } from "zod";

interface JsonSchema {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

function ofType(t: z.ZodTypeAny): JsonSchema {
  const d = t._def as { typeName?: string; description?: string };
  const desc = t.description ? { description: t.description } : {};
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return { ...ofType((t._def as { innerType: z.ZodTypeAny }).innerType), ...desc };
    case "ZodString":
      return { type: "string", ...desc };
    case "ZodNumber":
      return { type: "number", ...desc };
    case "ZodBoolean":
      return { type: "boolean", ...desc };
    case "ZodEnum":
      return { type: "string", enum: (t._def as { values: string[] }).values, ...desc };
    case "ZodArray":
      return { type: "array", items: ofType((t._def as { type: z.ZodTypeAny }).type), ...desc };
    case "ZodRecord":
      return { type: "object", additionalProperties: true, ...desc };
    default:
      // Anything exotic degrades to a permissive object — better than lying.
      return { type: "object", additionalProperties: true, ...desc };
  }
}

function isOptional(t: z.ZodTypeAny): boolean {
  const name = (t._def as { typeName?: string }).typeName;
  return name === "ZodOptional" || name === "ZodDefault";
}

/** JSON schema for a zod raw shape (the registry's param declarations). */
export function jsonSchemaOf(shape: z.ZodRawShape): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, t] of Object.entries(shape)) {
    properties[key] = ofType(t as z.ZodTypeAny);
    if (!isOptional(t as z.ZodTypeAny)) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}
