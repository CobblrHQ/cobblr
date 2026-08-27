// What a person sees when the AI provider fails mid-turn.
//
// A provider error used to reach the chat bubble verbatim: a 429 from Google
// arrived as `core-ai invoke failed: google-ai-studio: 429 [{ "error": { ...
// 900 chars of JSON with quota ids and a "head to this URL" line. The raw
// text belongs in the server log and the AI call log (it still goes there);
// the bubble gets one sentence that says what happened and what to do.

export interface HumanizedError {
  message: string;
  /** Seconds until a retry is worth trying, when the provider said. */
  retryAfterSec?: number;
}

const PROVIDER_PREFIX = /^core-ai invoke failed:\s*/i;

function retryAfterFrom(raw: string): number | undefined {
  // Google: "retryDelay": "36s"  ·  OpenAI-style: "try again in 1.2s" / "retry after 20 seconds"
  const m = raw.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i) ?? raw.match(/(?:try again|retry) (?:in|after)\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!m?.[1]) return undefined;
  const n = Math.ceil(Number(m[1]));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function providerName(raw: string): string {
  const m = raw.match(/^([a-z0-9-]+):\s*\d{3}\b/i);
  return m?.[1] ?? "your AI provider";
}

/**
 * Turn a provider/transport failure into the one line a user should read.
 * Anything that is not recognisably a provider error passes through untouched
 * (a TurnError already carries user-facing prose), minus any JSON tail.
 */
export function humanizeProviderError(error: string): HumanizedError {
  const isProvider = PROVIDER_PREFIX.test(error);
  const raw = error.replace(PROVIDER_PREFIX, "");
  const who = providerName(raw);
  const status = raw.match(/\b(\d{3})\b/)?.[1];
  const retryAfterSec = retryAfterFrom(raw);
  const quota = /quota|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i.test(raw);

  if (isProvider && (status === "429" || quota)) {
    const wait = retryAfterSec ? `Try again in about ${retryAfterSec} seconds.` : "Try again in a minute.";
    const tier = /free.?tier/i.test(raw) ? " (free tier)" : "";
    return {
      message: `${who} is rate-limiting this workspace${tier}: too many requests, or too much text sent, in the last minute. ${wait} Nothing was changed.`,
      retryAfterSec,
    };
  }
  if (isProvider && (status === "401" || status === "403" || /invalid api key|api key not valid|unauthori[sz]ed|PERMISSION_DENIED/i.test(raw))) {
    return { message: `${who} rejected the API key. Check it under Configuration → AI. Nothing was changed.` };
  }
  if (isProvider && (status === "404" || /model.*not found|not found.*model|no such model/i.test(raw))) {
    return { message: `${who} does not have the model this workspace is set to. Pick another under Configuration → AI. Nothing was changed.` };
  }
  if (isProvider && (status?.startsWith("5") || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|overloaded|UNAVAILABLE/i.test(raw))) {
    return { message: `${who} is unavailable right now (it did not answer, or answered with a server error). Try again shortly. Nothing was changed.` };
  }
  if (isProvider) {
    // Unknown provider failure: keep the first human line, never a JSON body.
    const firstLine = raw.split(/[\n[{]/)[0]?.trim().replace(/[:\s]+$/, "") ?? "";
    return { message: `${who} could not answer${firstLine ? ` (${firstLine})` : ""}. Try again, or check Configuration → AI. Nothing was changed.` };
  }
  return { message: error.split(/\n\s*[{[]/)[0]?.trim() || error };
}
