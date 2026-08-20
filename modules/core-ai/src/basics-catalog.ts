// Cobb's no-AI brain, server side. When a workspace has no AI provider, the
// Ask Cobb chat still answers the essentials from this hand-authored catalog
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
  /** Some replies do not ANSWER the message, they decline it: "that needs AI
   *  connected", "there is nothing waiting for a yes from me". Those are a
   *  reply to something a person chose to send, never something to volunteer
   *  while they are still typing — half a sentence has not asked for anything
   *  yet, and an unprompted "I can't help with that" is worse than silence.
   *  Also keeps them out of connected workspaces, where they are false. */
  notBeforeSend?: true;
  /** ...unless the question is still worth answering with AI on, just worded
   *  for that world. Wins over `reply` whenever a provider is available. */
  replyWhenAiOn?: string;
}

const CAPABILITIES = `Right now AI chat isn't connected, so I can't search your data or make changes for you — but I can point you to the right place:

- **Add stuff** — use **+ New** on any list (parts, printers, orders…), or **Scan** to add by barcode/photo.
- **Build your workspace** — the **Build** page turns a plain-English description into fields and modules.
- **Find things** — the search box up top spans every module.
- **Low stock, due dates, etc.** — open the list and sort or filter by that column.

Connect AI and I can do these *for* you from here — just ask.`;

// The same question in a workspace that HAS a provider. Asking "what can you
// do?" with AI connected used to get nothing back, because the only answer on
// file opened by saying AI was not connected.
const CAPABILITIES_AI = `Ask me about your workspace and I will go and look, or tell me to do something and I will do it:

- **Questions** — "how many parts do I have?", "what's low on stock?", "where is the label printer?"
- **Changes** — "add a part called Widget", "make racks 1-8 in the Garage", "move the drill to Shelf B".
- **Getting set up** — the **Build** page turns a plain-English description into fields and modules.

Every change I make is tracked, so you can undo it. Ask, and I will show you what I am about to do first.`;

