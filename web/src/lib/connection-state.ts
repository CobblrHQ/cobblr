// What a connection row and a save toast say about a key, from the
// verification the server keeps (connection-verification.ts). One place, so
// the workspace AI page and the personal connections page say the same
// thing for the same state (#2895).
import { verificationLabel } from "@cobblr/platform-contract/connection-verification";
import { ApiError, type ConnectionVerification } from "./api";

export type Tone = "ok" | "bad" | "warn" | "muted";

/** What a model refusal leads with, wherever it is said: the key works, this
 *  model does not, and what to do. Never "the key was rejected" (#6050). */
export function modelRefusalLead(why: { model?: string; default_answers?: string }): string {
  const model = why.model ? why.model : "This model";
  const then = why.default_answers
    ? `${why.default_answers} answers on this key: clear the Model field to use it, or choose another model.`
    : "Choose another model, or clear the Model field to use the connection's default.";
  return `The key works, but ${model} will not answer for this account. ${then}`;
}

/** The provider's own words, for diagnosis, after the explanation. */
function providerSaid(why: { provider?: string; provider_said?: string }): string {
  return why.provider_said ? ` ${why.provider || "The provider"} said: “${why.provider_said}”` : "";
}

/** The row's badge: a word and a tone. */
export function verificationBadge(v: ConnectionVerification | null | undefined): { text: string; tone: Tone; title?: string } {
  const text = verificationLabel(v ?? null);
  const when = v?.at ? new Date(v.at).toLocaleString() : undefined;
  const title = [v?.message, v?.model ? `model ${v.model}` : undefined, v?.provider_said ? `${v.provider || "The provider"} said: ${v.provider_said}` : undefined, when ? `checked ${when}` : undefined].filter(Boolean).join(" · ") || undefined;
  switch (v?.state) {
    case "verified":
      return { text, tone: "ok", title };
    case "invalid":
      return { text, tone: "bad", title };
    case "warning":
    case "unverifiable":
    case "unverified":
      return { text, tone: "warn", title };
    default:
      return { text, tone: "muted" };
  }
}

/** What the toast says after a save or a test, from the verdict. */
export function verificationToast(v: ConnectionVerification | null | undefined, saved: "added" | "updated" | "tested"): { kind: "success" | "error" | "info"; message: string } {
  const lead = saved === "added" ? "Connection added" : saved === "updated" ? "Connection updated" : "Tested";
  switch (v?.state) {
    case "verified":
      return { kind: "success", message: `${lead} and verified${v.model ? ` (${v.model})` : ""}.` };
    case "warning":
      return { kind: "info", message: `${lead}. Works with limitations: ${v.message ?? "check the connection's settings."}` };
    case "invalid":
      if (v.reason === "model_unavailable") return { kind: "error", message: `${lead}: ${modelRefusalLead(v)}` };
      return { kind: "error", message: v.message ?? `${lead}, but the provider rejected the key.` };
    case "unverifiable":
      return { kind: "info", message: `${lead}, but it could not be verified just now: ${v.message ?? "the provider did not answer"} It is saved; test it again later.` };
    case "unverified":
      return { kind: "info", message: `${lead} as unverified: ${v.message ?? "the key was not confirmed by the provider."}` };
    default:
      return { kind: "success", message: `${lead}.` };
  }
}

/** The save answered 409: the provider rejected the key (key_invalid), or a
 *  replacement could not be verified and the key it would displace works
 *  (key_unverifiable). Either way the person may go ahead, marked as such. */
export interface KeyRefusal {
  message: string;
  settled: boolean;
  /** Why, as the server's verification said: the key, or the model (#6050). */
  reason?: string;
  model?: string;
  default_answers?: string;
  provider?: string;
  provider_said?: string;
}

export function keyRefusedBy(err: unknown): KeyRefusal | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code !== "key_invalid" && err.code !== "key_unverifiable") return null;
  const d = (err.details ?? {}) as Partial<Pick<KeyRefusal, "reason" | "model" | "default_answers" | "provider" | "provider_said">>;
  const str = (x: unknown) => (typeof x === "string" && x ? x : undefined);
  return {
    message: err.message,
    settled: err.code === "key_invalid",
    ...(str(d.reason) ? { reason: str(d.reason) } : {}),
    ...(str(d.model) ? { model: str(d.model) } : {}),
    ...(str(d.default_answers) ? { default_answers: str(d.default_answers) } : {}),
    ...(str(d.provider) ? { provider: str(d.provider) } : {}),
    ...(str(d.provider_said) ? { provider_said: str(d.provider_said) } : {}),
  };
}

/** The confirm dialog for a refused save, by whether the provider actually
 *  rejected the key or the probe simply could not settle it. */
export function refusalDialog(refused: KeyRefusal, replacing: boolean): { title: string; message: string; confirmLabel: string } {
  // A model the account cannot use is not a rejected key: the heading names
  // the model and the lead says what to do (#6050).
  if (refused.settled && refused.reason === "model_unavailable") {
    return replacing
      ? { title: "The new model is not available on this key", message: `${modelRefusalLead(refused)} The connection you had is still in place. Save the change anyway, marked unverified?${providerSaid(refused)}`, confirmLabel: "Replace as unverified" }
      : { title: "This model is not available on this key", message: `${modelRefusalLead(refused)} You can save it anyway, marked unverified, and pick a model later.${providerSaid(refused)}`, confirmLabel: "Save as unverified" };
  }
  if (refused.settled) {
    return replacing
      ? { title: "The provider rejected the new key", message: `${refused.message} The key you had is still in place. Replace it anyway, marked unverified?`, confirmLabel: "Replace as unverified" }
      : { title: "The provider rejected this key", message: `${refused.message} You can save it anyway, marked unverified, and fix it later.`, confirmLabel: "Save as unverified" };
  }
  return {
    title: "The new key could not be verified",
    message: `${refused.message} The key you had works and is still in place. Replace it anyway, marked as not verified?`,
    confirmLabel: "Replace anyway",
  };
}

/** What the last test said, on one line under the row's name, beside the
 *  badge that carries the state: when, which model, how long it took and
 *  whether it read the test picture, or the exact failure. Null when it has
 *  never been tested. */
export function verificationLine(
  v: ConnectionVerification | null | undefined,
  when: (iso: string) => string = (iso) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
): { text: string; tone: Tone } | null {
  if (!v?.at) return null;
  const at = when(v.at);
  const took = typeof v.latency_ms !== "number" ? null : v.latency_ms < 1000 ? `${v.latency_ms} ms` : `${(v.latency_ms / 1000).toFixed(1)} s`;
  if (v.state === "verified" || v.state === "warning") {
    const photos = v.photos === "read" ? "can read photos ✓" : v.photos === "not-read" ? "can read photos ✗" : null;
    return { text: [`Tested ${at}`, v.model, took, photos, v.state === "warning" ? v.message : null].filter(Boolean).join(" · "), tone: v.state === "warning" || v.photos === "not-read" ? "warn" : "ok" };
  }
  const head = [`Tested ${at}`, took].filter(Boolean).join(" · ");
  if (v.state === "invalid" && v.reason === "model_unavailable") return { text: `${head}: ${modelRefusalLead(v)}`, tone: "bad" };
  return { text: v.message ? `${head}: ${v.message}` : head, tone: v.state === "invalid" ? "bad" : "warn" };
}
