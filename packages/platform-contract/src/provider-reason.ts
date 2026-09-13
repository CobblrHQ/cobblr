// Why a provider failed, as data: the reason it gave, read by every surface
// that has to say what to do about it.
//
// "google-ai-studio could not answer (google-ai-studio: 400)" told the person
// nothing while Google's body said API_KEY_INVALID (the 2026-09-13 review,
// #2895). The adapter that saw the body is the one place that knows; it
// throws a ProviderError carrying the reason, the router's refusal carries it
// on, and Cobb's bubble, the receipt reread, the scan card and the connection
// row all read the code and say the actionable sentence. Never a bare status.
//
// The key never appears in anything thrown: an adapter redacts every
// credential value out of the message first (redactSecrets), so a body that
// echoes the key, or a URL that carries it, cannot reach a log or a bubble.
//
// Buildless subpath: node resolves this file as-is, so no runtime import of a
// sibling (the exports map is the only door).

export const PROVIDER_REASONS = [
  /** The provider rejected the credential itself. */
  "invalid_key",
  /** The provider accepted the credential and refused the call for a limit: per-minute, per-day, or the plan's. */
  "quota",
  /** The provider does not serve the model this connection names. */
  "model_unavailable",
  /** The provider did not answer, or answered with its own failure. */
  "unreachable",
  /** The provider failed for a reason none of the above names. */
  "unknown",
] as const;
export type ProviderReason = (typeof PROVIDER_REASONS)[number];

export class ProviderError extends Error {
  readonly reason: ProviderReason;
  readonly provider: string;
  readonly status: number | undefined;
  /** Seconds the provider asked for before a retry, when it said. */
  readonly retryAfterSec: number | undefined;
  constructor(provider: string, reason: ProviderReason, message: string, status?: number, retryAfterSec?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.reason = reason;
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

export function providerError(provider: string, reason: ProviderReason, message: string, status?: number, retryAfterSec?: number): ProviderError {
  return new ProviderError(provider, reason, message, status, retryAfterSec);
}

/** The reason on an error, or null for one that carries none (a ProviderError,
 *  or a refusal the router built from one). */
export function providerReasonOf(err: unknown): ProviderReason | null {
  const reason = (err as { reason?: unknown } | null)?.reason;
  return typeof reason === "string" && (PROVIDER_REASONS as readonly string[]).includes(reason) ? (reason as ProviderReason) : null;
}

/** The provider's reason, from the status and the body it sent. One mapping
 *  for every HTTP provider: the words are the providers' own (Google's
 *  API_KEY_INVALID and RESOURCE_EXHAUSTED, OpenAI's invalid_api_key,
 *  Anthropic's authentication_error, Ollama's "model not found"). A 400 is
 *  not a bad key unless the body says so: a malformed request is "unknown". */
export function reasonFromResponse(status: number, body: string): ProviderReason {
  const b = body || "";
  // "API key not valid" (generateContent), "Please pass a valid API key" (the
  // compat models list), "Incorrect API key provided" (OpenAI): the words
  // differ by endpoint, the meaning does not.
  if (/API_KEY_INVALID|invalid_api_key|authentication_error|invalid x-api-key|valid api key|incorrect api key|invalid api key|PERMISSION_DENIED|UNAUTHENTICATED/i.test(b)) return "invalid_key";
  if (status === 401 || status === 403) return "invalid_key";
  if (status === 429 || /RESOURCE_EXHAUSTED|rate.?limit|too many requests|quota/i.test(b)) return "quota";
  if (status === 404 || /model.{0,40}not found|not found.{0,40}model|no such model|NOT_FOUND.{0,80}model|is not found for API version/i.test(b)) return "model_unavailable";
  if (status >= 500 || /overloaded|UNAVAILABLE|service unavailable/i.test(b)) return "unreachable";
  return "unknown";
}

/** The reason for a call that never got an answer. */
export function reasonFromTransportError(err: unknown): ProviderReason {
  const msg = err instanceof Error ? `${err.name} ${err.message}` : String(err ?? "");
  if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|socket hang up|aborted|timeout|timed out|network/i.test(msg)) return "unreachable";
  return "unknown";
}

/** The seconds a provider asked for before a retry, when its body says. */
export function retryAfterSecOf(body: string): number | undefined {
  const m = body.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i) ?? body.match(/(?:try again|retry) (?:in|after)\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!m?.[1]) return undefined;
  const n = Math.ceil(Number(m[1]));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** The text with every credential value blanked. Values under six characters
 *  are not secrets worth blanking a message for (a model name, a port). */
export function redactSecrets(text: string, secrets: ReadonlyArray<unknown>): string {
  let out = text;
  for (const s of secrets) {
    if (typeof s !== "string" || s.trim().length < 6) continue;
    out = out.split(s).join("[redacted]");
  }
  return out;
}

export type CredentialDoor = "personal" | "workspace";

/** Where to go to fix the key, by the door it came through. */
function whereToFix(door: CredentialDoor | undefined): string {
  return door === "workspace" ? "Configuration → AI" : "Your account → Connections";
}

/**
 * The one sentence a person reads for a provider's failure: what happened and
 * what to do. Never a status code, never a body. `door` says where the
 * credential lives, so the sentence points at the right screen.
 */
export function providerSentence(
  reason: ProviderReason,
  opts: { provider: string; door?: CredentialDoor; retryAfterSec?: number; status?: number; model?: string },
): string {
  const who = opts.provider || "your AI provider";
  switch (reason) {
    case "invalid_key":
      return `This ${who} key is not valid. Replace it under ${whereToFix(opts.door)}. Nothing was changed.`;
    case "quota": {
      const wait = opts.retryAfterSec ? `Try again in about ${opts.retryAfterSec} seconds.` : "Try again in a minute, or tomorrow if the day's allowance is spent.";
      return `${who} has refused this call for its usage limit. ${wait} Nothing was changed.`;
    }
    case "model_unavailable":
      return `${who} does not serve the model this connection names${opts.model ? ` (${opts.model})` : ""}. Pick another under ${whereToFix(opts.door)}. Nothing was changed.`;
    case "unreachable":
      return `${who} could not be reached, or answered with a failure of its own. Try again shortly. Nothing was changed.`;
    case "unknown":
      return `${who} could not answer. Try again, or check the connection under ${whereToFix(opts.door)}. Nothing was changed.`;
  }
}
