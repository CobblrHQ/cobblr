// Should a raw barcode/QR sighting FIRE a scan, or is it noise?
//
// Two jobs, both about not firing too eagerly:
//   1. AGREEMENT GATE — require the same code on two consecutive sightings before
//      accepting. The native BarcodeDetector loop runs every animation frame, and
//      a single frame can misread a barcode that isn't even in view; two-in-a-row
//      throws those away.
//   2. CONTINUOUS-PRESENCE DEDUP — a code HELD in the frame is ONE scan, not many.
//      A QR held at a location used to re-fire (and re-toast "Filing into…") every
//      couple of seconds, because the old guard measured time since we last ACTED
//      and never refreshed while the code stayed in view. Here the sighting time
//      is refreshed on every frame; `acted` records that we've handled this
//      continuous presence. Held steady → suppressed forever. It only re-scans
//      after the code LEAVES the frame for `repeatGapMs` (a gap in sightings
//      clears `acted`) and returns — the deliberate "scan it again" gesture.
//
// Pure and unit-tested. The component owns the mutable state (a ref) and the side
// effects; this decides yes/no. Extracted after a re-arm bug slipped through by
// eye: refreshing the timestamp on the return frame made the NEXT frame read as
// "still held" and suppress forever, so a code that left and came back never
// re-fired. That's exactly the kind of off-by-one a test pins down.

import { qrTokenFromUrl } from "@cobblr/platform-contract/qr-token";
import { hasUnallocatedPrefix } from "./gs1Prefix";

/** A generic web link (a product's marketing QR) that is NOT one of Cobblr's own
 *  `<host>/qr/<token>` labels. Lowest-priority sighting: a Nike box's
 *  `qr.nike.com/…` code must never beat the product barcode beside it (reported
 *  2026-07-24). A Cobblr QR is a URL too, but `qrTokenFromUrl` parses it, so it is
 *  NOT generic and keeps its priority. */
export function isGenericLink(v: string): boolean {
  return /^https?:\/\//i.test(v.trim()) && !qrTokenFromUrl(v.trim());
}

/** Priority TIER of one sighting (higher wins). Cobblr QR labels are ours and
 *  route to a bin/entity, so they lead; a retail digit-code next; then any other
 *  symbol (an alphanumeric SKU, a Code-128 label); a generic web link last, so it
 *  only wins when it is the ONLY thing in view. */
export function detectionTier(v: string): number {
  const t = v.trim();
  if (qrTokenFromUrl(t)) return 3; // Cobblr QR label
  if (/^\d{8,14}$/.test(t)) return 2; // retail UPC / EAN
  if (isGenericLink(t)) return 0; // marketing / redirect link — lowest
  return 1; // any other code (SKU, fragment)
}

/**
 * One frame can hold SEVERAL symbols — a book cover carries its main retail code
 * plus a small price-supplement barcode; a shoebox carries a UPC AND a marketing
 * QR. Feeding whichever comes first into the agreement gate made detection ORDER
 * decide the candidate, and when the order flips frame-to-frame the two-in-a-row
 * gate resets forever: "the scanner struggles with books". Pick ONE
 * deterministically by TIER (see detectionTier): a Cobblr QR beats a retail code
 * beats any other symbol beats a generic link. Within a tier the longest wins (an
 * EAN-13 main code beats a short supplement misread; a full QR URL beats a
 * fragment), then lexicographic so the same frame always picks the same code.
 */
export function pickDetection(values: string[]): string | null {
  const clean = values.map((v) => v.trim()).filter(Boolean);
  if (clean.length === 0) return null;
  if (clean.length === 1) return clean[0]!;
  return [...clean].sort((a, b) => {
    const ta = detectionTier(a);
    const tb = detectionTier(b);
    if (ta !== tb) return tb - ta;
    if (a.length !== b.length) return b.length - a.length;
    return a.localeCompare(b);
  })[0]!;
}

/** The ZXing fallback (pre-iOS-17 Safari) emits ONE result per callback, so a
 *  two-symbol cover (a book's main code + its price supplement) ALTERNATES
 *  values across callbacks and starves the agreement gate the same way
 *  multi-result native frames did. Collect the values seen within a short
 *  window and forward only the pickDetection winner, so the gate's candidate
 *  never RESETS to the supplement.
 *
 *  FORWARDS ARE PAID FOR WITH DECODES. A value may be forwarded at most as
 *  many times as the decoder actually produced it. The unlimited version
 *  turned ONE phantom read into a whole streak: a single rotated misread
 *  (6876437002726 from 859337002726) sat in the buffer as the longest
 *  same-tier value, so every subsequent callback that decoded the REAL code
 *  forwarded the phantom — the genuine sightings fed the phantom's agreement
 *  count, and requiredSightings' 4-streak defence was defeated by the very
 *  layer meant to stabilise it. With credit, a losing callback returns null:
 *  the gate simply doesn't advance that tick, which costs the real code at
 *  most the buffer window and can never promote a code beyond the number of
 *  times it was actually seen. */
