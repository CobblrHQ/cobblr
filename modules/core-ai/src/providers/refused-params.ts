// A parameter a model refuses is dropped, and remembered for that model.
//
// The hosted service, 2026-10-10: Claude Haiku 5.5 answers every request carrying
// `temperature` with 400 "`temperature` is deprecated for this model", so a
// workspace on it could read no receipt at all. Models keep retiring sampling
// knobs (OpenAI's reasoning models refused temperature first), and each one
// would break every job the same way until someone noticed. So: a 400 that
// names an optional parameter as deprecated or unsupported is sent again
// without it, and the model is remembered, so the next call skips it.

/** The optional knobs a request may carry and a model may refuse. A required
 *  field (the model, the messages) is never dropped. */
export const DROPPABLE_PARAMS = ["temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed", "parallel_tool_calls"] as const;

const REFUSAL = /deprecat|not supported|unsupported|does not support|not allowed|not permitted|unrecognized|unknown (?:parameter|field|argument)|extra inputs/i;

// SINGLE-PROCESS-SAFE: a per-process memory of what a model refused; another api process learns it with one refused call of its own.
const refused = new Map<string, Set<string>>();
const keyOf = (provider: string, model: string) => `${provider}::${model}`;

/** The optional parameter a refusal names, when it names one the request sent. */
export function refusedParamOf(status: number, text: string, body: Record<string, unknown>): string | null {
  if (status !== 400 && status !== 422) return null;
  if (!REFUSAL.test(text)) return null;
  return DROPPABLE_PARAMS.find((p) => p in body && new RegExp(`\\b${p}\\b`).test(text)) ?? null;
}

export function rememberRefused(provider: string, model: string, param: string): void {
  const k = keyOf(provider, model);
  const set = refused.get(k) ?? new Set<string>();
  set.add(param);
  refused.set(k, set);
}

/** The request without what this model has refused before. */
export function withoutRefused(provider: string, model: string, body: Record<string, unknown>): Record<string, unknown> {
  const set = refused.get(keyOf(provider, model));
  if (!set?.size) return body;
  const out = { ...body };
  for (const p of set) delete out[p];
  return out;
}

/** For a test: forget everything learned. */
export function forgetRefused(): void {
  refused.clear();
}

type Sent = { ok: boolean; status: number; text(): Promise<string> };

/** Send, and when the answer refuses an optional parameter, send again
 *  without it (at most once per parameter), remembering it for the model.
 *  A refusal that names nothing droppable is returned as it came, with its
 *  text still readable. */
export async function sendDroppingRefused<R extends Sent>(provider: string, model: string, body: Record<string, unknown>, send: (body: Record<string, unknown>) => Promise<R>): Promise<R> {
  let b = withoutRefused(provider, model, body);
  for (let i = 0; i <= DROPPABLE_PARAMS.length; i++) {
    const res = await send(b);
    if (res.ok || (res.status !== 400 && res.status !== 422)) return res;
    const text = await res.text();
    const param = refusedParamOf(res.status, text, b);
    if (!param) return withText(res, text);
    rememberRefused(provider, model, param);
    console.warn(`[core-ai] ${provider}/${model} refuses ${param}; sending without it from now on`);
    b = withoutRefused(provider, model, b);
  }
  return send(b);
}

/** A response whose body was read, still answering text() and json(). A
 *  plain object: a fetch Response's fields are getters that refuse a write. */
function withText<R extends Sent>(res: R, text: string): R {
  return {
    ok: res.ok,
    status: res.status,
    headers: (res as { headers?: unknown }).headers,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  } as unknown as R;
}
