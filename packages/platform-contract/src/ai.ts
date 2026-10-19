import type { ConnectionTestOutcome } from "./connection-verification.js";

// ──────────────────────── core-ai provider registry ───────────────
//
// Providers register at module load time (openai, anthropic, ollama
// ship built-in). The PlatformAi facade exposes a unified `invoke`
// that picks a provider + model based on the workspace's capability
// defaults, calls the provider, writes an audit row, returns the
// shaped result.

export const AiCapabilities = [
  "classify-image",
  "identify-image",
  "extract-text",
  "summarise",
  "embed-text",
  "chat",
  "match-to-catalog",
  // Multi-image: shown N candidate photos of one item, pick the best catalog
  // shot (product-only, correct colour, no people). The only capability that
  // sends more than one image in a call. See rank-images-prompt.ts.
  "rank-images",
  // One photo of SEVERAL things: list each distinct item with a bounding box,
  // so the scan inbox can split a group shot into children. It rode
  // identify-image with a caller-supplied prompt for a long time, and that cost
  // two separate bugs (adapters ignoring the prompt; a cache collision with the
  // identify call on the same photo) before it was given its own id. Its own
  // id is also what lets a workspace put splitting on a cheaper model than
  // identification and see its cost apart. The prompt itself is owned by the
  // caller (core-scan), which owns the output shape it parses.
  "split-image",
  // The FIRST LOOK at a photo: name + category + confidence, nothing else, so
  // it can come back in a second or two on a small model and be put to the
  // person as a question ("we think it's X - yes / no?") while the full
  // identify-image read runs, or is skipped because they answered. Its own id
  // because it asks a smaller question with a smaller answer, which is what
  // makes it fast; it is not identify-image with less context.
  "identify-glance",
  // Turning a sentence into a workspace: the bundle builder, the refine pass
  // and the template match. Its own id for the reason split-image has one, and
  // more so - it is the rarest call the platform makes and the one with the
  // most riding on it. Somebody describes what they keep, once, and either
  // recognises what comes back or gives up on the product.
  //
  // Rare and heavy is a different shape from chat, and a workspace should be
  // able to spend differently on it. On the free Google tier the fuller model
  // allows 20 requests a day against Lite's 500 (measured, see the preset):
  // hopeless for chat, exactly right for a handful of builds. Sharing chat's
  // id meant that trade could not be made at all.
  "design-workspace",
  // Reading a DOCUMENT: a bill of sale, an invoice, a receipt read as
  // paperwork, a warranty, a title, a form. Its own id because what rides on
  // it is a value somebody keeps (a VIN, a total, every line), so it goes to
  // each provider's fuller model, never its light one: Flash on Google's free
  // tier, not Lite, which stays for a quick glance at a photo (the owner,
  // 2026-10-02: "a document should get Flash, not Lite, since it's a more
  // serious item"). The caller sends its own prompt (what to read), and the
  // page as image_b64 with image_media_type; the answer is the model's text.
  // When the fuller model is busy the read waits for it rather than going to
  // a weaker one: a provider's busyAlternates are told the job, and answer
  // none lighter for this one.
  "document-read",
  "personal-document-read",
  // Planning a CHANGE in the chat: a turn that deletes a record or reshapes
  // the workspace (a feature off, a bundle removed, a list made, a field's
  // choices edited). The same conversation, tools and answer shape as `chat`,
  // and its own id so it goes to each provider's fuller model: a plan that
  // deletes or removes something is a serious action (the owner, 2026-10-02:
  // Flash, not Lite, on the same busy ladder). A turn starts on it when the
  // message asks for such a change, and moves to it the round the model
  // proposes one (modules/core-ai/src/api/plan-tier.ts). Never swapped down
  // to a lighter sibling when busy.
  "plan-changes",
  // Reading the TEXT of a document into fields: a receipt or invoice that came
  // as text (an email, a PDF with a text layer), the materials a pattern
  // lists. Its own id because it rode `chat` for a long time, so a person's
  // order for Cobb's chat read every receipt (the owner, 2026-10-10: choosing
  // Sonnet for Cobb read every receipt with Sonnet). It is thorough reading,
  // with documents and the scan inbox. The caller sends its own messages and
  // parses its own shape; a provider that does not declare it answers through
  // its chat, the same call as before.
  "read-document-text",
  // Naming a thing from TEXT evidence rather than a photo: a barcode's web
  // results, a product description checked against a photo's read. Thorough
  // reading, for the scan inbox; its own id for the reason above.
  "identify-from-text",
  // Organising what is already in the workspace: grouping pending scans into
  // themes, matching scans to records, planning a tidy-up, naming a sheet's
  // columns, laying out a floor plan's places. The caller's own prompt and
  // shape; a provider that does not declare it answers through its chat.
  "organise",
] as const;

