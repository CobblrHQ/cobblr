// Who answers an AI call here, in order, as a person reads it (#3842).
//
// The order itself is the server's (GET /ai-chain walks the router's own
// decision), so nothing here re-derives it. What lives here is how a person
// reads it: the jobs grouped by what they do rather than by capability id,
// and the warnings, each one a sentence about a consequence ("scanning
// waits") rather than a state ("1 provider").

import { AI_JOBS, isFloatingModel, type AiCapability, type AiJobId } from "@cobblr/platform-contract";

/** The AI page's "Who does what, in order", for links to it. */
export const WHO_ANSWERS_ANCHOR = "who-answers";

export interface AiChainStep {
  position: number;
  /** Within the providers one call may ask. */
  asked: boolean;
  source: "yours" | "shared" | "workspace" | "managed";
  label: string;
  provider_id?: string;
  model?: string;
  /** "Haiku · latest (5.5)", for a provider that lists its models. */
  model_label?: string;
  floating?: boolean;
  credential_id?: string;
  status: string | null;
  verified: boolean;
  /** "no": the provider cannot take an image at all. "declared": it reads
   *  images natively. null: in doubt (a bridge) and not yet shown the test
   *  picture. */
  reads_photos: "read" | "not-read" | "no" | "declared" | null;
  /** One of the person's own default steps for this job, set on Your
   *  account, Connections, rather than ordered here. */
  your_default?: true;
}

export interface AiChain {
  steps: AiChainStep[];
  refusal?: { code: string; message: string };
}

export interface AiChainAnswer {
  capability: string;
  you: AiChain;
  automations: AiChain;
}

export interface AiJobGroup {
  id: AiJobId;
  title: string;
  /** The job inside a sentence: "for a quick look", "for Cobb chat". */
  phrase: string;
  /** The job whose chain the group shows. */
  shows: AiCapability;
  /** Every job the group stands for: a reorder writes the order for each. */
  capabilities: AiCapability[];
  /** What waits when nothing answers, in the words of the warning. */
  waits: string;
}

const WAITS: Record<AiJobId, string> = {
  personal: "documents are read by code only",
  glance: "the scan card asks no first-look question",
  reading: "scanning and document reading wait",
  chat: "Cobb stops answering",
  text: "matching and summaries wait",
  search: "search falls back to plain words",
};

/** The contract's jobs (the router keeps a person's defaults by the
 *  same list), with what waits when nothing answers. Every capability sits
 *  in exactly one group (ai-chain.test.ts), so a job added to the contract
 *  cannot fall off the page. */
export const AI_JOB_GROUPS: AiJobGroup[] = AI_JOBS.map((j) => ({
  id: j.id,
  title: j.title,
  phrase: j.phrase,
  shows: j.shows,
  capabilities: [...j.capabilities],
  waits: WAITS[j.id],
}));

/** A model as a person reads it (#5622): "Haiku · latest (5.5)" for a
 *  provider that lists its models, the provider's own name for it
 *  otherwise, and an id that floats on the provider's side
 *  ("gemini-flash-lite-latest") as "Gemini Flash Lite · latest", never the id. */
export function modelWords(id: string, label?: string | null): string {
  const floating = isFloatingModel(id);
  if (label) return floating && !/latest/i.test(label) ? `${label} · latest` : label;
  if (!floating) return id;
  const words = id
    .trim()
    .replace(/^models\//, "")
    .replace(/[-:]latest$/i, "")
    .split(/[-_:]+/)
    .filter(Boolean)
    .map((w) => (/^\d/.test(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(" ");
  return `${words || "Model"} · latest`;
}

/** "Gemini · Flash Lite · latest · yours · Verified" */
export function stepLine(s: AiChainStep): string {
  const bits = [s.label];
  if (s.model_label) bits.push(s.model_label);
  else if (s.model) bits.push(modelWords(s.model));
  bits.push(sourceWords(s.source));
  if (s.status) bits.push(s.status);
  return bits.join(" · ");
}

export function sourceWords(source: AiChainStep["source"]): string {
  switch (source) {
    case "yours":
      return "yours";
    case "shared":
      return "shared";
    case "workspace":
      return "this workspace's";
    case "managed":
      return "your plan's";
  }
}

/** What a person should know about one group's chain, most serious first.
 *  Only what is about THIS kind of work: a floating model or a "Just me"
 *  connection is the same fact in every group, so it is said once, by
 *  `sectionWarnings`, rather than four times in amber. */
export function chainWarnings(group: AiJobGroup, answer: AiChainAnswer): string[] {
  const out: string[] = [];
  const asked = answer.you.steps.filter((s) => s.asked);
  const first = asked[0];
  // The personal documents panel says who reads them, once (#5621).
  if (group.id === "personal") return [];
  if (!first) return [`Nothing here can do this, so ${group.waits}.`];
  if (group.id === "glance" || group.id === "reading") {
    for (const s of asked) {
      if (s.reads_photos === "not-read") out.push(`${s.label} doesn't read photos: it answered the test picture without naming it.`);
      else if (s.reads_photos === null && s.source === "yours") out.push(`${s.label} has not been checked with a photo. Test it on Your account, Connections.`);
    }
  }
  if (asked.length === 1) out.push(`No backup: if ${first.label} is busy, ${group.waits}.`);
  return out;
}

/** The warnings that hold for every kind of work at once, said once. */
export function sectionWarnings(answers: AiChainAnswer[]): string[] {
  const out: string[] = [];
  const floating = new Map<string, string>();
  // A family's latest from a provider's own listing (it has a model_label,
  // "Haiku · latest (5.5)") moves only when the listing shows a newer model,
  // and the platform says so when it does: not a floating model.
  for (const a of answers) for (const s of a.you.steps) if (s.asked && s.floating && s.model && !s.model_label) floating.set(`${s.label}|${s.model}`, `${s.label} (${modelWords(s.model)})`);
  if (floating.size) {
    out.push(`Floating model: ${[...floating.values()].join(" and ")}. The provider can change what it points at without notice.`);
  }
  const justMe = new Set<string>();
  for (const a of answers) {
    const reach = new Set(a.automations.steps.map((s) => s.credential_id).filter(Boolean));
    for (const s of a.you.steps) if (s.asked && s.source === "yours" && s.credential_id && !reach.has(s.credential_id)) justMe.add(s.label);
  }
  if (justMe.size) {
    out.push(`Only you get ${[...justMe].join(" and ")}: automations and background work can't use a "Just me" connection. Share it with the workspace to let them.`);
  }
  return out;
}

/** One line for a workspace on Your account, Connections: "Gemini, then
 *  Claude bridge". Null when nothing answers. */
export function chainSummary(chain: AiChain): string | null {
  const names = chain.steps.filter((s) => s.asked).map((s) => s.label);
  if (!names.length) return null;
  return names.join(", then ");
}
