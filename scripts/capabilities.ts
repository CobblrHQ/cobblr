// "I do this" — the register of capabilities that must have exactly one owner.
//
// Every entry here replaces a bespoke lint script. The scripts were all the same
// three shapes wearing different clothes, so this is the shape, and
// lint-capabilities.ts is the one runner.
//
// WHAT A DECLARATION CANNOT DO, stated up front because it is the whole limit of
// this idea: a hand-rolled copy never declares anything. Nobody registered a
// rival "receipt address" control - someone wrote `<code>{address}</code>` in a
// page. So every entry needs a `detect` for the SHAPE of the copy, and writing
// that detector is the actual work. The registry buys uniformity and one place
// to look; it does not buy detection for free.
//
// AND SCOPE IS NOT OPTIONAL. Whether a second rendering is duplication or a
// legitimately different affordance is a judgement no rule can make. Both early
// versions of the receipt-chip lint failed exactly there: one flagged a MenuItem
// that COPIES the address and renders none of it, the other flagged the settings
// page whose entire purpose is showing it. That is why `scope` is required and
// deliberately narrow: a capability rule governs the surfaces where one shape is
// right, and says nothing about anywhere else.

export type Capability =
  | OwnsCapability
  | RequiresPropCapability
  | VocabularyCapability;

interface Base {
  /** Stable id, `<area>:<what-it-does>`. Appears in failure output. */
  id: string;
  /** One line: what this capability IS. Shown when it fails. */
  what: string;
  /** Why it must have one owner - the incident, in one sentence. */
  why: string;
}

/** One file owns an implementation; others in `scope` must not hand-roll it. */
export interface OwnsCapability extends Base {
  kind: "owns";
  /** The file allowed to implement it. */
  owner: string;
  /** The surfaces this rule governs. Never "everywhere" - see the note above. */
  scope: string[];
  /** The shape of a hand-rolled copy, matched per line. */
  detect: RegExp;
  /** What to do instead. */
  use: string;
}

/** Every render site of a component must pass props it needs to be correct. */
export interface RequiresPropCapability extends Base {
  kind: "requires-prop";
  component: string;
  required: string[];
  scope: string[];
}

/** One concept, one word. `noun` bans a wrong word anywhere; `label` bans a
 *  rival phrasing only when the string IS a control label. */
export interface VocabularyCapability extends Base {
  kind: "vocabulary";
  scope: string[];
  terms: Array<{ phrase: RegExp; use: string; as: "noun" | "label" }>;
}

