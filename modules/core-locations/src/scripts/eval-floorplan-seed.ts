// Eval for the floor-plan describe-to-seed (docs/design-decisions/location-floor-plan.md).
//   npx tsx modules/core-locations/src/scripts/eval-floorplan-seed.ts
//
// The seed needs platform().ai + a configured provider, so this is a live
// API-level eval (the test-match-template convention): it creates a throwaway
// location in the target workspace, runs /floorplan/seed with dry_run (writes
// NOTHING), asserts the drafted geometry against the canonical fixture — the
// description given verbatim — then deletes the throwaway location.
//
// Env: COBBLR_API (default http://localhost:4000/api/v1),
//      COBBLR_TOKEN + COBBLR_SLUG (a cbt_ token + workspace with AI resolving).
// Exits 0 with a clear message when unset / no AI — never hard-fails a box
// that can't run it.

const API = process.env.COBBLR_API ?? "http://localhost:4000/api/v1";
const TOKEN = process.env.COBBLR_TOKEN ?? "";
const SLUG = process.env.COBBLR_SLUG ?? "";

// The canonical fixture — reported 2026-07-09, verbatim.
// Fixture includes the furniture sentence ON PURPOSE: the model must resist
// drafting the rack/toolboxes/bench as zones (verified live 2026-07-09 — it
// did), so the no-furniture assertion has teeth.
const DESCRIPTION =
  "The garage is 3 bays wide. It is 24ft deep. Bays 1+2 are open to each other " +
  "and total 22ft wide. Then there is a partition wall and bay 3 is 11ft wide. " +
  "so our outer bound is a 24ft deep by 33ft wide rect. inside we have elements " +
  "that are largely against the walls: grey metal rack, HF blue 6 drawer tool box, " +
  "HF blue 5 drawer toolbox, HF 72 inch red toolbox, hooks on a different wall for " +
  "ladders to hang on, a small work table with a bandsaw on it.";

const FT = 304.8;
const EXPECT = {
  w_mm: 33 * FT, // 10058
  d_mm: 24 * FT, // 7315
  wall_x: 22 * FT, // 6706 — the partition
  bay3_w: 11 * FT, // 3353
};

function within(actual: number, expected: number, tol: number): boolean {
  return Math.abs(actual - expected) <= tol;
}

interface Draft {
  placements?: Array<{ name: string; rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number } }>;
  room: {
    w_mm: number;
    d_mm: number;
    walls?: Array<{ x1: number; y1: number; x2: number; y2: number; openings?: Array<{ at_mm: number; w_mm: number }> }>;
  };
  zones: Array<{ name: string; rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number } }>;
}

async function main(): Promise<void> {
  if (!TOKEN || !SLUG) {
    console.log("⚠ COBBLR_TOKEN / COBBLR_SLUG not set — cannot run the live seed eval.");
    console.log("  COBBLR_TOKEN=cbt_… COBBLR_SLUG=my-workspace npx tsx modules/core-locations/src/scripts/eval-floorplan-seed.ts");
    process.exit(0);
  }
  const H = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };
  const base = `${API}/orgs/${SLUG}/modules/core-locations/locations`;

  // Throwaway room — dry_run writes nothing to it, but the route wants an id.
  const createRes = await fetch(base, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ name: `Eval Garage ${Date.now()}`, kind: "area" }),
  });
  if (!createRes.ok) {
    console.error(`✗ could not create eval location: ${createRes.status} ${await createRes.text()}`);
    process.exit(1);
  }
  const room = (await createRes.json()) as { id: string };

  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — ${detail}`}`);
    if (!ok) failures++;
  };

  try {
    const seedRes = await fetch(`${base}/${room.id}/floorplan/seed`, {
      method: "POST",
      headers: H,
      body: JSON.stringify({ description: DESCRIPTION, dry_run: true }),
    });
    if (seedRes.status === 409) {
      console.log("⚠ no AI provider resolves in this workspace — eval skipped.");
      return;
    }
    if (!seedRes.ok) {
      console.error(`✗ seed failed: ${seedRes.status} ${await seedRes.text()}`);
      failures++;
      process.exitCode = 1; // the early return skips the summary exit — 2026-07-10 this silently exited 0 and a chain promoted past a red eval
      return;
    }
    const { draft } = (await seedRes.json()) as { draft: Draft };
    console.log("draft:", JSON.stringify(draft));

    // Room bound: 33 ft × 24 ft (±2%).
    check(
      "room ≈ 33ft × 24ft",
      within(draft.room.w_mm, EXPECT.w_mm, EXPECT.w_mm * 0.02) &&
        within(draft.room.d_mm, EXPECT.d_mm, EXPECT.d_mm * 0.02),
      `got ${draft.room.w_mm} × ${draft.room.d_mm}`,
    );

    // A vertical partition at x ≈ 22 ft (±400 mm).
    const partition = (draft.room.walls ?? []).find(
      (w) => w.x1 === w.x2 && within(w.x1, EXPECT.wall_x, 400),
    );
    check("vertical partition at ≈ 22ft", !!partition, `walls: ${JSON.stringify(draft.room.walls ?? [])}`);

    // Zones: the 22 ft open span covered (one region or bays 1+2), and a
    // bay-3 region ≈ 11 ft wide, east of the partition.
    const east = draft.zones.find(
      (z) => within(z.rect.w_mm, EXPECT.bay3_w, 500) && z.rect.x_mm >= EXPECT.wall_x - 400,
    );
    check("bay-3 region ≈ 11ft wide, east of the wall", !!east, `zones: ${JSON.stringify(draft.zones)}`);
    const westCoverage = draft.zones
      .filter((z) => z.rect.x_mm < EXPECT.wall_x - 400)
      .reduce((acc, z) => acc + z.rect.w_mm, 0);
    check(
      "open 22ft span covered by zone region(s)",
      within(westCoverage, EXPECT.wall_x, 700),
      `west zones total ${westCoverage} mm`,
    );

    // Nothing invented: no zone named after furniture.
    const furniture = draft.zones.find((z) => /rack|toolbox|bench|table|chest/i.test(z.name));
    check("no furniture drafted as zones", !furniture, `got zone "${furniture?.name}"`);

    // Placements: the named furniture drafts as PLACEMENTS instead — at least
    // the rack and the work table, every rect inside the room.
    const placements = (draft as { placements?: Array<{ name: string; rect: { x_mm: number; y_mm: number; w_mm: number; d_mm: number } }> }).placements ?? [];
    check(
      "≥4 placements incl. rack + work table",
      placements.length >= 4 &&
        placements.some((p) => /rack/i.test(p.name)) &&
        placements.some((p) => /table|bench/i.test(p.name)),
      `placements: ${JSON.stringify(placements.map((p) => p.name))}`,
    );
    const outOfBounds = placements.find(
      (p) =>
        p.rect.x_mm + p.rect.w_mm > draft.room.w_mm + 100 ||
        p.rect.y_mm + p.rect.d_mm > draft.room.d_mm + 100,
    );
    check("every placement inside the room", !outOfBounds, `out: ${JSON.stringify(outOfBounds)}`);
  } finally {
    await fetch(`${base}/${room.id}`, { method: "DELETE", headers: H }).catch(() => {});
  }

  console.log(failures === 0 ? "\nPASS" : `\nFAIL — ${failures} assertion(s)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
