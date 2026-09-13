// What a person sees when the AI provider fails mid-turn.
//
// A provider error used to reach the chat bubble verbatim: a 429 from Google
// arrived as `core-ai invoke failed: google-ai-studio: 429 [{ "error": { ...
// 900 chars of JSON with quota ids and a "head to this URL" line. The raw
// text belongs in the server log and the AI call log (it still goes there);
// the bubble gets one sentence that says what happened and what to do.

import { providerSentence, type CredentialDoor, type ProviderReason } from "@cobblr/platform-contract/provider-reason";

/** What the router's refusal carried beside the message, when it did: the
 *  provider's reason as its adapter read it, which door the credential came
 *  through, and the wait it asked for. Data first; the prose below is the
 *  reading for an error that carries none. */
export interface ProviderFailureDetail {
  reason?: ProviderReason | null;
  door?: CredentialDoor;
  retryAfterSec?: number;
  provider?: string;
}

export interface HumanizedError {
  message: string;
  /** Seconds until a retry is worth trying, when the provider said. */
  retryAfterSec?: number;
  /** What KIND of failure this is, for anything that must act rather than
   *  read: a widget deciding whether to offer "try again", a bench deciding
   *  whether to wait or give up. Prose is for people; this is for code. */
  code?: "rate_limited" | "session_limit" | "unauthorized" | "model_missing" | "unavailable" | "unknown";
  /** When the provider named a wall-clock reset ("resets 11:50pm"), its own
   *  words - a subscription's window is not a number of seconds it tells us. */
  resetsAt?: string;
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
export function humanizeProviderError(error: string, detail?: ProviderFailureDetail): HumanizedError {
  const isProvider = PROVIDER_PREFIX.test(error);
  const raw = error.replace(PROVIDER_PREFIX, "");
  const who = detail?.provider ?? providerName(raw);
  const status = raw.match(/\b(\d{3})\b/)?.[1];
  const retryAfterSec = detail?.retryAfterSec ?? retryAfterFrom(raw);
  // The reason the provider gave, read off the error: the sentence follows
  // from it and names the door the key came through. Prose is only read below
  // for an error that carries no reason (a bare Error from somewhere else).
  if (detail?.reason) {
    const message = providerSentence(detail.reason, { provider: who, door: detail.door, retryAfterSec });
    switch (detail.reason) {
      case "invalid_key":
        return { code: "unauthorized", message };
      case "quota":
        return { code: "rate_limited", message, retryAfterSec };
      case "model_unavailable":
        return { code: "model_missing", message };
      case "unreachable":
        return { code: "unavailable", message };
      case "unknown":
        break; // the prose may still know a session limit; read on
    }
  }
  const quota = /quota|rate.?limit|RESOURCE_EXHAUSTED|too many requests/i.test(raw);

  // A Claude subscription run through a bridge does not 429: `claude -p`
  // exits 1 saying "You've hit your session limit · resets 11:50pm". Reported
  // as a plain 502 it read as "the provider is down", which is wrong twice -
  // nothing is broken, and the one useful fact (when it comes back) was
  // thrown away. Measured on the bridge, 2026-09-01.
  const session = /session limit|usage limit|weekly limit|limit .{0,12}resets?/i.exec(raw);
  if (isProvider && session) {
    const resetsAt = /resets?\s+(?:at\s+)?([0-9]{1,2}[:.][0-9]{2}\s*(?:am|pm)?(?:\s*\([^)]+\))?)/i.exec(raw)?.[1]?.trim();
    return {
      code: "session_limit",
      ...(resetsAt ? { resetsAt } : {}),
      message: `Your AI subscription has used up its session allowance${resetsAt ? `; it resets at ${resetsAt}` : ""}. Nothing was changed - ask again after that.`,
    };
  }
  if (isProvider && (status === "429" || quota)) {
    const wait = retryAfterSec ? `Try again in about ${retryAfterSec} seconds.` : "Try again in a minute.";
    const tier = /free.?tier/i.test(raw) ? " (free tier)" : "";
    return {
      code: "rate_limited",
      message: `${who} is rate-limiting this workspace${tier}: too many requests, or too much text sent, in the last minute. ${wait} Nothing was changed.`,
      retryAfterSec,
    };
  }
  if (isProvider && (status === "401" || status === "403" || /invalid api key|api key not valid|unauthori[sz]ed|PERMISSION_DENIED/i.test(raw))) {
    return { code: "unauthorized", message: `${who} rejected the API key. Check it under Configuration → AI. Nothing was changed.` };
  }
  if (isProvider && (status === "404" || /model.*not found|not found.*model|no such model/i.test(raw))) {
    return { code: "model_missing", message: `${who} does not have the model this workspace is set to. Pick another under Configuration → AI. Nothing was changed.` };
  }
  if (isProvider && (status?.startsWith("5") || /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|socket hang up|overloaded|UNAVAILABLE/i.test(raw))) {
    return { code: "unavailable", message: `${who} is unavailable right now (it did not answer, or answered with a server error). Try again shortly. Nothing was changed.` };
  }
  if (isProvider) {
    // Unknown provider failure: the one sentence, never a status and never a
    // JSON body. "google-ai-studio could not answer (google-ai-studio: 400)"
    // was this branch quoting the raw line (#2895); the raw line is in the
    // server log and the AI call log for whoever debugs it.
    return { code: "unknown", message: providerSentence("unknown", { provider: who, door: detail?.door }) };
  }
  return { message: error.split(/\n\s*[{[]/)[0]?.trim() || error };
}
