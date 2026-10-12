// Verifying an AI connection means it GENERATED (#6024).
//
// A Google AI Studio connection showed "Verified … models/gemini-2.5-flash"
// for a key whose models list answered, while that model refused every
// generation for a new account ("no longer available to new users"). The
// probe had only listed models, and the card named the first one listed,
// which the connection had never asked anything. Listing models says a key is
// accepted; it does not say the connection can answer.
//
// So every AI provider's verify is its own cheap check (a bad key still fails
// fast and for free) and then ONE tiny real generation, context-free, with
// the model the connection will actually answer with: the one it names, or
// the provider's default for chat. A refusal is reported in the provider's
// own words, with the reason it maps to; a chosen model that is refused while
// the default answers says so, so the person has a model that works. A pass
// names the model that generated, never a listed one. A pass is kept for a
// few minutes, so pressing Test again costs nothing.
//
// The registry applies this to every provider (api/src/platform/ai.ts
// registerProvider), so a new provider cannot ship a list-only verify. A
// provider whose own test already generates says so (`generatesInTest`).
import type { AiConnectionTest, AiProviderDef } from "./index.js";
import { providerReasonOf, providerSentence, reasonFromTransportError, redactSecrets, type ProviderReason } from "@cobblr/platform-contract/provider-reason";

/** What the verify asks: nothing from any workspace, a handful of tokens. */
export const VERIFY_PROMPT = "Reply with the single word READY.";
/** Room for a model that thinks before it answers, and still a few tokens. */
export const VERIFY_MAX_TOKENS = 64;
/** How long a pass is kept: Test pressed twice asks the provider once. */
export const VERIFY_CACHE_MS = 10 * 60_000;

const passes = new Map<string, number>();

/** The provider's own words from an error: the message inside its JSON body
 *  when it sent one (Google's, OpenAI's, Anthropic's `error.message`,
 *  Ollama's `error`), else the error's text. Secrets blanked, one line. */
export function providerWordsOf(err: unknown, secrets: ReadonlyArray<unknown> = []): string {
  const text = err instanceof Error ? err.message : String(err ?? "");
  let words = "";
  for (const m of text.matchAll(/[[{][\s\S]*[\]}]/g)) {
    try {
      const body = JSON.parse(m[0]) as unknown;
      const first = Array.isArray(body) ? body[0] : body;
      const e = (first as { error?: unknown } | null)?.error;
      const said = typeof e === "string" ? e : (e as { message?: unknown } | null)?.message;
      if (typeof said === "string" && said.trim()) {
        words = said;
        break;
      }
    } catch {
      // not JSON: fall back to the text
    }
  }
  if (!words) words = text.replace(/^[\w .-]+:\s*\d{3}\s*/, "");
  return redactSecrets(words, secrets).replace(/\s+/g, " ").trim().slice(0, 300);
}

/** The model a connection answers chat with when nobody picks one. */
export function answeringModel(def: AiProviderDef, credentials: Record<string, unknown>, model = "default"): string {
  const resolved = def.resolveModel?.({ capability: "chat", model, credentials }).model;
  if (resolved && resolved !== "default") return resolved;
  const named = typeof credentials.model === "string" ? credentials.model.trim() : "";
  return (model !== "default" ? model : "") || named || def.capabilities.chat?.defaultModel || "default";
}

function passKey(def: AiProviderDef, model: string, credentials: Record<string, unknown>): string {
  const secrets = Object.entries(credentials)
    .filter(([k, v]) => !k.startsWith("__") && typeof v === "string")
    .map(([k, v]) => `${k}=${v as string}`)
    .sort()
    .join("\u0000");
  // A short non-reversible tag: the map never holds a key in the clear.
  let h = 2166136261;
  for (let i = 0; i < secrets.length; i++) h = Math.imul(h ^ secrets.charCodeAt(i), 16777619) >>> 0;
  return `${def.id}|${model}|${h.toString(36)}|${secrets.length}`;
}

async function generateOnce(def: AiProviderDef, credentials: Record<string, unknown>, model: string, timeoutMs: number): Promise<void> {
  const call = def.invoke({
    orgId: typeof credentials.__org_id === "string" ? credentials.__org_id : "verify",
    rowId: "verify",
    capability: "chat",
    model,
    credentials,
    input: { messages: [{ role: "user", content: VERIFY_PROMPT }] },
    // No temperature: some models refuse it outright (Haiku 5.5, barcode #55).
    config: { max_tokens: VERIFY_MAX_TOKENS },
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([call, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${Math.round(timeoutMs / 1000)} s`)), timeoutMs)))]);
  } finally {
    clearTimeout(timer);
  }
}

/** A provider whose verify is its own check, then one tiny generation. */
export function withGenerationCheck(def: AiProviderDef, opts: { now?: () => number; timeoutMs?: number } = {}): AiProviderDef {
  const own = def.testConnection;
  if (!own || def.generatesInTest) return def;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? (def.locality === "local" ? 120_000 : 45_000);
  const label = def.label || def.id;
  return {
    ...def,
    testConnection: async (credentials): Promise<AiConnectionTest> => {
      const checked = await own(credentials);
      if (!checked.ok) return checked;
      const named = typeof credentials.model === "string" && credentials.model.trim() ? credentials.model.trim() : "";
      const model = answeringModel(def, credentials);
      const key = passKey(def, model, credentials);
      if ((passes.get(key) ?? 0) > now()) return { ...checked, model };
      const secrets = Object.values(credentials);
      try {
        await generateOnce(def, credentials, model, timeoutMs);
        passes.set(key, now() + VERIFY_CACHE_MS);
        return { ...checked, model };
      } catch (err) {
        const reason: ProviderReason = providerReasonOf(err) ?? reasonFromTransportError(err);
        const said = providerWordsOf(err, secrets);
        // The sentence is ours; the provider's words and the default that
        // answers travel beside it, so the screen leads with the real cause
        // and keeps the words for diagnosis (#6050).
        const sentence = providerSentence(reason, { provider: label, model });
        let answers: string | undefined;
        // A model the person chose was refused: if the connection's default
        // answers on the same key, say which, so there is a model that works.
        const fallback = named ? answeringModel(def, { ...credentials, model: "" }) : "";
        if (named && fallback && fallback !== "default" && fallback !== model) {
          try {
            await generateOnce(def, { ...credentials, model: "" }, fallback, timeoutMs);
            answers = fallback;
          } catch {
            // the default fails too; the refusal above says what to do
          }
        }
        return {
          ok: false,
          reason,
          error: sentence,
          ...(checked.models ? { models: checked.models } : {}),
          ...(said ? { provider_said: said, detail: said } : {}),
          ...(answers ? { default_answers: answers } : {}),
          provider: label,
          model,
        };
      }
    },
  };
}

/** For tests: forget every kept pass. */
export function forgetVerifyPasses(): void {
  passes.clear();
}
