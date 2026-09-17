// The synthetic chat corpus: what people will type, before enough of them have.
//
// The platform has few users and little real chat history to learn from, so
// this corpus is authored instead of harvested (owner's call, 2026-08-25):
// several hundred utterances spanning what a workshop/home/collection workspace
// plausibly hears, each annotated with how BOTH halves of the product should
// resolve it —
//
//   no_ai   what the basics matcher does with no model connected: the exact
//           rule that answers, "command" for a computed command, "none" for an
//           honest fall-through to the generic reply, or "never-offer" for a
//           sentence the pre-send OFFER must not intercept (Enter still asks
//           the model; an offer over an instruction steals real work).
//   ai      the resolution class a connected model should reach. Scored by
//           scripts/bench-action-rail.ts against a live workspace's real
//           actions and the real tool definitions: `action:<id>` expects
//           invoke_action with that id, `create:record` / `update` / `delete`
//           expect that write tool, `read:<tool>` expects that read tool
//           before a prose answer, and `answer` / `clarify` / `escort:*`
//           expect no write; "read:a|b" accepts either read; "action:<id>{k=v}"
//           also judges the ARGUMENTS (text: case-insensitive substring,
//           number: equal, "*": present) - the id is where a model is usually
//           right, the arguments are where it can still be wrong. A claim the
//           workspace cannot host (an action it lacks, a kind with no records)
//           is reported SKIPPED, never counted.
//
// When real history exists, harvested utterances join here with the same
// annotations — the "Asked, but not answered" queue is the intake, this file
// is the archive, and scripts/corpus-intake.ts is the door between them: it
// prints each miss as a draft line with a guessed bucket and claims for a
// person to accept or fix. It never writes here itself; a wrong claim pasted
// unread would be enforced as truth. An utterance is a CLAIM about product behaviour: the
// chat-corpus test runs every no_ai claim on every change to the catalog.

export type NoAiExpect =
  | { kind: "answer"; rule: string }      // matchBasics replies with this rule
  | { kind: "command" }                   // a computed command takes it
  | { kind: "none" }                      // falls through to the generic reply
  | { kind: "never-offer" };              // MUST NOT match in offering mode

export interface CorpusCase {
  say: string;
  /** The screen this is said ON, when the sentence needs one to mean anything.
   *  "save this as a board" has no "this" without it, and the app always sends
   *  one (page-context.ts); a bench that did not was asking the model to
   *  resolve a pronoun with no referent, then scoring the honest answer as a
   *  miss. Only for sentences that genuinely depend on it. */
  on?: { label: string; summary?: string };
  /** The turns before this one, when the sentence only means something after
   *  them. "put it back" after a change the assistant made is the card's
   *  Undo, and a bench that sent it alone was scoring "put what back?".
   *  `applied` marks an assistant turn that CHANGED something: its card holds
   *  an Undo, and the widget presses it for a control word before any model
   *  is asked (ChatWidget send()), so the bench scores that sentence by code
   *  rather than asking a model the product never asks. */
  before?: Array<{ role: "user" | "assistant"; content: string; applied?: boolean }>;
  /** Broad bucket, for coverage reporting. */
  cat: string;
  no_ai: NoAiExpect;
  /** Informative: "answer" | "read:<tool>" | "action:<id>" | "create:<kind>"
   *  | "update" | "delete" | "escort:<dest>" | "clarify". */
  ai: string;
  /** The records the answer must NAME AS CHIPS: their titles, as the bench
   *  workspace holds them. A read answer that says "The Hobbit" in plain text
   *  with nothing to open is the failure this scores (the 2026-09-13 review):
   *  the server returns `mentions` for the records the turn read whose title
   *  the words carry, and the bench checks each of these is among them. */
  names?: string[];
  /** Words the answer must SAY, case-insensitive: "Living room" for a
   *  where-question about a record that lives there. The collection a record
   *  sits in is not where it is (the 2026-09-13 continuation review was told
   *  "in the Home Inventory list"). */
  says?: string[];
  /** A stated reason this case cannot be made deterministic, written after a
   *  real attempt. A case with this LEAVES THE GATE: it is still asked and
   *  recorded, but a miss cannot put its bucket under the floor; its pass rate
   *  over the last runs is tracked instead and alerts on a drop (#3101).
   *  "Non-deterministic" is a finding, never a label for a case somebody
   *  could not fix; the corpus owner decides which cases carry it. */
  trend?: string;
  /** The issue this case cannot pass without: a defect at its door, a
   *  fixture the seed never creates. A case with this is held OUT OF THE
   *  FLOOR while it is asked and recorded, so a gate does not require every
   *  known defect cleared before it can be green (a gate like that is one
   *  everyone learns to ignore; twelve such cases the night the cold cache
   *  warmed, #3101). Its failing is expected; its passing is reported, and a
   *  marker that keeps passing is a stale label, cleared in the PR that fixed
   *  the issue. Deterministic and red, which is the opposite of `trend`. */
  known_red?: string;
}

