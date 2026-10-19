import type { ConnectionVerification } from "@cobblr/platform-contract/connection-verification";
import type { AiConnectionTest, AiDefaultJobId, AiReportedModels } from "@cobblr/platform-contract";
import type { ProposalValue } from "../proposal-values";
import { idsThatFitAUrl, lookupInBody, request } from "./client";
import type { AiChainAnswer } from "../ai-chain";
import type { AiProviderDef } from "./integrations";

export interface AiStatus {
  available: boolean;
  reason: "ok" | "operator_disabled" | "not_entitled" | "no_provider" | "workspace_disabled";
  /** When available, where the call would be served from — drives honest copy. */
  source?: "personal" | "workspace" | "managed";
  /** A SEPARATE axis: this person's photo or barcode can be identified here,
   *  through the hosted service (even with no chat provider connected) or a
   *  provider with the image capability routed to them. Scan surfaces must
   *  not claim "basic mode" or "set it up" when identification does work. */
  identify_available?: boolean;
  /** Where identification would be served from, when it is available. */
  identify_source?: "hosted" | "personal" | "workspace" | "managed";
  /** Why identification is NOT available, when the reason is worth its own
   *  sentence. `hosted_scope`: this deployment's photo identify serves other
   *  workspaces, not this one, and the person's own AI is the way in. */
  identify_reason?: "hosted_scope";
  /** This deployment can read the text off an image with no model (the
   *  receipt-shape check before identify, the receipt door's line tier). */
  ocr_available?: boolean;
}

/** What the no-AI matcher offers to RUN, when a learned command fits. */
export interface BasicCommandOffer {
  id: string;
  template: string;
  operations: number;
  summary: string;
  /** Everything it will touch, one per line. */
  lines?: string[];
  /** What it found and is NOT touching: one sentence, ending in a colon when
   *  `also` lists the records it counts. */
  note?: string;
  /** Every record the note counts, each its own bullet on the card; a link
   *  when its kind is known, `why` when the sentence does not say. */
  also?: Array<{ id: string; title: string; kind?: string; why?: string }>;
  /** What sending the message would do about them; under the list. */
  hint?: string;
  /** The label over the records it left, with their count ("Left in
   *  Inventory, could not tell (6):"). */
  leftHeading?: string;
  /** One per destination when there are two or more: what goes where, each
   *  runnable on its own by key (`runCommand(..., section)`). Absent for one
   *  destination, which is one card. */
  sections?: PlanSectionOffer[];
}

/** One destination of a plan with several. */
export interface PlanSectionOffer {
  key: string;
  /** "4 into Groceries", "2 into a new Spices section". */
  heading: string;
  /** The records it moves; each a link on the card. `why` is the word that
   *  put it there when that was the table's vocabulary, not the person's. */
  lines: Array<{ id: string; title: string; kind?: string; why?: string }>;
  /** How many operations it is (a new list's create counts). */
  operations: number;
  note?: string;
}

/** Result of the no-AI basic-mode matcher (POST …/core-ai/basics/answer). */
export interface BasicAnswer {
  matched: boolean;
  reply: string;
  intent: string | null;
  key: string | null;
  score: number;
  candidates: Array<{ key: string; intent: string; score: number }>;
  /** Present when a learned command fits: an offer to RUN it, which the chat
   *  turns into a confirm rather than doing on its own. */
  command?: BasicCommandOffer;
  /** Present when a control word (yes / again / undo / stop) resolved against
   *  the prior turn: the act the chat should execute through the ordinary
   *  endpoints. See modules/core-ai/src/control-context.ts. */
  act?:
    | { kind: "run-command"; id: string; message: string }
    | { kind: "undo"; ledger_ids: string[] }
    | { kind: "dismiss-offer" };
}

/** The prior turn, summarised for the no-AI answer call so control words can
 *  point at something. The conversation lives on the client; this is its
 *  bounded shadow. */
export interface BasicPrior {
  offered?: { id: string; message: string };
  ran?: { id: string; message: string };
  ledger_ids?: string[];
}

/** One rule in the effective ruleset (GET …/core-ai/basics). */
export interface BasicRuleRow {
  /** row id, or null for a pristine built-in with no override row yet */
  id: string | null;
  /** built-in key, or the custom row id — stable per rule */
  key: string;
  builtin: boolean;
  intent: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  position: number;
}

/** Editable fields when creating/updating a rule. */
export interface BasicRuleInput {
  intent: string;
  keywords: string[];
  reply: string;
  enabled?: boolean;
}

