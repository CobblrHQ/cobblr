// /print/:slug/locations/:id/layout/:draftId: a planning layout on paper, to
// scale, with a scale bar and the sizes written in, to take into the room.
// Chrome-less like the plan print (PlanPrintPage) and always light: its one
// job is paper. Saving it as a PDF is the browser's print dialog.

import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { usePageTitle } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useLayoutBoard } from "../lib/useLayoutBoard";
import { LayoutPrint } from "../components/LayoutPrint";

export function LayoutPrintPage() {
  const { slug = "", id = "", draftId = "" } = useParams<{ slug: string; id: string; draftId: string }>();
  const drafts = useQuery({ queryKey: ["plan-drafts", slug, id], queryFn: () => api.planDrafts(slug, id), enabled: !!slug && !!id });
  const draft = drafts.data?.items.find((d) => d.id === draftId) ?? null;
  const { board, room, loading } = useLayoutBoard(slug, id, draft?.body ?? null, 300);
  usePageTitle(room && draft ? `${room.name}: ${draft.name} (to scale)` : "Layout");
  if (drafts.isLoading || loading) return <div className="p-6">Loading…</div>;
  if (!draft || !board) return <div className="p-6">That layout is not there.</div>;
  return (
    <div data-testid="layout-print" className="min-h-screen bg-white p-8 text-black">
      {/* Landscape, and drawn in real millimetres to fit letter and A4 alike. */}
      <style>{`@media print { .no-print { display: none !important; } @page { size: landscape; margin: 10mm; } body { background: white; } }`}</style>
      <div className="mb-3 flex items-baseline gap-3">
        <h1 className="m-0 text-xl font-semibold">
          {room?.name}: {draft.name}
        </h1>
        <span className="text-xs">{draft.applied_at ? `applied ${new Date(draft.applied_at).toLocaleDateString()}` : "draft, nothing moved yet"}</span>
        <span className="flex-1" />
        <button type="button" onClick={() => window.print()} className="no-print rounded border border-black px-3 py-1 text-sm">
          Print or save as PDF
        </button>
      </div>
      <LayoutPrint board={board} />
    </div>
  );
}
