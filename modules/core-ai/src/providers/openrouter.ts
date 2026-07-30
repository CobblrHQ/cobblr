// OpenRouter — one key, any model. A shaped preset over the OpenAI-v1 compat
// machinery (buildCompatProvider): fixed public base URL so nobody has to know
// it, required key + model, and OpenRouter's attribution headers. Pricing is
// effectively pass-through of the origin provider (OpenRouter buys usage in
// bulk); requests transit OpenRouter's infrastructure — that trade is theirs
// to make, so it's stated on the key field, not hidden.
//
// Why a separate id instead of "just use openai-compat": the picker deserves a
// first-class entry ("OpenRouter" is what users search for), the base URL is
// not something to retype, and the model field is REQUIRED here (a gateway has
// no loaded-model default the way LM Studio does — sending "default" is a
// guaranteed 4xx). Switching models later is editing one field, exactly the
// wholesale-gateway promise.

import { platform } from "@cobblr/platform-contract";
import { buildCompatProvider } from "./openai-compat.js";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

export function register(): void {
  platform().ai.registerProvider(
    buildCompatProvider({
      id: "openrouter",
      label: "OpenRouter (one key, any model)",
      describeCredentials: () => ({
        api_key: {
          label: "OpenRouter API key (openrouter.ai/keys, requests transit OpenRouter)",
          secret: true,
        },
        model: {
          label: "Model (e.g. anthropic/claude-sonnet-5, openai/gpt-5.5, openrouter.ai/models)",
          secret: false,
        },
      }),
      resolveBase: () => OPENROUTER_BASE,
      requireModel: true,
      // Attribution headers OpenRouter asks apps to send.
      extraHeaders: { "HTTP-Referer": "https://cobblr.xyz", "X-Title": "Cobblr" },
    }),
  );
}