/** One unanswered question (GET …/core-ai/basics/misses). */
export interface BasicMissRow {
  id: string;
  sample: string;
  times: number;
  first_seen: string;
  last_seen: string;
}

/** A command derived from a successful interaction, not yet adopted. */
export interface CommandCandidate {
  prompt: string;
  did: string;
  operations: number;
  template: string;
  pattern: string;
  slots: Array<{ name: string; kind: string }>;
  plan: Array<{ tool: string; entity_kind: string; action_id?: string | null; payload: Record<string, unknown> }>;
  repeat_field?: string;
  repeat_shape?: string;
  last_used: string;
}

/** A command the workspace has adopted. */
export interface LearnedCommandRow {
  id: string;
  template: string;
  pattern: string;
  enabled: boolean;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
}

/** A raw core_ai_basics row (returned by create/update). */
export interface BasicRuleRaw {
  id: string;
  builtin_key: string | null;
  intent: string;
  keywords: string[];
  reply: string;
  enabled: boolean;
  position: number;
  created_at: string;
  updated_at: string;
}
export type { ConnectionVerification } from "@cobblr/platform-contract/connection-verification";

export interface AiProvider {
  id: string;
  provider_id: string;
  label: string;
  config: Record<string, unknown>;
  enabled: boolean;
  monthly_budget_cents: number | null;
  /** Null for a row never checked. */
  verification?: ConnectionVerification | null;
  created_at: string;
  updated_at: string;
}

/** A personal credential the user configured once + routed to workspaces. */
/** Ask Cobb per-user prefs: the three pills. The model fields are null when
 *  the workspace's default applies. */
export interface ChatPrefs {
  read_tools: boolean;
  write_mode: "off" | "ask" | "auto";
  provider_id?: string | null;
  model?: string | null;
  credential_id?: string | null;
}
export interface ChatPrefsInput {
  read_tools: boolean;
  write_mode: "off" | "ask" | "auto";
  /** Omitted = leave the model choice alone; null = back to the workspace default. */
  provider_id?: string | null;
  model?: string | null;
  credential_id?: string | null;
}
export interface ChatModelOption {
  key: string;
  label: string;
  /** What the pill shows at rest; fits beside two other chips on one row. */
  short: string;
  note?: string;
  choice: { provider_id: string | null; model: string; credential_id: string | null };
}
export interface ChatModelMenu {
  /** `unlisted`: the connection could not be asked what it serves; the menu
   *  says so with a Retry instead of options. */
  groups: Array<{ key: string; heading: string; owner?: "you" | "shared"; options: ChatModelOption[]; unlisted?: { error: string } }>;
  current: ChatModelOption | null;
  defaultLabel: string | null;
  defaultShort: string;
}

/** One entry of a model picker for a provider that lists its models: each
 *  family's "latest" first, then exact versions to pin (#5417). */
export interface AiModelChoiceView {
  id: string;
  /** "Haiku · latest (5.5)" or "Haiku 4.5". */
  label: string;
  short: string;
  latest?: { family: string; resolves: string };
}

/** GET /me/ai-defaults: a person's own default AI per job (#5404). One row
 *  per job and connection step, with its order and model, so the page can
 *  draw it as chains or as a jobs-by-connections grid. */
export interface MyAiDefaults {
  jobs: Array<{
    id: AiDefaultJobId;
    title: string;
    steps: Array<{ credential_id: string; model: string; model_label?: string; label: string; provider_id: string | null; usable: boolean }>;
    /** Workspaces that chose for this job themselves, and which of its
     *  capabilities they chose for. */
    own_order_in: Array<{ org_id: string; slug: string; name: string; can_change: boolean; capabilities: string[] }>;
  }>;
  connections: Array<{
    id: string;
    label: string;
    provider_id: string;
    /** The models it can do each job with; a job it cannot do is absent. */
    jobs: Partial<Record<AiDefaultJobId, { models: string[]; default_model: string | null; choices?: AiModelChoiceView[] }>>;
    unlisted?: string;
    /** Its provider's listing could not be read; these are its usual models. */
    fallback?: string;
  }>;
  /** A model's name on a picker, per provider. */
  model_labels: Record<string, Record<string, string>>;
}

