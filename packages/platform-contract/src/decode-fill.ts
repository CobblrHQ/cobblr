import { type DecodeRole, parseDecodeRole } from "@cobblr/platform-contract/decode-role";

// ─────────────── Decode field-role vocabulary (P3) ────────────────
//
// The generalization seam of the identifier-decoder registry (VIN is its only
// current consumer). A decoder emits a flat bag of SEMANTIC keys (a VIN decode →
// { year, make, model, body, fuel_type, trim }); a bundle DECLARES which field
// holds the identifier and which fields receive each decoded key, by ROLE — so
// the fill no longer depends on a field being named "Make" in English. Two
// shapes, both carried in a single `decode_role` string:
//
//   identifier:<decoderId>   — this field HOLDS a decodable code (identifier:vin)
//   decode:<key>             — fill this field from the decoder's <key> (decode:make)
//
// Minimal + decoder-agnostic: <key> is the decoder's own output vocabulary, so a
// future ISBN decoder emitting `author` fills a `decode:author` field with zero
// new platform code. Presentation roles (title/subtitle/…) are untouched.

/**
 * Every DecodeRole variant MUST be consumed by the fill planner. Adding a kind to
 * the union without handling it in planDecodeFill is a COMPILE ERROR, courtesy of
 * the `never` below.
 *
 * This exists because `identifier:` was parsed and then silently ignored for
 * months. parseDecodeRole understood it perfectly; planDecodeFill only ever looked
 * for `kind === "target"`, so the field a bundle DECLARED as the holder of the VIN
 * was the one field the VIN never reached — after a scan it sat empty while the VIN
 * was printed in the title directly above it. Nothing failed. Nothing warned. The
 * declaration was simply a lie the type system was happy to keep.
 *
 * A variant you declare and don't consume is worse than one you never added: it
 * reads as a feature. So the compiler now insists.
 */
function assertEveryRoleKindIsConsumed(r: DecodeRole): void {
  switch (r.kind) {
    case "identifier": // → the identifier holder claim, at the top of planDecodeFill
      return;
    case "target": // → the decode:<key> claim, in the loop below
      return;
    default: {
      const unhandled: never = r;
      throw new Error(
        `DecodeRole "${(unhandled as { kind: string }).kind}" is declared but nothing fills it. ` +
          "Handle it in planDecodeFill — a role nothing consumes is a lie in the type.",
      );
    }
  }
}

/** A fillable field, described generically for the decode-fill planner. */
export interface DecodeFillTarget {
  /** Opaque id the caller uses to apply the fill; never interpreted here. */
  id: string;
  /** Programmatic field name (native column or metadata key). */
  name: string;
  /** Display label (may be relabeled, e.g. "Make", "VIN"). */
  label: string;
  /** Is the field currently empty? Only empty targets are ever filled. */
  empty: boolean;
  /** The field's declared `decode_role` string, when it has one. Preferred over
   *  name/label matching. */
  role?: string | null;
}

export interface DecodeFill {
  target: DecodeFillTarget;
  /** The decoder's semantic key this fill came from (year/make/model/…). */
  decodedKey: string;
  value: string | number;
}

/** Fallback name/label matchers (the P1 behaviour) — used only when no field
 *  declares the matching `decode:<key>` role. Order is the order decoded keys
 *  are consumed. Kept deliberately small + generic; a bundle that wants
 *  precision declares roles instead of relying on these. */
const DECODE_NAME_MATCHERS: ReadonlyArray<{
  key: string;
  match: (t: DecodeFillTarget) => boolean;
}> = [
  { key: "make", match: (t) => /^(make|manufacturer)$/i.test(t.name) || /^(make|manufacturer)$/i.test(t.label) },
  { key: "model", match: (t) => /^model$/i.test(t.name) || /^model$/i.test(t.label) },
  { key: "year", match: (t) => /^(model[_ ]?)?year$/i.test(t.name) || /^(model )?year$/i.test(t.label) },
  { key: "body", match: (t) => /^body([_ ]?class)?$/i.test(t.name) || /^body( class)?$/i.test(t.label) },
  { key: "fuel_type", match: (t) => /^fuel([_ ]?type)?$/i.test(t.name) || /fuel/i.test(t.label) },
  { key: "trim", match: (t) => /^trim$/i.test(t.name) || /^trim$/i.test(t.label) },
];

