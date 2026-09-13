// What a connection row and a save toast say about a key, from the
// verification the server keeps (connection-verification.ts). One place, so
// the workspace AI page and the personal connections page say the same
// thing for the same state (#2895).
import { verificationLabel } from "@cobblr/platform-contract/connection-verification";
import { ApiError, type ConnectionVerification } from "./api";

export type Tone = "ok" | "bad" | "warn" | "muted";

/** The row's badge: a word and a tone. */
export function verificationBadge(v: ConnectionVerification | null | undefined): { text: string; tone: Tone; title?: string } {
  const text = verificationLabel(v ?? null);
  const when = v?.at ? new Date(v.at).toLocaleString() : undefined;
  const title = [v?.message, v?.model ? `model ${v.model}` : undefined, when ? `checked ${when}` : undefined].filter(Boolean).join(" · ") || undefined;
  switch (v?.state) {
    case "verified":
      return { text, tone: "ok", title };
    case "invalid":
      return { text, tone: "bad", title };
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
    case "invalid":
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
export function keyRefusedBy(err: unknown): { message: string; settled: boolean } | null {
  if (!(err instanceof ApiError)) return null;
  if (err.code === "key_invalid") return { message: err.message, settled: true };
  if (err.code === "key_unverifiable") return { message: err.message, settled: false };
  return null;
}

/** The confirm dialog for a refused save, by whether the provider actually
 *  rejected the key or the probe simply could not settle it. */
export function refusalDialog(refused: { message: string; settled: boolean }, replacing: boolean): { title: string; message: string; confirmLabel: string } {
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
