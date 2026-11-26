// What a person reads when a request is refused by its schema. A ZodError's own
// message is its issues as JSON, and the station page showed that whole dump
// in its alert (#9763); the first issue's message is the sentence the schema
// wrote for a person (webLink's, say).
import type { z } from "zod";

export function refusalSentence(err: z.ZodError): string {
  return err.issues[0]?.message || "That request is not valid.";
}
