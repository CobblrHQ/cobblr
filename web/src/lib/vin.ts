// Client-side VIN helpers for the guarded-auto decode on the entity form.
//
// Two pure pieces, both unit-tested (vin.test.ts):
//   1. isShapeValidVin — the fire gate. Guarded-auto only calls the decode
//      endpoint when the VIN field holds a COMPLETE, shape-valid VIN; never on
//      a partial/garbage value. (Mirrors the server's matches() shape test —
//      a one-line regex, intentionally duplicated rather than shared through a
//      server-only module.)
//   2. planVinFill — maps the decoded semantic fields onto the form's target
//      fields BY ROLE/NAME, generically. Fills ONLY EMPTY targets (never
//      overwrites a value the user typed) and SKIPS a role whose target field
//      is absent. No field ids are hardcoded — a decoded `make` lands on
//      whichever field is named `manufacturer`/`make` OR labelled "Make", so
//      the same logic serves the shipped vehicle bundle, the authoring
//      template, and any user-built "VIN" table.

// 17 chars, A–Z0–9 except I/O/Q, uppercased first. Same rule as the server.
const VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;

export function isShapeValidVin(code: string): boolean {
  return VIN_RE.test(code.trim().toUpperCase());
}

/** A fillable field on the form, described generically. */
export interface VinFillTarget {
  /** Opaque id the caller uses to apply the fill (e.g. "native:manufacturer",
   *  "meta:year"). Never interpreted here. */
  id: string;
  /** The field's programmatic name (native column or metadata key). */
  name: string;
  /** The field's display label (may be relabeled, e.g. "Make", "VIN"). */
  label: string;
  /** Is the field currently empty? Only empty targets are ever filled. */
  empty: boolean;
  /** The field's declared semantic decode role (P3), e.g. `decode:make`. When
   *  present it targets the field by ROLE, winning over name/label matching —
   *  so a bundle that declares roles fills precisely, while one that only
   *  relabels still resolves by name (back-compat). */
  role?: string | null;
}

export interface VinFill {
  target: VinFillTarget;
  /** The decoded semantic key this fill came from (year/make/model/…). */
  decodedKey: string;
  value: string | number;
}

// A field matches a role if its NAME or its LABEL says so. Case-insensitive,
// generic — no specific field id anywhere. Order of ROLE_MATCHERS is the order
// decoded keys are consumed.
const ROLE_MATCHERS: ReadonlyArray<{ key: string; match: (t: VinFillTarget) => boolean }> = [
  {
    key: "make",
    match: (t) => /^(make|manufacturer)$/i.test(t.name) || /^(make|manufacturer)$/i.test(t.label),
  },
  {
    key: "model",
    match: (t) => /^model$/i.test(t.name) || /^model$/i.test(t.label),
  },
  {
    key: "year",
    match: (t) => /^(model[_ ]?)?year$/i.test(t.name) || /^(model )?year$/i.test(t.label),
  },
  {
    key: "body",
    match: (t) => /^body([_ ]?class)?$/i.test(t.name) || /^body( class)?$/i.test(t.label),
  },
  {
    key: "fuel_type",
    match: (t) => /^fuel([_ ]?type)?$/i.test(t.name) || /fuel/i.test(t.label),
  },
  {
    key: "trim",
    match: (t) => /^trim$/i.test(t.name) || /^trim$/i.test(t.label),
  },
];

/**
 * Given the decoded semantic fields and the form's target fields, decide which
 * fields to fill. Guarantees:
 *   - EMPTY ONLY: a non-empty target is never chosen (no clobbering typed input).
 *   - SKIP ABSENT: a decoded role with no matching target is dropped silently.
 *   - ONE-TO-ONE: each target is filled by at most one decoded key.
 * The caller applies the returned fills and shows a provenance chip per fill.
 */
/** Parse a `decode:<key>` / `identifier:<id>` role string (mirrors the server's
 *  parseDecodeRole; duplicated here to keep the client free of a server import,
 *  as the VIN shape regex above already is). */
function targetRoleKey(role: string | null | undefined): string | null {
  if (typeof role !== "string") return null;
  const m = role.trim().match(/^decode:([a-z][a-z0-9_-]*)$/i);
  return m ? m[1]!.toLowerCase() : null;
}

export function planVinFill(
  decoded: Record<string, string | number>,
  targets: VinFillTarget[],
): VinFill[] {
  const fills: VinFill[] = [];
  const claimed = new Set<string>();
  for (const [key, value] of Object.entries(decoded)) {
    if (value === "" || value === null || value === undefined) continue;
    // P3: a field explicitly declaring `decode:<key>` wins outright.
    let target = targets.find((t) => t.empty && !claimed.has(t.id) && targetRoleKey(t.role) === key);
    // P1 fallback: name/label match, but never steal a field reserved by another
    // key's role declaration.
    if (!target) {
      const matcher = ROLE_MATCHERS.find((m) => m.key === key);
      if (!matcher) continue; // a decoded key we don't map onto a field (e.g. raw extras)
      target = targets.find((t) => {
        if (!t.empty || claimed.has(t.id)) return false;
        const rk = targetRoleKey(t.role);
        if (rk && rk !== key) return false; // reserved by another role
        return matcher.match(t);
      });
    }
    if (!target) continue; // no empty target for this key → skip (absent or already filled)
    claimed.add(target.id);
    fills.push({ target, decodedKey: key, value });
  }
  return fills;
}
