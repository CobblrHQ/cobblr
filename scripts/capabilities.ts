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
    id: "cadence:ledger-write",
    what: "appending a fact to the cadence ledger, including the baseKindOf normalisation on write",
    why:
      "three doors wrote core_cadence_events and only one normalised the kind. The HTTP route called baseKindOf; the " +
      "record-event action handler inserted entity.kind raw, so a wire or an AI invocation filed a skinned instance " +
      "('tea:item') under a different identity than a scan of the same item ('inventory:part') - one item, two histories, " +
      "and every reader got whichever half it asked for. That is the exact split ledger the route's own comment was " +
      "written to prevent, reintroduced through a door added later (found 2026-08-27). A fourth door would do it again",
    owner: "modules/core-cadence/src/record.ts",
    scope: ["modules/core-cadence/src/api/index.ts", "modules/core-cadence/src/api/action-handlers.ts"],
    detect: /insertInto\(\s*["'`]core_cadence_events["'`]\s*\)/,
    use: "recordCadenceEvent(orgId, userId, observation) from core-cadence's record.ts",
  },
  {
    kind: "owns",
    id: "scan:committed-image-path",
    what: "resolving the image_path to stamp on a record when a scan is committed",
    why:
      "committedImagePath states the invariant in its own header - if the scan carries ANY image representation, a " +
      "stored catalog file OR a raw catalog URL, the committed record MUST get an image_path - because a scan " +
      "committed mid-enrich lost its picture (2026-07-24). The location path was fixed to call it; the path that " +
      "commits an item into a table kept building the URL by hand from catalog_image_file_id, so it silently skipped " +
      "every scan whose image was still a URL, which is every barcode scan for its first seconds. Real barcodes came " +
      "back correctly named and completely pictureless (found 2026-08-27 seeding a demo). A third commit path would " +
      "do it again",
    owner: "modules/core-scan/src/services/committed-image.ts",
    // The paths that COMMIT a scan onto a record. Rendering an already-stored
    // file elsewhere is not this rule's business.
    scope: ["modules/core-scan/src/api/inbox.ts", "modules/core-scan/src/api/organize.ts"],
    // A files/<id>/raw path built inline from a catalog image id, instead of asking the helper.
    detect: /core-files\/files\/\$\{[^}]*catalog_image_file_id[^}]*\}\/raw/,
    use: "committedImagePath(orgSlug, catalogImageFileId, catalogImageUrl) from core-scan's services/committed-image",
  },
  {
    id: "net:pinned-outbound-fetch",
    kind: "owns",
    what: "follow redirects yourself, re-validating and IP-pinning every hop, on an SSRF-guarded outbound fetch",
    why:
      "three guards (kernel egress, wasm-sandbox HOST_FETCH, scan image fetch) each grew their own copy of this " +
      "loop, and when pinning was added to close a DNS-rebind window (2026-08-25) all three copies got the SAME " +
      "wrong lookup callback: undici asks with { all: true }, Node then reads addresses[0].address, and answering " +
      "the single-address way made EVERY pinned fetch in the product die at the socket with 'Invalid IP address: " +
      "undefined'. Outbound webhooks, sync connectors, edge devices, sandboxed module fetch and every catalog " +
      "image download were dead for three days and no test noticed, because all three suites mock undici. One " +
      "loop means one place to get the connector contract right - and one real-socket test that proves it",
    owner: "packages/platform-net/src/index.ts",
    // The three SSRF-guarded fetch paths. A module doing a plain fetch to a
    // first-party service it was configured with is not this rule's business.
    scope: [
      "api/src/platform/egress.ts",
      "api/src/sandbox/pool.ts",
      "modules/core-scan/src/services/enrich.ts",
    ],
    // The lookup callback of a hand-rolled pinned Agent. `detect` is matched
    // PER LINE, so it has to be the one line the copy always has - a
    // multi-line `connect: { ... lookup:` pattern silently never fires, which
    // is how the first version of this row passed while a planted copy sat in
    // egress.ts. dns's own `lookup(host, …)` call and its import do not match.
    detect: /^\s*lookup\s*:\s*\(/,
    use: "pinnedRedirectingFetch({ url, validate }) from @cobblr/platform-net",
  },
  {
    id: "authoring:post-model-pipeline",
    kind: "owns",
    what: "parse → unwrap → lean natives → corroborate, on a model's bundle reply",
    why:
      "the interactive build and the operator eval each carried a copy; the corroboration layer landed in one, " +
      "and the eval kept measuring the old pipeline (2026-08-26) - an eval that skips the product's path measures a product that does not exist",
    owner: "modules/core-authoring/src/services/shape.ts",
    scope: ["modules/core-authoring/src/api/drafts.ts", "api/src/routes/super-admin.ts"],
    detect: /\b(parseJsonObject|unwrapBuild|unwrapApp|applyLeanNatives)\s*\(/,
    use: "shapeCandidate(text, task, { intent, kinds, natives }) from core-authoring's services/shape",
  },
  {
    kind: "owns",
    id: "placement:whats-inside",
    what: "answering what is stored inside a container - a room, a shelf, a bin",
    why: "the location page asked each kind's own list endpoint to filter by ?location_id=, which most of them do not implement: they ignored it and returned their whole table, so every room showed the same items and a book shelved in the dining room turned up in the den. Re-checking the rows client-side would have emptied the section instead, because a record's location lives in the placement table and its location_id column reads null (2026-08-23)",
    owner: "modules/core-placement/src/api/index.ts",
    // The surfaces that ask what is inside a location. A page filtering its OWN
    // module's list by its own column is not this rule's business.
    scope: [
      "web/src/pages/LocationDetailPage.tsx",
      "web/src/pages/LocationsPage.tsx",
      "web/src/components/FloorPlan.tsx",
    ],
    // A hand-rolled copy puts location_id in a list request's query string and
    // trusts the server to have implemented that filter.
    detect: /[?&]location_id=/,
    use: "GET /orgs/:slug/modules/core-placement/contents?container_kind=core-locations:location&container_id=<id> - placement is where containment lives, and a DB trigger keeps it in step with every location-bearing table, so one call covers every kind including instances",
  },
  {
    kind: "owns",
    id: "scan:install-before-filing",
    what: "installing the bundle a scan destination needs and deciding which instance to file into afterwards",
    why: "installing reports the target it really created, and a bundle that skins a module's default table creates NO instance - while the candidate still carries the synthetic token the routing menu used to name the bundle. Three call sites each installed and then confirmed the candidate verbatim, so a receipt of groceries failed on every line against a bundle that had installed perfectly (2026-08-22)",
    owner: "web/src/pages/scanInstall.ts",
    // Every surface that files a scanned item into a destination it may have to
    // install first. Other pages install bundles for their own reasons; that is
    // not this rule's business.
    scope: ["web/src/pages/ScanPage.tsx"],
    // A hand-rolled copy installs the bundle itself, and then has the candidate
    // instance in hand at the moment it must not be trusted.
    detect: /materializeQuickstart\s*\(/,
    use: "await resolveInstanceForFiling(slug, bundleId, candidateInstance) - it installs and returns the instance to file into, which may be none",
  },
  {
    kind: "owns",
    id: "credentials:provider-form",
    what: "rendering the credential fields for an AI/connection provider - the input, the paste recovery, the check-as-you-type verdict and the model dropdown it populates",
    why: "the same field loop was pasted into three forms, so every capability added to it landed on some and was missed on the rest: the paste recovery and the visible-while-typing key both shipped to the two workspace forms and skipped /me/connections, which is the form an individual user or self-hoster actually uses (2026-08-21)",
    owner: "web/src/components/CredentialFields.tsx",
    // The three forms that ask someone for provider credentials. Any future one
    // belongs here too; nothing else on these pages is this rule's business.
    scope: ["web/src/pages/AiPage.tsx", "web/src/pages/ConnectionsPage.tsx"],
    // A hand-rolled copy renders the input directly instead of the field set.
    detect: /<CredentialInput\b/,
    use: "render <CredentialFields fields={...} creds={...} onChange={...} scope={...} providerId={...} /> - it renders every field, including the choices and model cases",
  },
  {
    kind: "owns",
    id: "announce:destination-fanout",
    what: "deciding WHERE an operator announcement goes - reading the webhook config and sending to each place exactly once",
    why: "every publisher read ONE webhook URL out of ONE env var, so a second Discord meant editing each script by hand, and the per-destination delivery record (sent? how far? which message id, for a later correction) was three scalars that silently collapse when pointed at two servers: the new one reads as already delivered, a retry resumes it at the other one's cursor, and a correction edits the wrong post (2026-08-23)",
    owner: "scripts/lib/destinations.mjs",
    // The operator publishers. Tenant-configured webhooks (a workspace's own
    // Discord connector, digifab print rules, notification channels) are a
    // different thing entirely and are not this rule's business.
    scope: ["scripts/changelog-publish.mjs", "scripts/changelog-backfill.mjs"],
    // A hand-rolled copy reads the env var straight instead of parsing it into
    // destinations.
    detect: /process\.env\.[A-Z_]*WEBHOOK[A-Z_]*/,
    use: "call destinationsFrom(\"<ENV_VAR>\") from scripts/lib/destinations.mjs - a single URL is a list of one, so nothing has to change to configure it the way it is configured today",
  },
  {
    kind: "owns",
    id: "notifications:delivery-schedule",
    what: "deciding WHEN a user-facing message is delivered - batching, digests, quiet windows, any timer whose purpose is to send someone fewer messages",
    why: "the Discord DM spec shipped a DM_FLOOR and nothing that coalesced above it, so forty tracked consumables each perfectly debounced by core_cadence_signals still meant forty DMs a day; a per-item debounce is not a volume control, and the fix only works if there is exactly one place that holds a person's mail (2026-08-21)",
    owner: "api/src/platform/delivery-sweeper.ts",
    // The modules that emit the most user-facing signals, which is where a
    // private digest would be written. The platform's own dispatcher and
    // sweeper are the owner and are not this rule's business.
    scope: [
      "modules/core-cadence/src/sweeper.ts",
      "modules/core-notifications/src/module.ts",
      "modules/inventory/src/burn-rate.ts",
      "modules/lists/src/expiry-sweeper.ts",
      "modules/core-maintenance/src/sweeper.ts",
    ],
    // The tell is batching language ATTACHED TO A MESSAGE, not batching
    // language on its own. A bare `coalesce` is SQL and matched burn-rate's
    // jsonb merge on the first draft of this rule - the registry's own header
    // warns that an over-broad detector is the usual way these fail, and it
    // was right within a minute of writing it.
    detect: /\b(notif\w*|message|dm|digest)[A-Za-z_]*(digest|batch|queue|buffer|window)\b|\b(digest|batch|buffer)[A-Za-z_]*(notif\w*|message|dm)\b|\bquiet[_ ]?hours\b/i,
    use: "emit the notification as normal and let dispatch() defer it - a delivery window is per (person, channel) and lives in api/src/platform/delivery-windows.ts",
  },
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
    kind: "vocabulary",
    id: "account:one-name",
    what: 'the name of /me, which is "Your account"',
    why: 'the rename from "Profile" was DECIDED and WRITTEN DOWN (configuration-revamp.md § Naming: the pair was asymmetric, "Configuration" names an act and "Profile" names a document about you) and still only reached half the app. The user menu said "Your account", the sidebar said "Profile", the mobile nav said "profile" and the Connections back-link said "Profile" - four surfaces, three names, for one page. A comment in ConfigurationPage even said "until /me is relabelled (P5)", so the gap was known and stayed open. A decision recorded in a doc reminds whoever reads the doc; nobody reads it while renaming a nav row (2026-08-21)',
    scope: [
      "web/src/components/AppLayout.tsx",
      "web/src/components/MobileNav.tsx",
      "web/src/components/UserMenu.tsx",
      "web/src/pages/ConnectionsPage.tsx",
      "web/src/tour/tour.config.ts",
    ],
    terms: [
      {
        // The bare word as a user-visible label. Not "profile" inside an
        // identifier, a route, or a sentence about someone else's app (the
        // Homebox importer legitimately says "Homebox → Profile → API tokens").
        phrase: /(?:^|[>\s"'`])[Pp]rofile(?=[<\s"'`.,]|$)/,
        use: '"Your account" — the name /me carries everywhere else',
        as: "label",
      },
    ],
  },
  {
    kind: "owns",
    id: "location:bottom-up-shelves",
    what: "deciding which end of a rack numbering starts from, and which nouns that applies to",
    why: "a house convention is only worth having if it is the same convention everywhere, and locations get created from more than one surface. The convention (shelf 1 is the bottom) is a suggestion the user can decline per range, which is exactly why a second surface quietly defaulting the other way would be invisible: both racks look deliberate, and you only find out standing in front of the wrong one",
    owner: "web/src/lib/stacking.ts",
    // The surfaces that CREATE a location. The scan flow files into places that
    // already exist, so it is not in this rule.
    scope: [
      "web/src/pages/LocationsPage.tsx",
      "web/src/components/QuickCreateLocation.tsx",
      "web/src/components/LocationTreePicker.tsx",
    ],
    // A second list of stacking nouns. Matched on the ones that mean nothing
    // else: "shelf" also appears in the page's area-vs-container word list,
    // which is a different question about the same word.
    detect: /["'`](tier|rung|layer)["'`]/i,
    use: "STACKED_NOUNS / isStackedNoun / bottomUpDisplayOrder from lib/stacking.ts",
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