export type AiCapability = (typeof AiCapabilities)[number];

/** How much of a conversation the assistant is given with each message: the
 *  newest this many. ONE number for both ends. The panel sends the newest
 *  part and the server keeps the newest part, so a long conversation never
 *  becomes a request the server refuses. The panel keeps the whole scrollback
 *  on the device; this bounds only what is sent and read. Forty messages of
 *  history was a server-side limit alone, and the twenty-first exchange in a
 *  conversation was a red "Bad request body" until the panel was cleared. */
export const CHAT_HISTORY_MESSAGES = 40;

/** A job an OLDER job can serve when nothing declares the new one.
 *
 *  A capability id is a promise to every provider that already exists, and
 *  they cannot all be updated at once: a third-party or user-installed
 *  provider written before `design-workspace` declares `chat` and nothing
 *  else. Without this, splitting a job out of another one takes the feature
 *  away from those workspaces entirely - a thing disappearing because of a
 *  refactor nobody asked them about.
 *
 *  So splitting a job is ADDITIVE. A provider that declares the new id is used
 *  for it; one that does not still answers through the job it always answered
 *  through, and the workspace's own choice comes first either way. It lives in
 *  the contract rather than in the resolver because it is part of the
 *  vocabulary: it says what a capability id MEANS to a provider that has never
 *  heard of it. */
export const AI_CAPABILITY_FALLBACK: Partial<Record<AiCapability, AiCapability>> = {
  "design-workspace": "chat",
  // A provider written before documents had their own job still reads one,
  // the way it reads any picture it is handed a prompt for.
  "document-read": "identify-image",
  "personal-document-read": "document-read",
  // A provider written before planning had its own job plans in its chat.
  "plan-changes": "chat",
  // Split out of chat (2026-10-10): every provider that read these through its
  // chat still does, with no change, until it declares them.
  "read-document-text": "chat",
  "identify-from-text": "chat",
  "organise": "chat",
};

/** A turn of the conversation, with tools and the chat answer shape: `chat`
 *  itself, or a planning turn on the fuller model. Every adapter asks this
 *  instead of comparing to "chat", so a planning turn is never handed the
 *  plain-text path (no tools, no tool_calls back). */
export function isChatTurn(capability: AiCapability | string): boolean {
  return capability === "chat" || capability === "plan-changes";
}

/** The capabilities to try, in order, for one requested job. */
export function aiCapabilityChain(capability: AiCapability): AiCapability[] {
  const next = AI_CAPABILITY_FALLBACK[capability];
  return next ? [capability, next] : [capability];
}

/** The jobs a person arranges AI by, and the capabilities each stands for.
 *  ONE list for the router (a person's own defaults are kept per job) and
 *  the pages that show the jobs, so the two cannot disagree about which job
 *  a capability belongs to. Every capability sits in exactly one job.
 *  `shows` is the capability whose chain stands for the job on a page and
 *  whose models a person picks from. */
