// Every migration that shapes the production test tables, in order, found by
// what it touches rather than listed: a test that named its own files kept
// running against the schema as it was the day it was written.
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../../migrations/", import.meta.url);

export async function applyProductionSchema(pg) {
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const text = readFileSync(new URL(file, dir), "utf8");
    if (text.includes("digifab_test_")) await pg.exec(text);
  }
}