/** The same view as a person's own defaults, for a workspace (#5622). */
export interface WorkspaceAiOrder {
  can_edit: boolean;
  jobs: Array<{
    id: string;
    title: string;
    /** Set here; false = who answers now, with nothing chosen here. */
    chosen: boolean;
    steps: Array<{ credential_id: string; model: string; model_label?: string; label: string; provider_id: string | null; usable: boolean }>;
    own_order_in: [];
  }>;
  connections: Array<{
    id: string;
    label: string;
    provider_id: string;
    jobs: Partial<Record<string, { models: string[]; default_model: string | null; choices?: AiModelChoiceView[] }>>;
    unlisted?: string;
    fallback?: string;
    /** The caller's own "Just me" connection: it answers their calls only. */
    just_you?: true;
  }>;
  model_labels: Record<string, Record<string, string>>;
}

/** An AI-share offer as the workspace OWNER sees it. */
export interface WorkspaceAiOffer {
  credential_id: string;
  provider_id: string;
  label: string;
  offered_by_user_id: string;
  offered_by_name: string;
  status: "pending" | "approved";
  active: boolean;
  is_own: boolean;
}

/** What a connection reports it serves (platform().ai.modelsReportedBy).
 *  `choices` is a provider that lists its models: each family's "latest"
 *  first, then exact versions to pin; `fallback` says the list could not be
 *  read and these are the provider's usual models. */
/** The platform's own shape, so a field it adds (the redirects a
 *  connection's calls showed) reaches the picker without a second copy. */
export type { AiReportedModels } from "@cobblr/platform-contract";

export interface AiCapabilityDefault {
  capability: string;
  provider_id: string;
  /** Set when this job is pinned to a personal connection routed here rather
   *  than to one of the workspace's own providers. */
  credential_id: string | null;
  model: string;
  config: Record<string, unknown>;
}

export interface AiCall {
  id: string;
  provider_id: string;
  capability: string;
  model: string | null;
  /** The model the provider said answered; null when it did not say. */
  served_model?: string | null;
  input_summary: string | null;
  output_summary: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  /** Prompt tokens read from / written to the provider's prompt cache (#5319). */
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  cost_cents: number | null;
  duration_ms: number | null;
  ok: boolean;
  error: string | null;
  cached: boolean;
  invoked_at: string;
}

export interface AiUsageSummaryRow {
  capability: string;
  provider_id: string;
  calls: number;
  cached_calls: number;
  total_cost_cents: number | null;
  total_duration_ms: number | null;
  failed: number;
  input_tokens?: number | string | null;
  cache_read_tokens?: number | string | null;
  cache_write_tokens?: number | string | null;
}

/** One AI call in the activity log (list view). */
export interface AiActivityItem {
  id: string;
  user_id: string | null;
  capability: string;
  provider_id: string;
  /** The connection's own name when the call was made; null on older rows. */
  provider_label?: string | null;
  model: string | null;
  /** The model the provider said answered; null when it did not say. */
  served_model?: string | null;
  input_summary: string | null;
  output_summary: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_cents: number | null;
  duration_ms: number | null;
  ok: boolean;
  error?: string | null;
  source_kind: string | null;
  cached: boolean;
  invoked_at: string;
}
export interface AiActivityDetail extends AiActivityItem {
  input_full: string | null;
  output_full: string | null;
}

/** An offer as the server keeps it, with what became of it. */
export interface AiChatOfferState {
  id: string;
  summary: string;
  proposal: AiChatProposal;
  status: "open" | "confirming" | "confirmed" | "failed" | "cancelled" | "replaced";
  outcome: { ok?: boolean; message?: string } | null;
}