const answer = (rule: string) => ({ kind: "answer", rule } as const);
const none = { kind: "none" } as const;
const neverOffer = { kind: "never-offer" } as const;
const command = { kind: "command" } as const;

/** Expand one intent into its phrasings. */
function ph(cat: string, no_ai: NoAiExpect, ai: string, says: string[]): CorpusCase[] {
  return says.map((say) => ({ say, cat, no_ai, ai }));
}

/** The same, for sentences that only mean something on a particular screen. */
function onScreen(
  cat: string,
  no_ai: NoAiExpect,
  ai: string,
  on: { label: string; summary?: string },
  says: string[],
): CorpusCase[] {
  return says.map((say) => ({ say, cat, no_ai, ai, on }));
}

/** The cases held out of the floor, by sentence: the issue each one cannot
 *  pass without. Named by the corpus owner from the outcome-scored pass
 *  (2026-09-17). A sentence here that is not in the corpus is a dead marker,
 *  refused at load (below), so the list cannot drift from the cases. */
const KNOWN_RED: Record<string, string> = {
  // #3123: args_schema has no `required`, so the door lets an argument-less
  // call through and the card fails when pressed (class B, "call my parts
  // spools": rename-thing given a kind id where it wants a list name).
  "rename machines to printers everywhere": "#3123",
  "put purchase date and supplier under Buying on parts": "#3123",
  "rename the Buying heading to Purchasing": "#3123",
  "track where my things came from": "#3123",
  "turn on provenance": "#3123",
  "we measure filament in spools": "#3123",
  "call my parts spools": "#3123",
  // #3125: the seed never creates the subject (no Purchase Date field, no
  // Spices section), and turns every module on, so enable-module has nothing
  // to enable.
  "make Purchase Date required": "#3125",
  "put Spices and Tea under a Kitchen heading": "#3125",
  "turn on purchases": "#3125",
  "I want to track maintenance": "#3125",
  "enable the shipments feature": "#3125",
};

/** The cases that left the gate for the trend, by sentence: the reason each
 *  cannot be made deterministic, after a real attempt. */
const TREND: Record<string, string> = {
  // #3159: the door works for the model's call; the miss is the model's
  // choice between the action and a pointer to Fields & forms, two in three
  // either way.
  "add Aran to the yarn weight choices": "the model chooses between the action and a pointer to Fields & forms, two in three either way (#3159)",
};

