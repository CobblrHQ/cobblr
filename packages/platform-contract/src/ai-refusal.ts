// The router's refusal as DATA: a code on the error, read by everything that
// has to say why an AI call did not happen.
//
// The scan matchmaker classified the router's refusal by matching its
// message ("no provider configured...", "no provider available..."), which is
// the limits-are-data-not-prose class: a reworded message silently becomes
// "the AI did not answer" and the card lies again (review of #2862). The
// router now throws an error carrying one of these codes; readers ask for the
// code and fall back to the prose only for a bare Error from somewhere else.
// Buildless subpath: no runtime import of a sibling (AiFallback is a type).
import type { AiFallback } from "./scan-fallback.js";

export const AI_REFUSAL_CODES = [
  /** No provider anywhere for this call: none configured, not installed, or none with the capability. */
  "no_provider",
  /** AI is off for the whole instance (COBBLR_AI_ENABLED=false). */
  "operator_disabled",
  /** The workspace turned shared AI off. */
  "workspace_disabled",
  /** A provider exists but the plan's allowance refused the call. */
  "not_entitled",
  /** Nothing serves this person, and the AI routed here is someone else's
   *  own connection, which answers only their calls (#8855). */
  "not_shared",
  /** Replay mode with nothing to replay: a call that may not spend. */
  "replay_only",
  /** The provider was asked and failed. */
  "provider_error",
] as const;
export type AiRefusalCode = (typeof AI_REFUSAL_CODES)[number];

export class AiRefusalError extends Error {
  readonly code: AiRefusalCode;
  /** On a provider_error: the reason the provider gave, as the adapter read
   *  it (provider-reason.ts), so a surface can say the actionable thing. */
  readonly reason: string | undefined;
  /** On a provider_error: which door the credential came through, so the
   *  sentence points at the screen that holds it. */
  readonly door: "personal" | "workspace" | undefined;
  /** On a provider_error: seconds the provider asked for before a retry. */
  readonly retryAfterSec: number | undefined;
  /** On a provider_error: the provider that failed, by id and by the name a
   *  person reads ("Google AI Studio"), and the model it was asked for. */
  readonly providerId: string | undefined;
  readonly providerLabel: string | undefined;
  readonly model: string | undefined;
  /** Every provider asked before this one gave up, oldest first, when the
   *  router fell back across providers (#3819). */
  readonly attempts: ReadonlyArray<AiAttempt> | undefined;
  constructor(code: AiRefusalCode, message: string, detail?: AiRefusalDetail | null) {
    super(message);
    this.name = "AiRefusalError";
    this.code = code;
    this.reason = detail?.reason ?? undefined;
    this.door = detail?.door;
    this.retryAfterSec = detail?.retryAfterSec;
    this.providerId = detail?.providerId;
    this.providerLabel = detail?.providerLabel;
    this.model = detail?.model;
    this.attempts = detail?.attempts;
  }
}

/** One provider the router asked for a call, and why it did not answer. */
export interface AiAttempt {
  provider_id: string;
  /** What a person reads for it: the connection's own name ("Gemini for
   *  scans"), else the provider's ("Google AI Studio"). */
  label: string;
  model: string;
  /** The provider's reason (provider-reason.ts). */
  reason: string;
}

export interface AiRefusalDetail {
  reason?: string | null;
  door?: "personal" | "workspace";
  retryAfterSec?: number;
  providerId?: string;
  providerLabel?: string;
  model?: string;
  attempts?: ReadonlyArray<AiAttempt>;
}

/** The router's refusal: an Error a caller can read the code off, and on a
 *  provider failure the provider's reason and the credential's door too. */
export function aiRefusal(
  code: AiRefusalCode,
  message: string,
  detail?: AiRefusalDetail | null,
): AiRefusalError {
  return new AiRefusalError(code, message, detail);
}

/** The code on a refusal, or null for an error that is not one. */
export function refusalCodeOf(err: unknown): AiRefusalCode | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (AI_REFUSAL_CODES as readonly string[]).includes(code) ? (code as AiRefusalCode) : null;
}

/** What a scan's keyword floor should say the refusal was. The code decides;
 *  the prose is only read for a bare Error thrown by something other than
 *  the router. `hadUser` says whether a person was there to route through:
 *  without one, "no provider" is the background step's fault, not the
 *  workspace's. */
export function classifyAiFailure(err: unknown, opts: { hadUser: boolean }): AiFallback {
  const code = refusalCodeOf(err);
  if (code) {
    switch (code) {
      case "no_provider":
      case "operator_disabled":
      case "workspace_disabled":
      case "replay_only":
        return opts.hadUser ? "no-provider" : "background";
      case "not_entitled":
        return "not-entitled";
      case "not_shared":
        return opts.hadUser ? "not-shared" : "background";
      case "provider_error":
        return "provider-error";
    }
  }
  const msg = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  if (/^no provider configured/i.test(msg)) return opts.hadUser ? "no-provider" : "background";
  if (/^no provider available/i.test(msg)) return "not-entitled";
  if (/not entitled|allowance|quota/i.test(msg)) return "not-entitled";
  if (!msg) return "no-answer";
  return "provider-error";
}