export interface AiChatResponse {
  type: "reply" | "proposal" | "proposals" | "build-proposal" | "error";
  text?: string;
  /** Steps of the turn that did not happen, each with what would retry it.
   *  The answer's `text` already says them (#5067). */
  failed?: Array<{ step: string; error: string; ways?: Array<{ label: string; proposal: AiChatProposal }> }>;
  /** The plan the workspace worked out for this sentence without AI, as the
   *  same Do-it card the offer strip shows. Present whatever the model said. */
  command?: {
    id: string;
    template: string;
    operations: number;
    summary: string;
    message: string;
    lines?: string[];
    note?: string;
    leftHeading?: string;
    also?: BasicCommandOffer["also"];
    sections?: PlanSectionOffer[];
  };
  /** The model could not be asked (refused, rate-limited, out of quota, not
   *  entitled, or it errored) and `text` is that sentence; the plan the
   *  workspace worked out without it still rides as `command`. */
  refusal?: { code?: string; retry_after_sec?: number; resets_at?: string };
  summary?: string;
  proposal?: AiChatProposal;
  /** The offer this proposal is kept as server-side (core_ai_offers). */
  offer_id?: string;
  /** type:"proposals" — several writes from one turn, each its own confirm. */
  items?: Array<{ summary: string; proposal: AiChatProposal; offer_id?: string }>;
  /** AUTO mode: writes already applied this turn (ledgered) — render as
   *  "✓ done" cards with an Undo where undoable. */
  applied?: Array<{
    summary: string;
    ledger_id?: string;
    undoable?: boolean;
    /** Which record, named, so the panel can draw it as a chip. */
    entity?: { kind: string; id?: string; label?: string };
    touched?: Array<{ kind: string; id: string; label: string }>;
    /** Where an action put things: the card offers to go there. */
    destination?: { kind: string; label: string };
  }>;
  /** build-proposal: the build runs async — poll authoringDraft(draft_id)
   *  until the draft leaves "building", then read its validation.preview. */
  building?: boolean;
  draft_id?: string;
  /** Tier-1.5 escorts: screens Cobb walked the user to this turn (the
   *  widget navigates; prefill.* params fill the form; the page's own
   *  submit stays the user's). */
  escorts?: Array<{ path: string; label: string }>;
  /** Service jobs Cobb started this turn; each is its own card. */
  service_jobs?: Array<{ job_id: string; capability?: string; status?: string }>;
  /** The records this turn READ whose name the words carry, so a read answer
   *  opens what it names the way a write's card does. Decided server-side
   *  from what the tools returned; never a name the turn did not read. */
  mentions?: Array<{ kind: string; id: string; label: string; href?: string; open_label?: string }>;
  /** A write aimed at one of several look-alikes the person's words did not
   *  pick between (two CubePros, one label): the candidates, each with the
   *  sentence that re-asks with that record named. A tap sends it. `note` is
   *  what the turn read about that one ("in Garage"), never a guess. */
  choices?: Array<{ label: string; say: string; note?: string }>;
}

export type AiChatProposal =
  | { kind: "create"; entity_kind: string; fields: Record<string, unknown>; values?: ProposalValue[] }
  | { kind: "update"; entity_kind: string; entity_id: string; fields: Record<string, unknown>; entity_label?: string; values?: ProposalValue[] }
  | { kind: "delete"; entity_kind: string; entity_id: string; entity_label?: string }
  | {
      kind: "action";
      action_id: string;
      entity_kind: string;
      entity_id: string;
      entity_label?: string;
      args?: Record<string, unknown>;
      /** What it will touch, from the action's planner: the card lists it. */
      plan?: { title: string; lines: string[] };
      /** What it was handed, for an action with no planner: the card lists it. */
      values?: ProposalValue[];
    }
  | { kind: "build"; draft_id: string }
  /** add_thing: a thing put through the scan inbox's intake (#4472). */
  | { kind: "add"; args: Record<string, unknown> }
  /** Inbox items filed into one list; `lines` names each one. */
  | { kind: "file"; ids: string[]; list: string; list_label?: string; lines?: string[] }
  | { kind: "put_back"; id: string; revision?: string; label?: string }
  | { kind: "change_scan"; args: Record<string, unknown>; label?: string }
  /** What one message asked for, as one card: its steps in the order they
   *  run, each worded after the ones before it, and one Confirm (#4574). */
  | {
      kind: "plan";
      title: string;
      steps: Array<{ summary: string; proposal: Exclude<AiChatProposal, { kind: "plan" }>; undoable?: boolean | null }>;
    };

