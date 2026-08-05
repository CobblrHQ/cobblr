#!/usr/bin/env tsx
// The scanner never files. It only ever reaches the scan inbox.
//
// the author has had to restate this three times (2026-08-03, 2026-08-04, and the
// ruling on 2026-08-05) because the act kept coming back wearing a new label:
// first the matchmaker "ADD TO" chips on the barcode sheet, then — after those
// were removed — the capture drawer's "Confirm", which quietly POSTed
// confirmScanItem with the matchmaker's first candidate. Same act, different
// word. Filing is a decision made in the INBOX, where you can see everything at
// once and change your mind; the camera's job ends at capture.
//
// So no camera-side surface may call confirmScanItem. The inbox surfaces that
// legitimately file (ScanPage, WhatToDoPanel, OrganizePlanSheet) are untouched.
//
// The ONE exception is a deep link: opening the camera from a table's own
// "scan into this" (?into=) means the destination was the user's decision
// BEFORE the scan, so ScanResultModal's commit path may act on it.
//
//   cd <repo> && npx tsx scripts/lint-scanner-never-files.ts
//
// Local + CI, free, zero deps.

import { readFileSync } from "node:fs";

/** Camera-side surfaces: everything reachable while the viewfinder is live. */
const CAMERA_SURFACES = [
  "web/src/pages/ScanCameraPage.tsx",
  "web/src/pages/ScanCaptureDrawer.tsx",
];
/** The filing calls a camera surface must not make. */
const FILING_CALLS = /\b(confirmScanItem|commitScanItem)\b/;

const failures: string[] = [];
for (const file of CAMERA_SURFACES) {
  let src: string;
  try {
    src = readFileSync(file, "utf8");
  } catch {
    failures.push(`${file} is missing — update this lint's surface list.`);
    continue;
  }
  src.split("\n").forEach((line, i) => {
    if (!FILING_CALLS.test(line)) return;
    if (/^\s*(\/\/|\*)/.test(line)) return; // a comment explaining the rule is fine
    failures.push(
      `${file}:${i + 1} files from a camera surface: ${line.trim()}\n` +
        `    → the scanner only reaches the scan inbox; routing happens there.\n` +
        `      (A ?into= deep link is the one exception, and it lives in ScanResultModal.)`,
    );
  });
}

if (failures.length) {
  console.error(`[lint:scanner-never-files] ✗ ${failures.length} violation(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log("[lint:scanner-never-files] ✓ no camera surface files an item");
