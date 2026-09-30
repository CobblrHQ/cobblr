// A file read once per lint run, however many passes ask for it. The lints
// that walk every route and every screen (lint-ui-reach, the libraries it
// shares with lint-ai-reach-routes and lint-api-client-reachable) each read
// the same sources from more than one angle; the lint runner holds each to a
// read budget, so the second reading must cost nothing.
import { readFileSync } from "node:fs";

const cache = new Map<string, string>();

export function readOnce(path: string): string {
  let text = cache.get(path);
  if (text === undefined) {
    text = readFileSync(path, "utf8");
    cache.set(path, text);
  }
  return text;
}
