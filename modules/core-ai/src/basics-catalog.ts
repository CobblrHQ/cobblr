// Cobb's no-AI brain, server side. When a workspace has no AI provider, the
// Ask Cobblr chat still answers the essentials from this hand-authored catalog
// with ZERO model calls — greetings, "what can you do", how-do-I pointers.
//
// This is the built-in floor: same defaults for every workspace, edited here in
// code. Per-workspace overrides + custom rules land in a `core_ai_basics` table
// in a later phase (see docs/design-decisions/no-ai-chat-training.md); this
// catalog stays the frozen default those rows overlay. Keep the voice Cobb's —
// unpretentious, warm, sentence case, concise.

export interface BasicRule {
  /** stable id — the key a per-workspace override row will target */
  key: string;
  /** human label shown in the (future) management UI + returned for debugging */
  intent: string;
  /** lexical triggers — phrases/keywords matched on word boundaries (no regex,
   *  no model). A longer phrase is a more specific, higher-scoring match. */
  keywords: string[];
  /** the answer, in Cobb's voice */
  reply: string;
}

const CAPABILITIES = `Right now AI chat isn't connected, so I can't search your data or make changes for you — but I can point you to the right place:

- **Add stuff** — use **+ New** on any list (parts, printers, orders…), or **Scan** to add by barcode/photo.
- **Build your workspace** — the **Build** page turns a plain-English description into fields and modules.
- **Find things** — the search box up top spans every module.
- **Low stock, due dates, etc.** — open the list and sort or filter by that column.

Connect AI and I can do these *for* you from here — just ask.`;

// Order is the tie-breaker when two rules score equally: earlier wins. Keep the
// specific intents above the loose greeting so "how do I add…" isn't swallowed
// by a bare "hi".
export const BUILTIN_BASICS: BasicRule[] = [
  {
    key: "capabilities",
    intent: "capabilities / help",
    keywords: ["what can you do", "what do you do", "how do you work", "help", "capabilities", "commands", "options"],
    reply: CAPABILITIES,
  },
  {
    key: "connect-ai",
    intent: "connect / enable AI",
    keywords: ["connect ai", "enable ai", "turn on ai", "set up ai", "add ai", "ai provider", "ai key", "ai setup", "ai settings"],
    reply:
      "You connect AI under **Configuration → AI** (there's a link in the strip at the top of this panel). Add a provider key there and I can start answering questions about your workspace and making changes for you.",
  },
  {
    key: "who-is-cobb",
    intent: "who / what is Cobb",
    keywords: ["who are you", "what are you", "your name", "are you cobb", "who is cobb"],
    reply:
      "I'm Cobb — the workshop assistant. I help you set up and run your workspace. With AI connected I can dig through your data and make changes; without it I can still help you find your way around.",
  },
  {
    key: "add-item",
    intent: "add a part / item",
    keywords: ["how do i add", "add a part", "add an item", "new part", "new item", "create a", "add something", "add"],
    reply:
      "Use **+ New** at the top of the relevant list (Parts, Printers, Orders…), or hit **Scan** to add something by its barcode or a photo. Once AI's connected you can just tell me here — \"add a part called Widget\" — and I'll do it.",
  },
  {
    key: "scan",
    intent: "scan",
    keywords: ["scan", "barcode", "qr code", "qr", "camera"],
    reply:
      "Open **Scan** from the nav to add items by barcode or photo. Known barcodes fill in a name and picture automatically; the rest you can name yourself. (Auto-naming unknown items needs AI connected.)",
  },
  {
    key: "build",
    intent: "build / describe workspace",
    keywords: ["build my workspace", "set up my workspace", "what should i track", "describe what", "build page", "make an app", "build"],
    reply:
      "Head to the **Build** page — describe what you want to track in plain English and it'll propose the fields and modules, then set them up once you confirm.",
  },
  {
    key: "thanks",
    intent: "thanks",
    keywords: ["thank you", "thanks", "thx", "cheers", "appreciate it", "nice one"],
    reply: "Anytime.",
  },
  {
    key: "greeting",
    intent: "greeting",
    keywords: ["hi", "hey", "hello", "yo", "howdy", "sup", "hiya", "heya", "good morning", "good afternoon", "good evening", "greetings"],
    reply:
      "Hey — I'm Cobb. AI chat isn't wired up here yet, so I can't rummage through your workspace, but I can help you find your way around. Try **\"what can you do\"**.",
  },
];

/** Returned (and shown) when nothing matches, so the chat still closes the loop
 *  gracefully instead of inventing an answer. */
export const NO_MATCH_REPLY =
  "I can only handle the basics without AI connected — try **\"what can you do\"**. For anything about your actual data (or to have me make changes), connect AI using the link at the top and I'll take it from there.";
