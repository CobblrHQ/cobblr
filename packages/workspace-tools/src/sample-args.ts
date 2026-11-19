// A value for every parameter a tool takes, from its schema alone: what a
// test that calls every tool needs to call one it has never heard of.
import { z } from "zod";

export function sample(schema: z.ZodTypeAny, key: string): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) return sample(schema._def.innerType, key);
  if (schema instanceof z.ZodNullable) return sample(schema.unwrap(), key);
  if (schema instanceof z.ZodEffects) return sample(schema.innerType(), key);
  if (schema instanceof z.ZodEnum) return schema.options[0];
  if (schema instanceof z.ZodLiteral) return schema.value;
  if (schema instanceof z.ZodString) {
    if (schema._def.checks.some((c) => c.kind === "uuid")) return "00000000-0000-4000-8000-000000000000";
    return key.includes("kind") ? "inventory:part" : `sample-${key}`;
  }
  if (schema instanceof z.ZodNumber) return 1;
  if (schema instanceof z.ZodBoolean) return true;
  if (schema instanceof z.ZodArray) return [sample(schema.element, key), sample(schema.element, `${key}2`)];
  if (schema instanceof z.ZodObject) return Object.fromEntries(Object.entries(schema.shape as z.ZodRawShape).map(([n, f]) => [n, sample(f, n)]));
  if (schema instanceof z.ZodUnion) return sample(schema.options[0], key);
  if (schema instanceof z.ZodRecord) return { name: "sample" };
  if (schema instanceof z.ZodUnknown || schema instanceof z.ZodAny) return "sample";
  throw new Error(`Add a sample for ${key}: ${schema._def.typeName}`);
}

/** Every parameter of a tool, sampled. */
export function sampleArgs(params: z.ZodRawShape): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([n, f]) => [n, sample(f as z.ZodTypeAny, n)]));
}