/**
 * Decide which fields a decode result fills. Generic across decoders. For each
 * decoded key it PREFERS a field whose `decode_role` is `decode:<key>` (P3),
 * then falls back to name/label matching (P1). Guarantees:
 *   - EMPTY ONLY: a non-empty target is never chosen (no clobbering typed input).
 *   - ONE-TO-ONE: each target is filled by at most one decoded key.
 *   - SKIP ABSENT: a decoded key with no matching empty target is dropped.
 * Pure; unit-tested. Shared by the server scan-fill and the client form.
 */
export function planDecodeFill(
  decoded: Record<string, string | number>,
  targets: DecodeFillTarget[],
  /** The identifier that WAS decoded, when the caller knows it. A field declaring
   *  `identifier:<decoderId>` is the field that HOLDS that code — the VIN box on a
   *  vehicle, the ISBN box on a book — so it gets filled with the code itself.
   *
   *  Without this the role was parsed and then silently ignored: the Vehicles
   *  bundle tags `serial_number` as `identifier:vin`, and after a VIN scan that
   *  field sat empty while the VIN it was declared to hold was printed in the title
   *  directly above it. Optional, so a caller that doesn't know its own code
   *  behaves exactly as before. */
  identifier?: { decoderId: string; code: string },
): DecodeFill[] {
  const fills: DecodeFill[] = [];
  const claimed = new Set<string>();
  const roleOf = (t: DecodeFillTarget): DecodeRole | null => parseDecodeRole(t.role);

  // Every role a target declares must be one this planner actually consumes. The
  // check is compile-time (the `never` in assertEveryRoleKindIsConsumed); calling
  // it here keeps it wired to the real code path instead of rotting as an unused
  // export somebody deletes.
  for (const t of targets) {
    const r = roleOf(t);
    if (r) assertEveryRoleKindIsConsumed(r);
  }

  // The identifier holder is claimed FIRST: naming its decoder is the most specific
  // claim a field can make, so it must not lose its target to a name-match below.
  if (identifier?.code) {
    const want = identifier.decoderId.toLowerCase();
    const holder = targets.find((t) => {
      if (!t.empty || claimed.has(t.id)) return false;
      const r = roleOf(t);
      return r?.kind === "identifier" && r.decoderId === want;
    });
    if (holder) {
      claimed.add(holder.id);
      fills.push({ target: holder, decodedKey: want, value: identifier.code });
    }
  }

  for (const [key, value] of Object.entries(decoded)) {
    if (value === "" || value === null || value === undefined) continue;
    // P3: a field explicitly declaring `decode:<key>` wins outright.
    let target = targets.find((t) => {
      if (!t.empty || claimed.has(t.id)) return false;
      const r = roleOf(t);
      return r?.kind === "target" && r.key === key;
    });
    // P1 fallback: name/label match, but never steal a field that another key's
    // ROLE has reserved (a role declaration is authoritative).
    if (!target) {
      const matcher = DECODE_NAME_MATCHERS.find((m) => m.key === key);
      if (matcher) {
        target = targets.find((t) => {
          if (!t.empty || claimed.has(t.id)) return false;
          const r = roleOf(t);
          if (r?.kind === "target" && r.key !== key) return false; // reserved by another role
          return matcher.match(t);
        });
      }
    }
    if (!target) continue;
    claimed.add(target.id);
    fills.push({ target, decodedKey: key, value });
  }
  return fills;
}