export const AI_JOBS = [
  { id: "personal", phrase: "personal documents", title: "Personal documents", shows: "personal-document-read", capabilities: ["personal-document-read"] },
  // The owner (2026-10-10): "Identifying scans/photos in the moment needs to
  // be quick. Identifying things more thoroughly in the scan inbox can take
  // longer. Documents might fit in here. Cobb chat is separate."
  { id: "glance", phrase: "a quick look", title: "Quick look", shows: "identify-glance", capabilities: ["identify-glance"] },
  {
    id: "reading",
    phrase: "thorough reading",
    title: "Thorough reading",
    shows: "identify-image",
    capabilities: ["identify-image", "split-image", "rank-images", "classify-image", "extract-text", "document-read", "read-document-text", "identify-from-text"],
  },
  { id: "chat", phrase: "Cobb chat", title: "Cobb chat", shows: "chat", capabilities: ["chat", "plan-changes", "design-workspace"] },
  { id: "text", phrase: "organising and text", title: "Organising and text", shows: "organise", capabilities: ["summarise", "match-to-catalog", "organise"] },
  { id: "search", phrase: "search", title: "Search", shows: "embed-text", capabilities: ["embed-text"] },
] as const satisfies ReadonlyArray<{ id: string; title: string; /** The job inside a sentence: "for a quick look", "for Cobb chat". */ phrase: string; shows: AiCapability; capabilities: readonly AiCapability[] }>;

export type AiJobId = (typeof AI_JOBS)[number]["id"];
export const AI_JOB_IDS: readonly AiJobId[] = AI_JOBS.map((j) => j.id);

/** The job a capability belongs to. */
export function aiJobOf(capability: AiCapability): (typeof AI_JOBS)[number] {
  return AI_JOBS.find((j) => (j.capabilities as readonly string[]).includes(capability)) ?? AI_JOBS.find((j) => j.id === "chat")!;
}

/** One credential field an AI provider asks for. `choices` renders as a
 *  select (generic in every credential form) — e.g. the `transit` field on
 *  URL-based providers: direct fetch vs via the user's edge bridge. */
export interface AiCredentialField {
  label: string;
  secret: boolean;
  choices?: Array<{ value: string; label: string }>;
}

/** One numbered instruction on the way to a working connection. `href` turns it into a
 *  link, because "go to aistudio.google.com/apikey" as plain text is a URL somebody has
 *  to retype by hand, and that is where non-technical people give up. */
export interface AiSetupStep {
  text: string;
  href?: string;
}

/** How a person GETS the credentials this provider wants.
 *
 *  Without this the only place to explain "sign in, click Create API key, paste it here"
 *  was inside a field label, which renders as one long unclickable parenthetical. The
 *  fields say WHAT to paste; this says HOW to get it. */
export interface AiProviderSetup {
  /** One line on what this provider is and what it costs, before the steps. */
  summary: string;
  /** Ordered. Short enough to follow while switching between two tabs. */
  steps: AiSetupStep[];
  /** Anything true that a person should know before choosing it, e.g. what the free
   *  tier does with their data. Rendered as a caveat, not buried in a step. */
  caveat?: string;
}

export type AiPrivacy = "personal" | "normal";
export const AI_JOB_PRIVACY: Record<AiCapability, AiPrivacy> = {
  "classify-image": "normal",
  "identify-image": "normal",
  "extract-text": "normal",
  "summarise": "normal",
  "embed-text": "normal",
  "chat": "normal",
  "match-to-catalog": "normal",
  "rank-images": "normal",
  "split-image": "normal",
  "identify-glance": "normal",
  "design-workspace": "normal",
  "document-read": "normal",
  "personal-document-read": "personal",
  "plan-changes": "normal",
  "read-document-text": "normal",
  "identify-from-text": "normal",
  "organise": "normal",
};

/** The jobs a person may set their OWN default AI for (#5404): every job but
 *  a personal one. Personal documents are read by a local model only, by the
 *  workspace's own rule, so a person's defaults never reach them. */
export const AI_DEFAULT_JOBS = AI_JOBS.filter((j): j is Exclude<(typeof AI_JOBS)[number], { id: "personal" }> => AI_JOB_PRIVACY[j.shows] !== "personal");
export type AiDefaultJobId = (typeof AI_DEFAULT_JOBS)[number]["id"];

