// The web door as a fixture: recorded once, replayed forever (#3049).
//
// The catalog doors have had this since #2992 (catalog-replay.ts): under
// COBBLR_CATALOG_REPLAY_DIR every product and book lookup reads a cassette
// and never the network. The web door did not, so a test of anything that
// reaches a search engine (a typed model number's lookup, a picture by
// name) had two choices: the live engine, which walls the address for hours
// after a burst, or COBBLR_SCAN_WEBSEARCH=0, under which the pass proves
// nothing. So the same replay dir now covers the search engine's text
// results, its image results and the photo library's, one file per query
// under <dir>/web/<kind>/. Replay does not consult the web-search switch: a
// cassette sends nothing to anyone, which is what that switch protects.
//
// Record with COBBLR_CATALOG_REPLAY_RECORD=1 on a box the engine answers:
// the live call runs and its answer is written. A query with no cassette
// under replay is an empty result, deterministically.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { catalogRecording, catalogReplayDir } from "./catalog-replay.js";

export type WebCassetteKind = "text" | "images" | "library";

/** Replaying: a replay dir is set and this is not a recording session. */
export function replayingWeb(): boolean {
  return !!catalogReplayDir() && !catalogRecording();
}

/** The file for a query: readable words, then a short hash so two queries
 *  that slug the same never share a file. */
export function webCassetteFile(kind: WebCassetteKind, query: string): string | null {
  const dir = catalogReplayDir();
  if (!dir) return null;
  const q = query.trim();
  const slug = q.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "query";
  const hash = createHash("sha1").update(q).digest("hex").slice(0, 8);
  return join(dir, "web", kind, `${slug}-${hash}.json`);
}

/** The recorded answer, or null when not replaying / nothing recorded. */
export function readWebCassette<T>(kind: WebCassetteKind, query: string): T | null {
  if (!replayingWeb()) return null;
  const file = webCassetteFile(kind, query);
  if (!file || !existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { query?: string; results?: T };
    return parsed && typeof parsed === "object" && "results" in parsed ? (parsed.results as T) : null;
  } catch {
    return null;
  }
}

/** Under a recording session, write what the live door answered. */
export function writeWebCassette<T>(kind: WebCassetteKind, query: string, results: T): void {
  if (!catalogRecording()) return;
  const file = webCassetteFile(kind, query);
  if (!file) return;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ query: query.trim(), results }, null, 2) + "\n");
  } catch (err) {
    console.warn(`[core-scan] web cassette write failed for ${JSON.stringify(query)}: ${(err as Error).message}`);
  }
}
