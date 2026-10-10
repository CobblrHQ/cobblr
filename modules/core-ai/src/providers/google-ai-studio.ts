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
import { authHeadersFor, buildCompatProvider } from "./openai-compat.js";
import type { AiCapability } from "@cobblr/platform-contract";
import { servedModelOf } from "@cobblr/platform-contract/ai-models";
import { createHash } from "node:crypto";

export const GOOGLE_AI_STUDIO_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
/** Google's own (native) API, which says which model answered. */
export const GOOGLE_NATIVE_BASE = "https://generativelanguage.googleapis.com/v1beta";

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

// ...and the same measurement says the BUILDER should have the fuller model.
// The 20-a-day cap is fatal for chat and irrelevant to a job somebody runs
// twice: describing a workspace is the rarest call the platform makes and the
// one where a weak answer costs the most, because what comes back is either
// recognisable as their own things or it is the moment they give up. Three
// model calls at most per attempt, so twenty a day is several builds and every
// repair they need.
//
// Only the DEFAULT differs. A model typed on the connection still wins, and so
// does a workspace's own choice for this job on the AI page.
export const GOOGLE_AI_STUDIO_BUILDER_MODEL = "gemini-flash-latest";

// THE LADDER, when a model nobody chose stays busy. Both aliases float to the
// newest generation, and on 2026-10-02 the newest Flash was busy in every
// version Google serves (the alias, 3.8, 3.7, 3.6 returned 503 "high demand"
// on every page-sized request for over twenty minutes) while the PINNED
// 3.5 Flash answered. An alias can never reach an older version, so the
// ladder names them: the alias, then pinned older versions of the same tier,
// newest first, then the other tier (for a job that may use it).
//
// The pinned versions are DISCOVERED, never typed here: Google retires a
// numbered model on a date (gemini-2.5-flash 404s), and a ladder that names
// one dies with it. The list comes from Google's own models list, read at
// most once a day per process (refreshPinned).
export interface PinnedGemini {
  /** Stable Flash versions older than the newest, newest first. */
  flash: string[];
  /** Stable Lite versions older than the newest, newest first. */
  lite: string[];
}

/** At most this many older versions of one tier on a ladder: each is one
 *  more failed attempt before the workspace's next AI is asked. */
export const PINNED_PER_TIER = 3;
export const PINNED_REFRESH_MS = 24 * 3600_000;

/** The pinned stable versions in a models list ("models/gemini-3.5-flash"):
 *  plain numbered Flash and Flash Lite only, no preview, image, audio or
 *  speech variants, newest first, without the newest (the one the alias
 *  already is). */
