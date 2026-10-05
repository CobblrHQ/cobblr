// "Sign in with" on Your account → Identity & password: the instance's own
// sign-in providers, linked or not (#4492). Linking happens here, signed in,
// because being signed in is the proof the provider account is yours: a
// matching email address never links one on its own.
import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@cobblr/platform-web";
import { ApiError, api } from "../lib/api";

export function LinkedSignInsSection() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["me", "oidc"], queryFn: () => api.myOidc() });
  // Back from the provider after linking.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linked = params.get("linked");
    if (!linked) return;
    toast.success("Linked. You can sign in with it from now on.");
    params.delete("linked");
    window.history.replaceState(null, "", `${window.location.pathname}${params.size ? `?${params}` : ""}`);
  }, [toast]);
  const link = useMutation({
    mutationFn: (slug: string) => api.linkOidc(slug),
    onSuccess: (r) => window.location.assign(r.url),
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not start linking."),
  });
  const unlink = useMutation({
    mutationFn: (slug: string) => api.unlinkOidc(slug),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["me", "oidc"] });
      toast.success("Unlinked.");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Could not unlink it."),
  });
  const items = q.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <div className="block" data-testid="linked-sign-ins">
      <div className="text-xs text-muted mb-1">Sign in with</div>
      <ul className="space-y-1.5">
        {items.map((p) => (
          <li key={p.slug} className="flex items-center gap-2 text-sm">
            <span className="flex-1 min-w-0 truncate">
              {p.display_name}
              {p.linked && p.email ? <span className="text-xs text-faint"> · {p.email}</span> : null}
            </span>
            {p.linked ? (
              <button type="button" disabled={unlink.isPending} onClick={() => unlink.mutate(p.slug)} className="shrink-0 text-xs text-muted hover:underline">
                Unlink
              </button>
            ) : (
              <button
                type="button"
                data-testid="link-sign-in"
                disabled={link.isPending}
                onClick={() => link.mutate(p.slug)}
                className="shrink-0 text-xs font-medium text-accent hover:underline"
              >
                Link
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
