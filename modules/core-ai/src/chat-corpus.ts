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
//   ai      the resolution class a connected model should reach: informative
//           today (the tool benches sample it), enforced as those benches grow.
//
// When real history exists, harvested utterances join here with the same
// annotations — the "Asked, but not answered" queue is the intake, this file
// is the archive. An utterance is a CLAIM about product behaviour: the
// chat-corpus test runs every no_ai claim on every change to the catalog.

export type NoAiExpect =
  | { kind: "answer"; rule: string }      // matchBasics replies with this rule
  | { kind: "command" }                   // a computed command takes it
  | { kind: "none" }                      // falls through to the generic reply
  | { kind: "never-offer" };              // MUST NOT match in offering mode

export interface CorpusCase {
  say: string;
  /** Broad bucket, for coverage reporting. */
  cat: string;
  no_ai: NoAiExpect;
  /** Informative: "answer" | "read:<tool>" | "action:<id>" | "create:<kind>"
   *  | "update" | "delete" | "escort:<dest>" | "clarify". */
  ai: string;
}

const answer = (rule: string) => ({ kind: "answer", rule } as const);
const none = { kind: "none" } as const;
const neverOffer = { kind: "never-offer" } as const;
const command = { kind: "command" } as const;

/** Expand one intent into its phrasings. */
function ph(cat: string, no_ai: NoAiExpect, ai: string, says: string[]): CorpusCase[] {
  return says.map((say) => ({ say, cat, no_ai, ai }));
}

export const CHAT_CORPUS: CorpusCase[] = [
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
  // ── questions about MY data (the everyday spellings) ─────────────────────
  ...ph("my-data", answer("my-data"), "read:list_records", [
    "how many parts do I have", "how many locations are there", "how much filament is there",
    "do I have any M3 screws", "is there any PLA left", "how much do I have of the black yarn",
    "what do I have in the garage", "which bin did the drill end up in", "where did the multimeter go",
    "where is my soldering iron", "where are my drill bits", "show me my printers",
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
    "how do i add a module", "where do i turn on purchases", "what features can I enable",
  ]),
  ...ph("how-to", answer("scan"), "answer", [
    "how do i scan", "where do I scan a barcode", "how does the qr scanning work",
  ]),
  ...ph("how-to", answer("invite-people"), "answer", [
    "how do i invite someone", "how do I add a user", "who can see this workspace",
  ]),
  // ── instructions: entity writes (never intercepted; AI acts) ─────────────
  ...ph("write", neverOffer, "create:record", [
    "add a part called Brass Widget, quantity 4",
    "create a location called Shelf 9 in the garage",
    "add a task to reorder filament",
    "new project: birdhouse for mom",
    "add 3 spools of black PLA",
    "log a maintenance entry for the CNC: changed the spindle belt",
  ]),
  ...ph("write", neverOffer, "update", [
    "rename the Colour field to Shade",
    "set the drill's location to Bin 4",
    "change the quantity of M3 screws to 40",
    "mark the birdhouse task done",
    "move the multimeter to the electronics bin",
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
