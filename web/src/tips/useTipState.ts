// The person's tip state, from their account, with what this page just
// recorded laid over it so a dismissed tip is gone at once.
import { useCallback, useState } from "react";
import { useToast, type TipState } from "@cobblr/platform-web";
import { useAuth } from "../auth/AuthContext";
import { api } from "../lib/api";

export function useTipState(): { state: TipState; loaded: boolean; onShown: (id: string) => void; onDismiss: (id: string, where: "person" | "device") => void } {
  const { user } = useAuth();
  const toast = useToast();
  const [local, setLocal] = useState<TipState>({});
  const account = user?.tips ?? {};
  const state: TipState = {
    shown: { ...account.shown, ...local.shown },
    dismissed: { ...account.dismissed, ...local.dismissed },
  };
  const onShown = useCallback((id: string) => {
    const at = new Date().toISOString();
    setLocal((s) => ({ ...s, shown: { [id]: at, ...s.shown } }));
    // A lost write only means the tip is counted as new again tomorrow.
    void api.tipShown(id).catch(() => undefined);
  }, []);
  const [, redraw] = useState(0);
  const onDismiss = useCallback((id: string, where: "person" | "device") => {
    // A device tip kept its own dismissal; the page only needs to redraw.
    if (where === "device") return void redraw((n) => n + 1);
    const at = new Date().toISOString();
    setLocal((s) => ({ ...s, dismissed: { ...s.dismissed, [id]: at } }));
    // Final means kept: a dismissal the account did not take would come back.
    api.tipDismissed(id).catch((e: unknown) => toast.error(`That tip could not be put away: ${e instanceof Error ? e.message : String(e)}`));
  }, [toast]);
  // Absent tips on a loaded account is an older server: nothing recorded yet.
  return { state, loaded: !!user, onShown, onDismiss };
}
