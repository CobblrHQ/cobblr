// The web's api client (web/src/lib/api.ts) and whether anything calls each
// of its methods. One reading of "called", for the lint that fails an
// uncalled method (lint-api-client-reachable) and the one that asks whether a
// screen offers a route (lint-ui-reach): a method nothing calls is a door no
// screen opens, and the two must not disagree about which those are.
import { readOnce } from "./read-once.ts";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const API_CLIENT = "web/src/lib/api.ts";
const ROOTS = ["web/src", "packages/platform-web/src", "modules"];

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx|mjs)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p;
  }
}

/** A method's line: two spaces, its name, a colon, then its function. */
export const METHOD_LINE = /^ {2}([a-zA-Z0-9_]+): (?:\(|async \(|<)/;

export function apiClientMethods(src = readOnce(API_CLIENT)): string[] {
  return src.split("\n").flatMap((l) => l.match(METHOD_LINE)?.[1] ?? []);
}

/** Every source that could call the client, the client itself excepted. */
export function callerCorpus(): string {
  let corpus = "";
  for (const root of ROOTS) for (const f of walk(root)) if (!f.endsWith(API_CLIENT)) corpus += readOnce(f) + "\n";
  return corpus;
}

// `api` and its method may sit on two lines (a chained call formatted as
// api\n  .organizePlan(...)): the plan sheet's call read as no call at all
// once the one-line warm callers moved off it (#6702).
/** `api.name`, or `name` handed on as a value (`queryFn: name,`). */
export const isCalled = (name: string, corpus: string): boolean =>
  new RegExp(`\\bapi\\s*\\??\\.\\s*${name}\\b`).test(corpus) || new RegExp(`\\b${name}\\b\\s*[,)}]`).test(corpus);
