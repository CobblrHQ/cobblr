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
  /** When set, a `detect` hit counts only in a file that ALSO matches this
   *  somewhere: the copy is two lines that together do the thing (a click
   *  toggle is fine on its own; beside a hover-open it is the bug). */
  also?: RegExp;
  /** What to do instead. */
  use: string;
  /** Files in `scope` that do a DIFFERENT thing with the same shape, each with
   *  why. Named one by one, never a pattern, so an exemption is a decision
   *  somebody wrote down, and one whose file is gone fails as a stale scope. */
  except?: Record<string, string>;
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
    id: "digifab:job-display-name",
    what: "fabrication job titles use the saved display name with a filename fallback",
    why: "generated laser and cutter filenames hide the drawing name in the queue and fleet",
    owner: "web/src/features/digifab/jobDisplayName.ts",
    scope: ["web/src/features/digifab/**/*.tsx", "web/src/pages/DigifabPage.tsx", "web/src/pages/FloorManagerPage.tsx", "web/src/pages/MachineStationPage.tsx"],
    detect: /\{[^{}\n]*\.file_ref\b/,
    use: "jobDisplayName(job)",
  },
  {
    kind: "owns",
    id: "records:one-deletion-image",
    what: "one private before-image store for every record deletion",
    why: "a delete kept only by an assistant ledger cannot be undone when a person deletes the same record in the app",
    owner: "api/src/platform/deleted-records.ts", scope: ["api/src/platform/**/*.ts", "modules/*/src/**/*.ts"],
    detect: /(?:insertInto\(["'](?:deleted_records|\w+_deleted)["']|insert into deleted_records)/,
    use: "platform().deletedRecords.keep or capture, with the kind's snapshot and restore writer",
  },
  {
    kind: "requires-prop",
    id: "photos:host-editor",
    what: "the workspace shell supplies its shared record photo editor to module pages",
    why: "a module photo field cannot reach the shared web picker without the host component",
    component: "PlatformWebProvider",
    required: ["recordPhoto"],
    // The one provider, mounted by the shell and by the Station (#4640).
    scope: ["web/src/WorkspacePlatformWeb.tsx"],
  },
  {
    kind: "owns",
    id: "locations:the-open-space",
    what: "which room or container a floor-plan page has open: the address's `space`, read and set only through useSelectedSpace (web/src/components/placeItems/useSelectedSpace.ts)",
    why:
      "the Floor Plan tab kept its room in its own state and Place items read the address, so the button between them carried nothing " +
      "and a person who had just drawn the Garage landed on the Bathroom's empty plan (#4557)",
    owner: "web/src/components/placeItems/useSelectedSpace.ts",
    scope: ["web/src/**/*.tsx", "web/src/**/*.ts"],
    detect: /\.get\(\s*["']space["']\s*\)|\.set\(\s*["']space["']/,
    use: "useSelectedSpace(items) for the open space and its setter; placeItemsHref / floorPlanHref to link to a page with one open.",
  },
  {
    kind: "owns",
    id: "browser:random-id",
    what: "a random id made in the browser: randomId() from @cobblr/platform-contract/random-id (packages/platform-contract/src/random-id.ts)",
    why:
      "crypto.randomUUID exists only on HTTPS or localhost, so a record page that called it on mount crashed with " +
      "\"crypto.randomUUID is not a function\" for anyone opening Cobblr over plain http on a LAN address (#5293)",
    owner: "packages/platform-contract/src/random-id.ts",
    scope: ["web/src/**/*.tsx", "web/src/**/*.ts", "packages/platform-web/src/**/*.tsx", "packages/platform-web/src/**/*.ts", "modules/*/src/ui/**/*.tsx", "modules/*/src/ui/**/*.ts"],
    detect: /crypto\.randomUUID\b/,
    use: "randomId() from @cobblr/platform-contract/random-id: the same v4 UUID, backed by crypto.getRandomValues where randomUUID is missing.",
  },
  {
    kind: "owns",
    id: "fields:choice-picker",
    what: "a field's list of values that grows when someone types a new one: ChoiceCombobox in packages/platform-web/src/ChoiceCombobox.tsx (bound to a field by ChoiceField)",
    why:
      "every dropdown grew its own \"+ add new…\" option, a second box to type into and a separate \"which one\" box under it; " +
      "five copies behaved five ways and none offered what had already been typed on other records (#4516)",
    owner: "packages/platform-web/src/ChoiceCombobox.tsx",
    scope: ["web/src/**/*.tsx", "packages/platform-web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /<option[^>]*>\s*[+＋]\s*[Aa]dd new|value="__add__"|"__new_choice__"|>\s*New \{?[a-zA-Z.()]*\}?…<\/option>/,
    use: "ChoiceField for a field def (it offers the used values and learns a new one, undoably), or ChoiceCombobox for a plain list. Typing a value not on the list IS adding it; there is no add row.",
  },
  {
    kind: "owns",
    id: "services:who-has-to-say-yes",
    what: "deciding whether a service job may start without a person, from the capability's declared effect and the door it came in by: serviceConsent / serviceRunsUnconfirmed in packages/platform-contract/src/service-consent.ts",
    why:
      "the one standing rule about the physical world (a print never starts without a person's yes) lived only in client dialogs, " +
      "and a door that decides for itself (the chat, the MCP route, a wire, module code) is where a print starts on Auto (#4034)",
    owner: "packages/platform-contract/src/service-consent.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts", "packages/*/src/**/*.ts"],
    // A comparison against an effect value, the shape every hand-rolled copy
    // of the rule takes. A declaration (effect: "physical") is not a decision.
    detect: /(?:effect|\.effect)\s*[!=]==?\s*["'](?:physical|spends|writes)["']|["'](?:physical|spends|writes)["']\s*[!=]==?\s*\w*[eE]ffect\b|case\s+["'](?:physical|spends)["']\s*:/,
    use: "serviceConsent(effect, door, { writeMode, policy, wireRuns }) from @cobblr/platform-contract/service-consent",
  },
  {
    kind: "owns",
    id: "purchases:receiving-an-order",
    what: "receiving an order's lines and telling the stock and spend wires: receiveOrderLines in modules/purchases/src/receive.ts, the one emitter of purchases.order_item.received",
    why:
      "two doors received an order each their own way: 'Mark arrived' sent qty where the stock wire reads delta, so no stock was added, " +
      "and nothing stamped a line received, so an order that arrived twice added its stock twice (#4115)",
    owner: "modules/purchases/src/receive.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts"],
    detect: /emit\(\s*["']purchases\.order_item\.received["']/,
    use: "receiveOrderLines(db, orgId, orderId, receivedOn) from modules/purchases/src/receive.ts",
  },
  {
    kind: "owns",
    id: "counters:what-a-record-counts",
    what: "the counters a kind keeps and one record's reading of them (a module's own EntityWriter.counters plus every number field with the usage role): countersFor / readCounters in api/src/platform/counters.ts, reached as platform().entities.countersFor / readCounters",
    why:
      "the schedule form's choices and the schedule's due reading each asked the writer for its counters, so a counter from a field " +
      "could be offered and never read, or read and never offered, and only machines could be serviced by use (#4174)",
    owner: "api/src/platform/counters.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts"],
    // Reaching into a writer's own counters: the declaration inside a module's
    // writer (counters: { defs: ...) is not a read.
    detect: /\.counters\??\.(?:defs|read)\b/,
    use: "platform().entities.countersFor(orgId, kind) and platform().entities.readCounters(orgId, kind, id)",
  },
  {
    kind: "owns",
    id: "network:is-this-a-home-address",
    what: "deciding whether an address is on the person's own network (and so needs a bridge from a hosted Cobblr): addressReach / needsBridge in packages/platform-contract/src/address-reach.ts",
    why:
      "two address forms each carried a copy of the rule and the rest had none, so Part-DB, Homebox and a sync connection said nothing " +
      "about 192.168.1.50 until the import failed; the copies also missed the tailnet range the hosted egress guard blocks (#3904)",
    owner: "packages/platform-contract/src/address-reach.ts",
    scope: ["web/src/**/*.tsx", "web/src/**/*.ts", "packages/platform-web/src/**/*.tsx", "packages/platform-web/src/**/*.ts", "modules/*/src/ui/**/*.tsx", "modules/*/src/ui/**/*.ts"],
    // The shapes a rule takes in code, never an example address in a
    // placeholder: a comparison with 168, an escaped 192\.168 in a regex, a
    // .local suffix test, or a named copy.
    detect: /===\s*168\b|192\\\.168|\.endsWith\(\s*["']\.local["']\s*\)|function\s+looksLike(?:Lan|Local)/,
    use: "addressReach(raw) or needsBridge(raw, { hosted }) from @cobblr/platform-contract/address-reach, and <HomeNetworkHint> in a form",
    except: {
      "packages/platform-web/src/local-network.test.ts": "the browser gate's own test names the addresses it must refuse",
    },
  },
  {
    kind: "owns",
    id: "stock:one-stepper",
    what: "the control that changes how much of a thing there is: StockStepper in packages/platform-web/src/StockStepper.tsx, which steps a counted thing by one and has a measured one (kg, m, L) typed as what was used",
    why:
      "each surface had its own −/+, so after a spool's page learned to take grams the parts wall's tile still took a whole kilogram " +
      "off a spool per tap (#4030)",
    owner: "packages/platform-web/src/StockStepper.tsx",
    scope: ["web/src/**/*.tsx", "packages/platform-web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /aria-label=(?:"(?:Decrease|Increase) quantity"|\{`One (?:fewer|more) )/,
    also: /stockAdjust|adjustStock|stock-adjust|onStep\b/,
    use: "<StockStepper qty={qty} unit={unit} label={name} onStep={(delta) => …} /> (or QtyStepper, which mounts it)",
    except: {
      "packages/platform-web/src/AmountControl.tsx": "the measured half StockStepper hands a kg/m/L thing to; its counted mode is StockStepper's own rule",
    },
  },
  {
    kind: "owns",
    id: "layout:sticky-bottom-bar",
    what: "a row pinned to the bottom of the screen while a page scrolls: StickyBottomBar in packages/platform-web/src/StickyBottomBar.tsx, which reserves its own height as the page's scroll padding",
    why:
      "a bar pinned with sticky bottom-0 sits over whatever scrolls beneath it, so a record's last field, or one focused with the " +
      "phone's keyboard up, was hidden under Duplicate · Move · Delete (#3990)",
    owner: "packages/platform-web/src/StickyBottomBar.tsx",
    scope: ["web/src/**/*.tsx", "packages/platform-web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /\bsticky\s+bottom-0\b|\bbottom-0\s+sticky\b/,
    use: "<StickyBottomBar className=\"…\">actions</StickyBottomBar>",
  },
  {
    kind: "owns",
    id: "input:drag-saves-once",
    what: "a control whose value moves while dragged (a colour swatch, a slider): DragInput in packages/platform-web/src/DragInput.tsx, which previews every tick and commits once on release",
    why:
      "the browser fires input on every tick of a drag and React's onChange is that event, so the record's colour field saved about " +
      "86 times in one minute on one filament, each with its own activity row (#3942); the digifab sensitivity slider did the same",
    owner: "packages/platform-web/src/DragInput.tsx",
    scope: ["web/src/**/*.tsx", "packages/platform-web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /(?<!\[)\btype=["'](?:color|range)["']/,
    use: "<DragInput control=\"color\" | \"range\" value onPreview onCommit />: onPreview for the live look, onCommit for the save",
  },
  {
    kind: "owns",
    id: "bridge:the-install-command",
    what: "the copy-ready command that installs a tunnel bridge (docker run and compose): bridgeInstallCommands in packages/platform-contract/src/edge-channel.ts",
    why:
      "two setup screens each hand-built the same install, so a line added to one (the host's name, so a bridge is not listed " +
      "as a container id) would have missed the other (#3904)",
    owner: "packages/platform-contract/src/edge-channel.ts",
    scope: ["web/src/**/*.tsx", "web/src/**/*.ts", "packages/platform-web/src/**/*.tsx", "packages/platform-web/src/**/*.ts", "modules/*/src/**/*.ts", "modules/*/src/**/*.tsx", "api/src/**/*.ts"],
    detect: /BRIDGE_RELAY_TOKEN[=:]/,
    use: "bridgeInstallCommands({ relayUrl, token, bridgeId }) from @cobblr/platform-contract/edge-channel",
  },
  {
    kind: "owns",
    id: "bridge:a-call-to-a-lan-service",
    what: "a fetch-shaped call a bridge performs on its own network: platform().edge.fetch (fetchViaEdge in api/src/platform/edge.ts)",
    why:
      "four modules each built their own source call on edge.send, each with its own body, headers and retry rules, and two " +
      "retried on an error text the kernel had reworded, so the retry never fired (#4034 S3a)",
    owner: "api/src/platform/edge.ts",
    scope: ["modules/*/src/**/*.ts", "api/src/**/*.ts"],
    detect: /\bsource:\s*\{\s*baseUrl\b/,
    use: "platform().edge.fetch(key, { baseUrl, path, method, headers, body, timeoutMs, lane }), which returns a Response",
  },
  {
    kind: "owns",
    id: "bridge:tells-offline-from-no-answer",
    what: "telling 'no bridge' from 'the bridge did not answer': the EdgeOffline and EdgeTimeout types in @cobblr/platform-contract",
    why:
      "the AI transits matched an edge error's words (/no edge device|edge disconnected/), the kernel reworded the message, and " +
      "a bridge's poll gap became a hard AI failure with nothing to show why (#4034 S3a)",
    owner: "packages/platform-contract/src/index.ts",
    scope: ["modules/*/src/**/*.ts", "api/src/**/*.ts", "web/src/**/*.ts", "web/src/**/*.tsx"],
    detect: /no edge device|edge disconnected|edge channel gone/i,
    use: "catch (e) { if (e instanceof EdgeOffline) … } from @cobblr/platform-contract",
  },
  {
    kind: "owns",
    id: "overlay:holds-the-page-still",
    what: "stopping the page scrolling behind an overlay: lockPageScroll / useLockPageScroll in packages/platform-web/src/scrollLock.ts",
    why:
      "html, body and #root are full height, so a menu that locked overflow on both <html> and <body> made the page one screen " +
      "long and threw it to the top on every open, drawing the menu offscreen (#3718); five overlays each locked it by hand",
    owner: "packages/platform-web/src/scrollLock.ts",
    scope: ["web/src/**/*.tsx", "web/src/**/*.ts", "packages/platform-web/src/**/*.tsx", "packages/platform-web/src/**/*.ts", "modules/*/src/ui/**/*.tsx"],
    detect: /(?:document\.body|document\.documentElement|\bhtml|\bbody)\.style\.overflow\s*=/,
    use: "useLockPageScroll(open), or lockPageScroll() and call what it returns",
    except: {
      "packages/platform-web/src/scrollLock.test.ts": "the lock's own test sets the page's starting state before it locks",
    },
  },
  {
    kind: "owns",
    id: "placement:keys-are-canonical",
    what:
      "where a record is: platform().placement (place / remove / containerOf / contents in api/src/index.ts), which stores and " +
      "reads every placement under the record's base kind, whatever spelling the caller holds",
    why:
      "a record placed as inventory:part and moved by the assistant as home-inventory:item got a second row, so the same desk fan " +
      "was in the Bedroom and the Garage at once and a lookup with the other spelling found neither (#3663)",
    owner: "api/src/index.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts"],
    detect: /core_placement_placements/,
    use: "platform().placement.place / remove / containerOf / contents, never the table",
    except: {
      "api/src/platform/placement-compare.ts":
        "the placement seam's atomic compare-and-write helper, called only after api/src/index.ts canonicalizes both refs",
      "api/src/platform/migrate-location-to-placement.ts":
        "the location trigger: it writes under its own table's kind, which is the base kind, the key the kernel reads by",
      "modules/core-placement/src/heal-instance-kinds.ts":
        "the one-shot heal that folds rows stored under a collection's kind onto the base kind (retires by its DONE WHEN)",
      "api/src/routes/test-support.ts":
        "the test-only door that plants a row as it was stored before the fix, so the heal's test has one to fold",
      "api/src/platform/heal-dangling-places.ts":
        "the one-shot heal that FINDS placements whose place no longer exists, a question the seam cannot ask without the place's " +
        "id; it only reads, and takes each thing out through platform().placement.remove (retires by its DONE WHEN)",
    },
  },
  {
    kind: "owns",
    id: "consumption:how-full-and-what-is-left",
    what:
      "how full a consumable is and what is left of it: consumptionGauge / remainingOf / amountPct in " +
      "@cobblr/platform-contract/consumption-gauge, which only ever divide two amounts in one unit",
    why:
      "the Consumption panel divided a count in skeins by the length of one skein in metres and printed \"2 skein left · of 200 " +
      "skein · 1%\" for two full skeins (#3648), and the assistant, reading the record's fields itself, said 200 m left of a skein " +
      "the page showed at 160 m (#3651)",
    owner: "packages/platform-contract/src/consumption-gauge.ts",
    scope: [
      "modules/inventory/src/ui/PartDetailPage.tsx",
      "modules/inventory/src/ui/PartsListPage.tsx",
      "modules/inventory/src/ui/consumption/perUnit.ts",
      "modules/inventory/src/api/resolvers.ts",
      "modules/inventory/src/api/parts.ts",
      "web/src/pages/Dashboard.tsx",
    ],
    // Something divided by a capacity: the shape every hand-rolled gauge had.
    // A comment's `//` does not count: the slash must not follow another.
    detect: /[^/*]\/\s*\(?\s*[\w.?]*[cC]apacity\b/,
    use: "consumptionGauge(item, units.lens) for a gauge, remainingOf(...) for what is left, from @cobblr/platform-contract/consumption-gauge",
  },
  {
    kind: "owns",
    id: "community:the-places-to-ask",
    what:
      "the community places a deployment offers (its Discord invite, forum, issue tracker, docs), as every menu and the " +
      "feedback widget show them: CommunityLinks in web/src/components/CommunityLinks.tsx, shown exactly when the server lists them",
    why:
      "the account menu, the phone menu and the feedback widget each read the list their own way, and the hosted app's " +
      "Discord ended up reachable only under the feedback widget and from no phone menu at all",
    owner: "web/src/components/CommunityLinks.tsx",
    scope: ["web/src/**/*.{ts,tsx}"],
    // A surface reading the places for itself.
    detect: /communityLinksFor\(|\.discord_invite_url\b|\.community_links\b/,
    use: "<CommunityLinks user={user} itemClassName=... heading=... /> from web/src/components/CommunityLinks.tsx",
    except: {
      "web/src/lib/community-links.ts": "the reader itself, which CommunityLinks calls",
      "web/src/lib/community-links.test.ts": "the reader's own test",
    },
  },
  {
    kind: "owns",
    id: "tiles:the-wall-grid",
    what:
      "the grid a wall of photo tiles sits in (galleries, card walls, the vending wall): TILE_GRID in " +
      "packages/platform-web/src/EntityTile.tsx, two across on a phone and ~180px slots above that",
    why:
      "each wall picked its own columns, so a desktop vending wall ran five tiles at ~370px while the machines wall ran " +
      "five fixed columns, and a fix to one never reached the others",
    owner: "packages/platform-web/src/EntityTile.tsx",
    scope: ["web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    // A tile wall choosing its own columns.
    detect: /lg:grid-cols-5|repeat\(auto-fill,\s*minmax\(/,
    also: /<EntityTile\b|<VendingTile\b|<GalleryTile\b/,
    use: "<div className={TILE_GRID}> from @cobblr/platform-web",
  },
  {
    kind: "owns",
    id: "views:a-views-records",
    what:
      "reading a saved view's records in the web app: useViewData in web/src/lib/useViewData.ts, which holds every record " +
      "(the server walks every page), carries the server's total and offers the rest past its cap",
    why:
      "each surface fetched a view its own way and counted what arrived: a board read \"50 3D printers\" of 56 and dropped a " +
      "column, a dashboard card counted a 500-row sample, an app's count stopped at 500 and its list at 100",
    owner: "web/src/lib/useViewData.ts",
    scope: ["web/src/**/*.{ts,tsx}"],
    // A surface fetching a view's data for itself.
    detect: /\bapi\.viewData\(/,
    use: "const data = useViewData(slug, viewId, kind) from web/src/lib/useViewData.ts; show data.total, place <ViewMore data={data} />",
  },
  {
    kind: "owns",
    id: "fields:a-collections-presentation",
    what:
      "how a collection presents its native fields (relabels, hides): useFieldPresentation in " +
      "packages/platform-web/src/field-presentation.tsx, which says `failed` rather than `nothing configured`, and the " +
      "PresentationGate an item's fields wait behind",
    why:
      "three copies of the reader (web, inventory, projects) drifted; two read a failed request as no overrides and cached it, " +
      "so the same Home Inventory lamp showed Min qty, Cost and Supplier URL through Locations and Paid and Make / brand " +
      "through its own list (#3645)",
    owner: "packages/platform-web/src/field-presentation.tsx",
    scope: ["web/src/**/*.{ts,tsx}", "modules/*/src/ui/**/*.{ts,tsx}"],
    // A presentation read of its own: a query over the overrides endpoint.
    detect: /queryKey:\s*\[\s*"native-field-overrides"|native-field-overrides\?kind=/,
    use: "useFieldPresentation(kind) from @cobblr/platform-web, and PresentationGate around an item's fields",
    except: {
      "web/src/pages/PresentationPage.tsx": "the settings page that EDITS a collection's overrides, not a surface that draws an item's fields",
      "web/src/pages/an-items-page-is-the-same-however-you-got-there.test.tsx": "the test's stand-in for the host's API (App.tsx's listNativeFieldOverrides), fetched as the host does",
    },
  },
  {
    kind: "owns",
    id: "views:a-rows-group",
    what:
      "which group a saved-view row belongs in: groupKeyOf / groupRows in web/src/lib/view-group-key.ts, for the full view's " +
      "renderers and the dashboard's preview of it alike",
    why:
      "the dashboard preview read fields[group_by] itself, which knows neither the reserved location key (a row's room) nor " +
      "the metadata a bundle's fields live under, so it told somebody to set a location on a lamp the full By room view, one " +
      "click away, grouped under its room (#3588); the full view had already been through the same two misreadings (#3341, #3391)",
    owner: "web/src/lib/view-group-key.ts",
    // The surfaces that group SAVED-VIEW rows. The module list pages (parts,
    // projects, assets, machines) group their own record shapes, not view rows,
    // and are a different affordance.
    scope: ["web/src/pages/Dashboard.tsx", "web/src/pages/ViewsPage.tsx"],
    // A row's group read straight off its fields by the view's group_by.
    detect: /\bfields\??\.?\[\s*(groupBy|group_by|view\.config)/,
    use: "groupRows(rows, groupBy, areaOf) (or groupKeyOf for one row) from web/src/lib/view-group-key.ts, with useAreaResolver",
  },
  {
    kind: "owns",
    id: "bundle:table-vocabulary",
    what:
      "the words a bundle's table routes with: the table's own PLUS the manifest's, deduped, through bundleTableWords, " +
      "never either list alone",
    why:
      "this drifted three times in three places. The scan offer merged both lists while the install wrote the table's alone, " +
      "so an installed Groceries knew 40 words where the offer knew 150; then a test built its tables the same short way and " +
      "pinned six answers the real router does not give, one of them the opposite of a change (#3219) that had shipped on " +
      "purpose, and stayed green because it could not see the words the change added (#3217)",
    owner: "packages/platform-contract/src/bundle-words.ts",
    // The readers that BUILD a table from a bundle manifest. A reader of an
    // already-built menu entry (the matchmaker, the resolver, the bench) inherits
    // the product's words and is correctly not here. Scope is explicit, which is
    // this registry's stated limit: a NEW file that reads bundles/*.json the
    // short way is not covered until it is listed.
    // modules/core-scan/src/services/sample-drink-routes-to-groceries.test.ts is
    // already right and is left out only because its one copy reads an object
    // bundleTableWords built, which the per-line detect cannot tell apart.
    scope: [
      "api/src/lib/flagship-bundles.ts",
      "api/src/routes/bundles.ts",
      "web/src/lib/suggest-featured.ts",
      "packages/platform-contract/src/table-fit.test.ts",
      "modules/core-ai/src/move-into-list.test.ts",
      "modules/core-scan/src/services/seasoning-routes-to-groceries.test.ts",
    ],
    // A table or instance config whose words are copied straight off another
    // object: the shape every one of the three drifts had.
    detect: /\bscan_keywords\s*:\s*[A-Za-z_$][\w$]*\.scan_keywords\b/,
    use: "bundleTableWords(instance.scan_keywords, manifest.scan_keywords) from @cobblr/platform-contract/bundle-words",
  },
  {
    kind: "owns",
    id: "scan:where-a-row-is-headed",
    what:
      "the question 'which table is this row headed to, and does the workspace have a better one': answered once by the resolver " +
      "(scanDestination / scanBetterTable over the router's rule in table-fit.ts), never re-derived on a surface",
    why:
      "the destination nudge was a third opinion outside the resolver, a one-whole-word rule with no plausibility floor and no " +
      "category, read from four places: every product whose brand is a fruit was offered Groceries (Apple iPhone, Orange SIM, " +
      "a Raspberry Pi board), and File all moved a person's chosen table by default (#3136). The doubt lint (#3058) owns 'is this " +
      "row ready and what is wrong'; this row owns 'where is it headed'; the next gap is a third question nobody has named",
    owner: "packages/platform-contract/src/scan-triage.ts",
    scope: [
      "packages/platform-contract/src/destination-label.ts",
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
      "web/src/pages/ScanPhoneRow.tsx",
      "web/src/pages/ScanItemScreen.tsx",
      "web/src/pages/scanFileAll.ts",
      "web/src/lib/scanCombine.ts",
      "web/src/lib/scanResolverTables.ts",
    ],
    // The router's fit rule asked directly, or a table's declared words
    // matched by hand against an item's words (the old nudge's shape).
    detect: /\b(rankFits|bestFit|betterDestination)\s*\(|\b(scan_keywords|keywords)\b[^\n]*\.(some|includes|find)\s*\(/,
    use: "scanRowState(row, { tables }).destination (replaced / offered) on a pending row, scanBetterTable(item, kind, tables) on a filed one; tables from web/src/lib/scanResolverTables.ts",
  },
  {
    kind: "owns",
    id: "identity:how-a-title-reads",
    what:
      "how a titled work's title READS for the person asking: composed once by the kernel for every served entity (served-title.ts, " +
      "from the request's actor) and by the scan inbox's withTitle for its rows; the web reads a served row as served",
    why:
      "the inbox composed its rows with the person's title preference while a filed record showed the stored name, so an item " +
      "page, a search result and the assistant each read the same book differently from the inbox (#3061). Two formatters " +
      "agreeing today drift next quarter, so a second call to the formatter outside the two composers is refused",
    owner: "api/src/platform/served-title.ts",
    scope: [
      "modules/core-scan/src/api/organize.ts",
      "modules/core-scan/src/api/duplicates.ts",
      "modules/core-search/src/api/index.ts",
      "modules/core-ai/src/api/chat.ts",
      "packages/workspace-tools/src/tools.ts",
      "api/src/routes/platform.ts",
      "api/src/platform/entities.ts",
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
      "web/src/pages/ScanItemScreen.tsx",
      "web/src/pages/ScanPhoneRow.tsx",
      "web/src/pages/RecordsPage.tsx",
      "web/src/components/SearchBar.tsx",
    ],
    // The formatter asked directly. The scan inbox's withTitle (inbox.ts) is
    // the one other composer and is not in scope by name; the Appearance
    // page previews the formats themselves on a sample, not a record.
    detect: /\bformatTitleVariants\s*\(/,
    use: "read `title` as served (the kernel composed it for this request); a row's forms are on `title_variants` beside it",
  },
  {
    kind: "owns",
    id: "scan:names-as-people",
    what: "whether two names name one PERSON (namesAgree) or one MAKER (brandsAgree): the surname shared and nothing else differing, erring toward asking",
    why:
      "the first comparator leaned toward 'same person' (any shared word, a four-letter prefix, initials dropped), so Amy Johnson agreed with John Smith " +
      "and A. Volkov with Sergei Volkov: a conflict suppressed with no hold, no sentence, no question (#3070, #3118); a local 'quick match' " +
      "written beside a route is exactly where that lean walks back in",
    owner: "packages/platform-contract/src/scan-evidence.ts",
    scope: [
      "packages/platform-contract/src/scan-triage.ts",
      "packages/platform-contract/src/display-identity.ts",
      "modules/core-scan/src/services/field-provenance.ts",
      "modules/core-scan/src/services/entity-match.ts",
      "modules/core-scan/src/services/matchmaker.ts",
      "modules/core-scan/src/services/enrich.ts",
      "modules/core-scan/src/services/enrich-photo.ts",
      "web/src/lib/scanCombine.ts",
      "web/src/pages/ScanInboxCard.tsx",
    ],
    // A comparator DEFINED for names, people or makers (a call to the owner's
    // is fine), or a Cyrillic-to-Latin table literal (the transliteration a
    // second copy would start by pasting).
    detect:
      /\bfunction\s+\w*(?:names?|authors?|creators?|persons?|people|makers?|brands?)(?:Agree|Match|Same|Equal|Alike)\w*\s*\(|\b(?:const|let)\s+\w*(?:names?|authors?|creators?|persons?|people|makers?|brands?)(?:Agree|Match|Same|Equal|Alike)\w*\s*=\s*(?:\(|async|function)|["']?[а-яё]["']?\s*:\s*["'][a-z]{1,4}["']\s*,\s*["']?[а-яё]["']?\s*:/i,
    use: "namesAgree(a, b) for people and brandsAgree(a, b) for makers, from @cobblr/platform-contract/scan-evidence",
  },
  {
    kind: "owns",
    id: "nav:hover-aware-open",
    what: "a menu that opens on hover and toggles on click: one rule for the click, since a click is a hover first",
    why:
      "the More navigation menu hand-rolled onMouseEnter to open and onClick to toggle over one open state; hover opened it as the " +
      "pointer arrived and the click a moment later shut it, so the first-time review and every automated browser saw a menu that " +
      "held nothing (#2797, 2026-09-12); after the fix nothing refused the next menu that did the same (#2923)",
    owner: "web/src/components/hover-aware-open.ts",
    scope: [
      "web/src/components/ModuleNav.tsx",
      "web/src/components/HeaderMenu.tsx",
      "web/src/components/UserMenu.tsx",
      "web/src/components/SidebarNav.tsx",
      "web/src/components/MobileNav.tsx",
      "web/src/components/CommandPalette.tsx",
      "web/src/components/Combobox.tsx",
      "packages/platform-web/src/EntityActionsBar.tsx",
    ],
    // A click handler that TOGGLES an open state ...
    detect: /onClick=\{[^}]*set\w*[Oo]pen\(\s*(?:\(?\s*\w+\s*\)?\s*=>\s*!\s*\w+|!\s*\w*[oO]pen\b)/,
    // ... in a file where a hover handler also opens one.
    also: /onMouseEnter=\{[^}]*(?:set\w*[Oo]pen\(\s*true|[oO]pen(?:Now|Menu)?\b)/,
    use: "useHoverAwareOpen() from web/src/components/hover-aware-open.ts: hoverOpen / hoverClose on the trigger, clickTrigger for the click",
  },
  {
    kind: "owns",
    id: "field-defs:roles-for-kind",
    what: "which field roles a kind wears in a workspace: read off the defs the record shows (its own, plus trait-scoped ones), never its base kind's",
    why:
      "the faces and actions resolvers each read module_field_defs rows for [kind, base] on their own; the Groceries bundle keeps a copy of its " +
      "food fields on the base kind, so every inventory instance in that workspace inherited expiry, turned perishable, and a Home Inventory " +
      "kettle offered Opened, Threw it out and Restock one from fields it did not have (#2849, 2026-09-13)",
    owner: "api/src/platform/field-defs.ts",
    scope: ["api/src/platform/faces.ts", "api/src/platform/actions.ts"],
    detect: /selectFrom\(\s*["']module_field_defs["']\s*\)/,
    use: "fieldRolesForKind(orgId, kind) from platform/field-defs.ts",
  },
  {
    kind: "owns",
    id: "impersonation:start",
    what: "starting a support ('View as') session: the member/admin/reason checks, the audit row, the activity-feed entry, the signed token",
    why:
      "there are two doors into this - the operator console over HTTP and the deploy box (view-as CLI) - and if either " +
      "re-implements the mint they drift; the copy that drifts is the one that quietly stops writing the activity-feed " +
      "entry, which is the whole reason impersonation is acceptable, and no test of the other door would catch it (2026-09-08)",
    owner: "api/src/platform/impersonation.ts",
    scope: ["api/src/routes/super-admin.ts", "api/src/cli/view-as.ts"],
    detect: /\.insertInto\(\s*["']impersonation_sessions["']/,
    use: "startImpersonation(input) from platform/impersonation.ts",
  },
  {
    kind: "owns",
    id: "activity:feed-verb",
    what: "the verb a feed row puts between who did it and what (\"created\", \"signed in\", \"ran an automation\")",
    why:
      "the dashboard's recent activity and the account's own log each kept a verb map, and they had drifted: only one " +
      "knew what an automation row says, so the same row read differently on two screens (found adding the trial carry's " +
      "row, 2026-09-22)",
    owner: "web/src/lib/activity-words.ts",
    scope: ["web/src/pages/Dashboard.tsx", "web/src/pages/MeActivityPage.tsx"],
    detect: /\bmoved_by_upgrade\s*:|\bpairing_created\s*:\s*["']linked["']/,
    use: "activityVerb(action) from lib/activity-words.ts",
  },
  {
    kind: "owns",
    id: "publish:does-this-path-ship",
    what: "the glob matcher that decides whether a path is in the public export (the manifest's include/exclude)",
    why:
      "the pre-commit guard carried its own copy of the export gate's matcher; the two agreed only by coincidence, and a " +
      "drift would let the pre-commit pass a path the export blocks or the reverse (#3421 survey, #3499)",
    owner: "scripts/publish/path-gate.mjs",
    scope: ["scripts/lint-public-clean.mjs", "scripts/publish/export-repo.mjs", "scripts/lint-public-readme-links.ts", "scripts/lint-dockerfile-copies-ship.ts"],
    detect: /function\s+globToRe\s*\(/,
    use: "compileGlobs / anyGlobMatch / shippedPaths from scripts/publish/path-gate.mjs",
  },
  {
    kind: "owns",
    id: "signature:ed25519-verify",
    what: "checking an ed25519 signature over bytes (the registry index, a module tarball, a file-preview renderer)",
    why:
      "four copies read a signature four ways (prefix stripped inside or by the caller; a malformed key false or a " +
      "throw that became a 500) and agreed only on what the registry writes today (#3421 survey, #3499). The image-build " +
      "installer keeps a copy it cannot avoid; scripts/signature-verdicts-agree.test.ts holds it to the same verdicts",
    owner: "packages/platform-contract/src/signature.ts",
    scope: ["api/src/routes/registry.ts", "api/src/routes/sandbox-install.ts", "modules/core-file-preview/src/api/renderers.ts"],
    detect: /\bcryptoVerify\s*\(|\bverify\s*\(\s*null\s*,/,
    use: "verifyEd25519(publicKeyB64, data, signature) from @cobblr/platform-contract/signature",
  },
  {
    kind: "owns",
    id: "feedback:card-post",
    what: "posting a feedback item's Discord card AND remembering its message id, so the same card can be edited as the item moves",
    why:
      "two places posted the card; one stored the id, one did not, and a Discord-origin ticket got a second, unlinked " +
      "'resolved' card hours later (2026-09-07). A post that forgets its id cannot be found again, and every later edit " +
      "silently falls back to a fresh card",
    owner: "api/src/routes/feedback-card-post.ts",
    scope: ["api/src/routes/feedback.ts", "api/src/routes/super-admin.ts", "api/src/routes/feedback-card.ts"],
    detect: /announce(ReturningMessage)?\(\s*["']feedback\.new["']/,
    use: "postFeedbackCard(feedbackId, payload) from routes/feedback-card-post.ts",
  },
  {
    kind: "owns",
    id: "web:hand-a-file-to-the-browser",
    what: "saving a Blob as a download: object URL, anchor, click, and revoking the URL only after the browser has had a chance to open it",
    why:
      "hand-rolled nine times, each with its own revoke timing and several revoking synchronously, which Safari can honour " +
      "before the download starts and quietly save nothing. The labels Save PNG path was the ninth copy (2026-09-07); a fix " +
      "to any of them had to be found and applied nine times",
    owner: "packages/platform-web/src/download-blob.ts",
    scope: [
      "web/src/components/ExportInboxModal.tsx",
      "web/src/components/BundleDetailModal.tsx",
      "web/src/pages/BundleComposerPage.tsx",
      "web/src/pages/OpenApiPage.tsx",
      "web/src/pages/BundlesPage.tsx",
      "web/src/pages/ApiRecipesPage.tsx",
      "web/src/pages/BackupPage.tsx",
      "modules/inventory/src/ui/api.ts",
      "modules/labels/src/ui/downloadPng.ts",
    ],
    detect: /\.download\s*=/,
    use: "downloadBlob(blob, filename) from @cobblr/platform-web",
  },
  {
    kind: "owns",
    id: "sandbox:whose-row-it-is",
    what:
      "deciding whether a sandbox's row is an example it came with or something the person made: examplesOf / " +
      "madeByThePerson in api/src/platform/trial-ledger.ts, and leaveOut in api/src/platform/take-provenance.ts",
    why:
      "the take decided by comparing each row's timestamp with the hand-over, and a row the platform wrote a moment " +
      "after it (a label code for a sample part) carried that part out as the person's own; the log says who made " +
      "a thing, a clock only says when",
    owner: "api/src/platform/trial-ledger.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.{ts,tsx}"],
    // Reading the hand-over instant to sort rows by it.
    detect: /\bhandedOverAt\(/,
    use: "examplesOf(orgId) / madeByThePerson(orgId) from api/src/platform/trial-ledger.ts",
    except: {
      "api/src/platform/try-sandbox-export.ts": "hands the line to the take, whose own rule (leaveOut) asks the log who made each row",
    },
  },
  {
    kind: "owns",
    id: "csv:a-spreadsheet-cell",
    what:
      "writing a CSV cell or file (quoting, the formula guard, line ends, the byte order mark): csvCell / toCsv / " +
      "csvDownloadHeaders in packages/platform-contract/src/csv.ts, and unguardCsvText to read a guarded cell back",
    why:
      "three exporters each kept their own cell writer and they drifted: one did not quote a carriage return, and none " +
      "guarded a record named like =HYPERLINK(...), which a spreadsheet runs as a formula when the export is opened",
    owner: "packages/platform-contract/src/csv.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.{ts,tsx}", "web/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
    // A hand-rolled CSV quote: doubling the quotes inside a cell.
    detect: /replace\(\/"\/g,\s*['"`]""['"`]\)/,
    use: 'csvCell(value) / toCsv(header, rows) from "@cobblr/platform-contract/csv"',
    except: {
      "api/src/sandbox/module-role.ts": "quotes a Postgres identifier (a role name), not a spreadsheet cell",
    },
  },
  {
    kind: "owns",
    id: "scan:picture-options-pool",
    what: "the ladder for a web picture: library first for fresh things, the engine one ask at a time, the shop-less retry, the library when the engine refuses, and the refusal reported",
    why:
      "three surfaces searched on their own (the catalog tile, the entity picker, the inbox card's strip). The picker " +
      "got the second source and the honest 'not answering' flag; the inbox card kept calling the engine alone and " +
      "folding every failure into an empty list, so it said nothing found for \"Apple Cider\" under a catalog tile the " +
      "library had just filled with two glasses of it (2026-09-07). Any surface that reaches the engine or the library " +
      "directly is the next one to drift",
    owner: "modules/core-scan/src/services/picture-options.ts",
    scope: [
      "modules/core-scan/src/api/entity-image.ts",
      "modules/core-scan/src/api/inbox.ts",
      "modules/core-scan/src/services/enrich-photo.ts",
      "modules/core-scan/src/services/enrich.ts",
      "modules/core-scan/src/services/auto-rank.ts",
      "modules/core-scan/src/services/entity-image.ts",
      "modules/core-scan/src/services/pictures-sweeper.ts",
      "modules/core-scan/src/services/barcode-websearch.ts",
    ],
    detect: /\b(searchImages|searchCommonsImages)\s*\(/,
    use: "pictureOptions({ query, name, plainQuery, brand, color, fresh, limit }) from services/picture-options.ts, and pass its throttled flag through to the strip",
  },
  {
    kind: "owns",
    id: "scan:target-from-kind",
    what: "turning a kind (a module's kind, or an instance kind like groceries:item) into a scan target: the module's scannable plus the instance it names",
    why:
      "scannability is registered per MODULE kind and a tracked match is reported under the kind it lives in, so a route " +
      "that looked the request's kind up directly answered 'groceries:item is not a scan target' on every re-buy button " +
      "(2026-09-12). Confirm had grown its own fallback for the same miss in June and attach never did; a third spelling " +
      "sat in the matcher. And the LIST has the same blind spot the other way: listScannable() is the registry of BASE " +
      "kinds, so a walk over it to read records saw no grocery and no yarn and looked like it worked, in the sibling tier, " +
      "the Organize plan, the bin census and the per-kind duplicates door (#3132), after a comment in one of them had " +
      "said exactly that. Only the owner asks the kernel's scannable registry, whatever the argument is called",
    owner: "modules/core-scan/src/services/scan-target.ts",
    scope: [
      "modules/core-scan/src/api/inbox.ts",
      "modules/core-scan/src/api/duplicates.ts",
      "modules/core-scan/src/api/entity-image.ts",
      "modules/core-scan/src/api/organize.ts",
      "modules/core-scan/src/services/entity-match.ts",
      "modules/core-scan/src/services/matchmaker.ts",
      "modules/core-scan/src/services/suggest-location.ts",
      "modules/core-scan/src/services/organize-plan.ts",
      "modules/core-scan/src/services/putaway-route.ts",
      "modules/core-scan/src/services/reroute-keyword-rows.ts",
    ],
    detect: /\b(getScannable(ForModule)?|listScannable(ForOrg)?)\s*\(/,
    use:
      "scanTargetOf(orgId, kind, instance?, module?) for a request's kind, scanTargetOfRecord({ kind, module_name }) for a registry record, " +
      "scanTargetsForOrg(orgId) to walk the kinds that hold records in a workspace, scanTargetsRegistered() for the module-level list; all from services/scan-target.ts",
  },
  {
    kind: "owns",
    id: "scan:quantity-through-the-door",
    what: "moving a scannable record's count from a scan route: the kind's adjust action (its lots, floor and ledger) when it declares one, else its module route; and the one count a create starts with",
    why:
      "a scan attach bumped the count with a PATCH of the quantity field, a bare number: the milk you just scanned kept last week's " +
      "dates and no lot was started, while a check-off on the same record dated a fresh one (2026-09-12). The bin adjust and the " +
      "undo had their own PATCH too. A quantity key spelled in a scan route is the next path back to the bare write",
    owner: "modules/core-scan/src/services/scan-target.ts",
    scope: ["modules/core-scan/src/api/inbox.ts", "modules/core-scan/src/api/putaway.ts", "modules/core-scan/src/services/autofile.ts"],
    detect: /\[[^\]\n]*(qty(_f|F)ield|\bfield)[^\]\n]*\]\s*[:=]/,
    use: "moveQuantity(orgId, target, entity, delta, { restock, reason, source, door, current }) and startingCount(scannable, qty) from services/scan-target.ts",
  },
  {
    kind: "owns",
    id: "scan:payload-classifier",
    what: "what a scan payload IS (a Cobblr label, a retail code, another symbol, a web link, words) and so where it goes",
    why:
      "three doors take a payload (the lens, the typed field beside it, the inbox's paste box, plus a hardware wedge) " +
      "and each read it its own way: the camera routed a Cobblr label URL to the place, the typed field posted the " +
      "same URL as a barcode and made a pending item named 'Cobblr' (the 2026-09-13 review, #2850)",
    owner: "web/src/lib/scanPayload.ts",
    scope: [
      "web/src/pages/ScanCameraPage.tsx",
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
      "web/src/pages/omniIntake.ts",
      "web/src/pages/ScanResultModal.tsx",
      "web/src/pages/ScanCaptureDrawer.tsx",
      "web/src/components/ManualScanField.tsx",
      "web/src/components/GlobalScanWedge.tsx",
      "web/src/components/LiveSortSheet.tsx",
    ],
    detect: /qrTokenFromUrl\(|isGenericLink\(|\^\\d\{8,14\}\$/,
    use: "classifyScanPayload(raw) / typedVerdict(raw) from lib/scanPayload.ts",
  },
  {
    kind: "owns",
    id: "photo:add-to-record",
    what: "letting a person add a photo to something: usePhotoPick in packages/platform-web/src/photo-capture.tsx, which opens the app's camera on a phone and the file picker elsewhere",
    why:
      "every record surface hand-rolled <input type=file accept=\"image/*\">, which on a phone is the OS chooser, library first, " +
      "a detour away from the thing in front of you and past the app's own camera (#4140, the #4115 audit)",
    owner: "packages/platform-web/src/photo-capture.tsx",
    scope: ["web/src/**/*.tsx", "packages/platform-web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /accept=["']image\/\*["']/,
    use: "usePhotoPick(onFiles, { title, label, multiple?, camera? }) from @cobblr/platform-web: call pick() from your button and render input once; camera: false for a picture that is not a photo of the thing (a catalog image, a screenshot)",
    except: {
      "web/src/components/FeedbackWidget.tsx": "attaches a screenshot of the app to a report; the library is the right first choice",
      "web/src/components/ThemeEditor.tsx": "a workspace logo is a file you already have, never a photo taken now",
      "web/src/pages/ScanCameraPage.tsx": "the camera page's hidden test door, used by the e2e suite to feed a picture without a camera",
    },
  },
  {
    kind: "owns",
    id: "scan:repurchase-answers",
    what: "the three answers to 'you already have one of these': Replaced the one that ran out / +N, still had some / Old one went bad, and which of them leads",
    why:
      "two surfaces show a tracked match (the closed inbox card's line and the open card's banner) and each drew its " +
      "own buttons. Within a day of the banner gaining the three answers, the card still showed the retired 'this buy " +
      "was' chips and a bare '+1 to it' (2026-09-09); the answer a person needed most was on the surface they open least",
    owner: "web/src/components/RepurchaseControls.tsx",
    scope: [
      "web/src/components/TrackedMatchBanner.tsx",
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
      "web/src/pages/ScanResultModal.tsx",
      "web/src/pages/ScanCaptureDrawer.tsx",
    ],
    detect: /Replaced the one that ran out|still had some|Old one went bad|This buy was|mode:\s*["']replace["']/,
    use: "<RepurchaseAnswers itemId match quantity onDone /> from components/RepurchaseControls.tsx",
  },
  {
    kind: "owns",
    id: "scan:tracked-match-nudges",
    what: "the two things to say while a scan and the record it matched are both in view: it is filed in the wrong list, it has no picture yet",
    why:
      "the nudges shipped in the banner only, so the closed card, the surface people act from, never offered the move " +
      "or the picture; a second hand-drawn copy would drift the way the answers did (2026-09-09)",
    owner: "web/src/components/TrackedMatchNudges.tsx",
    scope: [
      "web/src/components/TrackedMatchBanner.tsx",
      "web/src/components/RepurchaseControls.tsx",
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
      "web/src/pages/ScanResultModal.tsx",
    ],
    detect: /Move it to \{|Use this scan|listMismatch\(|pictureOffer\(/,
    use: "<TrackedMatchNudges item match /> from components/TrackedMatchNudges.tsx",
  },
  {
    kind: "requires-prop",
    id: "picture-strip:reports-the-wall",
    what: "telling a pre-fetched ImageSearchPicker whether the engine refused",
    why:
      "a strip not told it can only say 'nothing found', which is a claim about the product; the inbox card said exactly " +
      "that under a tile the library had just filled (2026-09-07)",
    component: "ImageSearchPicker",
    required: ["throttled"],
    scope: ["web/src/pages/ScanInboxCard.tsx"],
  },
  {
    kind: "owns",
    id: "clipboard:image-reader",
    what: "reading the image files off a pasted clipboard",
    why:
      "there were four hand-rolled copies and three different answers. Two read only clipboardData.items, one read " +
      "only .files, and which list a browser fills depends on the browser and on whether the picture was copied from " +
      "a page or from a file manager - so on the wrong pairing the paste was dropped with no error, no toast and " +
      "nothing in the console, which is indistinguishable from the feature not existing (2026-09-03). A paste that " +
      "silently does nothing is the one bug a person cannot report usefully, so the reading of it has one owner that " +
      "checks both lists and is tested against both",
    owner: "web/src/components/pastedImage.ts",
    scope: [
      "web/src/components/EntityAttachments.tsx",
      "web/src/components/FeedbackWidget.tsx",
      "web/src/components/ImageLightbox.tsx",
      "web/src/components/ImageSearchPicker.tsx",
      "web/src/pages/omniIntake.ts",
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
    ],
    detect: /clipboardData\s*[?.]*\.\s*(items|files)\b/,
    use: "clipboardImageFiles(e.clipboardData) from pastedImage.ts, or readPastedImage(payloadFromClipboard(...)) when an address counts too",
  },
  {
    kind: "owns",
    id: "browser:local-network-door",
    what: "reaching an address on the visitor's own machine from the browser",
    why:
      "the Live box polls the local print bridge on 127.0.0.1 and is passed a poll interval of 0 while closed - its call " +
      "site says a closed box has no reason to be asking anything - and the hook did one read BEFORE it consulted the " +
      "interval. One request, but that box follows you across every page, so it was every visitor on their first screen: " +
      "a browser that gates local network access asked strangers whether the site could reach other apps on their device " +
      "before they had clicked anything (2026-08-29). These three files exist to talk to local hardware, so a raw fetch " +
      "here is exactly how the next one gets added without a gate",
    owner: "packages/platform-web/src/local-network.ts",
    scope: [
      "packages/platform-web/src/bridge-printer.ts",
      "packages/platform-web/src/bridge-live.ts",
      "web/src/components/DesktopAppCard.tsx",
    ],
    detect: /(?<!local)(?<![.\w])fetch\s*\(/,
    use: "localFetch() from local-network.ts, which refuses until somebody has asked for something on this machine",
  },
  {
    kind: "owns",
    id: "edge:channel-key",
    what: "how a bridge is addressed: the edge channel key (`<orgId>`, `<orgId>::<name>`, or the owner's user id) and the bridge name inside it",
    why:
      "seven files derived the key, each with its own idea of the name: the receiving doors capped it at 60 characters, core-print trimmed it and " +
      "did not cap, the rest did neither. A bridge whose name ran past 60 or carried a space registered on one key and was sent to on another, and " +
      "a send to a channel nobody holds reads exactly like a bridge that is offline (#3499)",
    owner: "packages/platform-contract/src/edge-channel.ts",
    scope: [
      "api/src/platform/edge.ts",
      "api/src/routes/edge.ts",
      "modules/digifab/src/jobs-core.ts",
      "modules/digifab/src/api/edge-relay.ts",
      "modules/core-print/src/edge.ts",
      "modules/core-integrations/src/sync/edge-fetch.ts",
      "modules/core-ai/src/providers/edge-transit.ts",
      "modules/core-shipments/src/drivers/edge-transit.ts",
      "modules/core-shipments/src/drivers/connection.ts",
      "api/src/platform/user-credentials.ts",
    ],
    // A key built by hand (`${org}::${name}`), a bridge name cut by hand, or a
    // transit setting read by hand.
    detect: /::\$\{|\.slice\(0,\s*60\)|\.slice\((?:7|"bridge:"\.length)\)|\.startsWith\(\s*["']bridge/,
    use: 'import { edgeChannelKey, edgeBridgeName, edgeTransit, edgeRouteKey } from "@cobblr/platform-contract/edge-channel"',
  },
  {
    kind: "owns",
    id: "sandbox:countdown-mount",
    what: "mounting the sandbox countdown bar and its Keep this workspace button",
    why:
      "it was mounted in AppLayout's sidebar foot, which only renders in full-sidebar mode. In the default top-nav " +
      "layout it never mounted at all, so a visitor on a workspace that deletes itself in an hour saw no clock and had " +
      "no way to keep it, and the whole thing simply vanished with their work in it (found 2026-08-29 by looking at " +
      "the screenshot). The bar portals to <body>, so its place in the tree decides nothing except WHETHER it mounts - " +
      "which is exactly why putting it inside a layout branch is silently wrong rather than visibly wrong",
    owner: "web/src/App.tsx",
    scope: ["web/src/components/AppLayout.tsx"],
    detect: /<SandboxBar\b/,
    use: "leave it at the app root in App.tsx, where it mounts in every nav mode",
  },
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
    id: "entities:list-text-search",
    what: "the where clause a list resolver builds for `q`: case-insensitive substring over every text column the kind carries",
    why:
      "every module hand-rolled it and each chose its own columns - machines matched the name only, sales the name only, " +
      "tags the name, purchase lines the description. To a person 'the Bambu one' is a manufacturer and 'my deltas' a type, " +
      "and to the assistant q is a text search, so a name-only resolver answered 'you have no Bambu' about a workspace with " +
      "one (2026-08-27). The clause is identical everywhere; only the column list belongs to the module",
    owner: "packages/platform-contract/src/index.ts",
    scope: [
      "modules/purchases/src/api/resolvers.ts",
      "modules/projects/src/api/handlers.ts",
      "modules/core-tags/src/api/resolvers.ts",
      "modules/sales/src/api/resolvers.ts",
      "modules/core-locations/src/api/resolvers.ts",
      "modules/core-catalogs/src/api/resolvers.ts",
      "modules/inventory/src/api/resolvers.ts",
      "modules/machines/src/api/resolvers.ts",
      "modules/assets/src/api/resolvers.ts",
      "modules/lists/src/api/resolvers.ts",
      "modules/knowledge/src/api/resolvers.ts",
    ],
    // A hand-rolled like: lower(<col>) like <needle>, in either the builder or raw-sql spelling.
    detect: /eb\.fn\(\s*["']lower["'][^\n]*["']like["']|lower\([a-z_.>'"-]+\)\s+like/i,
    use: "textSearchWhere(eb, query.q, { text: [...], json: [...] }) from @cobblr/platform-contract",
  },
  {
    kind: "owns",
    id: "entities:metadata-write-shape",
    what: "how a record write reaches its `metadata` bag: unknown keys lifted in, server-managed keys kept, the bag read back from an object or a jsonb string",
    why:
      "six modules and two kernel files each carried a copy of routeUnknownToMetadata / preserveServerManaged / coerceMetadata, identical " +
      "only by care: the purchases copy's header promised to share it once a shared package existed, and the contract has been that package " +
      "for a long time (#3499)",
    owner: "packages/platform-contract/src/entity-metadata.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts"],
    detect: /\bfunction\s+(?:routeUnknownToMetadata|preserveServerManaged|coerceMetadata)\b/,
    use: 'import { routeUnknownToMetadata, preserveServerManaged, coerceMetadata } from "@cobblr/platform-contract/entity-metadata"',
  },
  {
    kind: "owns",
    id: "instances:request-instance",
    what: "which instance a module request is for: the one resolveInstance stamped, else the module's own name (the column default)",
    why:
      "seven modules cast the request to read `instance` themselves; one that fell back to anything but its column default would read the " +
      "default instance's rows as another's, or none (#3499)",
    owner: "packages/platform-contract/src/request-instance.ts",
    scope: ["modules/*/src/**/*.ts"],
    detect: /\{\s*instance\?:\s*string\s*\}\s*\)\s*\.instance\b/,
    use: 'import { requestInstance } from "@cobblr/platform-contract/request-instance"; instanceOf(req) = requestInstance(req, "<module>")',
  },
  {
    kind: "owns",
    id: "connections:unverified-refusal",
    what: "the 409 a key-saving door answers when the probe rejected the key, or could not settle a replacement, and the person has not said save it anyway",
    why:
      "the personal-connection door and the workspace AI-provider door each built the refusal, and the settings panel reads its codes " +
      "(key_invalid / key_unverifiable) from both: two copies of the body are two chances for one door to say it differently (#3499)",
    owner: "packages/platform-contract/src/connection-verification.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts"],
    detect: /\bfunction\s+refuseUnverified\b|"key_unverifiable"/,
    use: 'res.status(409).json(unverifiedRefusal(verification)) from "@cobblr/platform-contract/connection-verification"',
  },
  {
    kind: "owns",
    id: "web:relative-time",
    what: "saying how long ago something happened in the web UI (\"just now\", \"5m ago\", \"3h ago\", \"4d ago\", a date)",
    why:
      "five page-local copies had drifted into three voices (\"5m ago\", \"5 min ago\", \"5 h ago\") and two cut-offs for switching to a " +
      "date, so one screen said a thing happened \"2 days ago\" and the next \"2d ago\" (#3499)",
    owner: "packages/platform-web/src/relativeTime.ts",
    scope: ["web/src/**/*.ts", "web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /\$\{[^}]+\}\s?(?:m|min|mins|h|hrs?|d|days?|mo)\s+ago\b/,
    except: {
      "web/src/features/digifab/fleet.tsx": "fmtFileDate pairs a printer file's calendar date with a day-count hint (\"3d ago · 26 Feb 2023\"), in the machine's local time with no zone",
    },
    use: 'import { relativeTime } from "@cobblr/platform-web"',
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
    id: "ai:answer-text",
    what: "reading the words of an AI answer: `platform().ai.invoke(...).text`, worked out once by aiAnswerText, whichever key the adapter used",
    why:
      "adapters answer chat as `content` and summarise and the vision jobs as `text`, and the seam typed the answer `unknown`. Fifteen callers " +
      "hedged with both keys in both orders; five read only `content` and were right only because each asked for chat, so moving one to a job " +
      "that answers `text` would have read an empty answer and degraded silently (#3499)",
    owner: "packages/platform-contract/src/ai-answer.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts", "modules/*/src/**/*.tsx"],
    // A caller casting the answer to one of the two keys, or reading either off `.result`.
    detect: /\bas\s*\{\s*(?:content|text)\?:\s*string;?\s*(?:(?:content|text)\?:\s*string;?\s*)?\}|\.result\)?\??\.(?:text|content)\b/,
    except: {
      "modules/core-ai/src/api/none-from-one-list.test.ts": "reads the chat transcript's messages, which are the conversation, not an answer from invoke",
      "api/src/platform/a-chat-on-a-canary-is-answered-by-the-canary-never-its-release.test.ts": "reads an MCP tools/call result's content blocks, the protocol's own answer shape, not an answer from ai.invoke",
    },
    use: "read `r.text` off the invoke result (tool calls and vectors stay on `r.result`)",
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
    id: "shell:desktop-width",
    what: "deciding, live, whether the window is at the desktop breakpoint (md, 768px)",
    why: "the full-sidebar layout was a choice with no width in it, so below md the sidebar hid and took the verify card, Feedback and the toast stack's home with it; the next JS gate on width must read the one query, not grow its own (#3326, 2026-09-21)",
    owner: "web/src/lib/useIsDesktopWidth.ts",
    scope: [
      "web/src/components/AppLayout.tsx",
      "web/src/components/SidebarNav.tsx",
      "web/src/components/MobileNav.tsx",
      "web/src/components/LiveBox.tsx",
      "web/src/components/EmailVerifyBanner.tsx",
      "web/src/tour/GuidedTour.tsx",
      "web/src/lib/nav-layout.ts",
    ],
    detect: /matchMedia(\?\.)?\(\s*["'`]\(min-width:\s*768px\)/,
    use: "useIsDesktopWidth() from web/src/lib/useIsDesktopWidth",
  },
  {
    kind: "owns",
    id: "shell:full-sidebar",
    what: "deciding whether the window gets the full-sidebar shell (nav in the sidebar, no top bar, desktop width)",
    why: "App.tsx carried its own copy of AppLayout's rule (\"same derivation AppLayout uses\"), so when the width joined the rule in one place the Feedback pill and the labels basket kept the old one and stayed hidden at 720 in Sidebar only (#3326, 2026-09-21)",
    owner: "web/src/lib/nav-layout.ts",
    scope: [
      "web/src/App.tsx",
      "web/src/components/AppLayout.tsx",
      "web/src/components/SidebarNav.tsx",
      "web/src/components/MobileNav.tsx",
      "web/src/components/LiveBox.tsx",
      "web/src/components/FeedbackWidget.tsx",
      "web/src/components/WorkspaceStateBar.tsx",
      "web/src/tour/GuidedTour.tsx",
    ],
    detect: /navMode\s*===\s*["'`]side["'`]\s*&&\s*!\s*navTopBar/,
    use: "isFullSidebar({ navMode, navTopBar, appMode, desktopWidth }) from web/src/lib/nav-layout",
  },
  {
    kind: "owns",
    id: "scan-triage:needs-a-human",
    what: "deciding whether a pending capture still needs a person to look at it",
    why: "the predicate lived inline in the Scan page, so the API could not filter by it and Ask Cobb could not read it — and the page's own second copy had already drifted, flagging items a human had marked \"looks fine\" (2026-08-14)",
    owner: "packages/platform-contract/src/scan-triage.ts",
    scope: [
      "web/src/pages/ScanPage.tsx",
      "web/src/pages/ScanInboxCard.tsx",
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
      "web/src/pages/ScanInboxCard.tsx",
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
  {
    kind: "owns",
    id: "fields:edit-field",
    what: "the blur-to-commit field a record page edits a native column with (EditField, EditSelect), and the caption over any control beside one (FieldLabel, LabeledField)",
    why:
      "the 2026-09-16 review started from a survey that found EditField written four times (assets, machines, purchases, " +
      "records), each drifting on its own: one had lost `numeric`, one `type`, and every one carried `col-span-2` for its " +
      "multiline case, a layout decision the field made for the grid around it. #3107 replaced the four with the one in " +
      "platform-web and gave the span to the packer; a fifth copy is how the survey's finding comes back",
    owner: "packages/platform-web/src/EditField.tsx",
    scope: [
      "web/src/pages/AssetsPage.tsx",
      "web/src/pages/MachinesPage.tsx",
      "web/src/pages/PurchasesPage.tsx",
      "web/src/pages/RecordsPage.tsx",
      "web/src/pages/LocationDetailPage.tsx",
      "web/src/pages/BundleComposerPage.tsx",
      "web/src/pages/BundlesPage.tsx",
      "web/src/pages/MeNotificationChannelsPage.tsx",
      "modules/inventory/src/ui/NewPartDialog.tsx",
      "modules/inventory/src/ui/PartDetailPage.tsx",
    ],
    detect: /\b(function|const)\s+(EditField|EditSelect|FieldLabel|LabeledField|InlineText|InlineTextarea)\b/,
    use: "import { EditField, EditSelect, LabeledField, editFieldItem } from \"@cobblr/platform-web\" and render the fields through <FieldPack>",
  },
  {
    kind: "owns",
    id: "scan:unresolved-is-not-absent",
    what: "writing a barcode lookup's answer to the SHARED barcode cache, the one every workspace reads: only a DURABLE outcome (hit, miss) may be written",
    why:
      "a throttled, refused or unreachable catalog is UNRESOLVED, not absent, and a miss cached from one stands in the workspace " +
      "with no expiry and in every workspace for thirty days. The outcome type carried a comment saying not to cache `unavailable` " +
      "and the caller cached it anyway for a year; every provider mapped a 5xx or the network to miss; the book door's null meant " +
      "both. decodeVin had the right shape (unavailable, never cached) beside them and nobody was pointed at it (2026-09-17, #3179). " +
      "So the writers live in one file and take DurableBarcodeOutcome, which durableOutcome() alone produces: a comment asked, the type refuses",
    owner: "modules/core-scan/src/services/enrich.ts",
    scope: [
      "modules/core-scan/src/services/barcode-lookup.ts",
      "modules/core-scan/src/services/barcode-cache.ts",
      "modules/core-scan/src/services/barcode-websearch.ts",
      "modules/core-scan/src/services/enrich-photo.ts",
      "modules/core-scan/src/services/scan-router.ts",
      "modules/core-scan/src/services/retry-lookup.ts",
      "modules/core-scan/src/services/hosted-identify.ts",
      "modules/core-scan/src/services/identify-identifier.ts",
      "modules/core-scan/src/services/catalog-replay.ts",
      "modules/core-scan/src/api/inbox.ts",
      "modules/core-scan/src/api/decode.ts",
      "modules/core-scan/src/api/handlers.ts",
    ],
    detect: /\.sharedCache\.put\(\s*BARCODE_NS\b/,
    use: "return the outcome to enrich.ts; a new writer goes beside cacheDurable/cacheHit there and takes DurableBarcodeOutcome (durableOutcome(result) is the one filter). A workspace's own photo-proven identity is rememberLocalIdentity, tenant cache only",
  },
  {
    kind: "owns",
    id: "lints:strip-comments",
    what: "blanking comments out of source before a lint matches it: one scanner, lib/source-scan.ts's stripComments, which knows where a comment starts",
    why:
      "a regex pair (block comments first, then line comments) cannot tell a `/*` inside a string or a line comment from a real one, so it " +
      "opens a comment that runs to the next `*/` anywhere in the file: it blanked 419 lines of ScanPage.tsx and the capability rules " +
      "reported clean over code they had never read (2026-08-22). The scanner replaced it there; three lints kept private copies and were " +
      "blind to hundreds of lines of the code they guard, rule C of module isolation to 59 lines of server.ts (#3476)",
    owner: "scripts/lib/source-scan.ts",
    scope: ["scripts/lint-*.ts", "scripts/lib/*.ts", "scripts/lib/*.mjs"],
    // The regex pair's opening half (a lazy block match), or a private stripper
    // by name. A bare `/\/\*$/` (a route's `/*` suffix) is not a stripper.
    detect: /\bfunction\s+stripComments\b|\bconst\s+stripComments\s*=|\.replace\(\/\\\/\\\*\[(?:\\s\\S|\^)\]\*\?/,
    except: {
      "scripts/lint-deprecated-table-fks.ts": "strips SQL (`--` and block comments) from migrations; SQL is not the language the scanner reads",
      "scripts/lint-migration-additive.ts": "strips SQL, dollar-quoted bodies and quoted literals from migrations; not TypeScript",
      "scripts/lint-fixed-chrome.ts": "the regex here is checkCss, over stylesheets: CSS has no `//` comments, and a `url(http://…)` would read as one to the TS scanner",
      "scripts/lint-inline-style-overrides.ts": "strips comments from CSS, which has only block comments; the TS scanner would take `//` in a url() for a line comment",
    },
    use: 'import { stripComments } from "./lib/source-scan.js" (from scripts/lib: "./source-scan.js")',
  },
  {
    kind: "owns",
    id: "entity:metadata-merge",
    what:
      "a record update's write to its custom-field bag (`metadata`): the kernel merge, platform().db.mergeJsonb, reached " +
      "through withMetadataMerged, which sets the keys sent, removes the nulled ones and leaves the rest as the live row holds them",
    why:
      "three quick edits to one Home Inventory item each sent the bag as the page had rendered it plus one field, and the " +
      "PATCH replaced the bag with it, so only the last survived and the other two were lost with a 200 each (#3625); assets, " +
      "records, machines, orders, projects, lists and more replaced the same way, and one hoisted field could wipe the rest",
    owner: "api/src/platform/jsonb-merge.ts",
    scope: ["modules/*/src/api/**/*.ts", "api/src/routes/**/*.ts"],
    // A metadata value assigned into an update patch other than the merge, or a
    // request body spread straight into an update's set.
    detect: /patch\.metadata\s*=(?!\s*platform\(\)\.db\.mergeJsonb)|\.set\(\s*\{\s*\.\.\.(patchRest|parsed\.data)\b|=\s*\{\s*\.\.\.(patchRest|parsed\.data)\b/,
    use:
      'wrap the update\'s set in withMetadataMerged(set, serverManagedNames) from "@cobblr/platform-contract/entity-metadata", ' +
      'or assign platform().db.mergeJsonb("metadata", fields)',
    except: {
      "modules/assets/src/api/sync-writer.ts": "a sync applies the remote record's whole state; replacing is how a key removed at the source goes",
      "modules/inventory/src/api/sync-writer.ts": "a sync applies the remote record's whole state; replacing is how a key removed at the source goes",
      "modules/machines/src/api/sync-writer.ts": "a sync applies the remote record's whole state; replacing is how a key removed at the source goes",
      "modules/core-locations/src/api/sync-writer.ts": "a sync applies the remote record's whole state; replacing is how a key removed at the source goes",
      "modules/core-scan/src/api/inbox.ts": "builds a REQUEST body for the owning module's PATCH (which merges), holding only the keys the scan adds",
      "modules/digifab/src/api/failure.ts": "a failure-detection config row with no custom-field bag; an upsert of plain columns",
    },
  },
  {
    kind: "owns",
    id: "web:metadata-edit-sends-changed-keys",
    what: "an edit to a record's custom fields sends only the keys it changes; the server merges them into the live row",
    why:
      "a detail page sent `{ metadata: { ...p.metadata, [name]: value } }` from the bag it had rendered, so an edit made before " +
      "the last one's refetch wrote the stale values back over it, even with the server merging (#3625)",
    owner: "packages/platform-contract/src/jsonb-merge.ts",
    scope: ["web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /\bmetadata:\s*\{\s*\.\.\./,
    use: "send `{ metadata: { [name]: value } }`; a null removes the key",
  },
  {
    kind: "owns",
    id: "integrations:outbound-connector-is-a-service",
    what: "registering an outbound connector (Slack, Discord, webhook, HTTP, any new one): registerOutboundConnector registers it for wires AND as one built-in service per action",
    why:
      "the connectors were services in everything but name, yet only a wire could reach them: Cobb and MCP could not see a Slack post, and nothing asked a person before one ran. " +
      "A connector registered straight with the kernel would slip back to that, visible to wires and invisible to everything else (services.md §12)",
    owner: "modules/core-integrations/src/services.ts",
    scope: ["modules/*/src/**/*.ts", "api/src/**/*.ts"],
    detect: /\bintegrations\.registerConnector\(/,
    except: {
      "api/src/index.ts": "the kernel wires platform().integrations.registerConnector to its own registry; that is the thing registered through, not a connector",
    },
    use: "registerOutboundConnector(def) from modules/core-integrations/src/services.ts",
  },
  {
    kind: "owns",
    id: "dates:days-until-a-date",
    what: "how many days until (or since) a date: daysUntil / daysUntilField / countdownWords in @cobblr/platform-contract/day, fed the reader's day",
    why:
      "one Home page said a banana dated Sep 29 expired 'in 4d' (the attention list rounded an instant) and 'in 5 days' (Up next counted " +
      "calendar days), minutes apart, and the grocery wall and expiryState each had a third and fourth rule that changed their answer in " +
      "the evening (#3641). A clock difference is a fraction of a day, and every surface turned it into a number its own way",
    owner: "packages/platform-contract/src/day.ts",
    scope: ["web/src/pages/*.tsx", "web/src/components/*.tsx", "web/src/lib/*.ts", "api/src/routes/*.ts", "api/src/lib/*.ts", "modules/*/src/**/*.ts", "modules/*/src/**/*.tsx", "packages/platform-web/src/*.tsx", "packages/platform-contract/src/*.ts"],
    // A millisecond difference divided into days, in a file that talks about
    // expiry. Measured on the tree: four countdowns (all moved here) and the
    // cadence model's intervals, which are not a countdown.
    detect: /\/\s*(?:86_?400_?000|MS_PER_DAY|DAY_MS|ONE_DAY|DAY)\b/,
    // A countdown lives wherever a date is said to be due, not only where
    // food expires: the maintenance page divided milliseconds into days as
    // "overdue", out of this row's sight, and disagreed with the record (#3991).
    also: /expir|overdue|due (?:in|today|soon)/i,
    except: {
      "modules/core-cadence/src/model.ts": "the gap between two purchases in days (a rate), not a countdown to a date anybody reads",
      "modules/purchases/src/arrival-sweeper.ts": "two thresholds (how stale a parcel is, how long since it was last asked about) that decide whether to ask; no number reaches a person",
      "packages/platform-contract/src/every-surface-shows-one-countdown.test.ts": "rebuilds the two retired rules on purpose, to prove the grid can tell them from the calendar",
    },
    use: "daysUntilField(value, today) for a stored date, daysUntil(day, today) for a day, countdownWords(day, today, 'short' | 'long') for the words; today is dayHere() in the browser, the person's day (accounts.dayFor / the client's ?today) on the server",
  },
  {
    kind: "owns",
    id: "scan:an-items-destination",
    what:
      "where a scan item goes (or went): the card's resolver, scanDestination over the person-first candidates and the " +
      "workspace's menu. filingDestination on the server, scanRowState(...).destination / itemDestinationLabel in the web, " +
      "and a filed row's recorded filed_into",
    why:
      "the dashboard's scanner queue grouped a vinegar the card sent to Groceries under Inventory, so 'Add all 54 to Inventory' " +
      "would have filed it where nobody chose (#3618); Recently committed then read '→ Inventory · Groceries?' for bananas filed " +
      "into Groceries (#3620). Each reader of the raw top candidate had its own idea",
    owner: "modules/core-scan/src/services/destination.ts",
    scope: [
      "modules/core-scan/src/**/*.ts",
      "api/src/routes/quickstart.ts",
      "web/src/pages/Scan*.tsx",
      "web/src/pages/scan*.ts",
      "web/src/components/Scan*.tsx",
      "web/src/components/WhatToDoPanel.tsx",
      "web/src/components/TrackedMatchNudges.tsx",
    ],
    // The raw top candidate's table, read straight off the list or through a
    // cast. Reading what it NAMED, its fields, its category or its count is
    // not a destination read.
    detect: /(suggested_candidates|candidates|cands)\??\.?\[0\]\??\.(module|instance|label|bundle_external_id)\b|\[0\]\s*as\s*\{[^}]*\b(bundle_external_id|module|instance|label)\b/,
    use:
      "filingDestination(row, tables) (modules/core-scan/src/services/destination.ts) on the server; " +
      "scanRowState(row, viewer).destination or itemDestinationLabel / useItemDestinationLabel (web/src/lib/itemDestination.ts) in the web",
  },
  {
    kind: "owns",
    id: "scan:what-a-rebuy-updates",
    what:
      "whether filing a scan adds to a record the workspace already has, and which: scanMergeTarget in the contract, surfaced " +
      "as scanRowState(...).merge and scanDestination(...).updates, so the pill, +1 more and every door name one record",
    why:
      "the card said Inventory beside +1 more while Replaced wrote to the milk in Groceries, and the dashboard's Add all would " +
      "have made a second milk; each surface read the matchmaker's stamp its own way (#3707)",
    owner: "packages/platform-contract/src/scan-triage.ts",
    scope: [
      "modules/core-scan/src/**/*.ts",
      "api/src/routes/quickstart.ts",
      "web/src/pages/Scan*.tsx",
      "web/src/pages/scan*.ts",
      "web/src/components/*.tsx",
      "web/src/lib/*.ts",
    ],
    // The stamped match's identity, read straight off the row: which record
    // it is, its kind or its table. Its title and picture are display.
    detect: /tracked_match(\s+as\s+[^)]*\))?\??\.(id|kind|instance)\b|scanTrackedMatch\([^)]*\)\??\.(id|kind|instance)\b/,
    use:
      "scanRowState(row, viewer).merge or scanDestination(row, ctx).updates (the contract's scanMergeTarget); " +
      "filingDestination(row, tables).updates on the server; scanDeclinesRecord for a door that finds matches live",
  },
  {
    kind: "owns",
    id: "scan:what-a-scan-matches",
    what:
      "the record a scan already matches, derived one way: trackedMatchStamp over findTracked asked through matchQuery " +
      "(the person's name first), stamped on the row by the matcher, a rename, or File everything for a row never asked",
    why:
      "the card read the match stamped under the model's name while File everything asked findTracked live under the " +
      "person's, so a renamed book was +1 on its card and Filed as new in the plan (#3726)",
    owner: "modules/core-scan/src/services/tracked-stamp.ts",
    scope: ["modules/core-scan/src/**/*.ts"],
    // A hand-built matcher query (an object literal straight into findTracked)
    // or a hand-built stamp.
    detect: /findTracked\(\s*[^,()]+,\s*\{|\btracked_match:\s*\{/,
    use:
      "findTracked(orgId, matchQuery(row, fields, category)) and trackedMatchStamp(...) or restampTrackedMatch(...) " +
      "(modules/core-scan/src/services/tracked-stamp.ts); read a row's match through scanRebuy in the contract",
    except: {
      "modules/core-scan/src/services/file-through-confirm.test.ts": "a fixture: the stamp as the matcher writes it, to test a door that reads it",
    },
  },
  {
    id: "activity:actor-and-via",
    kind: "owns",
    what: "Who made an activity row and how (the person, Automation or Cobblr, and the token / MCP / assistant / automation chip).",
    why: "The dashboard feed rendered the actor itself and showed no token, while the Activity page named it; the owner had been told the feed shows both, and rows with no user read \"someone\" (#3833).",
    owner: "web/src/lib/activity-words.ts",
    scope: ["web/src/pages/Dashboard.tsx", "web/src/pages/ActivityPage.tsx"],
    detect: /\.token\??\.name\b|actor\??\.display_name\s*\?\?|"someone"/,
    use: "Render the actor cell with <ActorVia> / <GroupActorVia> (web/src/components/ActorVia.tsx), whose words are actorWords / viaWords in activity-words.ts.",
  },
  {
    id: "lists:ticked-rows",
    kind: "owns",
    what: "The rows ticked on a list with a selection bar: kept for the tab through a reload, keyed by the page and its filters, dropped when the row is gone, cleared by × or a finished bulk action with Undo ticking them again.",
    why: "Every list kept its ticks in component state, so a refresh unticked the eleven inbox items a person had just asked Cobb about (#4587).",
    owner: "packages/platform-web/src/ticked-rows.ts",
    scope: ["web/src/pages/*.tsx", "modules/*/src/ui/*.tsx"],
    detect: /\[selected, setSelected\]\s*=\s*useState<Set<string>>/,
    also: /<BulkActionBar\b/,
    use: "const [selected, setSelected, clearTicks] = useTickedRows(loaded ? ids : null) from @cobblr/platform-web; call clearTicks() when a bulk action finishes and hand what it returns to that action's Undo.",
  },
  {
    id: "markdown:render",
    kind: "owns",
    what: "Rendering Markdown as elements (react-markdown), loaded the first time a Markdown block is drawn.",
    why: "Seven surfaces imported react-markdown directly, so the renderer and its parser rode in every first page load whether or not a page drew any Markdown (#4945).",
    owner: "packages/platform-web/src/markdown-render.tsx",
    scope: ["web/src/**/*.tsx", "packages/platform-web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx"],
    detect: /^import (?!type\b)[^;]*from "react-markdown"/,
    use: "Render through <MarkdownText> (or <Markdown> for the styled block) from @cobblr/platform-web; it loads the renderer on first use and shows the words meanwhile.",
    except: {
      "web/src/components/ChatRefChip.test.tsx": "a test rendering the chips with the renderer itself, synchronously, to read the links it draws",
      "web/src/components/PayloadView.render.test.tsx": "a test rendering the renderer itself, synchronously, to read what it draws",
      "web/src/lib/every-record-cobb-names-is-a-chip-that-opens-it.test.tsx": "a test rendering the chips with the renderer itself, synchronously, to read the links it draws",
    },
  },
  {
    id: "scanner:decode",
    kind: "owns",
    what: "Decoding barcodes from camera frames with ZXing (about 120 KB gzipped).",
    why: "The decoder shared a file with the camera helpers the app shell uses, so every first page load downloaded it (#4945).",
    owner: "web/src/lib/barcodeDecode.ts",
    scope: ["web/src/**/*.{ts,tsx}", "packages/platform-web/src/**/*.{ts,tsx}"],
    detect: /^import (?!type\b)[^;]*from "@zxing\//,
    use: "Import the decoder from web/src/lib/barcodeDecode.ts, statically only from a screen that reads codes, and with import() from anything the shell can load.",
  },
  {
    id: "camera:torch-on",
    kind: "owns",
    what: "Turning the camera light ON: the one rule for who may (the flashlight button always; the automatic assist only when the person switched Auto light on; a remembered flashlight), with the per-device choices.",
    why: "Auto light started ON on every camera open and forgot being turned off, so the light kept coming on for someone who did not want it, after a booth fix that only narrowed when it fired (#3933).",
    owner: "web/src/lib/cameraLight.ts",
    scope: ["web/src/pages/ScanCameraPage.tsx", "web/src/components/CameraCaptureSheet.tsx"],
    // Any setTorch whose "on" argument is not a literal false.
    detect: /\bsetTorch\((?![^,()]*,\s*false\s*\))/,
    use: "Turn the light on through applyLight(track, source, on) in web/src/lib/cameraLight.ts; setTorch(track, false) to put it out stays allowed anywhere.",
  },
  {
    id: "inventory:count-derived-row",
    kind: "owns",
    what: "Redrawing a stock row after its count moves: Available, on hand and low, derived the way the list endpoint derives them (withCount), and Available read one way (availableOnHand).",
    why: "The row stepper moved the count and available_qty by hand and left on_hand behind, so the table's Available (read through on hand) stayed put after −1 until a reload (#4001).",
    owner: "modules/inventory/src/stock-derived.ts",
    scope: ["modules/inventory/src/ui/**/*.tsx", "web/src/components/**/*.tsx", "web/src/features/**/*.tsx"],
    // A cached row's available figure written by hand, or Available re-derived
    // from on_hand beside the shared reader.
    detect: /\bavailable_qty:\s*(?:Number\(|[\w.]+\s*[-+])|available_qty\s*\+\s*\(\s*[\w.]*on_hand/,
    use: "Patch the cached row with withCount(row, newQty) and show Available with availableOnHand(row), both from modules/inventory/src/stock-derived.ts (exported through @cobblr/inventory/ui).",
  },
  {
    id: "locations:name-range",
    kind: "owns",
    what: 'Reading a name as a run of places ("Drawer 1-3" is Drawer 1, Drawer 2 and Drawer 3), for every form that makes places.',
    why: "The list's New location form expanded \"Drawer 1-3\" into three drawers while the floor plan's made one location literally named \"Drawer 1-3\" filling the whole face (#3986).",
    owner: "web/src/lib/nameRange.ts",
    scope: ["web/src/pages/**/*.tsx", "web/src/components/**/*.tsx"],
    // A hand-written range pattern: digits, a dash, digits.
    detect: /\(\\d\+\)\\s\*\[-–\]/,
    use: "parseRange(name) from web/src/lib/nameRange.ts.",
  },
  {
    id: "floorplan:metadata-writes",
    kind: "owns",
    what: "Writing a location's or a thing's floor plan blob: its spot on a plan (withRect), its own layout (withBound; a container's goes to its face), its decoration (withDecor), each keeping the rest of the metadata.",
    why: "saveBound replaced the whole metadata with the bound, so setting a placed toolbox's face took it off the garage, and a footprint write stretched the drawer face it shared a w × d with (#3986).",
    owner: "web/src/lib/floorplanGeometry.ts",
    scope: [
      "web/src/components/FloorPlan.tsx",
      "web/src/components/LocationFloorPlanTab.tsx",
      "web/src/components/placeItems/PlaceItemsView.tsx",
      "web/src/pages/PlaceItemsPage.tsx",
      "web/src/pages/LocationsPage.tsx",
      "web/src/pages/LocationDetailPage.tsx",
    ],
    // A blob written by hand: `floorplan: <value>` in an object, or an
    // assignment to `.floorplan`.
    detect: /\bfloorplan\s*:\s*[\w{[]|\.floorplan\s*=[^=]/,
    use: "withRect(metadata, rect, { keepFace }), withBound(metadata, bound, kind) or withDecor(metadata, patch) from web/src/lib/floorplanGeometry.ts.",
  },
  {
    id: "nav:hide-says-where-it-went",
    kind: "owns",
    what: "Hiding an entry from this sidebar (or showing it again), which the first time says the app is in ⊞ More apps.",
    why: "Hiding an app took it out of the nav with nothing saying where it went; the owner had to be told the way back existed (#3883).",
    owner: "web/src/lib/moreApps.ts",
    scope: ["web/src/components/**/*.tsx", "web/src/pages/**/*.tsx"],
    detect: /\btoggleNavHidden\(/,
    use: "const toggleHidden = useToggleNavHidden() from web/src/lib/moreApps.ts; toggleHidden(slug, name).",
  },
  {
    id: "discord:connect-door",
    kind: "owns",
    what: "Asking whether this person can connect Discord here: useDiscordStatus (web/src/lib/useDiscordStatus.ts) read through discordConnectable / doorLeadsSomewhere (web/src/lib/discord-connect.ts), which every Connect Discord door calls before it draws.",
    why:
      "each door read the status its own way, and three never read it at all, so a server with no Discord app or no bot " +
      "offered a connect in five places that could only end on a page saying Discord is not set up (#4144)",
    owner: "web/src/lib/useDiscordStatus.ts",
    scope: ["web/src/**/*.tsx", "web/src/**/*.ts"],
    detect: /\bmeDiscordStatus\(/,
    use: "const discord = useDiscordStatus(); then discordConnectable(discord.data), or doorLeadsSomewhere(to, discord.data) for a link that may be the connect door.",
  },
  {
    id: "purchases:order-total",
    kind: "owns",
    what: "What an order cost, for any spend figure: the stated total, else its lines plus shipping, as `total` from orderTotal in modules/purchases/src/order-total.ts.",
    why:
      "every spend figure summed total_cost, which only a receipt or a typed total fills, so a hand-entered order and every past " +
      "purchase filled in line by line counted as nothing spent",
    owner: "modules/purchases/src/order-total.ts",
    scope: ["modules/*/src/**/*.ts", "modules/*/src/**/*.tsx", "web/src/**/*.tsx", "web/src/**/*.ts"],
    detect: /sum\(\s*\w+\.total_cost|\+\s*Number\(\s*\w+\??\.total_cost|money\(\s*\w+\??\.total_cost/,
    use: "Read `total` (served beside total_cost on orders and vendor orders); in SQL, orderTotal(alias) from modules/purchases/src/order-total.ts.",
  },
  {
    id: "inventory:stock-moved",
    kind: "owns",
    what: "What follows a change to a part's count: the statement line, inventory.stock.changed, and inventory.stock.low on a decrease, through stockMoved in modules/inventory/src/api/stock-moved.ts.",
    why:
      "five doors changed a count and each ran its own subset of what follows: an edit of the record (and so Cobb's update) ran none, " +
      "so a count typed down past the minimum never reached the running-low list or a draft order, and a recount left no statement line",
    owner: "modules/inventory/src/api/stock-moved.ts",
    scope: ["modules/inventory/src/**/*.ts"],
    detect: /emit\(\s*["'`]inventory\.stock\.(changed|low)["'`]/,
    use: "await stockMoved(db, orgId, { partId, delta, newQty, minQty, reason, ledger }) from modules/inventory/src/api/stock-moved.ts.",
    except: {
      "modules/inventory/src/api/target-lines.ts": "a holding moved between places; the count did not change (delta 0), so there is nothing to ledger or check",
    },
  },
  {
    kind: "owns",
    id: "sales:an-order-change-is-written-down",
    what: "writing to a sales order's timeline: orderHappened in modules/sales/src/history.ts, which also writes the workspace log and the status_changed event",
    why:
      "each door wrote what it remembered: Fulfill and Ship moved the status with no event and no log entry, and a line change left no trace (#4115)",
    owner: "modules/sales/src/history.ts",
    scope: ["modules/sales/src/**/*.ts"],
    detect: /insertInto\(\s*["']sales_order_history["']|insert\s+into\s+sales_order_history/i,
    use: "orderHappened(db, orgId, orderId, { kind, ... }) from modules/sales/src/history.ts",
  },
  {
    kind: "owns",
    id: "sales:an-order-line-is-written-down",
    what: "adding or removing a line on a sales order: addLine / removeLine (and changeLine) in modules/sales/src/order-lines.ts",
    why: "the routes and the actions each inserted and deleted lines directly, so no line change reached the order's timeline or the log (#4115)",
    owner: "modules/sales/src/order-lines.ts",
    scope: ["modules/sales/src/**/*.ts"],
    detect: /(?:insertInto|deleteFrom)\(\s*["']sales_order_items["']|(?:insert\s+into|delete\s+from)\s+sales_order_items/i,
    use: "addLine / changeLine / removeLine from modules/sales/src/order-lines.ts",
  },
  {
    kind: "owns",
    id: "sales:an-order-is-cancelled-one-way",
    what: "setting a sales order to cancelled: cancelOrder in modules/sales/src/cancel.ts, which puts back what Fulfill took (or asks whether a shipped order came back) and writes it down",
    why: "the status list set cancelled directly, so a cancelled order kept the stock it had taken for a sale that never happened (#4115)",
    owner: "modules/sales/src/cancel.ts",
    scope: ["modules/sales/src/**/*.ts"],
    detect: /status:\s*["']cancelled["']/,
    use: "cancelOrder(db, orgId, userId, orderId, { returned? }) from modules/sales/src/cancel.ts",
  },
  {
    kind: "owns",
    id: "tags:every-tag-write",
    what: "writing a tag or putting one on or off a record: createTag / ensureTag / updateTag / deleteTag / attachTag / detachTag / mergeTag in modules/core-tags/src/tag-writes.ts",
    why:
      "the routes and the actions each had their own copy, so a rename onto a taken name answered 500, two attaches of one new tag raced " +
      "into a 500, and only a new tag ever reached the activity log (#4115)",
    owner: "modules/core-tags/src/tag-writes.ts",
    scope: ["api/src/**/*.ts", "modules/*/src/**/*.ts"],
    detect: /(?:insertInto|updateTable|deleteFrom)\(\s*["']core_tags_|\b(?:insert\s+into|update|delete\s+from)\s+core_tags_/i,
    use: "the matching function from modules/core-tags/src/tag-writes.ts (another module: the core-tags actions, or platform().tags for a bulk writer)",
    except: {
      "api/src/index.ts":
        "platform().tags, the in-process seam for bulk writers (a sheet import, a sync) that cannot import a module; they write their own " +
        "activity entry for the batch rather than one per tag",
      "api/src/platform/rehome-instance.ts": "a one-off move of assignments between kinds, not a tag change anyone made",
    },
  },
  {
    kind: "owns",
    id: "ui:the-chosen-tile",
    what: "how a chosen tile in a picker or photo grid looks (the photo in use, the current pick): SelectableTile in packages/platform-web/src/SelectableTile.tsx",
    why:
      "the record's photo search drew the AI's pick with a border and ring of its own and the photo in use not at all, while the scan " +
      "inbox outlined it; the owner asked for the chosen tile to look the same everywhere (#4515)",
    owner: "packages/platform-web/src/SelectableTile.tsx",
    scope: ["web/src/**/*.tsx", "modules/*/src/ui/**/*.tsx", "packages/platform-web/src/**/*.tsx"],
    // A selected-state outline or ring drawn by hand, not a focus ring.
    detect: /(?<![:\w-])(?:outline|ring)-2\b[^"'`]*?(?<![:\w-])(?:outline|ring)-(?:accent|cobble-\d+)\b/,
    // Only where pictures are drawn: a grid you pick a picture from.
    also: /<img\b|<EntityPhoto\b|<EntityThumb\b/,
    use: "<SelectableTile selected={…} topLeft={…}> from @cobblr/platform-web (badges in its corner slots)",
    except: {
      "web/src/features/digifab/fleet.tsx": "a printer card under a file being dragged onto it: a drop target, not a choice",
      "web/src/pages/ViewsPage.tsx": "a card lifted while it is being dragged, not a choice",
      "packages/platform-web/src/EntityThumb.tsx": "a suggested photo not yet accepted, drawn dashed so it never reads as chosen",
    },
  },
];
