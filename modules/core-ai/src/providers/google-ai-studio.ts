// Google AI Studio — the free tier worth recommending to someone who has no AI
// subscription and no wish to acquire one.
//
// A shaped preset over the OpenAI-v1 compat machinery, same as OpenRouter: Google
// publishes an OpenAI-compatible endpoint that speaks `image_url` inputs and the
// standard `tools`/`tool_choice` parameters, which is exactly what the scan inbox,
// image identification, chat and tool-call surfaces need. One key covers all four.
//
// WHY A FIRST-CLASS ENTRY rather than "just use openai-compat": a key is free and
// takes about four clicks, but only if you already know to point at
// generativelanguage.googleapis.com. Asking a non-technical person to find and paste
// a base URL is the step that loses them, and it is the whole reason this preset
// exists. Here they paste a key and stop.
//
// NOT OAuth. Google documents OAuth for the Gemini API against `cloud-platform` and
// `generative-language.retriever` scopes, and does not say it covers `generateContent`.
// A one-click "Connect Google" would be nicer than a pasted key and may yet be
// possible, but it is unverified for vision + tools on the free tier, so this ships
// the path that demonstrably works.

import { platform } from "@cobblr/platform-contract";
import { buildCompatProvider } from "./openai-compat.js";

export const GOOGLE_AI_STUDIO_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";

// LITE, not Flash, and the reason is the free tier's daily cap rather than quality.
// Measured on a real free-tier account: Flash allows 20 requests PER DAY (5/min), Lite
// allows 500 (15/min). Twenty is one sitting with a box of yarn, so a Flash default
// would hand this preset's target user a dead AI by lunchtime and no clue why.
//
// A floating alias rather than a pinned version, because Google retires numbered models
// on a schedule: gemini-2.5-flash already 404s. A default that dies on a date is support
// load for exactly the people this preset exists for.
//
// Someone who wants the stronger model can type it; the field says so. That is the right
// way round, since the cost of the better model is a cap they will hit rather than money.
export const GOOGLE_AI_STUDIO_DEFAULT_MODEL = "gemini-flash-lite-latest";

export function register(): void {
  platform().ai.registerProvider(
    buildCompatProvider({
      id: "google-ai-studio",
      label: "Google AI Studio (free tier)",
      describeCredentials: () => ({
        api_key: {
          // Short, because `setup` above now carries where to get it and what the free
          // tier does with your input. This label used to hold all of that, since a
          // field label was the only place to put it; keeping both would say the same
          // thing twice on one screen.
          // NO prefix claim. This said "starts with AIza", which is what Google's older
          // keys looked like; a real key issued now is 53 characters and does not. A
          // confident, wrong hint is worse than none: it tells someone their good key is
          // the broken thing.
          label: "API key",
          secret: true,
        },
        model: {
          // Quota is PER MODEL on the free tier, and the gap is 25x, so the field states
          // the trade instead of linking to a model list nobody will read mid-setup.
          // The quota trade stays HERE rather than in the steps: it is a decision about
          // this field, and only matters to someone who chooses to change it.
          label:
            `Model (optional. Blank uses ${GOOGLE_AI_STUDIO_DEFAULT_MODEL}, ` +
            "500 free/day. gemini-flash-latest is stronger, 20/day)",
          secret: false,
        },
      }),
      // Free and the fewest steps, so it leads: someone with no AI at all can finish in a minute.
      rank: 10,
      setup: {
        summary:
          "Free. No card, no Google Cloud project. Around 500 requests a day, which is " +
          "plenty for one person scanning and asking questions.",
        steps: [
          { text: "Open Google AI Studio and sign in with any Google account.", href: "https://aistudio.google.com/apikey" },
          { text: 'Click "Create API key". Pick any project it offers if it asks.' },
          { text: "Copy the key itself, not the sample code next to it. It is shown once." },
          { text: "Paste it below, leave everything else alone, and save." },
        ],
        caveat:
          "On the free tier Google may use what you send to improve their products. " +
          "Their paid tier does not. If that matters for what you photograph, use Ollama " +
          "instead, which never leaves your own machine.",
      },
      resolveBase: () => GOOGLE_AI_STUDIO_BASE,
      // Unlike a bare gateway, this one has a sensible default, so the model field can
      // be left alone. requireModel would make the common case a two-field form for no
      // reason.
      requireModel: false,
      defaultModel: GOOGLE_AI_STUDIO_DEFAULT_MODEL,
    }),
  );
}