/** The job a person's own defaults answer a capability with, or null when
 *  they never do (personal documents). */
export function aiDefaultJobOf(capability: AiCapability): AiDefaultJobId | null {
  const id = aiJobOf(capability).id;
  return AI_DEFAULT_JOBS.find((j) => j.id === id)?.id ?? null;
}

export interface AiProviderDef {
  locality?: "local" | "cloud";
  id: string;
  label: string;
  /** The company a call is sent to, as a person consents to it: "Anthropic",
   *  "Google". Named in the consent to read personal documents in the cloud
   *  (#5621); the label stands in when it is not set. */
  company?: string;
  describeCredentials: () => Record<string, AiCredentialField>;
  /** Step-by-step, shown in the UI when this provider is picked. Optional: a provider
   *  needing no credentials (a managed one) has nothing to instruct. */
  setup?: AiProviderSetup;
  /** Where this sits in the picker. Lower sorts first, and the FIRST entry is what the
   *  add form defaults to, so this decides what someone with no AI at all is offered.
   *  Unset sorts last.
   *
   *  Explicit because it used to be import order in one file, which meant the default
   *  provider could change as a side effect of adding an unrelated `register()` line
   *  and nothing would say so. */
  rank?: number;
  /** Map capability → models the provider supports for it. */
  capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
  /** What a model is CALLED and what it costs, for a picker a person reads.
   *  "gemini-flash-lite-latest" means nothing at a glance; "Flash Lite - 500
   *  free a day" is a decision. Optional; an id with no entry shows as its id. */
  modelNotes?: Record<string, { label: string; note?: string; short?: string }>;
  /** How this provider's models are LISTED rather than written down (#5417):
   *  its own models endpoint, family and version per id, a rule per job, and
   *  the one fallback list for when it cannot be asked. A provider with a
   *  catalog offers "latest" per family, resolved before every call. */
  modelCatalog?: import("@cobblr/platform-contract/ai-models").AiModelCatalog;
  /** Whether a workspace that has configured NO provider may have this one
   *  auto-selected by the zero-config fallback. Default true — a managed,
   *  credential-less provider (instance key) is ready to use. A provider that
   *  needs per-user setup before it works — e.g. the edge bridge needs a
   *  connected agent + a personal Connection — sets `false`, so it's used only
   *  when explicitly chosen/routed and a missing-provider case stays a clean
   *  "no provider configured" rather than an error from the unset provider. */
  autoSelectable?: boolean;
  freeBackground?: boolean;
  freeBackgroundModel?: string;
  /** This backend RUNS tools itself and cannot hand `tool_calls` back (a
   *  `claude -p`-style agent). Cobb's tools reach it as a read-only MCP relay
   *  instead: the platform mints a short-lived, workspace-pinned grant and puts
   *  it on `input.mcp` for the adapter to forward.
   *
   *  A BYO connection declares the same thing per-connection through the
   *  `mcp_relay: "bridge"` credential field. This is the declaration for a
   *  provider that is ALWAYS such a bridge and has no credentials to carry a
   *  flag — a managed one, say. Without it, that provider silently receives no
   *  tools at all: every read tool and every action invisible, the model left
   *  saying "I don't have that tool", and nothing logged. (Found on staging
   *  2026-08-15: the assistant's whole tool surface was dark on the managed
   *  bridge, and it read like a plausible refusal rather than a fault.) */
  relaysToolsViaMcp?: boolean;
  /** Its connection test shows it a known picture (AiConnectionTest.photos),
   *  because whether its backend looks at an image is in doubt (a bridge to an
   *  agent). Until that test has run, the AI page says "not checked with a
   *  photo" about it; a provider that reads images natively is not in doubt
   *  and is never flagged. */
  checksPhotosInTest?: boolean;
  /** Its testConnection already makes a real generation (a bridge asks its
   *  agent; the replay double answers from its cassette), so the registry
   *  does not add another (ai-verify.ts, #6024). Every other provider's
   *  verify is its own check and then one tiny generation. */
  generatesInTest?: boolean;
  /**
   * A fingerprint of the PROMPT this provider will actually send for
   * (capability, input) — i.e. the part of the request that the caller's `input`
   * does NOT already contain.
   *
   * The AI cache keys on `{capability, provider, model, input}`. For most image
   * capabilities the prompt is NOT in `input`: it's a constant the adapter injects
   * (`IDENTIFY_PROMPT`, and the extract-text / match-to-catalog / summarise
   * literals). So **editing one of those prompts changed nothing about the cache
   * key, and every already-seen image kept returning the answer generated by the
   * OLD prompt — forever, because cache rows have no TTL.**
   *
   * The worst victim was the prompt-eval harness: the one tool whose entire job is
   * to measure whether a prompt change helped was scoring stale replies.
   *
   * Returning a hash of the built prompt folds it into the key, so a prompt edit
   * invalidates exactly the entries it should and nothing else. Omit it and the
   * old (broken) behaviour stands — which is why every first-party adapter
   * implements it, and why a lint fails a new one that doesn't.
   *
   * MUST NOT hash the image bytes: they are already in `input` and therefore
   * already in the key. Hashing megabytes on every call to re-derive something the
   * key has would be pure waste.
   */
  promptFingerprint?: (capability: AiCapability, input: Record<string, unknown>) => string | null;
  /** The model this provider will ACTUALLY send for a call, and whether a
   *  person chose it (a model typed on the connection, or a workspace's choice
   *  for the job) rather than it being the provider's own default. The call
   *  log records this model: an adapter that resolves a placeholder such as
   *  "default" internally used to leave the log naming the placeholder, so the
   *  model that failed was the one thing a failure line never said (#3819).
   *  Omit it and the log records the model the router handed over. */
  resolveModel?: (ctx: {
    capability: AiCapability;
    model: string;
    credentials: Record<string, unknown>;
  }) => { model: string; chosen: boolean };
  /** Other models on the SAME key to try, in order, when this one stays busy
   *  after its retries, before the router tries another provider. Only used
   *  for a model nobody chose (see resolveModel): a person's explicit model is
   *  never swapped behind their back. For a provider whose default is a
   *  floating alias that can be overloaded for an hour while its sibling
   *  answers. Told the job, because a sibling fit for one job is not for
   *  another: a document is never handed to a lighter model (document-read). */
  busyAlternates?: (model: string, capability: AiCapability) => string[];
  /** Run a single inference. The platform handles caching + audit
   *  before/after. */
  invoke: (ctx: {
    privacy?: AiPrivacy;
    orgId: string;
    rowId: string;
    capability: AiCapability;
    model: string;
    credentials: Record<string, unknown>;
    input: Record<string, unknown>;
    config: Record<string, unknown>;
    /** Called with each piece of the answer as it arrives, when the caller
     *  wants to show words appearing rather than a spinner. Optional on both
     *  sides: a caller may not care, and an adapter whose provider cannot
     *  stream simply never calls it and returns the whole thing as before. */
    onDelta?: (text: string) => void;
  }) => Promise<{
    result: unknown;
    input_tokens?: number;
    output_tokens?: number;
    /** Prompt tokens a provider read from its prompt cache, and wrote to it
     *  (#5319); counted apart from input_tokens, as Anthropic reports them. */
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_cents?: number;
    /** The model the provider's response says answered, as it said it
     *  (Anthropic's and an OpenAI-compatible `model`, Ollama's `model`).
     *  A provider can serve another model than the one asked for, silently
     *  (a deprecated model redirected to its successor), so the ledger
     *  keeps both. Absent or null when the response did not say: never a
     *  copy of the requested id. */
    served_model?: string | null;
  }>;
  /** Optional health/test ping.
   *
   *  `models` is what the provider says it can serve. The check for "is this key any
   *  good" is usually a model-list request anyway, so the list comes back free with the
   *  answer — and it is what lets the UI offer a dropdown instead of asking someone to
   *  type an exact model name they have no way to know. */
  testConnection?: (credentials: Record<string, unknown>) => Promise<AiConnectionTest>;
  /** The models THIS connection serves, asked of it live (an Ollama's
   *  /api/tags, an OpenAI-compatible /models, a bridge's own list). A
   *  provider whose models depend on the endpoint implements it, so a menu
   *  offers what the connection has rather than the type's suggestions; a
   *  hosted service with a curated list leaves it out. Throws when the
   *  connection cannot be asked. */
  listModels?: (credentials: Record<string, unknown>) => Promise<string[]>;
}

