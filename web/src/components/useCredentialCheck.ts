import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";

export interface CredentialCheck {
  state: "idle" | "checking" | "ok" | "bad";
  message: string;
  /** What the provider says it can serve. Empty until a check succeeds. */
  models: string[];
}

/** Where the credentials are being added: a workspace's AI page, or /me/connections.
 *  A plain value (not a callback) so the hook's deps stay stable across renders. */
export type CredentialScope = { kind: "workspace"; slug: string } | { kind: "personal" };

const IDLE: CredentialCheck = { state: "idle", message: "", models: [] };

/** Check the credentials someone has just typed, without saving them.
 *
 *  WHY BEFORE SAVE: testing after save means a wrong key is written down and only then
 *  reported, leaving a broken connection to go back and edit. A real user pasted a whole
 *  curl command in; it saved happily. Checking what is currently typed means nothing
 *  wrong is ever stored.
 *
 *  The same request returns the provider's model list, because for every
 *  OpenAI-compatible provider "is this key good" IS a model-list request. That is what
 *  lets the form offer a dropdown rather than asking for an exact model name the person
 *  has no way to know.
 *
 *  Debounced, and stale replies are dropped: someone pasting a key fires a change per
 *  keystroke on the way in, and an early slow reply must not overwrite a later verdict. */
export function useCredentialCheck(scope: CredentialScope, providerId: string) {
  const [check, setCheck] = useState<CredentialCheck>(IDLE);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const slug = scope.kind === "workspace" ? scope.slug : "";

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    seq.current++;
    setCheck(IDLE);
  }, []);

  // A verdict and a model list belong to the provider they came from, so switching
  // provider clears both. Here rather than at each call site: three forms use this,
  // and one of them forgetting is a stale model list offered for the wrong provider.
  useEffect(() => reset(), [providerId, reset]);

  const run = useCallback(
    (credentials: Record<string, string>, opts?: { delayMs?: number }) => {
      if (timer.current) clearTimeout(timer.current);
      const mine = ++seq.current;
      // Nothing to check yet: an empty form is not a failure, so say nothing.
      if (!Object.values(credentials).some((v) => v && v.trim())) {
        setCheck(IDLE);
        return;
      }
      setCheck((c) => ({ ...c, state: "checking", message: "Checking…" }));
      timer.current = setTimeout(async () => {
        try {
          const body = { provider_id: providerId, credentials };
          const r = slug ? await api.testAiCredentials(slug, body) : await api.testConnection(body);
          if (mine !== seq.current) return; // a newer edit already won
          setCheck(
            r.ok
              ? {
                  state: "ok",
                  message: r.note ?? r.detail ?? "Works.",
                  models: (r.models ?? []).filter(Boolean),
                }
              : { state: "bad", message: r.error ?? "That did not work.", models: [] },
          );
        } catch (e) {
          if (mine !== seq.current) return;
          setCheck({
            state: "bad",
            message: e instanceof ApiError ? e.message : String(e),
            models: [],
          });
        }
      }, opts?.delayMs ?? 600);
    },
    [slug, providerId],
  );

  return { check, run, reset };
}
