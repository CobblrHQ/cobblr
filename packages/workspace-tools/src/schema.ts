// zod → JSON-schema, for the subset the tool registry uses (string, number,
// boolean, enum, literal, union, nullable, object, record, array, optional,
// described). The MCP SDK consumes the zod shapes directly; the hosted MCP
// endpoint and the chat's provider adapters need JSON schema — this converter
// keeps ONE source of truth without pulling in a schema library.

import { z } from "zod";

export interface JsonSchema {
  type?: string;
  description?: string;
  enum?: Array<string | number | boolean>;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
}

// A param the converter cannot describe is still sent, as a permissive object,
// so a model is not refused outright; `misses` names it so a test can refuse it
// at build time instead (#7589: a nullable id and a 90/180/270 choice both
// went out as "any object", and a schema-following assistant could not use them).
function ofType(t: z.ZodTypeAny, path: string, misses: string[]): JsonSchema {
  const d = t._def as { typeName?: string };
  const desc = t.description ? { description: t.description } : {};
  switch (d.typeName) {
    case "ZodOptional":
    case "ZodDefault":
      return { ...ofType((t._def as { innerType: z.ZodTypeAny }).innerType, path, misses), ...desc };
    case "ZodNullable": {
      const inner = ofType((t._def as { innerType: z.ZodTypeAny }).innerType, path, misses);
      const { description, ...rest } = inner;
      return { anyOf: [rest, { type: "null" }], ...(description ? { description } : {}), ...desc };
    }
    case "ZodString":
      return { type: "string", ...desc };
    case "ZodNumber":
      return { type: "number", ...desc };
    case "ZodBoolean":
      return { type: "boolean", ...desc };
    case "ZodEnum":
      return { type: "string", enum: (t._def as { values: string[] }).values, ...desc };
    case "ZodLiteral": {
      const value = (t._def as { value: string | number | boolean }).value;
      return { type: typeof value, enum: [value], ...desc };
    }
    case "ZodUnion": {
      const options = (t._def as { options: z.ZodTypeAny[] }).options;
      const literals = options.map((o) => (o._def as { typeName?: string; value?: unknown }));
      if (literals.every((o) => o.typeName === "ZodLiteral") && new Set(literals.map((o) => typeof o.value)).size === 1) {
        const values = literals.map((o) => o.value as string | number | boolean);
        return { type: typeof values[0], enum: values, ...desc };
      }
      return { anyOf: options.map((o, i) => ofType(o, `${path}|${i}`, misses)), ...desc };
    }
    case "ZodArray":
      return { type: "array", items: ofType((t._def as { type: z.ZodTypeAny }).type, `${path}[]`, misses), ...desc };
    case "ZodObject": {
      // Nested, the fields are what a model needs; "no others" is not worth
      // its characters on every turn (lint:tool-descriptions).
      const { additionalProperties: _closed, ...open } = objectOf((t as z.AnyZodObject).shape, path, misses);
      return { ...open, ...desc };
    }
    case "ZodRecord":
      return { type: "object", additionalProperties: true, ...desc };
    default:
      misses.push(`${path} (${d.typeName ?? "unknown"})`);
      return { type: "object", additionalProperties: true, ...desc };
  }
}

function isOptional(t: z.ZodTypeAny): boolean {
  const name = (t._def as { typeName?: string }).typeName;
  return name === "ZodOptional" || name === "ZodDefault";
}

function objectOf(shape: z.ZodRawShape, path: string, misses: string[]): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, t] of Object.entries(shape)) {
    properties[key] = ofType(t as z.ZodTypeAny, path ? `${path}.${key}` : key, misses);
    if (!isOptional(t as z.ZodTypeAny)) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false };
}

/** JSON schema for a zod raw shape (the registry's param declarations). */
export function jsonSchemaOf(shape: z.ZodRawShape): JsonSchema {
  return objectOf(shape, "", []);
}

/** The params of a shape the converter could only send as "any object". */
export function undescribedParams(shape: z.ZodRawShape): string[] {
  const misses: string[] = [];
  objectOf(shape, "", misses);
  return misses;
}