/** What a connection reported it serves (platform().ai.modelsReportedBy),
 *  with the model typed on the connection itself always among them: a pinned
 *  entry the person added stays choosable even when the list cannot be read. */
export type AiReportedModels =
  | {
      ok: true;
      models: string[];
      /** For a provider with a model catalog: the picker's entries for the
       *  job asked about, "latest" per family first, then pins. */
      choices?: import("@cobblr/platform-contract/ai-models").AiModelChoice[];
      /** The listing could not be read and these came from the provider's
       *  fallback list: why, for a "Refresh models" beside them. */
      fallback?: string;
    }
  | { ok: false; error: string; models: string[] };

export interface AiConnectionTest extends ConnectionTestOutcome {
  error?: string;
  /** Why it failed, as the provider said it (provider-reason.ts): a bad key,
   *  a quota, a missing model, or a provider that did not answer. */
  reason?: import("./provider-reason.js").ProviderReason;
  /** Human-readable extra, e.g. a few model names. */
  detail?: string;
  /** Every model id the provider reported, unfiltered and in its own order. */
  models?: string[];
  /** The model the verify GENERATED with (ai-verify.ts): the one a pass
   *  names, or the one refused. Never a listed model nobody asked (#6024). */
  model?: string;
  /** A refused chosen model: the connection's default that answered instead. */
  default_answers?: string;
  /** The provider's own words for a refusal (connection-verification.ts). */
  provider_said?: string;
  /** The provider, as the screen names it. */
  provider?: string;
  /** Said instead of a verdict when the provider implements no test at all. */
  note?: string;
  /** A provider that can be handed an image but whose backend may or may not
   *  look at it (a bridge to an agent) is shown a known picture as part of
   *  its test: `read` is whether its answer named what is in it. Absent when
   *  the test did not try. */
  photos?: { read: boolean; said?: string };
}

