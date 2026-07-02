// The mobile bottom action bar (redesign A5): Scan · Add · Search — the three
// thumb verbs. On phones the header packs nav + icons up top, far from the
// thumb, and doing-things loses to browsing-things; this puts capture-first
// where a phone user's hand already is. Hidden ≥md (desktop keeps the header).
//
// Add opens a minimal capture sheet (free text → scanNote → the matchmaker
// finds it a home) so "write something down" works from ANY page, two taps.
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, Plus, Search, X } from "lucide-react";
import { useToast } from "@cobblr/platform-web";
import { api } from "../lib/api";
import { useActiveOrg } from "../auth/ActiveOrgContext";

export function MobileActionBar() {
  const { activeSlug } = useActiveOrg();
  const [addOpen, setAddOpen] = useState(false);
  // The command palette (and anything else) can summon the add sheet — the
  // sheet is a body portal, so it works on desktop even though the BAR is
  // md:hidden.
  useEffect(() => {
    const on = () => setAddOpen(true);
    window.addEventListener("cobblr:open-add-sheet", on);
    return () => window.removeEventListener("cobblr:open-add-sheet", on);
  }, []);
  if (!activeSlug) return null;
  return (
    <>
      <nav
        aria-label="Quick actions"
        className="md:hidden fixed inset-x-0 bottom-0 z-40 border-t border-line dark:border-slate-700 bg-surface/95 dark:bg-slate-900/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="grid grid-cols-3">
          <Link to="/scan/camera" className="flex flex-col items-center gap-0.5 py-2 text-muted dark:text-slate-300 hover:text-accent transition">
            <Camera size={20} />
            <span className="text-[10px] font-medium">Scan</span>
          </Link>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="flex flex-col items-center gap-0.5 py-2 text-muted dark:text-slate-300 hover:text-accent transition"
          >
            <span className="w-8 h-8 -my-1 rounded-full bg-cobble-600 text-white flex items-center justify-center">
              <Plus size={18} />
            </span>
            <span className="text-[10px] font-medium">Add</span>
          </button>
          <Link to="/search" className="flex flex-col items-center gap-0.5 py-2 text-muted dark:text-slate-300 hover:text-accent transition">
            <Search size={20} />
            <span className="text-[10px] font-medium">Search</span>
          </Link>
        </div>
      </nav>
      {addOpen && <AddSheet slug={activeSlug} onClose={() => setAddOpen(false)} />}
    </>
  );
}

/** Two-tap capture from anywhere: type it, we file it (same scanNote →
 *  matchmaker path as the homepage funnel; pending items surface there). */
function AddSheet({ slug, onClose }: { slug: string; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => inputRef.current?.focus(), []);
  const mut = useMutation({
    mutationFn: (t: string) => api.scanNote(slug, t),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["capture-inbox", slug] });
      toast.success("Added — finding it a home. It'll show on your dashboard.");
      onClose();
      navigate("/dashboard");
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't add that"),
  });
  return createPortal(
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end md:items-center md:justify-center" onClick={onClose}>
      <div
        className="w-full md:max-w-md rounded-t-2xl md:rounded-xl border border-line dark:border-slate-700 bg-surface dark:bg-slate-900 p-4 space-y-3"
        style={{ paddingBottom: "calc(1rem + env(safe-area-inset-bottom))" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <h2 className="flex-1 text-sm font-semibold text-content dark:text-mortar-100">Add a thing</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-faint hover:text-content transition">
            <X size={16} />
          </button>
        </div>
        <input
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. a spool of black PLA, my passport…"
          className="input w-full"
          onKeyDown={(e) => { if (e.key === "Enter" && text.trim()) mut.mutate(text.trim()); }}
        />
        <button
          type="button"
          disabled={!text.trim() || mut.isPending}
          onClick={() => mut.mutate(text.trim())}
          className="w-full rounded-lg bg-cobble-600 hover:bg-cobble-700 text-white text-sm font-medium px-3 py-2 transition disabled:opacity-50"
        >
          {mut.isPending ? "Adding…" : "Add it — we'll find it a home"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
