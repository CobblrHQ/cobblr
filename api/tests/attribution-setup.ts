// The nightly attribution run (#5761 A1): before each test file, empty the api's counts; after it, record
// what ran as that file's. Only when COBBLR_TEST_ATTRIBUTION_OUT names the file to append to, and then the
// suite runs one file at a time against the job's one api (vitest.config.ts), a shard of it per job
// (ci-impact.yml), so no other file's requests or jobs land in its counts.
import { appendFileSync } from "node:fs";
import { relative } from "node:path";
import { afterAll, beforeAll, expect } from "vitest";

const OUT = process.env.COBBLR_TEST_ATTRIBUTION_OUT;
const BASE = process.env.COBBLR_TEST_API ?? "http://localhost:4000";

async function take(): Promise<{ spans: Record<string, Array<[number, number]>>; loaded: string[]; boot?: boolean }> {
  const r = await fetch(`${BASE}/api/v1/test/attribution`, { method: "POST" });
  if (!r.ok) throw new Error(`attribution door: HTTP ${r.status} ${await r.text()}`);
  return (await r.json()) as { spans: Record<string, Array<[number, number]>>; loaded: string[]; boot?: boolean };
}

if (OUT) {
  let file = "";
  beforeAll(async () => {
    file = relative(`${__dirname}/..`, expect.getState().testPath ?? "").split("\\").join("/");
    // What ran before this file began: the api's own boot the first time (recorded, so a change to code
    // that runs only at boot reaches every test), else background work between files (dropped).
    const before = await take();
    if (before.boot) appendFileSync(OUT, `${JSON.stringify({ file: "<boot>", spans: before.spans, loaded: before.loaded })}\n`);
  });
  afterAll(async () => {
    const { spans, loaded } = await take();
    appendFileSync(OUT, `${JSON.stringify({ file, spans, loaded })}\n`);
  });
}
