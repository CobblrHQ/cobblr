// Eval harness for hosted match-template (Phase 2).
//   npx tsx modules/core-authoring/src/scripts/test-match-template.ts
//
// The matcher needs platform().ai + a configured provider, so this is an
// API-level eval (like the e2e), not a pure unit test: it drives the live
// /match-template endpoint against a fixture set of (intent → expected
// template). The pass RATE is the gate for offering hosted match on a model
// tier (business-models/06 eval gate, 08).
//
// Degrades, never hard-fails the harness, when no AI provider is configured:
// it reports ai:false and prints the would-be accuracy as "skipped".
//
// Env: COBBLR_API (default http://localhost:4000/api/v1),
//      COBBLR_TOKEN + COBBLR_SLUG  (a cbt_ token + workspace with
//      core-authoring enabled). Falls back to a clear message if unset.

const API = process.env.COBBLR_API ?? "http://localhost:4000/api/v1";
const TOKEN = process.env.COBBLR_TOKEN ?? "";
const SLUG = process.env.COBBLR_SLUG ?? "";

// Fixtures: plain-English intent → the template id we expect as the best
// fit. Add cases as the catalog grows; keep a "none" negative (an ask no
// template fits) so we measure false-positive forcing too.
const FIXTURES: Array<{ intent: string; expect: string | null }> = [
  { intent: "track all my belongings at home for insurance", expect: "home-inventory" },
  { intent: "catalog my classic car collection and their service history", expect: "collection-and-maintenance" },
  { intent: "keep tabs on my tools and when each was last serviced", expect: "collection-and-maintenance" },
  { intent: "what plants I've put in the garden and their watering schedule", expect: "garden-tracker" },
  { intent: "my lego sets — set numbers, themes, minifigs", expect: "lego-collection" },
  { intent: "a CRM for my sales pipeline with deal stages", expect: null }, // nothing fits → expect null
];

async function main(): Promise<void> {
  if (!TOKEN || !SLUG) {
    console.log("⚠ COBBLR_TOKEN / COBBLR_SLUG not set — cannot run the live eval.");
    console.log("  Mint a cbt_ token, enable core-authoring in a workspace, then:");
    console.log("  COBBLR_TOKEN=cbt_… COBBLR_SLUG=my-workspace npx tsx modules/core-authoring/src/scripts/test-match-template.ts");
    process.exit(0);
  }
  const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

  let correct = 0;
  let aiAnswered = 0;
  let degraded = false;

  for (const f of FIXTURES) {
    const r = await fetch(`${API}/orgs/${SLUG}/modules/core-authoring/match-template`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ intent: f.intent }),
    });
    const m = (await r.json()) as { template_id: string | null; confidence: number; reason: string; ai: boolean };
    if (!m.ai) {
      degraded = true;
      console.log(`⚠ no AI provider — "${f.intent.slice(0, 40)}…" → degraded (${m.reason})`);
      continue;
    }
    aiAnswered++;
    const hit = m.template_id === f.expect;
    if (hit) correct++;
    console.log(`${hit ? "✓" : "✗"} "${f.intent.slice(0, 44)}…" → ${m.template_id ?? "null"} (want ${f.expect ?? "null"}, conf ${m.confidence})`);
  }

  if (degraded) {
    console.log(`\n==== match-template — no/partial AI provider; ${aiAnswered}/${FIXTURES.length} answered. Eval skipped, not failed. ====`);
    process.exit(0);
  }
  const rate = aiAnswered ? Math.round((correct / aiAnswered) * 100) : 0;
  console.log(`\n==== match-template — ${correct}/${aiAnswered} correct (${rate}%) ====`);
  // Gate: hosted match should clear a high bar before it's the default path.
  // 80% is a starting threshold; tune as the corpus grows.
  process.exit(rate >= 80 ? 0 : 1);
}

void main();
