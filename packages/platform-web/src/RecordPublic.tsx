import { RecordActionItem } from "./RecordActionContributions";
// "Public", or "Public until Sun 6 pm" in booth mode: the record can be seen
// by people outside the workspace right now, through a public page (#4502).
// Beside "Shared with" on every record (EntityActionsBar), so its owner knows
// before a stranger does; nothing when no live page opens it.

import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { Link } from "react-router-dom";
import { usePlatformWeb } from "./context";

export function RecordPublic({ id }: { id: string }) {
  const { api, orgSlug } = usePlatformWeb();
  const { data } = useQuery({
    queryKey: ["record-public-pages", orgSlug, id],
    queryFn: () => api.recordPublicPages!(orgSlug, id),
    enabled: !!api.recordPublicPages && !!orgSlug,
    staleTime: 60_000,
  });
  const pages = data?.pages ?? [];
  if (!pages.length) return null;
  // The soonest end, if every page ends: past it the record is private again.
  const ends = pages.every((p) => p.public_until) ? pages.map((p) => new Date(p.public_until!)).sort((a, b) => a.getTime() - b.getTime())[0] : null;
  const how = (p: (typeof pages)[number]) => [p.links ? `${p.links} link${p.links === 1 ? "" : "s"}` : null, p.label_door ? "its label" : null].filter(Boolean).join(" and ");
  return (
    <RecordActionItem id="record:public" group="share" label="Public pages" description="See the public pages that show this record." badge={ends ? `Public until ${ends.toLocaleDateString()}` : "Public"}><Link
      to="/configuration/sharing"
      data-testid="record-public-chip"
      title={`Anyone can see this through ${pages.map((p) => `${p.name} (${how(p)})`).join(", ")}`}
      className="inline-flex items-center gap-1 rounded border border-accent px-1.5 py-0.5 text-xs text-accent hover:border-accent transition"
    >
      <Globe size={10} aria-hidden />
      {ends ? `Public until ${ends.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: ends.getMinutes() ? "2-digit" : undefined })}` : "Public"}
    </Link></RecordActionItem>
  );
}
