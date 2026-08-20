#!/usr/bin/env tsx
// The recorded corpus must cover both kinds of model, and the shapes that go
// WRONG.
//
// Every cassette used tool_calls, which is what a first-party API key does. The
// path a subscription bridge takes - no tool support, the model writes a JSON
// move in its reply - had no fixture at all, and that is precisely where three
// stacked defects lived until a user found them (2026-08-19). A corpus made
// only of happy paths on one transport is a corpus that agrees with whatever
// the code currently does.
//
// So this asserts the corpus keeps its shape:
//   * some cassettes drive TOOLS, and some drive the TOOL-LESS move;
//   * some cassette answers are plain prose (most of what a model says is
//     English, and it must not be mistaken for a broken proposal);
//   * something covers a call that FAILS.
//
// It counts kinds, not files, so adding fixtures never fights the lint.
//
//   cd <repo> && npx tsx scripts/lint-ai-corpus-shape.ts

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "api/tests/ai-cassettes";

interface Round {
  content?: string;
  tool_calls?: Array<{ name: string }>;
}

const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
let withTools = 0;
let withMove = 0;
let prose = 0;
let failing = 0;
const problems: string[] = [];

for (const f of files) {
  let rounds: Round[] = [];
  try {
    rounds = (JSON.parse(readFileSync(join(DIR, f), "utf8")) as { rounds?: Round[] }).rounds ?? [];
  } catch (e) {
    problems.push(`${f}: not valid JSON (${(e as Error).message})`);
    continue;
  }
  if (!rounds.length) problems.push(`${f}: no rounds — it can answer nothing`);
  for (const r of rounds) {
    if (r.tool_calls?.length) {
      withTools++;
      // A round that fires a tool the registry does not have is a fixture that
      // tests nothing but its own typo.
      if (r.tool_calls.some((c) => !c.name)) problems.push(`${f}: a tool call with no name`);
      continue;
    }
    const text = (r.content ?? "").trim();
    if (!text) continue;
    if (text.includes('"type"') && text.includes("{")) withMove++;
    else prose++;
  }
  if (/fail|error|not there|without/i.test(f)) failing++;
}

if (withTools === 0) problems.push("no cassette drives a TOOL call — the first-party-key path is uncovered");
if (withMove === 0)
  problems.push(
    "no cassette drives the TOOL-LESS move (a `content` round carrying a JSON move) — the path a subscription bridge takes is uncovered, which is how the reorder defects shipped",
  );
if (prose === 0) problems.push("no cassette answers in plain prose — most of what a model says is English");
if (failing === 0) problems.push("no cassette covers something going WRONG — every bug this corpus was built for was a failure path");

if (problems.length) {
  console.error(`✗ ai-corpus lint: the recorded corpus has lost its shape.\n`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error(`
Add a cassette to ${DIR}. A round with "tool_calls" drives the tool path; a
round whose "content" carries a JSON move drives the tool-less path; a round of
plain prose is a plain answer. See that directory's README.`);
  process.exit(1);
}

console.log(
  `✓ ai-corpus lint: ${files.length} cassette(s) — ${withTools} tool round(s), ${withMove} tool-less move(s), ${prose} prose answer(s), ${failing} failure scenario(s).`,
);