// Order is the tie-breaker when two rules score equally: earlier wins. Keep the
// specific intents above the loose greeting so "how do I add…" isn't swallowed
// by a bare "hi".
export const BUILTIN_BASICS: BasicRule[] = [
  {
    key: "capabilities",
    intent: "capabilities / help",
    keywords: ["what can you do", "what do you do", "how do you work", "help", "capabilities", "commands", "options"],
    reply: CAPABILITIES,
    replyWhenAiOn: CAPABILITIES_AI,
  },
  {
    key: "what-is-cobblr",
    intent: "what is Cobblr",
    keywords: ["what is cobblr", "what is this", "what does this do", "what's this app", "how does cobblr work", "what can this do"],
    reply:
      "Cobblr is a build-it-yourself workspace: switch on the pieces you need (inventory, machines, projects, labels…) and it becomes a tool shaped to *your* thing, no code. Ask me **\"what can you do\"** for the tour, or open **Build** to describe what you want.",
  },
  {
    key: "connect-ai",
    intent: "connect / enable AI",
    keywords: ["connect ai", "enable ai", "turn on ai", "set up ai", "add ai", "ai provider", "ai key", "ai setup", "ai settings"],
    reply:
      "You connect AI under **Configuration → Connections → AI** (there's a link in the strip at the top of this panel). Add a provider key there and I can start answering questions about your workspace and making changes for you.",
  },
  {
    key: "who-is-cobb",
    intent: "who / what is Cobb",
    keywords: ["who are you", "what are you", "your name", "are you cobb", "who is cobb"],
    reply:
      "I'm Cobb, the workshop assistant. I help you set up and run your workspace. With AI connected I can dig through your data and make changes; without it I can still help you find your way around.",
  },
  {
    key: "add-item",
    intent: "add a part / item",
    keywords: ["how do i add", "add a part", "add an item", "new part", "new item", "create a", "add something", "add"],
    reply:
      "Use **+ New** at the top of the relevant list (Parts, Printers, Orders…), or hit **Scan** to add something by its barcode or a photo. Once AI's connected you can just tell me here (\"add a part called Widget\") and I'll do it.",
  },
  {
    key: "scan",
    intent: "scan",
    keywords: ["scan", "barcode", "qr code", "qr", "camera"],
    reply:
      "Open **Scan** from the nav to add items by barcode or photo. Known barcodes fill in a name and picture automatically; the rest you can name yourself. (Auto-naming unknown items needs AI connected.)",
    // Same directions, minus a caveat that does not apply to this workspace.
    replyWhenAiOn:
      "Open **Scan** from the nav to add items by barcode or photo. Known barcodes fill in a name and picture automatically, and I can name and describe the ones that aren't in any catalog from the photo itself.",
  },
  {
    key: "build",
    intent: "build / describe workspace",
    keywords: ["build my workspace", "set up my workspace", "what should i track", "describe what", "build page", "make an app", "build"],
    reply:
      "Head to the **Build** page: describe what you want to track in plain English and it'll propose the fields and modules, then set them up once you confirm.",
  },
  {
    // The single most-sent phrase in a real workspace's chat history, and it
    // used to fall through to the generic "I only handle the basics". Someone
    // saying "try again" has already been let down once; the answer has to say
    // what is actually in the way.
    key: "retry",
    intent: "try again / retry",
    keywords: [
      "try again",
      "try it again",
      "do it again",
      "retry",
      "one more time",
      "again please",
      "can you retry",
    ],
    reply:
      "Trying again will land in the same place, I am afraid: without AI connected I cannot act on your workspace, so there is nothing to retry. Connect AI using the link at the top and ask me again, and I will actually do it. If it already failed WITH AI connected, tell me what you asked for and I will say what went wrong.",
    notBeforeSend: true,
  },
  {
    // A bare confirmation with nothing to confirm. Basic mode proposes nothing,
    // so "yes" arriving here means the user thinks a change is queued up.
    key: "confirm-yes",
    intent: "yes / go ahead / do it",
    // NOT a bare "confirm": confirming a scan is a real thing people ask how to
    // do, and this rule would answer "there is nothing waiting for a yes".
    keywords: ["yes do it", "go ahead", "do it", "yes please", "yes go", "sounds good", "yep"],
    reply:
      "There is nothing waiting for a yes from me: with no AI connected I answer questions but never queue up a change. Connect AI using the link at the top and I will propose the change first, then do it once you confirm.",
    notBeforeSend: true,
  },
  {
    key: "stop-cancel",
    intent: "stop / cancel / never mind",
    keywords: ["stop", "cancel", "never mind", "nevermind", "forget it", "wait no"],
    reply:
      "Nothing is running, so there is nothing to stop. With no AI connected I only answer from a fixed set of replies. If a change already ran and you want it back, open the record and edit it, or use the undo on the change if one is offered.",
    notBeforeSend: true,
  },
  {
    key: "undo",
    intent: "undo / revert",
    keywords: ["undo", "undo that", "revert", "put it back", "take that back"],
    reply:
      "I cannot undo anything from here: without AI connected I have not changed anything to undo. When AI IS connected, every change I make shows an undo right in the chat, and you can undo an undo. A change you made yourself is edited or deleted on the record itself.",
    notBeforeSend: true,
  },
  {
    // The whole class of "questions about MY data". These are the ones a
    // no-AI workspace most wants answered and least can be, so the reply says
    // where to look instead of only saying no.
    key: "my-data",
    intent: "how many / what do I have / where is it",
    keywords: [
      "how many",
      "what do i have",
      "what have i got",
      "where is my",
      "where are my",
      "how much do i have",
      "what is low",
      "what's low",
      "running low",
      "what needs my attention",
      "show me my",
    ],
    reply:
      "Questions about your own records need AI connected, because answering them means reading your workspace. Connect AI using the link at the top and I will search and answer properly. In the meantime the search box at the top finds anything by name, and each list has filters and a low-stock view where the module offers one.",
    notBeforeSend: true,
  },
  {
    key: "find-search",
    intent: "find / search",
    keywords: ["search", "find", "how do i find", "where is", "look for", "look up", "can't find"],
    reply:
      "Use the **search box** at the top: it spans every module (parts, machines, projects…). Or hit **⌘K / Ctrl-K** for the command palette to jump anywhere fast.",
  },
  {
    key: "edit-update",
    intent: "edit / update something",
    keywords: ["how do i edit", "edit a", "edit an", "update a", "change a", "rename", "modify"],
    reply:
      "Open the item and hit its **edit** button (the pencil). Changes save right away. To change what *fields* a kind of thing has, that's **custom fields** in Configuration.",
  },
  {
    key: "delete-remove",
    intent: "delete / remove something",
    keywords: ["how do i delete", "delete", "remove", "get rid of", "trash"],
    reply:
      "Open the item and use **delete** (usually a trash icon), then confirm: that removes just that item. To drop a whole *feature*, turn its module off under Configuration → Build → Modules.",
  },
  {
    key: "custom-fields",
    intent: "custom fields",
    keywords: ["how do i add a field", "add a custom field", "custom field", "add a field", "new field", "extra field", "more fields", "track extra", "fields"],
    reply:
      "Add your own fields to any kind of thing under **Configuration → Build → Fields & forms**: a \"warranty expires\" date on parts, a \"shelf\" on inventory, whatever you track. New fields show up in forms, tables, and search automatically.",
  },
  {
    key: "enable-module",
    intent: "enable a module / feature",
    keywords: ["how do i add a module", "enable a module", "enable module", "turn on", "add a module", "enable inventory", "enable machines", "modules", "features", "add a feature"],
    reply:
      "Turn features on under **Configuration → Build → Modules**. A new workspace starts lean; switch on the parts you want (inventory, machines, projects, labels, and more) whenever you need them. They do nothing until you enable them.",
  },
  {
    key: "invite-people",
    intent: "invite people / sharing",
    keywords: ["how do i add a user", "how do i add someone", "invite", "add a user", "add someone", "add people", "share", "team", "members", "collaborator", "permissions", "who can"],
    reply:
      "Invite people and set what each can do under **Configuration → People → Permissions**. Roles run owner → admin → member → guest, so you decide who can edit, who can just look, and who runs the place.",
  },
  {
    key: "settings",
    intent: "settings / configuration",
    keywords: ["settings", "configuration", "configure", "where are the settings", "preferences"],
    reply:
      "Workspace settings live under **Configuration** (the hub): modules, fields, members, AI, and more. Your *personal* settings (profile, notifications) are in the **account menu** at the top-right.",
  },
  {
    key: "export-backup",
    intent: "export / backup",
    keywords: ["export", "backup", "back up", "download my data", "blueprint", "save a copy", "migrate"],
    reply:
      "You can **export or back up** the whole workspace as a **Blueprint** under Configuration: it captures your setup and data so you can restore it or clone it into another workspace.",
  },
  {
    key: "labels-qr",
    intent: "labels / QR / printing",
    keywords: ["print a label", "print label", "label", "print", "sticker"],
    reply:
      "With **Labels & QR** enabled, open an item to print a label or generate a **QR code** that links back to it, great for bins and shelves. Don't see it? Turn it on under Configuration → Build → Modules.",
  },
  {
    key: "mobile-app",
    intent: "mobile / app",
    keywords: ["mobile", "phone", "is there an app", "pair my phone", "ios", "android", "add to home screen"],
    reply:
      "Cobblr is a **PWA**. Open it in your phone's browser and \"Add to Home Screen\" for an app-like icon. You can also **pair your phone** to a workspace (to scan with its camera) from the capture/scan screen.",
  },
  {
    key: "account",
    intent: "account / password / sign out",
    keywords: ["log out", "logout", "sign out", "password", "reset password", "my account", "profile", "log in"],
    reply:
      "Your **account menu** is at the top-right: profile, password, notifications, and **sign out**. Locked out? An admin on this workspace can reset your password (there's no email reset).",
  },
  {
    key: "feedback-support",
    intent: "feedback / report a bug",
    // NOT a bare "support": "do you support kanban swimlanes" is a question
    // about a feature, and it was getting the report-a-bug answer.
    keywords: ["feedback", "report a bug", "bug", "contact support", "get support", "support ticket", "something's broken", "something is broken", "suggestion"],
    reply:
      "Found a bug or have an idea? Use **feedback** in your **account menu** (top-right): it goes straight to whoever runs this Cobblr.",
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
      "Hey. I'm Cobb. AI chat isn't wired up here yet, so I can't rummage through your workspace, but I can help you find your way around. Try **\"what can you do\"**.",
  },
];

/** Returned (and shown) when nothing matches, so the chat still closes the loop
 *  gracefully instead of inventing an answer. */
export const NO_MATCH_REPLY =
  "I can only handle the basics without AI connected — try **\"what can you do\"**. For anything about your actual data (or to have me make changes), connect AI using the link at the top and I'll take it from there.";