const RAW_CORPUS: CorpusCase[] = [
  // ── greetings & meta ──────────────────────────────────────────────────────
  ...ph("meta", answer("greeting"), "answer", [
    "hi", "hey there", "good morning", "hello cobb",
  ]),
  ...ph("meta", answer("capabilities"), "answer", [
    "what can you do", "help", "what are my options here",
  ]),
  ...ph("meta", answer("what-is-cobblr"), "answer", [
    "what is cobblr", "what does this app do", "how does cobblr work",
  ]),
  // ── conversational control ───────────────────────────────────────────────
  ...ph("control", answer("retry"), "clarify", [
    "try again", "do it again", "one more time", "do that over", "can you retry that", "once more",
  ]),
  ...ph("control", answer("confirm-yes"), "clarify", [
    "yes do it", "go ahead", "go for it", "yep", "sounds good",
  ]),
  ...ph("control", answer("stop-cancel"), "clarify", [
    "stop", "cancel that", "never mind", "forget it", "wait no",
  ]),
  ...ph("control", answer("undo"), "action:undo", [
    "undo", "undo that", "put it back", "revert what you just did",
  ]),
  // After a change the assistant made and applied, "put it back" is the
  // card's Undo. The model composed a fresh +1 stock write instead (measured
  // on the rig, 2026-09-13): right count, wrong road, and a second ledger row
  // where the card already had the way back. With AI off the control word
  // resolves against the prior turn's ledger in code; with AI on the widget
  // does the same before any model is asked (that is the product's road, and
  // the bench scores it by code: `applied` below), and the prompt says so for
  // the phrasings the control vocabulary misses. The prompt line alone held
  // 17/17 on a workspace where every count was zero and not once the counts
  // were real (#2859): the model proposes +1 when there is stock to add to.
  {
    say: "put it back",
    cat: "control",
    no_ai: answer("undo"),
    ai: "answer",
    before: [
      { role: "user", content: "I just used one Basmati rice" },
      { role: "assistant", content: "I've recorded that you used one Basmati rice.", applied: true },
    ],
  },
  // ── questions about MY data (the everyday spellings) ─────────────────────
  // A count is arithmetic: the model's right move is count_records, never a
  // page it then counts by eye (that is how "how many Bambus" became "None").
  ...ph("my-data", answer("my-data"), "read:count_records", [
    "how many parts do I have", "how many locations are there",
    "do I have any M3 screws", "is there any PLA left",
  ]),
  // "How much" reads a quantity off the record; a page or a count both get
  // there (measured: the model reads the record and says the number).
  ...ph("my-data", answer("my-data"), "read:list_records|count_records|search_records", [
    "how much filament is there",
  ]),
  // The answer must be TRUE, not merely a read. The model searched the Yarn
  // list, found nothing, and said "you don't have any black yarn" while four
  // sat in Inventory; that scored as a read answer (#3085). The record
  // named as a chip proves it was found; the count proves it was read.
  {
    say: "how much do I have of the black yarn",
    cat: "my-data",
    no_ai: answer("my-data"),
    ai: "read:list_records|count_records|search_records",
    names: ["Black yarn"],
    says: ["4"],
  },
  ...ph("my-data", answer("my-data"), "read:list_records|search_records", [
    "what do I have in the garage", "show me my printers",
  ]),
  // The reviewer's sentence, word for word. The answer was right and named
  // the book in plain text with nothing to open; a read answer's names are
  // chips now (mentions.ts), and this case scores that they are.
  {
    say: "Which books are in this workspace? Please only read, do not change anything.",
    cat: "my-data",
    no_ai: answer("my-data"),
    ai: "read:list_records|search_records|list_record_kinds",
    names: ["The Hobbit", "Dune"],
  },
  // The continuation review's question, word for word: the lamp was a chip,
  // the yarn was text ("the blue cotton yarn" for Blue cotton yarn 100g
  // 200m: a prefix of the title names the record now), and "where" was
  // answered with the collection while the record said Living room (the
  // resolved record carries location_name now, and the answer rules say a
  // where-question is the recorded place).
  {
    say: "Where is my LED desk lamp, and how much blue cotton yarn do I have? Please only read my data.",
    cat: "my-data",
    no_ai: answer("my-data"),
    ai: "read:search_records|list_records|get_record",
    names: ["LED desk lamp", "Blue cotton yarn 100g 200m"],
    says: ["Living room"],
  },
  ...ph("my-data", answer("my-data"), "read:search_records", [
    "which bin did the drill end up in", "where did the multimeter go",
    "where is my soldering iron", "where are my drill bits",
  ]),
  // The three from the phone (2026-08-27): counts of a VALUE inside a kind.
  // Answered before enter by count-answers.ts; a model gets count_records.
  ...ph("my-data", answer("my-data"), "read:count_records", [
    "how many Bambus?", "how many bambu printers do I have", "do I have any delta printers?",
    "any deltas?", "which model do I have the most of?", "what manufacturer is most common",
  ]),
  ...ph("my-data", answer("my-data"), "read:get_attention", [
    "what's low", "what is running low", "what needs my attention", "anything overdue?",
  ]),
  ...ph("my-data", none, "read:search_records", [
    "brass widget", "dcd777", "harry potter",  // bare search terms: no rule should guess
  ]),
  // ── how-do-i (question → offer allowed; the rule answers) ────────────────
  ...ph("how-to", answer("add-item"), "answer", [
    "how do i add a part", "how do I add an item", "how do i create a new part",
  ]),
  ...ph("how-to", answer("edit-update"), "answer", [
    "how do i edit a part", "how do I rename something?", "how do i change a field on an item",
  ]),
  ...ph("how-to", answer("enable-module"), "answer", [
    "how do i add a module", "what features can I enable",
  ]),
  // A "where do I" that names the thing: a model may just do it.
  ...ph("how-to", answer("enable-module"), "action:platform:enable-module{module=purchases}|answer", [
    "where do i turn on purchases",
  ]),
  ...ph("how-to", answer("scan"), "answer", [
    "how do i scan", "where do I scan a barcode", "how does the qr scanning work",
  ]),
  // Members is an escort-only surface: taking the person there IS the answer.
  ...ph("how-to", answer("invite-people"), "escort:members|answer", [
    "how do i invite someone", "how do I add a user", "who can see this workspace",
  ]),
  // ── instructions: entity writes (never intercepted; AI acts) ─────────────
  // A module's own create action is a create.
  ...ph("write", neverOffer, "create:record|action:inventory:create-item", [
    "add a part called Brass Widget, quantity 4",
    "create a location called Shelf 9 in the garage",
    "add a task to reorder filament",
    "new project: garden bench for dad",
  ]),
  ...ph("write", neverOffer, "action:core-maintenance:log|create:record", [
    "log a maintenance entry for the CNC: changed the spindle belt",
  ]),
  // A module's own create action counts as creating the record.
  // Three spools of a filament the workspace already stocks is a stock
  // adjustment as much as a create; both are right.
  ...ph("write", neverOffer, "action:inventory:create-item|action:inventory:adjust-stock|create:record", [
    "add 3 spools of black PLA",
  ]),
  ...ph("write", neverOffer, "update", [
    "mark the birdhouse task done",
  ]),
  // Moving a thing is the placement action or a field update; both put it there.
  ...ph("write", neverOffer, "action:core-placement:place|update", [
    "set the drill's location to Bin 4",
    "move the multimeter to the electronics bin",
  ]),
  ...ph("write", neverOffer, "action:platform:edit-field|update", [
    "rename the Colour field to Shade",
  ]),
  ...ph("write", neverOffer, "action:inventory:set-stock|update", [
    "change the quantity of M3 screws to 40",
  ]),
  ...ph("write", neverOffer, "delete", [
    "delete the duplicate rack",
    "remove the test part I just made",
  ]),
  // ── instructions: workspace actions ──────────────────────────────────────
  ...ph("workspace", neverOffer, "action:platform:enable-module", [
    "turn on purchases", "I want to track maintenance", "enable the shipments feature",
  ]),
  ...ph("workspace", neverOffer, "action:platform:rename-thing", [
    "call my parts spools", "rename machines to printers everywhere",
  ]),
  ...ph("workspace", neverOffer, "action:platform:add-field", [
    "add a Purchase Date field to parts", "track a colour on every physical thing",
  ]),
  ...ph("workspace", neverOffer, "action:platform:edit-field", [
    "hide the manufacturer field on parts", "make Purchase Date required",
    "add Aran to the yarn weight choices",
    "remove tea category from inventory, it is no longer a valid option",
  ]),
  ...ph("workspace", neverOffer, "action:platform:group-fields", [
    "put purchase date and supplier under Buying on parts",
    "rename the Buying heading to Purchasing",
  ]),
  ...ph("workspace", neverOffer, "action:core-presentation:group-nav", [
    "put Spices and Tea under a Kitchen heading",
    "group my yarn sections under one Crafts menu",
  ]),
  ...ph("workspace", neverOffer, "action:platform:set-field-preset", [
    "track where my things came from", "turn on provenance",
  ]),
  ...ph("workspace", neverOffer, "action:core-locations:reorder", [
    "put the racks in Den in numeric order", "sort the shelves by name",
  ]),
  ...ph("workspace", neverOffer, "action:inventory:adjust-stock", [
    "I used 2 of the M3 screws", "add five more of the blue filament",
  ]),
  ...ph("workspace", neverOffer, "action:labels:print", [
    "print a label for the new rack", "queue labels for everything in Bin 7",
  ]),
  // ── a workshop of machines (the action bench's cases; records exist for
  //    these on the dev rig, so the AI half can be scored; bucket "workshop") ──────────────────
  ...ph("workshop", neverOffer, "action:core-maintenance:log{name=*}", [
    "log that I serviced the Kossel Mini today", "changed the nozzle on the Rostock Max",
  ]),
  ...ph("workshop", neverOffer, "action:machines:record-usage{hours=4}", [
    "the Rostock Max ran four hours yesterday",
  ]),
  ...ph("workshop", neverOffer, "action:machines:record-usage{prints=12}", [
    "log 12 prints on the X1 Carbon",
  ]),
  ...ph("workshop", neverOffer, "action:labels:print", [
    "print a label for the X1 Carbon", "sticker the Kossel Mini",
  ]),
  ...ph("workshop", neverOffer, "action:core-tags:tag-record{tag_name=fragile}", [
    "tag the Kossel Mini as fragile",
  ]),
  ...ph("workshop", neverOffer, "action:core-tags:tag-record{tag_name=urgent}", [
    "label the X1 Carbon urgent",
  ]),
  ...ph("workshop", neverOffer, "action:core-tags:untag-record{tag_name=fragile}", [
    "take the fragile tag off the Kossel Mini",
  ]),
  // A note about a machine needing a part is a comment on it or a maintenance
  // entry about it; the workspace records it either way, and the twin phrasing
  // below already accepted both. Judging the same intent by two different
  // claims made the nightly report a good answer as a miss for a week.
  ...ph("workshop", neverOffer, "action:core-discussion:post-comment{body=nozzle}|action:core-maintenance:log{name=nozzle}", [
    "leave a note on the X1 Carbon that it needs a new nozzle",
  ]),
  ...ph("workshop", neverOffer, "action:core-discussion:post-comment{body=belt}", [
    "comment on the Kossel Mini: belt is loose",
  ]),
  ...ph("workshop", neverOffer, "action:core-placement:place{container_id=*}", [
    "put the Kossel Mini in the Garage", "the X1 Carbon lives on Shelf B now",
  ]),
  ...ph("workshop", neverOffer, "action:core-placement:remove", [
    "take the CubePro out of the Garage",
  ]),
  ...ph("workshop", neverOffer, "action:core-catalogs:match-to-catalog", [
    "match the X1 Carbon to the catalog",
  ]),
  // A question in shape ("where is my…"), an action in intent: basic mode
  // answers where-is from the workspace, a model runs the tracking action.
  ...ph("workshop", answer("my-data"), "action:core-shipments:track", [
    "where is my parcel, tracking 1Z999AA10123456784",
  ]),
  ...ph("workshop", neverOffer, "action:core-units:add-unit{name=spool}", [
    "we measure filament in spools",
  ]),
  ...ph("workshop", neverOffer, "action:platform:rename-workspace{name=garage}", [
    "call this workspace The Garage",
  ]),
  ...ph("workshop", neverOffer, "action:platform:remove-field{field=colour}", [
    "remove the Colour field from machines",
  ]),
  ...ph("workshop", neverOffer, "action:platform:disable-module{module=shipments}", [
    "turn off shipments",
  ]),
  // Both of these are said AT a screen, and mean nothing without one.
  ...onScreen("workshop", neverOffer, "action:platform:set-simple-mode", { label: "Machines" }, [
    "this is too cluttered, simplify it",
  ]),
  ...onScreen(
    "workshop",
    neverOffer,
    "action:core-views:save-view",
    { label: "Machines", summary: "14 machines, filtered to status = idle, sorted by name" },
    ["save this as a board"],
  ),
  // Reported twice from the product, with screenshots, before there was any
  // way to do it: once Cobb created a second copy of two items and said it had
  // moved them, once it proposed deleting them. The no-AI path takes this one
  // now (computed:move-into-list), and platform:move-records is what either
  // path runs.
  // "There are other spice and baking items in inventory that I am also
  // looking to move to their correct locations" (2026-09-12): one sentence
  // per category is a workaround. Sorting a list into sections by what each
  // record is filed under is worked out in code (computed:sort-into-lists),
  // and runs the move and the promote-category actions.
  ...ph("workshop", command, "action:platform:move-records|action:platform:promote-category", [
    "sort the rest of inventory into the right sections",
    "put everything in inventory where it belongs",
    "move the rest of inventory into their own sections",
    "file everything on this page into the correct lists",
  ]),
  ...ph("workshop", command, "action:platform:move-records", [
    "move all the tea from this page into the Tea section",
    "get all the other grocery/ spices out of inventory and into the dedicated sections",
    "get the grocery and spices out of inventory and into their own sections",
    "move the chamomile and earl grey into the Tea list",
    "move the tea into the Tea list",
    "move tea from this page into its own section",
    "get all the tea out of inventory and into the dedicated tea section",
  ]),
  ...ph("workshop", answer("my-data"), "read:count_records", [
    "which printer do I have the most of?", "how many machines do I have?",
  ]),
  // No basics rule reads a record's field; an honest fall-through, and the
  // model looks it up.
  ...ph("workshop", none, "read:list_records|search_records|get_record", [
    "what state is the Kossel Mini in?", "who makes the X1 Carbon?",
  ]),

  // ── a kitchen (second domain: the matcher and the model must not be
  //    workshop-shaped; seeded by the bench: Pantry, spices, a Shopping list) ─
  ...ph("kitchen", answer("my-data"), "read:count_records", [
    "how many spices do I have", "any cumin left?", "do I have any paprika",
  ]),
  ...ph("kitchen", answer("my-data"), "read:search_records|list_records", [
    "where is the paprika", "where's the rice",
  ]),
  // An item created straight onto the list is the same outcome as the action.
  ...ph("kitchen", neverOffer, "action:lists:add-item{title=cumin}|create:record", [
    "add cumin to the shopping list", "put cumin on the list",
  ]),
  ...ph("kitchen", neverOffer, "action:core-tags:tag-record{tag_name=running low}", [
    "tag the olive oil as running low",
  ]),
  ...ph("kitchen", neverOffer, "action:labels:print", [
    "print a label for the paprika",
  ]),
  ...ph("kitchen", neverOffer, "action:core-placement:place{container_id=*}|update", [
    "the rice lives in the pantry now",
  ]),
  // Two doors end with the jar existing: the record create, and the
  // inventory:create-item action (whose own examples are "add a box of
  // screws"). The action is accepted here only because the bench opens the
  // door: a call naming a list the workspace does not have is refused and
  // scored as the miss it is (#3092), and one that lands in Inventory runs
  // and is put back.
  ...ph("kitchen", neverOffer, "create:record|action:inventory:create-item", [
    "add a jar of turmeric", "new spice: garam masala",
  ]),
  // "Used up one" is what use-one does; and on a pantry that dates lots on
  // arrival a bag IS a lot, and Used up ends the oldest lot as used, which
  // is the same bag. All three are the answer.
  ...ph("kitchen", neverOffer, "action:inventory:adjust-stock|action:inventory:use-one|action:inventory:use-up", [
    "used up one bag of rice",
  ]),
  // "half" is not a quantity the record can take; asking is as right as guessing.
  ...ph("kitchen", neverOffer, "action:inventory:adjust-stock|action:inventory:use-one|clarify", [
    "I used half the cumin",
  ]),
  // ── adversarial phrasings: the same intents in words the examples never
  //    used, so the bench measures understanding, not echo ─────────────────
  ...ph("workshop", neverOffer, "action:core-tags:untag-record{tag_name=fragile}", [
    "kill the fragile tag on the Kossel",
  ]),
  ...ph("workshop", neverOffer, "action:labels:print", [
    "sticker the Rostock",
  ]),
  // Two machines are called CubePro and no place is named, so the right
  // answer is the question, naming both; a label printed for one of them is
  // a guess. It missed two asks in three for weeks as an action claim,
  // because the model was right two times in three (#3001).
  {
    say: "I need a label on the CubePro",
    cat: "workshop",
    no_ai: neverOffer,
    ai: "clarify",
    says: ["CubePro #9", "CubePro #10"],
  },
  // "note that on it" is a comment or a maintenance note; both are notes on it.
  ...ph("workshop", neverOffer, "action:core-discussion:post-comment{body=nozzle}|action:core-maintenance:log{name=nozzle}", [
    "the X1 needs a new nozzle, note that on it",
  ]),
  ...ph("workshop", neverOffer, "action:platform:remove-field{field=colour}", [
    "bin the Colour field on machines",
  ]),
  ...ph("workshop", neverOffer, "action:machines:record-usage{hours=2}", [
    "two hours on the Rostock this morning",
  ]),
  ...ph("workshop", answer("my-data"), "read:count_records", [
    "got any deltas",
  ]),
  // A bare "<thing> count?" matches no rule: an honest fall-through, and the
  // model counts. Teaching the matcher "count" would intercept instructions.
  ...ph("workshop", none, "read:count_records", [
    "bambu count?",
  ]),

  // ── computed commands (no AI needed, run on Tab/Do-it) ───────────────────
  ...ph("command", command, "action:computed", [
    "delete duplicates", "remove duplicate locations", "fix broken links", "delete empty places",
  ]),
  // Questions ABOUT those topics are not instructions:
  ...ph("command", none, "answer", [
    "why are there duplicates in my list?", "did that create a duplicate?",
  ]),
  // ── escort-only surfaces (AI must escort, not fake it) ───────────────────
  // The how-to reply IS the best no-AI answer for these: it names the screen.
  ...ph("escort", answer("invite-people"), "escort:members", [
    "invite grace@example.com as an editor",
  ]),
  ...ph("escort", none, "escort:api-tokens", [
    "make me an api token",
  ]),
  ...ph("escort", answer("export-backup"), "escort:backup", [
    "restore last week's backup",
  ]),
  ...ph("escort", none, "escort:wires", [
    "when stock hits zero, email me",  // composing an automation is consented in the composer
  ]),
  // ── genuinely out of scope (honest none; AI answers generally) ───────────
  ...ph("general", none, "answer", [
    "what's a good infill percentage for PETG",
    "how do I get dried glue off plywood",
    "convert 3/8 inch to mm",
    "what's the difference between PLA and ABS",
  ]),
];

const marked = (c: CorpusCase): CorpusCase => ({
  ...c,
  ...(KNOWN_RED[c.say] ? { known_red: KNOWN_RED[c.say] } : {}),
  ...(TREND[c.say] ? { trend: TREND[c.say] } : {}),
});
for (const say of [...Object.keys(KNOWN_RED), ...Object.keys(TREND)]) {
  if (!RAW_CORPUS.some((c) => c.say === say)) throw new Error(`chat-corpus: a marker names a sentence that is not a case: "${say}"`);
}
export const CHAT_CORPUS: CorpusCase[] = RAW_CORPUS.map(marked);