export function makeDetectionCollector(
  windowMs: number,
): (value: string, now: number) => string | null {
  let buf: Array<{ value: string; at: number; credit: number }> = [];
  return (value, now) => {
    const v = value.trim();
    if (!v) return null;
    buf = buf.filter((e) => now - e.at < windowMs);
    const hit = buf.find((e) => e.value === v);
    // The cap only matters for a value that keeps LOSING (a supplement under a
    // main code): unbounded, its banked credit could outlive its presence in
    // the frame by more forwards than the window justifies.
    if (hit) {
      hit.at = now;
      hit.credit = Math.min(hit.credit + 1, 4);
    } else {
      buf.push({ value: v, at: now, credit: 1 });
    }
    const winner = pickDetection(buf.map((e) => e.value));
    const w = winner ? buf.find((e) => e.value === winner) : undefined;
    if (!w || w.credit <= 0) return null;
    w.credit -= 1;
    return winner;
  };
}

export interface DedupState {
  /** The last code we ACCEPTED, and when it was last seen in view. */
  seen: { value: string; at: number; acted: boolean } | null;
  /** The current agreement-gate candidate (a code seen once, awaiting a second). */
  candidate: { value: string; count: number } | null;
}

export function freshDedupState(): DedupState {
  return { seen: null, candidate: null };
}

/**
 * Feed one sighting. MUTATES `state` (it mirrors the component's refs) and returns
 * true when this sighting should fire a scan.
 *
 * @param repeatGapMs how long a code must be ABSENT before it counts as new.
 */
/** How many consecutive identical sightings a code needs before it fires.
 *
 *  TWO ways a code earns the longer streak, and the second was learned the hard
 *  way:
 *
 *  1. It is SHORT (under UPC-A's 12 digits: EAN-8, UPC-E, and partial-slice
 *     misreads of longer codes).
 *  2. It claims a GS1 prefix nobody has been issued. A rotated read of
 *     859337002726 produced 6876437002726 — thirteen digits, checksum-valid,
 *     sharing the last EIGHT digits with the real code (reported 2026-08-14).
 *     Being LONGER, it sailed past rule 1 on the lenient requirement of 2. Its
 *     prefix, 687, has never been allocated to anybody.
 *
 *  Rule 2 is a second net, not the answer: only about 28% of the prefix space
 *  is unallocated, so most misreads still land somewhere plausible and are
 *  caught, if at all, by having to repeat themselves. */
export function requiredSightings(code: string): number {
  if (/^\d{4,11}$/.test(code)) return 4;
  if (hasUnallocatedPrefix(code)) return 4;
  return 2;
}

export function shouldFireScan(
  state: DedupState,
  raw: string,
  now: number,
  repeatGapMs: number,
): boolean {
  const code = raw.trim();
  if (!code) return false;

  // Continuous-presence dedup, keyed on the last ACCEPTED code.
  const seen = state.seen;
  if (seen && seen.value === code) {
    if (now - seen.at >= repeatGapMs) seen.acted = false; // it left the frame + came back
    seen.at = now; // keep the sighting time alive while it's in view
    if (seen.acted) {
      state.candidate = null;
      return false;
    }
  }

  // Agreement gate: consecutive identical sightings — MORE of them for a
  // short numeric code. A diagonal scan line through part of a UPC-A can
  // decode as a DIFFERENT, checksum-valid EAN-8 (it produced "33720272" from
  // 859337002726 at ~45° — reported 2026-08-05), and the checksum can't save you
  // because the misread's checksum is genuinely valid. But such slices are
  // unstable frame to frame, while a real EAN-8 held in view repeats
  // identically — so demanding a longer streak filters the phantom and costs a
  // genuine short code only ~100ms. enrich.ts has flagged short codes as
  // collision-prone ("lowTrust") for months; this brings that knowledge to
  // the gate that actually admits scans.
  const cand = state.candidate;
  if (cand && cand.value === code) {
    cand.count += 1;
  } else {
    state.candidate = { value: code, count: 1 };
    return false;
  }
  if (cand.count < requiredSightings(code)) return false;

  state.candidate = null;
  state.seen = { value: code, at: now, acted: true };
  return true;
}
