// Curated manufacturer paint-code → marketing-color-name table (Tier 1 of the
// vehicle color ladder — see docs/design-decisions/vehicle-color-resolution.md).
//
// A paint code is a finite, STABLE key, so `(make, code) → name` is a lookup,
// not a model call. This resolves the common case at zero tokens and lookup
// speed; the web-search + AI-text tiers (later) are only for codes not here.
//
// DISCIPLINE: seed only codes we're confident about — a WRONG color is worse
// than a miss (a miss just falls to a later tier / leaves the field blank). Keep
// it accurate and let it GROW from verified web-search hits rather than padding
// it with guesses. Codes are matched case-insensitively with spaces/hyphens
// stripped (labels print "NH830M", "NH-830M", "NH 830M" interchangeably); make
// is matched lowercased (codes collide across makes — "NH…" is a Honda prefix).

// GM shares one code system across its divisions (a Chevy and a GMC in the same
// paint use the same code), so define once and alias each make vPIC reports.
const GM_CODES: Record<string, string> = {
  GAZ: "Summit White",
  GBA: "Black",
  GAN: "Silver Ice Metallic",
  G7C: "Red Hot",
  GXD: "Mosaic Black Metallic",
  GJI: "Cajun Red Tintcoat",
  GLU: "Satin Steel Metallic",
};

// Chrysler/Stellantis ("Mopar") likewise shares codes across Jeep/Ram/Dodge/Chrysler.
const MOPAR_CODES: Record<string, string> = {
  PW7: "Bright White",
  PX8: "Black",
  PXJ: "Diamond Black Crystal Pearl",
  PAU: "Granite Crystal Metallic",
  PSC: "Billet Silver Metallic",
  PRV: "Redline Red Tricoat",
  PBS: "Patriot Blue Pearl",
};

/** make (lowercase) → normalized code → marketing color name. Curated + high-
 *  confidence only; grows via Tier-2 web-search rather than hand-padding. */
export const PAINT_CODES: Record<string, Record<string, string>> = {
  honda: {
    NH830M: "Lunar Silver Metallic",
    NH731P: "Crystal Black Pearl",
    NH883P: "Platinum White Pearl",
    NH877P: "Sonic Gray Pearl",
    NH797M: "Modern Steel Metallic",
    NH700M: "Alabaster Silver Metallic",
    NH603P: "White Diamond Pearl",
    NH578: "Taffeta White",
    R513: "Rallye Red",
    R81: "Milano Red",
    B593M: "Aegean Blue Metallic",
    B588P: "Obsidian Blue Pearl",
    YR585M: "Urban Titanium Metallic",
  },
  acura: {
    NH883P: "Platinum White Pearl",
    NH731P: "Crystal Black Pearl",
    NH782M: "Graphite Luster Metallic",
    B588P: "Obsidian Blue Pearl",
  },
  toyota: {
    "040": "Super White",
    "070": "Blizzard Pearl",
    "202": "Black",
    "1F7": "Classic Silver Metallic",
    "1G3": "Magnetic Gray Metallic",
    "1H5": "Celestial Silver Metallic",
    "1D6": "Silver Sky Metallic",
    "218": "Attitude Black Mica",
    "3R3": "Barcelona Red Metallic",
    "3T3": "Ruby Flare Pearl",
    "8W2": "Blue Crush Metallic",
  },
  lexus: {
    "085": "Eminent White Pearl",
    "212": "Obsidian",
    "1J7": "Atomic Silver",
    "1H9": "Atomic Silver",
    "3R1": "Matador Red Mica",
  },
  nissan: {
    KH3: "Super Black",
    K23: "Brilliant Silver",
    G41: "Magnetic Black",
    KAD: "Gun Metallic",
    QAB: "Pearl White Tricoat",
    NAH: "Scarlet Ember Tintcoat",
    RAY: "Deep Blue Pearl",
  },
  subaru: {
    K1X: "Crystal White Pearl",
    "01G": "Crystal Black Silica",
    G1U: "Ice Silver Metallic",
    "61K": "Magnetite Gray Metallic",
    D4S: "Dark Gray Metallic",
    E8H: "Dark Blue Pearl",
  },
  mazda: {
    "46V": "Soul Red Crystal Metallic",
    "25D": "Snowflake White Pearl Mica",
    "41W": "Jet Black Mica",
    "46G": "Machine Gray Metallic",
    "42A": "Deep Crystal Blue Mica",
    "42S": "Sonic Silver Metallic",
  },
  ford: {
    YZ: "Oxford White",
    UM: "Agate Black",
    J7: "Magnetic Metallic",
    G1: "Shadow Black",
    RR: "Race Red",
    N1: "Iconic Silver",
  },
  chevrolet: GM_CODES,
  gmc: GM_CODES,
  buick: GM_CODES,
  cadillac: GM_CODES,
  jeep: MOPAR_CODES,
  ram: MOPAR_CODES,
  dodge: MOPAR_CODES,
  chrysler: MOPAR_CODES,
};

/** Normalize a paint code as printed on a label: uppercase, strip spaces/hyphens
 *  ("NH-830 M" → "NH830M"). Pure. */
export function normalizePaintCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

/** Tier-1 lookup: the marketing color name for a (make, code), or null when the
 *  make/code isn't in the curated table (→ a later tier resolves it). Pure. */
export function lookupPaintCode(make: string, code: string): string | null {
  const m = make.trim().toLowerCase();
  const c = normalizePaintCode(code);
  return PAINT_CODES[m]?.[c] ?? null;
}
