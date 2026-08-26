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

import { existsSync, readFileSync } from "node:fs";

const YARN = "kiosk/guided-yarn.mjs";
const LEGO = "kiosk/guided-lego.mjs";
const LIB = "kiosk/lib.mjs";
const FIXTURE = "kiosk/fixtures/redheart-inbox.json";
const STATIC_CHECK = "scripts/check-recording-static.mjs";
const CATALOG_ASSET = "kiosk/assets/redheart-catalog.png";

/** Every guided tour, not just the golden one.
 *
 *  This list is the fix for the reason the lego tour shipped with a 27.5-second
 *  frozen modal in it: every check in this file named YARN, so guided-lego.mjs
 *  was never held to the floor at all. A tour that is not in TOURS is a tour
 *  nobody is checking. */
const TOURS = [YARN, LEGO];

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
  // ── every tour carries the two watchdogs (invariant 8) ──
  ...TOURS.flatMap((file) => [
    {
      file,
      needle: /installLeakWatchdog\(ctx\)/,
      why:
        "the vendor-leak watchdog is installed — a published cut carried a scraped eBay listing " +
        "title in a toast even though the confirm body WAS rewritten, because the leak came " +
        "through a field nobody had staged",
    },
    {
      file,
      needle: /leaks\.assertClean\(\)/,
      why: "the take FAILS on a leak instead of quietly becoming a published file",
    },
  ]),
  {
    file: LIB,
    needle: /export async function softly\(/,
    why:
      "softly() exists — a swallowed tour step needs a budget and a log line, or it burns " +
      "Playwright's 30s default on camera and erases the evidence",
  },
  {
    file: STATIC_CHECK,
    needle: /DEFAULT_MAX_STATIC/,
    why: "the pixel-level dead-air check exists — the log saying VERIFY YES is not evidence",
  },
  // ── the scanned card shows BOTH pictures (invariant 12) ──
  {
    file: YARN,
    needle: /catalog\.kiosk\.invalid/,
    why:
      "the catalog photo is served from kiosk/assets, not the live web — a scanned product must show " +
      "the catalog picture BESIDE the shot you took, and fetching it from the open web each run is how " +
      "a scraped listing title reached a published cut",
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

// ── the rule that would have caught the 27.5-second freeze at authoring time ──
//
// `await thing.click().catch(() => {})` inherits Playwright's THIRTY-SECOND
// default actionTimeout, and the catch destroys the evidence. That is how a
// two-button KIND control being driven with selectOption() became half a minute
// of dead air in a published file while the run log still said VERIFY YES. Two
// more calls in the same tour and two in the golden one had the same shape.
//
// So: a swallowed locator action must carry an explicit timeout. Comments are
// skipped (this file's own prose describes the bad pattern), as is
// page.keyboard.* (no element, so no actionability wait to blow).
const ACTION = /\.(?:click|dblclick|tap|fill|selectOption|selectText|check|uncheck|press|hover|focus|setInputFiles|scrollIntoViewIfNeeded|waitFor)\(/;
for (const file of [...TOURS, LIB]) {
  let src: string;
  try {
    src = read(file);
  } catch {
    continue; // the missing-file failure is already recorded above
  }
  src.split("\n").forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
    if (!code.includes(".catch(() => {})")) return;
    if (!ACTION.test(code)) return;
    if (/keyboard\./.test(code) || /\.evaluate\(/.test(code) || /\broute\./.test(code)) return;
    if (/timeout/.test(code)) return;
    failures.push(
      `${file}:${i + 1}: swallowed action with no timeout — it can block for Playwright's 30s\n` +
        `    default and the catch hides it (27.5s of one frozen modal shipped this way).\n` +
        `    → wrap it in softly(...) or pass an explicit { timeout }.\n` +
        `    ${code.slice(0, 110)}`,
    );
  });
}

// ── controls that are no longer <select>s ──
//
// selectOption() on anything but a <select> never becomes actionable, so it does
// not fail fast — it burns the full actionTimeout and then throws into whatever
// catch is nearby. KIND was a <select> when the tours were written and is now two
// buttons. (PARENT in the same modal is still a real <select>, verified against a
// live instance — the tree picker on that page is a different control. Check the
// DOM before adding a row here; a wrong entry costs a take.)
const NOT_SELECTS: Array<{ re: RegExp; what: string }> = [
  { re: /getByLabel\(\/kind\/i\)\s*\.selectOption/, what: "the location modal's KIND control is two <button>s, not a dropdown" },
];
for (const file of TOURS) {
  let src: string;
  try {
    src = read(file);
  } catch {
    continue;
  }
  for (const { re, what } of NOT_SELECTS) {
    if (re.test(src)) {
      failures.push(`${file}: selectOption on a control that is not a <select> — ${what}.\n    → drive the real control; this call stalls for the whole actionTimeout.`);
    }
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
  // The card renders catalog + yours side by side only when BOTH exist. Without
  // this the beat silently degrades to one big barcode photo, which is what the
  // published cut showed.
  const catalogUrl = (fx.item_overlay as Record<string, unknown> | undefined)?.catalog_image_url;
  if (typeof catalogUrl !== "string" || !catalogUrl) {
    failures.push(`${FIXTURE}: item_overlay.catalog_image_url is required — without it the scanned card shows only the barcode photo.`);
  } else if (!/^https:\/\/catalog\.kiosk\.invalid\//.test(catalogUrl)) {
    failures.push(`${FIXTURE}: catalog_image_url must point at the staged host (got ${catalogUrl}) — a live URL puts the take back on the open web.`);
  }
  if (!existsSync(CATALOG_ASSET)) {
    failures.push(`${CATALOG_ASSET} is missing — the staged catalog route serves this file.`);
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
