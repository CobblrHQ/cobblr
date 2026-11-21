// Why a write was refused, in words, beside the control that tried it.
//
// A member of a club's workspace pressed −1 on a cable and nothing happened:
// the server answered 403 "This needs permission to edit parts" and the page
// dropped it on the floor. A write that fails without a word looks
// like a button that does nothing, and the person tries again, or gives up,
// or writes it on the wall instead. So every inline write shows its refusal
// right where it was made, in the server's own sentence (which already says
// what is missing and who can give it), and lint:mutations-say-why-they-failed
// refuses a mutation that neither handles its error nor shows it.
import { isKeptOffline } from "./network-failure";
import type { ReactNode } from "react";
import { argumentRefusal } from "@cobblr/platform-contract/action-refusal";

/** The sentence for a failed write: the server's own message when it sent
 *  one, else a plain fallback. Never a status code alone. */
/** What a person reads for a sign-in that ended: never the server's token
 *  words ("signature verification failed", "jwt expired"), #4115. */
export const SIGNED_OUT_SENTENCE = "You were signed out. Sign in again to carry on.";

export function errorSentence(e: unknown): string {
  const validation = argumentRefusal(e);
  if (validation) return validation;
  const m = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  const status = e && typeof e === "object" && "status" in e ? (e as { status?: unknown }).status : undefined;
  const kept = e && typeof e === "object" && "code" in e && (e as { code?: unknown }).code === "kept_offline";
  if (!kept && (status === 401 || /signature verification|jwt (expired|malformed)|invalid (token|signature)|token expired/i.test(m))) return SIGNED_OUT_SENTENCE;
  if (!m || /^HTTP \d+$/.test(m)) return "That did not go through. Try again, or ask whoever runs this workspace.";
  return m;
}

export function MutationError({
  mutation,
  className,
  children,
}: {
  /** Any TanStack mutation (or anything with isError + error). */
  mutation: { isError: boolean; error: unknown };
  className?: string;
  /** Optional words before the sentence ("Could not change the count:"). */
  children?: ReactNode;
}) {
  if (!mutation.isError) return null;
  // Kept on the device (offline, or signed out): nothing is lost, so it is a
  // note, never "Not saved:" (#4115).
  if (isKeptOffline(mutation.error)) {
    return (
      <span role="status" className={`text-xs text-muted dark:text-slate-400 ${className ?? ""}`} data-testid="mutation-kept">
        {errorSentence(mutation.error)}
      </span>
    );
  }
  return (
    <span role="alert" className={`text-xs text-ember-600 dark:text-ember-400 ${className ?? ""}`} data-testid="mutation-error">
      {children ? <>{children} </> : null}
      {errorSentence(mutation.error)}
    </span>
  );
}