/** A pluggable entitlement guard. Called by invoke() AFTER the provider +
 *  model are resolved but BEFORE caching/inference. Returning { allow:false }
 *  makes invoke() refuse exactly like "no provider configured" — so every
 *  caller's existing degrade path (the ai:false contract) handles it.
 *
 *  Open core ships NO guard (everything is allowed — self-host runs free).
 *  The hosted overlay registers one that denies the managed providers unless
 *  the org's plan/allowance permits it. This is the seam the proprietary
 *  cloud layer plugs into; the billing logic itself is NOT in the open core.
 *  See business-models/docs/09. */
export interface AiEntitlementGuard {
  (ctx: {
    orgId: string;
    capability: AiCapability;
    providerId: string;
    model: string;
  }): Promise<{ allow: boolean; reason?: string }>;
}

/** SSRF policy for AI providers that fetch a workspace-supplied URL
 *  (e.g. the ollama `base_url`). "lan" allows RFC1918 (a self-hosted
 *  Ollama lives on the LAN); "strict" blocks all private/loopback/
 *  metadata (a cloud tenant's "home" endpoint is reached over the
 *  public internet). Open core defaults to "lan"; the hosted overlay
 *  sets "strict" at boot. See docs/operations/security-audit.md §10. */
export type AiEndpointPolicy = "lan" | "strict";

