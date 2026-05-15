// Floating queue widget. Visible everywhere when there's at least
// one label queued. Clicks navigate to the labels queue page.

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Tag } from "lucide-react";
import { useLabels } from "./context";

export function BasketWidget() {
  const { api } = useLabels();
  const { data } = useQuery({
    queryKey: ["labels-queue"],
    queryFn: () => api.listQueue(),
    refetchInterval: 10_000,
  });
  const items = data?.items ?? [];
  if (items.length === 0) return null;
  const total = items.reduce((acc, i) => acc + i.qty, 0);

  return (
    <Link
      to="/labels"
      className="fixed bottom-4 right-4 z-40 bg-slate-700 text-mortar-50 rounded-full shadow-lg px-4 py-2 flex items-center gap-2 hover:bg-slate-600 transition"
      title="Open label queue"
    >
      <Tag size={14} />
      <span className="text-sm font-medium">{total}</span>
      <span className="text-[10px] font-mono opacity-70">queued</span>
    </Link>
  );
}
