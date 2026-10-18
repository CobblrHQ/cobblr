// The web's api client (web/src/lib/api/*.ts, one file per area behind the
// web/src/lib/api.ts barrel, #7364) and whether anything calls each
// of its methods. One reading of "called", for the lint that fails an
// uncalled method (lint-api-client-reachable) and the one that asks whether a
// screen offers a route (lint-ui-reach): a method nothing calls is a door no
// screen opens, and the two must not disagree about which those are.
import { readOnce } from "./read-once.ts";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const API_CLIENT = "web/src/lib/api.ts";
export const API_CLIENT_DIR = "web/src/lib/api";
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

/** The client's files: the barrel and every area file under it. */
export function apiClientFiles(): string[] {
  // A tree from before the split (a test fixture) has the barrel alone.
  if (!existsSync(API_CLIENT_DIR)) return [API_CLIENT];
  return [API_CLIENT, ...readdirSync(API_CLIENT_DIR).filter((n) => /\.ts$/.test(n) && !/\.test\.ts$/.test(n)).sort().map((n) => `${API_CLIENT_DIR}/${n}`)];
}

export const isApiClientFile = (f: string): boolean => f === API_CLIENT || (f.startsWith(`${API_CLIENT_DIR}/`) && !f.slice(API_CLIENT_DIR.length + 1).includes("/"));

export function apiClientMethods(src = apiClientFiles().map((f) => readOnce(f)).join("\n")): string[] {
  return src.split("\n").flatMap((l) => l.match(METHOD_LINE)?.[1] ?? []);
}

/** Every source that could call the client, the client itself excepted. */
export function callerCorpus(): string {
  let corpus = "";
  for (const root of ROOTS) for (const f of walk(root)) if (!isApiClientFile(f)) corpus += readOnce(f) + "\n";
  return corpus;
}

// `api` and its method may sit on two lines (a chained call formatted as
// api\n  .organizePlan(...)): the plan sheet's call read as no call at all
// once the one-line warm callers moved off it (#6702).
/** `api.name`, or `name` handed on as a value (`queryFn: name,`). */
export const isCalled = (name: string, corpus: string): boolean =>
  new RegExp(`\\bapi\\s*\\??\\.\\s*${name}\\b`).test(corpus) || new RegExp(`\\b${name}\\b\\s*[,)}]`).test(corpus);