/** One AI in the order a call would ask them (platform().ai.chainFor). */
export interface AiChainStep {
  position: number;
  /** Within the providers one call may ask. */
  asked: boolean;
  provider_id: string;
  /** The connection's own name for a personal one or a workspace provider
   *  with a label; the provider's otherwise. */
  label: string;
  model: string;
  /** What a person reads for the model ("Haiku · latest (5.5)"), when the
   *  provider lists its models. */
  model_label?: string;
  floating: boolean;
  source: "yours" | "shared" | "workspace" | "managed";
  credential_id?: string;
  owner_user_id?: string;
  provider_row_id?: string;
  /** One of the caller's own default steps for the job (#5404): set on Your
   *  account, Connections, not ordered from a workspace's page. */
  your_default?: true;
}

export interface PlatformAi {
  registerProvider(p: AiProviderDef): void;
  /** Register the (single) entitlement guard. Last registration wins;
   *  open core never calls this — only the hosted overlay does. */
  registerEntitlementGuard(g: AiEntitlementGuard): void;
  /** SSRF policy for workspace-supplied provider URLs. Defaults to
   *  "lan"; the hosted overlay sets "strict" at boot. Providers that
   *  fetch a user URL read this via getEndpointPolicy(). */
  getEndpointPolicy(): AiEndpointPolicy;
  setEndpointPolicy(p: AiEndpointPolicy): void;
  listProviders(): Array<{
    id: string;
    label: string;
    // AiCredentialField, not a narrower inline copy: `choices` was already missing here
    // while the UI reads it, so the type was quietly lying about the payload.
    credentials: Record<string, AiCredentialField>;
    capabilities: Partial<Record<AiCapability, { models: string[]; defaultModel?: string }>>;
    /** What each model is called and costs, for a picker a person reads. */
    modelNotes?: Record<string, { label: string; note?: string; short?: string }>;
    setup?: AiProviderSetup;
    /** Position in the picker; lower first, and FIRST IS THE DEFAULT. The list
     *  is returned already sorted by it — carried as well as applied, so a
     *  consumer that re-merges these with another registry can re-sort. */
    rank?: number;
    locality?: "local" | "cloud";
  }>;
  getProvider(id: string): AiProviderDef | null;
  /** Every AI a call for `capability` by `userId` would ask, in the order it
   *  asks them: the router's own walk (#3842), so a surface that lists
   *  choices cannot offer one the router would never reach or leave out one
   *  it would. A person's own "Just me" connection is in it; somebody else's
   *  is only when shared with the workspace. */
  chainFor(orgId: string, userId: string | null, capability: AiCapability, opts?: { limit?: number; privacy?: AiPrivacy }): Promise<{ steps: AiChainStep[] }>;
  /** The models a connection serves, asked of it (briefly cached), for a menu
   *  or a setting that must offer only what it has. Names the workspace's own
   *  provider (`providerId`) or a personal connection routed here
   *  (`credentialId`). Null when the provider keeps a curated list instead
   *  (no listModels), or the connection is not one this caller may use. */
  modelsReportedBy(
    orgId: string,
    userId: string | null,
    ref: { providerId?: string; credentialId?: string },
    opts?: { fresh?: boolean; capability?: AiCapability },
  ): Promise<AiReportedModels | null>;
  /** The models a connection's calls asked for and were answered by
   *  another model (requested id to served id): a provider redirecting a
   *  deprecated model, learned from each call's served model. Any provider,
   *  a curated list's too. Null when none, or when the caller may not use
   *  the connection. */
  modelRedirects(orgId: string, userId: string | null, ref: { providerId?: string; credentialId?: string }): Promise<Record<string, string> | null>;
  /** Single entry point for any module to use AI. Picks provider +
   *  model from the workspace's capability defaults, calls the
   *  cache, calls the provider, writes audit + cache rows, returns
   *  the result. */
  invoke(req: ({ privacy: "personal"; provider_id?: never } | { privacy?: "normal"; provider_id?: string }) & {
    orgId: string;
    capability: AiCapability;
    input: Record<string, unknown>;
    /** Override provider + model from workspace defaults. */
    model?: string;
    /** A PERSONAL connection routed into this workspace, chosen for this call
     *  (cobblr_meta.user_credentials.id). The chat's model pill sets it per
     *  user; a workspace's per-job default sets it per workspace. Wins over
     *  the workspace's own providers, the way naming a provider_id does. */
    credential_id?: string;
    /** Per-call provider knobs (max_tokens, temperature, …) merged OVER the
     *  workspace capability-default config. A surface that knows its own
     *  needs (the matchmaker's 2-candidate JSON never fits 1024 tokens)
     *  states them here instead of relying on an ops-set DB row. */
    config?: Record<string, unknown>;
    /** Skip cache lookup AND skip cache write. Useful for
     *  match-to-catalog after a user rejects a suggestion. */
    bypass_cache?: boolean;
    /** REPLAY ONLY — serve from cache, and if there's no cached reply, fail
     *  instead of calling the provider. Costs nothing and spends no tokens.
     *
     *  This is what makes a "re-run without AI" possible: every AI stage already
     *  degrades to a deterministic path when a call fails (identify → null, the
     *  matchmaker → its keyword heuristic), so replaying the model's PREVIOUS
     *  answers through TODAY's parsers and heuristics exercises a fix to them
     *  without buying a single token. The miss throws in the "no provider" error
     *  family precisely so those existing degrade paths handle it unchanged.
     *
     *  It cannot test a PROMPT change: the cache key hashes the input (the image),
     *  not the prompt, so a cached reply answers whatever prompt was live when it
     *  was bought. Mutually exclusive with bypass_cache; bypass_cache wins. */
    cache_only?: boolean;
    costPolicy?: "free";
    source?: { kind: string; id: string };
    /** The user who initiated this call (for the AI activity log). Null/absent
     *  for system-initiated calls (e.g. a wire). */
    userId?: string | null;
    /** Show the answer as it is written. Passed to the adapter, which streams
     *  when its provider can and ignores it when it cannot — so a caller may
     *  always pass it and simply see nothing until the end. A cached reply
     *  never streams: there is nothing to watch, it is already written. */
    onDelta?: (text: string) => void;
    /** What this call does when no AI answers (no provider, the plan's limit, a refusal): its no-AI
     *  path, said where the call is made (#5761). `heuristic` names the deterministic answer the caller
     *  falls back to (the matchmaker's keyword match); `byHand` is what the person is told to do instead.
     *  Every new call site states one (lint:ai-invoke-no-ai); "heuristic first, AI last". */
    noAi?: { heuristic: string } | { byHand: string };
  }): Promise<{
    /** The adapter's answer as it gave it: tool calls, a vector, the message. */
    result: unknown;
    /** The words of the answer, whichever key the adapter put them under
     *  (`content` for chat, `text` for the rest, or a bare string), and "" for
     *  an answer with none. Read this, never `result.text` or
     *  `result.content` (@cobblr/platform-contract/ai-answer). */
    text: string;
    provider_id: string;
    model: string;
    cached: boolean;
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
    cost_cents?: number;
    duration_ms: number;
    /** The model the provider said answered, when it said; `model` is the
     *  one asked for (servedModelDiffers in ai-models says whether they are
     *  different models). */
    served_model?: string | null;
    /** The providers asked first that did not answer (busy, unreachable, a
     *  limit, a key), oldest first, when this answer came from the next
     *  provider the workspace lists (#3819). Absent when the first answered. */
    answered_after?: Array<{ provider_id: string; label: string; model: string; reason: string }>;
    /** What a person reads for the connection that answered: its own name
     *  ("Claude bridge (Sam)") when it has one, else the provider's. */
    provider_label?: string;
    /** The kind of AI it is ("Local AI (via edge bridge)"), a secondary hint
     *  beside the name. */
    provider_kind_label?: string;
  }>;
}
