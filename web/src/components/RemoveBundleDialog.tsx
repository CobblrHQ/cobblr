// The one Remove for an installed bundle (lib/bundle-remove.ts has why). It
// says what goes, asks whether the bundle's records go too when there are
// any (keeping them is the default), and offers Undo when they were kept.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { changeWorkspaceShape, Modal, SegmentedChoice, useToast } from "@cobblr/platform-web";
import { api, ApiError } from "../lib/api";
import { planRemove } from "../lib/bundle-remove";

export function RemoveBundleDialog({
  slug,
  bundle,
  onClose,
  onRemoved,
}: {
  slug: string;
  bundle: { id: string; name: string } | null;
  onClose: () => void;
  onRemoved?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const preview = useQuery({
    queryKey: ["bundle-uninstall-preview", slug, bundle?.id],
    queryFn: () => api.bundleUninstallPreview(slug, bundle!.id),
    enabled: !!bundle,
  });
  const plan = planRemove(preview.data ?? null);
  const [choice, setChoice] = useState<"keep" | "delete" | null>(null);
  const deleteData = choice ? choice === "delete" : plan.defaultDelete;
  const [failed, setFailed] = useState<string | null>(null);

  const remove = useMutation({
    mutationFn: () => changeWorkspaceShape(qc, slug, () => api.uninstallBundle(slug, bundle!.id, { deleteData })),
    onSuccess: (r) => {
      const put = r?.removed?.length ? ` Put back ${r.removed.map((x) => x.name).join(", ")}.` : "";
      const kept = r?.kept_words?.length ? ` ${r.kept_words.join(" ")}` : "";
      const said = `Removed ${bundle!.name}.${put}${kept}`;
      const undoId = r?.undo_snapshot_id;
      if (undoId) {
        toast.action(said, {
          actionLabel: "Undo",
          duration: 10000,
          onAction: () => {
            void changeWorkspaceShape(qc, slug, () => api.bundleRevert(slug, undoId))
              .then(() => toast.success(`${bundle!.name} is back, with its records.`))
              .catch((e: unknown) => toast.error(e instanceof ApiError ? `Could not put it back: ${e.message}` : "Could not put it back."));
          },
        });
      } else {
        toast.success(said);
      }
      onRemoved?.();
      onClose();
    },
    // Said in the dialog itself, beside the button that failed, not only in a
    // toast that can come and go before anyone reads it.
    onError: (e: unknown) => setFailed(e instanceof ApiError && e.message ? e.message : "It may not have been removed: the workspace did not say why. Look at the list, then try again."),
  });

  return (
    <Modal open={!!bundle} onClose={onClose} title={bundle ? `Remove ${bundle.name}?` : ""} destructive size="sm">
      <div className="space-y-3 text-sm" data-testid="remove-bundle-dialog">
        {preview.isLoading ? <p className="text-muted">Checking what it would remove…</p> : <p className="text-content dark:text-mortar-200">{plan.always}</p>}
        {plan.choice && (
          <div data-testid="remove-bundle-choice">
            <SegmentedChoice
              stack
              label="What happens to the data"
              value={deleteData ? "delete" : "keep"}
              onChange={(v) => setChoice(v)}
              options={[
                { value: "keep", label: plan.choice.keepLabel },
                { value: "delete", label: plan.choice.deleteLabel, tone: "danger" },
              ]}
            />
          </div>
        )}
        {plan.stays.map((s) => (
          <p key={s} className="text-xs text-muted">{s}</p>
        ))}
        {failed && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="remove-bundle-error">
            {failed}
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="px-3 py-1.5 rounded-md text-sm font-medium text-content dark:text-slate-300 hover:bg-subtle dark:hover:bg-slate-800">
            Cancel
          </button>
          <button
            type="button"
            disabled={remove.isPending || preview.isLoading}
            onClick={() => {
              setFailed(null);
              remove.mutate();
            }}
            className="px-3 py-1.5 rounded-md text-sm font-medium text-mortar-50 bg-ember-600 hover:bg-ember-700 disabled:opacity-60"
          >
            {remove.isPending ? "Removing…" : deleteData && plan.choice ? "Remove and delete records" : "Remove"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