export function pinnedFromModelList(ids: readonly string[]): PinnedGemini {
  const versions = (re: RegExp) =>
    ids
      .map((i) => i.replace(/^models\//, ""))
      .flatMap((id) => {
        const m = re.exec(id);
        return m ? [{ id, v: m[1]!.split(".").map(Number) }] : [];
      })
      .sort((a, b) => {
        for (let i = 0; i < Math.max(a.v.length, b.v.length); i++) {
          const d = (b.v[i] ?? 0) - (a.v[i] ?? 0);
          if (d) return d;
        }
        return 0;
      })
      .map((x) => x.id);
  return {
    flash: versions(/^gemini-(\d+(?:\.\d+)*)-flash$/).slice(1, 1 + PINNED_PER_TIER),
    lite: versions(/^gemini-(\d+(?:\.\d+)*)-flash-lite$/).slice(1, 1 + PINNED_PER_TIER),
  };
}

let pinned: PinnedGemini = { flash: [], lite: [] };
let pinnedAt = 0;
let pinnedRead: Promise<void> | null = null;

/** Read Google's models list when the last read is a day old. The first
 *  read in a process is waited for (briefly), so a busy call right after a
 *  restart already has a ladder; later reads happen beside the call. A
 *  failed read keeps what was known and tries again in an hour. */
async function refreshPinned(credentials: Record<string, unknown>): Promise<void> {
  if (Date.now() - pinnedAt < PINNED_REFRESH_MS) return;
  pinnedRead ??= (async () => {
    try {
      const res = await fetch(`${GOOGLE_AI_STUDIO_BASE}/models`, { headers: authHeadersFor(credentials), signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`models list answered ${res.status}`);
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      pinned = pinnedFromModelList((body.data ?? []).map((m) => String(m.id ?? "")));
      pinnedAt = Date.now();
    } catch (err) {
      console.warn(`[core-ai] google-ai-studio: reading the models list failed (${(err as Error).message}); the busy ladder keeps ${pinned.flash.length + pinned.lite.length} pinned versions`);
      pinnedAt = Date.now() - PINNED_REFRESH_MS + 3600_000;
    } finally {
      pinnedRead = null;
    }
  })();
  const first = pinned.flash.length + pinned.lite.length === 0;
  if (first) await Promise.race([pinnedRead, new Promise((r) => setTimeout(r, 3_000))]);
}

export function setPinnedForTest(p: PinnedGemini | null): void {
  pinned = p ?? { flash: [], lite: [] };
  pinnedAt = p ? Date.now() : 0;
}

/** The ladder below one busy model, for one job. A document is never read by
 *  a lighter model, and a change is never planned by one: their ladder stays
 *  in the Flash tier, and when every rung is busy the job waits for the
 *  workspace's next AI (#4573, #4574). */
/** The jobs a busy Flash never hands to Lite. */
const NEVER_LIGHTER = new Set<AiCapability>(["document-read", "plan-changes"]);

export function googleLadder(model: string, capability: AiCapability): string[] {
  const flash = [GOOGLE_AI_STUDIO_BUILDER_MODEL, ...pinned.flash];
  const lite = [GOOGLE_AI_STUDIO_DEFAULT_MODEL, ...pinned.lite];
  const order = isLiteModel(model) ? [...lite, ...flash] : [...flash, ...lite];
  const below = order.filter((m) => m !== model);
  return NEVER_LIGHTER.has(capability) ? below.filter((m) => !isLiteModel(m)) : below;
}

/** Google's light tier, by its name: every Lite id says so. */
export function isLiteModel(model: string): boolean {
  return /(^|-)lite(-|$)/i.test(model);
}

// WHICH MODEL ANSWERED. Google redirects a deprecated model to its successor
// with no error ("all traffic is automatically redirected to Gemini 3.6
// Flash"), and the OpenAI-compatible endpoint this preset calls ECHOES the
// requested id in `model`: asked for gemini-3.5-flash it says
// gemini-3.5-flash while the native generateContent for the same model says
// `modelVersion: "gemini-3.6-flash"`. So the compatible `model` is never
// recorded as the served model. Instead one native call per key and model, at
// most once a day, asks with a
// one-token reply, and its `modelVersion` is what
// the call reports as served. It runs beside the call, so the call never
// waits on it longer than SERVED_PROBE_WAIT_MS; until it has answered, the
// served model is unknown (null).
// Once a day per key and model: a free key can have 20 Flash calls a day, and
// a probe every 6 h spent a fifth of them on bookkeeping. Redirects are rare
// and announced, so a day's lag in noticing one costs less than that.
export const SERVED_PROBE_MS = 24 * 3600_000;
const SERVED_PROBE_RETRY_MS = 3600_000;
const SERVED_PROBE_WAIT_MS = 2_000;
let probeNow = () => Date.now();
// single-flight: one native probe per key and model in `probing`; its answer is kept a day in `servedProbes`
const servedProbes = new Map<string, { at: number; served: string | null }>();
const probing = new Map<string, Promise<void>>();

function probeKeyOf(credentials: Record<string, unknown>, model: string): string {
  return `${createHash("sha256").update(String(credentials.api_key ?? "")).digest("hex").slice(0, 16)}|${model}`;
}

/** Ask Google's native API once which model answers `model` for this key:
 *  the `modelVersion` of a one-token reply. Null when it did not say. */
export async function askServedModel(credentials: Record<string, unknown>, model: string): Promise<string | null> {
  const res = await fetch(`${GOOGLE_NATIVE_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": String(credentials.api_key ?? "") },
    body: JSON.stringify({ contents: [{ parts: [{ text: "ok" }] }], generationConfig: { maxOutputTokens: 1 } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`generateContent answered ${res.status}`);
  return servedModelOf(((await res.json()) as { modelVersion?: unknown }).modelVersion);
}

/** Start the probe for this key and model when it is due; the promise
 *  settles when the answer (or the failure) is kept. */
function probeServed(credentials: Record<string, unknown>, model: string): Promise<void> {
  const key = probeKeyOf(credentials, model);
  const hit = servedProbes.get(key);
  if (hit && probeNow() - hit.at < SERVED_PROBE_MS) return Promise.resolve();
  const flight = probing.get(key);
  if (flight) return flight;
  const p = (async () => {
    try {
      servedProbes.set(key, { at: probeNow(), served: await askServedModel(credentials, model) });
    } catch (err) {
      console.warn(`[core-ai] google-ai-studio: asking which model serves ${model} failed (${(err as Error).message}); asked again in an hour`);
      servedProbes.set(key, { at: probeNow() - SERVED_PROBE_MS + SERVED_PROBE_RETRY_MS, served: hit?.served ?? null });
    } finally {
      probing.delete(key);
    }
  })();
  probing.set(key, p);
  return p;
}

/** What the native API last said serves this model for this key, or null. */
export function servedByGoogle(credentials: Record<string, unknown>, model: string): string | null {
  return servedProbes.get(probeKeyOf(credentials, model))?.served ?? null;
}

export function setServedProbesForTest(opts: { clock?: (() => number) | null; reset?: boolean }): void {
  if (opts.clock !== undefined) probeNow = opts.clock ?? (() => Date.now());
  if (opts.reset) {
    servedProbes.clear();
    probing.clear();
  }
}

/** The preset itself, so the router's own tests can run Google's real model
 *  choice and busy ladder with only the network call faked. */
export function googleAiStudioProvider(): ReturnType<typeof buildCompatProvider> {
  const def = googleAiStudioPreset();
  const invoke = def.invoke;
  return {
    ...def,
    invoke: async (ctx) => {
      await refreshPinned(ctx.credentials);
      // An embedding is not a generation: generateContent cannot be asked.
      const probe = ctx.capability === "embed-text" ? null : probeServed(ctx.credentials, ctx.model);
      const out = await invoke(ctx);
      if (probe) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([probe, new Promise((r) => (timer = setTimeout(r, SERVED_PROBE_WAIT_MS)))]);
        clearTimeout(timer);
      }
      // The compatible endpoint's `model` echoes the request: never evidence.
      return { ...out, served_model: probe ? servedByGoogle(ctx.credentials, ctx.model) : null };
    },
  };
}

function googleAiStudioPreset(): ReturnType<typeof buildCompatProvider> {
  return buildCompatProvider({
      id: "google-ai-studio",
      freeBackground: true,
      freeBackgroundModel: "gemini-flash-lite-latest",
      label: "Google AI Studio (free tier)",
      company: "Google",
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
            `500 free/day, and ${GOOGLE_AI_STUDIO_BUILDER_MODEL} for building a ` +
            "workspace, which is stronger and capped at 20 free/day. Naming one here uses it for everything)",
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
      // A document is read by Flash too: what it holds is a value somebody
      // keeps, and Lite misreads the small print a form is made of.
      // So is a chat turn that plans a change: a delete or a reshape is a
      // serious action, planned by Flash, never Lite (#4574).
      modelForCapability: {
        "design-workspace": GOOGLE_AI_STUDIO_BUILDER_MODEL,
        "document-read": GOOGLE_AI_STUDIO_BUILDER_MODEL,
        "plan-changes": GOOGLE_AI_STUDIO_BUILDER_MODEL,
      },
      // Each alias is overloaded on its own schedule: Lite answered "high
      // demand" for over an hour while the same key could still reach Flash.
      // Both float, so neither dies on a retirement date. Flash's smaller
      // daily cap is fine for the minutes Lite is busy; its "limit" then
      // moves the call to the workspace's next AI.
      //
      // Never Lite for a document: a busy Flash moves the read to the
      // workspace's next AI, and with none free the read waits for one,
      // rather than coming back from a weaker model (#4573).
      busyAlternates: googleLadder,
      // The menu the chat's model pill offers. Two, on purpose: the free tier
      // has exactly two models worth choosing between, and the choice is a
      // quota decision the note makes visible. Google reports fifty-one models
      // to /models; the settings page shows all of them for someone who wants
      // to type one, this is for someone deciding in a chat.
      //
      // Every other job Gemini can do offers the same two, Lite first: without
      // a menu a job fell back to the compat adapter's "default" placeholder,
      // so when the models list could not be read (a failed key, an outage)
      // the only "model" a person could pick for Reading photos was "default"
      // and their own defaults could not be saved at all.
      modelsFor: {
        ...Object.fromEntries(
          (["identify-image", "identify-glance", "split-image", "rank-images", "classify-image", "extract-text", "summarise", "match-to-catalog"] as const).map((cap) => [
            cap,
            [GOOGLE_AI_STUDIO_DEFAULT_MODEL, GOOGLE_AI_STUDIO_BUILDER_MODEL],
          ]),
        ),
        chat: [GOOGLE_AI_STUDIO_DEFAULT_MODEL, GOOGLE_AI_STUDIO_BUILDER_MODEL],
        "design-workspace": [GOOGLE_AI_STUDIO_BUILDER_MODEL, GOOGLE_AI_STUDIO_DEFAULT_MODEL],
        "document-read": [GOOGLE_AI_STUDIO_BUILDER_MODEL],
        "plan-changes": [GOOGLE_AI_STUDIO_BUILDER_MODEL],
      },
      modelNotes: {
        // `short` is what the chat's pill shows at rest. The pill shares one
        // row with two other chips in a ~430px panel, and "Gemini Flash Lite"
        // wrapped it to a second row; the family name is the menu's job.
        [GOOGLE_AI_STUDIO_DEFAULT_MODEL]: { label: "Gemini Flash Lite", short: "Flash Lite", note: "500 free a day" },
        [GOOGLE_AI_STUDIO_BUILDER_MODEL]: { label: "Gemini Flash", short: "Flash", note: "stronger, 20 free a day" },
      },
    });
}

export function register(): void {
  platform().ai.registerProvider(googleAiStudioProvider());
}
