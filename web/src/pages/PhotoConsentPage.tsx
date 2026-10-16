// /me/photos: whether Cobblr may keep photos of the things you file, to
// improve identification (#3769 step 3). Hidden from Your account until the
// updated terms ship (the server says `available`); reached directly before
// then, it says so and offers nothing.
//
// On records the acceptance with its date. Off records the decline with its
// date, stops any new photo being kept at once, and unlinks the photos already
// kept: they stay as anonymous examples but no longer lead to you.

import { productName } from "@cobblr/platform-web";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { usePageTitle, useToast, useConfirm } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : null);

export function PhotoConsentPage() {
  usePageTitle("Photos of things you file");
  const qc = useQueryClient();
  const toast = useToast();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: ["photo-consent"], queryFn: () => api.mePhotoConsent() });
  const save = useMutation({
    mutationFn: (keep: boolean) => api.setMePhotoConsent(keep),
    onSuccess: (r) => {
      qc.setQueryData(["photo-consent"], r);
      toast.success(
        r.keep
          ? `${productName()} may keep photos of the things you file.`
          : r.unlinked
            ? "No new photos are kept, and the ones already kept no longer lead to you."
            : "No photos of yours are kept.",
      );
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't save that. Try again."),
  });

  if (q.isLoading) return null;
  const c = q.data;
  if (!c?.available) {
    return (
      <p data-testid="photo-consent-unavailable" className="text-sm text-muted dark:text-slate-400">
        {productName()} does not keep photos of the things you file here. Nothing to set.
      </p>
    );
  }

  const change = async (keep: boolean) => {
    if (!keep && c.keep) {
      const ok = await confirm({
        title: "Stop keeping your photos?",
        message:
          "No new photo of yours will be kept. The photos already kept stay as anonymous examples, but their link to you is removed, so they can no longer be found or deleted on your request. You can turn this back on at any time.",
        confirmLabel: "Stop keeping them",
      });
      if (!ok) return;
    }
    save.mutate(keep);
  };

  return (
    <section className="rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3">
      <label className="flex items-start gap-3 cursor-pointer" data-testid="photo-consent-toggle">
        <input
          type="checkbox"
          checked={c.keep}
          disabled={save.isPending}
          onChange={(e) => void change(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-cobble-600 shrink-0"
        />
        <span className="min-w-0">
          <span className="text-sm text-content dark:text-mortar-100">Keep photos of things I file to improve identification</span>
          <span className="block text-xs text-faint dark:text-slate-400">
            When you file an item, {productName()} may keep its photo as a private example, so the same product can be recognised for
            the next person. It is never shown to anyone. Receipts, documents and photos with people in them are never kept.
          </span>
        </span>
      </label>
      <p data-testid="photo-consent-state" className="text-xs text-muted dark:text-slate-400">
        {c.keep
          ? `On since ${when(c.accepted_at)}.`
          : c.declined_at
            ? `Off since ${when(c.declined_at)}. Turning it off stops new photos being kept at once, and removes the link to you from any already kept.`
            : "Off. Nothing of yours is kept until you turn it on."}
      </p>
    </section>
  );
}
