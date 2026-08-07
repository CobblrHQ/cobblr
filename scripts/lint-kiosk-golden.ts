#!/usr/bin/env tsx
// The golden guided tour is a quality FLOOR (kiosk/GOLDEN.md). Every guard below
// exists because a take was ruined without it, and every one of them is a single
// line a refactor can drop without any visible symptom until somebody records a
// video and watches raw vendor data land in the payoff shot.
//
// A doc alone could not hold this: the whole class of bug is "it still runs, the
// log still says VERIFY YES, only the pixels are wrong". So the mechanical half
// of the golden contract is asserted here.
//
//   cd <repo> && npx tsx scripts/lint-kiosk-golden.ts
//
// Local + CI, free, zero deps.

import { readFileSync } from "node:fs";

const YARN = "kiosk/guided-yarn.mjs";
const LIB = "kiosk/lib.mjs";
const FIXTURE = "kiosk/fixtures/redheart-inbox.json";

interface Check {
  file: string;
  /** Something that MUST be present. */
  needle: string | RegExp;
  why: string;
}

const CHECKS: Check[] = [
  // ── staging covers every render layer (GOLDEN invariant 1) ──
  {
    file: YARN,
    needle: /route\(\s*"\*\*\/modules\/core-scan\/scan"/,
    why: "the scan RESPONSE is staged — it renders the decode card on the camera view",
  },
  {
    file: YARN,
    needle: /route\(\s*"\*\*\/modules\/core-scan\/inbox\*\*"/,
    why: "the inbox is staged — it renders the triage form's name + fields",
  },
  {
    file: YARN,
    needle: /route\(\s*"\*\*\/modules\/core-scan\/inbox\/\*\/confirm"/,
    why:
      "the CONFIRM is staged — it resolves from the server's stored candidates, so " +
      "without it a perfect triage screen still commits a vendor listing title into the stash",
  },
  {
    file: YARN,
    needle: /route\(\s*"\*\*\/extract-pattern-file"/,
    why: "the AI extraction is staged — no live model belongs in a recording",
  },
  // ── overlay correctness (invariant 2) ──
  {
    file: YARN,
    needle: "barcode_text",
    why: "the overlay matches on barcode_text (the key that exists); a wrong key silently no-ops",
  },
  {
    file: YARN,
    needle: /replace\(\/\^0\+\/, ""\)/,
    why: "UPC-A vs EAN-13 zero-padding is normalized, or the overlay misses intermittently",
  },
  {
    file: YARN,
    needle: "suggested_candidates: INBOX_FIXTURE.suggested_candidates",
    why: "the fixture REPLACES live candidates (never defers to them — the live matchmaker wins races)",
  },
  {
    file: YARN,
    needle: "item_overlay",
    why:
      "item-level identity is rewritten too (suggested_name/manufacturer/metadata) — " +
      "the triage name field and decode card read those, not the candidates",
  },
  // ── presentation (invariants 3, 5, 6) ──
  {
    file: LIB,
    needle: "cobblr.tour.dashboard.v1",
    why: "the first-boot coach tour is suppressed — it spotlights over whatever act is playing",
  },
  {
    file: LIB,
    needle: "stageSignupEmail",
    why: "the on-camera email is a clean persona address; uniqueness happens on the wire",
  },
  {
    file: YARN,
    needle: /PRETTY_EMAIL/,
    why: "the tour types the pretty email, not a dev-looking unique one",
  },
  // ── the camera beat (invariant 4) ──
  {
    file: LIB,
    needle: /localhost\|127\\\./,
    why:
      "camera tours REFUSE a non-localhost WEB — getUserMedia needs a secure context and the " +
      "insecure-origin flag does not work under Playwright (2 ruined takes). Tunnel it instead",
  },
  // ── pacing (invariant 7) ──
  {
    file: YARN,
    needle: /Promise\.race\(\[triagePoll/,
    why: "the triage wait is BOUNDED — an unbounded one froze 79s of a cut on a single frame",
  },
  {
    file: YARN,
    needle: /skipping the triage beat/,
    why: "a not-ready beat is SKIPPED, never frozen (a missing beat is invisible; dead air is not)",
  },
];

const failures: string[] = [];
const cache = new Map<string, string>();
const read = (f: string): string => {
  if (!cache.has(f)) cache.set(f, readFileSync(f, "utf8"));
  return cache.get(f)!;
};

for (const { file, needle, why } of CHECKS) {
  let src: string;
  try {
    src = read(file);
  } catch {
    failures.push(`${file} is missing — the golden tour cannot be verified.`);
    continue;
  }
  const present = typeof needle === "string" ? src.includes(needle) : needle.test(src);
  if (!present) {
    failures.push(
      `${file}: golden guard gone — ${why}.\n    (looked for ${needle})`,
    );
  }
}

// The fixture is the single source of the curated identity; a stray extra
// candidate puts a second row in the triage list and the take stops matching.
try {
  const fx = JSON.parse(read(FIXTURE)) as {
    suggested_candidates?: unknown[];
    item_overlay?: Record<string, unknown>;
  };
  if ((fx.suggested_candidates ?? []).length !== 1) {
    failures.push(
      `${FIXTURE}: expected exactly ONE curated candidate (got ${(fx.suggested_candidates ?? []).length}).\n` +
        `    → the tour is a presentation: one clean suggestion reads best and keeps takes identical.`,
    );
  }
  if (!fx.item_overlay?.suggested_name) {
    failures.push(`${FIXTURE}: item_overlay.suggested_name is required (the triage name field reads it).`);
  }
} catch (e) {
  failures.push(`${FIXTURE} is missing or invalid JSON — the staged identity comes from it. (${(e as Error).message})`);
}

if (failures.length) {
  console.error(`[lint:kiosk-golden] ✗ ${failures.length} problem(s) — see kiosk/GOLDEN.md:`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:kiosk-golden] ✓ the golden guided tour keeps all its guards");