export const aiApi = {

  /** The person's own default AI per job: each job's steps, their AI
   *  connections with the models each can do each job with, and the
   *  workspaces that chose for a job themselves (#5404). */
  /** `fresh` asks each connection that lists its models for its list now
   *  ("Refresh models"). */
  getMyAiDefaults: (fresh = false) => request<MyAiDefaults>("GET", `/me/ai-defaults${fresh ? "?fresh=1" : ""}`),
  /** Replace one job's steps, First first. Refused with a sentence when a
   *  step could not answer the job. */
  setMyAiDefaults: (job: string, steps: Array<{ credential_id: string; model: string }>) =>
    request<MyAiDefaults>("PUT", `/me/ai-defaults/${encodeURIComponent(job)}`, { steps }),
  clearMyAiDefaults: (job: string) => request<MyAiDefaults>("DELETE", `/me/ai-defaults/${encodeURIComponent(job)}`),
  /** The workspace's own order per job (#5622): each job's steps, the
   *  connections it can name with the models each can do each job with, and
   *  whether the caller may change it (owner or admin). A connection is a
   *  personal connection's id or `workspace:<provider id>`. */
  getWorkspaceAiOrder: (slug: string, fresh = false) => request<WorkspaceAiOrder>("GET", `/orgs/${slug}/ai-job-order${fresh ? "?fresh=1" : ""}`),
  setWorkspaceAiOrder: (slug: string, job: string, steps: Array<{ connection: string; model: string }>) =>
    request<WorkspaceAiOrder>("PUT", `/orgs/${slug}/ai-job-order/${encodeURIComponent(job)}`, { steps }),
  clearWorkspaceAiOrder: (slug: string, job: string) => request<WorkspaceAiOrder>("DELETE", `/orgs/${slug}/ai-job-order/${encodeURIComponent(job)}`),

  // Workspace owner: review + approve members' AI-share offers.
  listAiShares: (slug: string) =>
    request<{ items: WorkspaceAiOffer[] }>("GET", `/orgs/${slug}/ai-shares`),
  approveAiShare: (slug: string, credentialId: string, active = false) =>
    request<{ items: WorkspaceAiOffer[] }>("POST", `/orgs/${slug}/ai-shares/${credentialId}/approve`, { active }),
  rejectAiShare: (slug: string, credentialId: string) =>
    request<{ items: WorkspaceAiOffer[] }>("POST", `/orgs/${slug}/ai-shares/${credentialId}/reject`),
  setActiveAiShare: (slug: string, credentialId: string | null) =>
    request<{ items: WorkspaceAiOffer[] }>("POST", `/orgs/${slug}/ai-shares/active`, { credential_id: credentialId }),
  getAiStatus: (slug: string) =>
    request<AiStatus>("GET", `/orgs/${slug}/ai-status`),
  /** Who answers a job here, in the order the router asks (#3842). */
  getAiChain: (slug: string, capability: string) =>
    request<AiChainAnswer>("GET", `/orgs/${slug}/ai-chain?capability=${encodeURIComponent(capability)}`),
  getAiSettings: (slug: string) =>
    request<{ ai_disabled: boolean }>("GET", `/orgs/${slug}/ai-settings`),
  updateAiSettings: (slug: string, body: { ai_disabled: boolean }) =>
    request<{ ai_disabled: boolean }>("PATCH", `/orgs/${slug}/ai-settings`, body),

  // Ask Cobb "basic mode" — the no-AI floor. When AI is off, the chat asks the
  // server to match a message against the effective ruleset (no model, no cost).
  answerBasic: (slug: string, message: string, prior?: BasicPrior) =>
    request<BasicAnswer>("POST", `/orgs/${slug}/modules/core-ai/basics/answer`, {
      message,
      ...(prior ? { prior } : {}),
    }),
  // The effective ruleset (built-ins overlaid with per-workspace overrides + customs).
  listBasics: (slug: string) =>
    request<{ rules: BasicRuleRow[] }>("GET", `/orgs/${slug}/modules/core-ai/basics`),
  createBasic: (slug: string, body: BasicRuleInput & { builtin_key?: string }) =>
    request<BasicRuleRaw>("POST", `/orgs/${slug}/modules/core-ai/basics`, body),
  updateBasic: (slug: string, id: string, body: Partial<BasicRuleInput> & { position?: number }) =>
    request<BasicRuleRaw>("PATCH", `/orgs/${slug}/modules/core-ai/basics/${id}`, body),
  deleteBasic: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-ai/basics/${id}`),
  // The questions basic mode had no answer for — the raw material for new
  // rules, in the words people actually used.
  listBasicMisses: (slug: string) =>
    request<{ items: BasicMissRow[] }>("GET", `/orgs/${slug}/modules/core-ai/basics/misses`),
  dismissBasicMiss: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-ai/basics/misses/${id}`),
  // Learned commands: things the workspace can do with no AI, from having
  // watched an AI do them once.
  listCommandCandidates: (slug: string) =>
    request<{ items: CommandCandidate[] }>("GET", `/orgs/${slug}/modules/core-ai/basics/learned`),
  listCommands: (slug: string) =>
    request<{ items: LearnedCommandRow[] }>("GET", `/orgs/${slug}/modules/core-ai/basics/commands`),
  adoptCommand: (slug: string, body: Omit<CommandCandidate, "prompt" | "did" | "operations" | "last_used">) =>
    request<LearnedCommandRow>("POST", `/orgs/${slug}/modules/core-ai/basics/commands`, body),
  setCommandEnabled: (slug: string, id: string, enabled: boolean) =>
    request<void>("PATCH", `/orgs/${slug}/modules/core-ai/basics/commands/${id}`, { enabled }),
  deleteCommand: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-ai/basics/commands/${id}`),
  // "Does anything this workspace already knows fit what is being typed?"
  // Asked as the user types; writes nothing.
  matchCommand: (slug: string, message: string, selectionIds?: string[], pageKind?: string) =>
    request<{ command: BasicCommandOffer | null }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/basics/commands/match`,
      {
        message,
        ...(selectionIds?.length ? { selection_ids: selectionIds } : {}),
        // Which list is on screen, so "from this page" means this page.
        ...(pageKind ? { page_kind: pageKind } : {}),
      },
    ),
  // Answer a question that is still being typed, from the workspace, with no
  // model involved. Null when it is not a question this can answer.
  peekAnswer: (slug: string, message: string, aiOn: boolean) =>
    request<{ answer: string | null; detail?: string; from?: "guide"; mentions?: Array<{ kind: string; id: string; label: string; href?: string; open_label?: string }> }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/basics/peek`,
      { message, ai_on: aiOn },
    ),
  /** Put back everything ONE instruction did, in one request. The turn is the
   *  unit a person asked in, so it is the unit they take back. */
  aiChatUndoTurn: (slug: string, turnId: string, force = false) =>
    request<{
      ok: boolean;
      undone: number;
      total: number;
      message: string;
      /** What it would not take back on its own, and why — the panel offers
       *  these by name rather than leaving a dead end. */
      held?: Array<{ label: string; reason: string; detail?: string }>;
      can_force?: boolean;
    }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/chat/undo-turn/${encodeURIComponent(turnId)}${force ? "?force=1" : ""}`,
    ),
  runCommand: (slug: string, id: string, message: string, selectionIds?: string[], section?: string) =>
    request<{
      ok: boolean;
      done: number;
      failed: number;
      message: string;
      /** The section that ran, when one was named. */
      section?: string;
      ledger_ids?: string[];
      undoable?: boolean;
      destination?: { kind: string; label: string };
      /** The records it changed, named, so the result's sentence opens them. */
      touched?: Array<{ kind: string; id: string; label: string }>;
    }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/basics/commands/${id}/run`,
      { message, ...(selectionIds?.length ? { selection_ids: selectionIds } : {}), ...(section ? { section } : {}) },
    ),

  // core-ai — provider config + capability defaults + usage. See
  // docs/modules/core-ai.md.
  listAiProviderCatalogue: (slug: string) =>
    request<{ items: AiProviderDef[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/providers/catalogue`,
    ),
  listAiProviders: (slug: string) =>
    request<{ items: AiProvider[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/providers`,
    ),
  createAiProvider: (
    slug: string,
    body: {
      provider_id: string;
      label: string;
      credentials: Record<string, unknown>;
      config?: Record<string, unknown>;
      monthly_budget_cents?: number | null;
      /** Save a key the probe rejected anyway, marked unverified. */
      confirm_unverified?: boolean;
    },
  ) => request<AiProvider>("POST", `/orgs/${slug}/modules/core-ai/providers`, body),
  updateAiProvider: (
    slug: string,
    id: string,
    body: {
      label?: string;
      credentials?: Record<string, unknown>;
      confirm_unverified?: boolean;
      config?: Record<string, unknown>;
      enabled?: boolean;
      monthly_budget_cents?: number | null;
    },
  ) => request<AiProvider>("PATCH", `/orgs/${slug}/modules/core-ai/providers/${id}`, body),
  deleteAiProvider: (slug: string, id: string) =>
    request<void>("DELETE", `/orgs/${slug}/modules/core-ai/providers/${id}`),
  /** Test credentials that have not been saved yet, and get back what the provider says
   *  it can serve. One request answers both "is this key good" and "which models". */
  testAiCredentials: (slug: string, body: { provider_id: string; credentials: Record<string, unknown> }) =>
    request<AiConnectionTest>(
      "POST",
      `/orgs/${slug}/modules/core-ai/providers/test-credentials`,
      body,
    ),
  testAiProvider: (slug: string, id: string) =>
    request<{ ok: boolean; error?: string; note?: string; reason?: ConnectionVerification["reason"]; verification?: ConnectionVerification }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/providers/${id}/test`,
    ),
  listAiCapabilityDefaults: (slug: string) =>
    request<{ items: AiCapabilityDefault[]; all_capabilities: string[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/capability-defaults`,
    ),
  upsertAiCapabilityDefault: (
    slug: string,
    body: {
      capability: string;
      /** One of the workspace's own installed providers. */
      provider_id?: string;
      /** OR a personal connection routed into this workspace. The server
       *  derives the provider from it, and its default model when none is
       *  given - a connection whose owner's setup is private to them still
       *  has to be choosable here. */
      credential_id?: string;
      model?: string;
      config?: Record<string, unknown>;
    },
  ) =>
    request<AiCapabilityDefault>(
      "PUT",
      `/orgs/${slug}/modules/core-ai/capability-defaults`,
      body,
    ),
  /** What a connection reports it serves; null for a curated list. */
  aiReportedModels: (slug: string, ref: { provider_id?: string; credential_id?: string; capability?: string }, fresh = false) =>
    request<{ reported: AiReportedModels | null; redirects?: Record<string, string> | null }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/capability-defaults/models?${new URLSearchParams({ ...ref, ...(fresh ? { fresh: "1" } : {}) } as Record<string, string>).toString()}`,
    ),
  deleteAiCapabilityDefault: (slug: string, capability: string) =>
    request<void>(
      "DELETE",
      `/orgs/${slug}/modules/core-ai/capability-defaults/${encodeURIComponent(capability)}`,
    ),
  invokeAi: (
    slug: string,
    body: {
      capability: string;
      input: Record<string, unknown>;
      provider_id?: string;
      model?: string;
      bypass_cache?: boolean;
    },
  ) =>
    request<{
      result: unknown;
      provider_id: string;
      model: string;
      cached: boolean;
      cost_cents?: number;
      duration_ms: number;
    }>("POST", `/orgs/${slug}/modules/core-ai/invoke`, body),
  /** Agentic chat: returns a plain reply OR one/many proposed writes the user
   *  confirms via aiChatExecute (the tool loop can propose several in one turn —
   *  "add it to the list AND save it as a note"). */
  aiChat: (
    slug: string,
    messages: { role: "user" | "assistant"; content: string }[],
    /** What the user is looking at right now (route + one-line summary), for
     *  Cobb's situational awareness. See web/src/lib/chat-context.ts. */
    context?: { label: string; summary?: string; kind?: string },
  ) =>
    request<AiChatResponse>("POST", `/orgs/${slug}/modules/core-ai/chat`, { messages, ...(context ? { context } : {}) }),
  /** The same turn, PERSISTED. Returns at once with a turn id; subscribe with
   *  aiChatTurnEvents for progress and the final response. This is what makes
   *  the widget show progress, survive a refresh, and stay in sync across
   *  tabs: the turn lives server-side, not in one tab's pending promise. */
  aiChatStart: (
    slug: string,
    messages: { role: "user" | "assistant"; content: string }[],
    context?: { label: string; summary?: string; kind?: string },
    /** What the user is pointing AT — ticked rows, or a highlight. The
     *  difference between Cobb knowing you are on Locations and Cobb knowing
     *  you mean these twelve racks. */
    selection?: { label: string; kind?: string; ids?: string[]; text?: string },
  ) =>
    request<{ type: "turn"; turn_id: string }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/chat?mode=turn`,
      { messages, ...(context ? { context } : {}), ...(selection ? { selection } : {}) },
    ),
  /** Is a turn already running for me in this workspace? A tab asks on open. */
  aiChatOpenTurn: (slug: string) =>
    request<{ turn: { id: string; prompt: string; status: string; created_at: string } | null }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/chat/turns/open`,
    ),
  /** One turn's row: status + the final response once done. */
  aiChatTurn: (slug: string, turnId: string) =>
    request<{
      turn: { id: string; prompt: string; status: "queued" | "running" | "done" | "failed"; result: AiChatResponse | null; error: string | null };
    }>("GET", `/orgs/${slug}/modules/core-ai/chat/turns/${turnId}`),
  /** A turn's events as JSON: how a turn that finished before the panel
   *  followed it gets its steps back (#5067). */
  aiChatTurnEvents: (slug: string, turnId: string) =>
    request<{ status: string; events: Array<{ seq: number; kind: string; payload: Record<string, unknown> }> }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/chat/turns/${turnId}/events?after=0`,
      undefined,
      { Accept: "application/json" },
    ),
  /** The URL the widget opens an EventSource on. */
  aiChatTurnEventsUrl: (slug: string, turnId: string, after = 0) =>
    `/api/v1/orgs/${slug}/modules/core-ai/chat/turns/${turnId}/events?after=${after}`,
  /** `prompt`: what was asked, the ledger row's label for this write. */
  aiChatExecute: (slug: string, proposal: AiChatProposal, prompt?: string, offerId?: string) =>
    request<{
      ok: boolean;
      message: string;
      entity?: { kind: string; id?: string };
      /** The AI change-ledger row for this write — undo handle. */
      ledger_id?: string;
      undoable?: boolean;
      /** A plan's steps that ran, each a done card with its own undo. */
      applied?: Array<{ summary: string; ledger_id?: string; undoable?: boolean; entity?: { kind: string; id?: string; label?: string }; touched?: Array<{ kind: string; id: string; label: string }>; destination?: { kind: string; label: string } }>;
    }>("POST", `/orgs/${slug}/modules/core-ai/chat/execute`, {
      proposal,
      ...(offerId ? { offer_id: offerId } : {}),
      ...(prompt ? { prompt: prompt.slice(0, 2000) } : {}),
    }),
  /** The offers named, as the server keeps them: the plan, and what became of
   *  it. A reloaded panel redraws its cards from these. */
  aiChatOffers: (slug: string, ids: string[]) =>
    lookupInBody<{ items: AiChatOfferState[] }>(
      `/orgs/${slug}/modules/core-ai/chat/offers/lookup`,
      { ids },
      // id-list-in-url: the older api's door only, trimmed to fit by idsThatFitAUrl.
      () => `/orgs/${slug}/modules/core-ai/chat/offers?ids=${encodeURIComponent(idsThatFitAUrl(ids).join(","))}`,
    ),
  aiChatCancelOffer: (slug: string, id: string) =>
    request<{ ok: boolean; offer: AiChatOfferState | null }>("POST", `/orgs/${slug}/modules/core-ai/chat/offers/${encodeURIComponent(id)}/cancel`),
  /** This person's conversation, kept server-side so another tab or device
   *  opens on the same one. */
  aiChatConversation: (slug: string) =>
    request<{ conversation: { messages: unknown[]; updated_at: string } | null }>("GET", `/orgs/${slug}/modules/core-ai/chat/conversation`),
  /** `owner` is the account the panel read these messages for; the server
   *  refuses them when it is not the one signed in (#7062). */
  aiChatSaveConversation: (slug: string, messages: unknown[], owner: string) =>
    request<{ updated_at: string }>("PUT", `/orgs/${slug}/modules/core-ai/chat/conversation`, { messages, owner }),
  /** Ask Cobb tool consent (per-user, per-workspace): may the chat read your
   *  workspace data into prompts, and the write mode (off / ask / auto)?
   *  Enforced server-side; auto still asks for ACTIONS (irreversible). */
  aiChatPrefs: (slug: string) => request<ChatPrefs>("GET", `/orgs/${slug}/modules/core-ai/chat/prefs`),
  aiChatSetPrefs: (slug: string, prefs: ChatPrefsInput) =>
    request<ChatPrefs>("PUT", `/orgs/${slug}/modules/core-ai/chat/prefs`, prefs),
  /** The model pill: what this chat can be answered by, and what it is set to. */
  aiChatModels: (slug: string, fresh = false) => request<ChatModelMenu>("GET", `/orgs/${slug}/modules/core-ai/chat/models${fresh ? "?fresh=1" : ""}`),
  /** The AI change ledger: what Cobb wrote (confirmed or auto), what's undoable. */
  aiChatWrites: (slug: string) =>
    request<{
      items: Array<{
        id: string;
        tool: "create" | "update" | "delete" | "action";
        entity_kind: string;
        entity_id: string | null;
        entity_label: string;
        auto_applied: boolean;
        undone_at: string | null;
        undo_of: string | null;
        created_at: string;
        undoable: boolean;
      }>;
    }>("GET", `/orgs/${slug}/modules/core-ai/chat/writes`),
  aiChatUndo: (slug: string, writeId: string) =>
    request<{ ok: boolean; message: string }>(
      "POST",
      `/orgs/${slug}/modules/core-ai/chat/writes/${writeId}/undo`,
    ),
  listAiCalls: (slug: string, limit = 50) =>
    request<{ items: AiCall[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/usage/calls?limit=${limit}`,
    ),
  // AI activity log (full prompt/response). Per-user within a workspace.
  aiActivity: (slug: string, scope: "mine" | "workspace" = "mine", limit = 100) =>
    request<{ items: AiActivityItem[]; scope: string }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/activity?scope=${scope}&limit=${limit}`,
    ),
  aiActivityDetail: (slug: string, id: string) =>
    request<AiActivityDetail>("GET", `/orgs/${slug}/modules/core-ai/activity/${id}`),
  getAiUsageSummary: (slug: string) =>
    request<{ since: string; items: AiUsageSummaryRow[] }>(
      "GET",
      `/orgs/${slug}/modules/core-ai/usage/summary`,
    ),
};