export const CAPABILITIES: Capability[] = [
  {
    kind: "owns",
    id: "catalog-hit:field-normalization",
    what: "cleaning a barcode provider's raw fields (the brand synonym list, the name-language choice) before anything downstream stores them",
    why: 'the Open*Facts adapter split OFF\'s comma-separated `brands` and the resolver tier twenty lines below it passed the same field through whole, so a Lidl item carried "Belbake, Dolciando, Elbake, Lidl" into its own title (2026-08-14)',
    owner: "modules/core-scan/src/services/catalog-normalize.ts",
    // Only the lookup file: five provider tiers live here and each one is a
    // place the next author could "just split it here". Downstream consumers
    // receive an already-clean hit and are not this rule's business.
    scope: ["modules/core-scan/src/services/barcode-lookup.ts"],
    // A raw provider field being sliced or lower-cased inline.
    detect: /\b(brands|product_name(_en)?|generic_name(_en)?)\b[^;\n]*\.(split|toLowerCase|replace)\(/,
    use: "primaryBrand(…) / preferredFactsName(…) from catalog-normalize.ts, applied once at the lookupBarcode funnel",
  },
  {
    kind: "owns",
    id: "receipt-address:reveal-and-copy",
    what: "showing the receipt drop-box address in a header, revealed and copied in one press",
    why: "Purchases rendered a permanent wall of address text while Scan had already collapsed it to a chip - one fact, two renderings (2026-08-03)",
    owner: "web/src/components/ReceiptAddressChip.tsx",
    scope: ["web/src/pages/ScanPage.tsx", "web/src/pages/PurchasesPage.tsx"],
    // The address printed as JSX children; `address={receiptAddress}` is a prop.
    detect: /(^|[^=])\{\s*receiptAddress\s*\}/,
    use: "<ReceiptAddressChip address={…} />",
  },
  {
    kind: "owns",
    id: "category:identity-comparison",
    what: "deciding whether two category labels mean the same thing",
    why: 'three inline `[^a-z0-9]` normalizers each missed plurals and synonyms, so "Figurines" joined a vocabulary already holding "Figurine" (2026-08-02)',
    owner: "packages/platform-contract/src/category-reconcile.ts",
    scope: [
      "modules/core-scan/src/api/inbox.ts",
      "modules/core-scan/src/services/matchmaker.ts",
      "api/src/platform/instance-promote.ts",
      "web/src/pages/sessionCategory.ts",
    ],
    detect: /toLowerCase\(\)[\s\S]{0,40}?replace\(\s*\/\[\^a-z0-9\]\+?\/g\s*,\s*""\s*\)/,
    use: "normaliseCategory from @cobblr/platform-contract/category-reconcile",
  },
  {
    kind: "owns",
    id: "device:touch-primary",
    what: "deciding whether this is a touch-primary device",
    why: "two inline matchMedia(\"(pointer: coarse)\") copies existed and a third was about to be written for Live Sort's confirm copy (2026-08-05)",
    owner: "web/src/lib/useIsTouch.ts",
    scope: [
      "web/src/components/PairPhoneButton.tsx",
      "web/src/components/WhatToDoPanel.tsx",
      "web/src/components/LiveSortSheet.tsx",
    ],
    // `matchMedia?.(` - optional chaining is `?.`, not `?`. The first version of
    // this pattern missed the real call site verbatim, which is why every
    // capability's detector gets proved against an actual copy before shipping.
    detect: /matchMedia(\?\.)?\(\s*["'`]\(pointer: coarse\)/,
    use: "useIsTouch() / isTouchPrimary() from web/src/lib/useIsTouch",
  },
  {
    kind: "owns",
    id: "scan-triage:needs-a-human",
    what: "deciding whether a pending capture still needs a person to look at it",
    why: "the predicate lived inline in the Scan page, so the API could not filter by it and Ask Cobb could not read it — and the page's own second copy had already drifted, flagging items a human had marked \"looks fine\" (2026-08-14)",
    owner: "packages/platform-contract/src/scan-triage.ts",
    scope: [
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/scanFileAll.ts",
      "web/src/pages/scan-status.ts",
      "modules/core-scan/src/api/inbox.ts",
      "modules/core-scan/src/api/organize.ts",
      "packages/workspace-tools/src/tools.ts",
    ],
    // Three single-line signatures of a re-derivation: the confidence threshold,
    // the stale window, and the two lookup flags read TOGETHER. Reading
    // `rate_limited` alone to pulse "retrying…", or `low_trust` alone to offer
    // the barcode corrector, are different affordances and stay allowed — as is
    // `!x.suggested_name ||`, which organize.ts uses for a different question.
    detect:
      /(\bai_confidence\b[^\n]*<\s*0?\.\d)|(\b2\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000\b)|((low_trust|lowTrust)[^\n]{0,40}(rate_limited|rateLimited))/,
    use: "needsScanReview() from @cobblr/platform-contract/scan-triage",
  },
  {
    kind: "requires-prop",
    id: "scan-card:session-reconciled-category",
    what: "telling a scan card the category its SESSION agreed on",
    why: "a card not told it falls back to its own raw value, so one session showed both Figurines and Figurine (2026-08-02)",
    component: "InboxCard",
    required: ["sessionCategoryLabel"],
    scope: ["web/src/pages/ScanPage.tsx"],
  },
  {
    kind: "owns",
    id: "location:one-picker",
    what: "choosing a location, including choosing a PARENT for one",
    why: "three pickers accumulated because each replacement was written as a drop-in and then applied only to the surface that prompted it. LocationPicker was superseded in 2026-08 and still rendered a native <select> on six call sites in Records/Assets/Machines, and two separate forms hand-rolled their own parent dropdown, one of them re-implementing the no-cycles closure beside it (2026-08-17)",
    owner: "web/src/components/LocationTreePicker.tsx",
    // The surfaces that PICK one. The chip picker is a peer implementation for
    // the scan flow's density (documented in the 2026-08-07 audit, H7) and is
    // deliberately out of scope rather than in breach.
    scope: [
      "web/src/pages/LocationsPage.tsx",
      "web/src/pages/RecordsPage.tsx",
      "web/src/pages/AssetsPage.tsx",
      "web/src/pages/MachinesPage.tsx",
      "web/src/components/FloorPlan.tsx",
    ],
    // Rendering a hierarchy's depth as indentation is the tell that someone is
    // drawing a location tree into an <option> list by hand.
    detect: /\.repeat\([^)]*\bdepth\b/,
    use: "<LocationTreePicker> (drill-down; pass excludeSubtreeOf when choosing a parent, it computes the no-cycles closure itself), or <LocationChipPicker> for the scan flow's chip density",
  },
  {
    kind: "owns",
    id: "deploy:live-surface-sha",
    what: "reading which core commit a deployed surface (canary or prod) is actually running",
    why: "five hand-rolled probes accumulated, each re-deriving how to pick the web container, and they disagreed. `grep public-web | head -1` matched the canary slot and reported a false green while cobblr.me was 34 commits behind, because canary tracks :latest and therefore always looks current. Then the reverse on 2026-08-17: a scan fix was merged, checked against staging and reported done, while canary still ran the older api. The reporter retested there, saw the original bug, and reported it a second time",
    owner: "scripts/lib/shippable.sh",
    // Only the two scripts that answer "is my commit live on a surface".
    // release-drift.sh compares surfaces to each other and
    // verify-cobblr-deploy.sh audits one specific rollout; both read labels for
    // their own reasons and are deliberately out of scope, not in breach.
    scope: ["scripts/deploy-gap.sh", "scripts/canary-wait.sh"],
    // Selecting the web CONTAINER by name filter is the exact trap and the only
    // shape worth flagging. deploy-gap deliberately inspects the pinned IMAGE
    // (cobblr-public-web:pin) for prod, which answers a different question --
    // what is pinned, not what happens to be running -- and must keep doing it.
    detect: /docker ps --filter name=cobblr-public-web/,
    use: "live_pair <canary|prod> for the raw pair, or live_contains <surface> <commit> to ask whether it is already there (ancestry, both halves)",
  },
  {
    kind: "vocabulary",
    id: "location:one-name",
    what: 'one word for the thing a user sets, and one action name ("Set location")',
    why: 'the scan flow had six names for it, and the chip said "No filing location" on desktop but "Set location" on a phone (2026-08-01)',
    scope: [
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/sessionCategory.ts",
      "web/src/pages/scanFileAll.ts",
      "web/src/components/SessionLocationModal.tsx",
      "web/src/components/LocationTreePicker.tsx",
      "web/src/components/LocationChipPicker.tsx",
      "web/src/components/OrganizePlanSheet.tsx",
      "web/src/components/OrganizeWalkSheet.tsx",
    ],
    terms: [
      { phrase: /\bfiling location\b/, as: "noun", use: '"location" (the action is "Set location")' },
      { phrase: /\bno location set\b/, as: "noun", use: '"Set location"' },
      { phrase: /\bneeds? a place\b/, as: "noun", use: '"needs a location"' },
      { phrase: /\bpick a place\b/, as: "noun", use: '"Pick a location"' },
      { phrase: /\bchoose a place\b/, as: "noun", use: '"Set location"' },
      { phrase: /\ba place for\b/, as: "noun", use: '"a location for"' },
      { phrase: /\bhave nowhere to go\b/, as: "noun", use: '"have no location yet"' },
      { phrase: /\bpick a location\b/, as: "label", use: '"Set location"' },
      { phrase: /\bchoose a location\b/, as: "label", use: '"Set location"' },
      { phrase: /\bset a location\b/, as: "label", use: '"Set location" or "Set the location"' },
    ],
  },
];
